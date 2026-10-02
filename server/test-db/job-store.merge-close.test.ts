import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { sweepRuntimeWakes } from '../src/db/workflow-blocks/runtime.js';
import type { WorkflowDefinition } from '../src/db/workflow-schema.js';
import { useTestDb } from './harness.js';

/**
 * The merged-PR closure against a real database (issue #390): a verified merge delivery closes
 * every thread published to that PR — done-stamped with no local actor, queued work stopped,
 * waits cancelled `pr merged`, the reclaim queued only when every member is terminal — while a
 * plain close, another org/repo/PR, a redelivery and a manual Reopen all leave exactly the
 * traces the issue demands.
 */

const mustCreate = (p: Promise<{ id: string } | 'purging'>): Promise<{ id: string }> =>
    p.then((ref) => {
        if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
        return ref;
    });

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
let prs: ReturnType<typeof createPrLifecycleStore>;

const ORG = 'test-org';
const OTHER_ORG = 'other-org';
const WORKER = 'worker-1';
const REPO = 'acme/widgets';
const OTHER_REPO = 'acme/other';
const LEASE_SECONDS = 300;
const PULL = 7;
const SESSION = '33333333-3333-4333-8333-333333333333';
const ALICE = { id: randomUUID(), githubUserId: 424242, login: 'alice-merge' };

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE] });

/** first (publish: true, resume) -> second -> third (resume): successors the merge must not let run. */
const chainWorkflow: WorkflowDefinition = {
    entry: 'first',
    params: [],
    nodes: [
        { name: 'first', kind: 'agent', session: 'resume', publish: true, prompt: 'first' },
        { name: 'second', kind: 'agent', session: 'resume', prompt: 'second' },
        { name: 'third', kind: 'agent', session: 'resume', prompt: 'third' },
    ],
    edges: [
        { from: 'first', to: 'second', when: 'succeeded' },
        { from: 'second', to: 'third', when: 'succeeded' },
    ],
};

/** entry (publish: true) -> review (a `pr-delivery-wait` boundary): the parked review-wait shape. */
const waitingWorkflow: WorkflowDefinition = {
    entry: 'verify',
    params: [],
    nodes: [
        { name: 'verify', kind: 'agent', session: 'fresh', publish: true, prompt: 'verify' },
        {
            name: 'review',
            kind: 'agent',
            session: 'fresh',
            prompt: 'react to review',
            runtime: { runtime: 'pr-delivery-wait', block: 'fake/test-block', params: {} },
        },
    ],
    edges: [{ from: 'verify', to: 'review', when: 'succeeded' }],
};

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    store = createJobStore({ sql, orgId: ORG, prs });
});

/** A workflow-less thread taken to a terminal verdict, published to the suite's PR. */
const finishPublished = async (command: string, status: 'succeeded' | 'failed' = 'succeeded'): Promise<string> => {
    const { id } = await mustCreate(store.create(command, null, { repo: REPO, executor: null }));
    const claim = await store.claim(WORKER, LEASE_SECONDS);
    if (claim === null) throw new Error('claim refused');
    await store.session(id, claim.leaseToken, SESSION);
    await store.complete(id, claim.leaseToken, {
        status,
        exitCode: status === 'succeeded' ? 0 : 1,
        output: `${command} output`,
        publication: {
            repo: REPO,
            prNumber: PULL,
            prUrl: `https://github.com/${REPO}/pull/${PULL}`,
            headBranch: `factory/${id}`,
            baseBranch: 'main',
        },
    });
    return id;
};

const mustFollowUp = (root: string, command: string): Promise<{ id: string }> =>
    store.createFollowUp(root, command, null).then((ref) => {
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        return ref;
    });

const mustRetry = (id: string): Promise<{ id: string }> =>
    store.createRetry(id, null).then((ref) => {
        if (typeof ref === 'string') throw new Error(`createRetry refused: ${ref}`);
        return ref;
    });

const claimOf = async (id: string): Promise<Claim> => {
    const claim = await store.claim(WORKER, LEASE_SECONDS);
    if (claim === null || claim.id !== id) throw new Error(`claim refused for ${id}`);
    return claim;
};

const reclaimRowsOf = async (root: string): Promise<{ root_job_id: string }[]> =>
    sql`select root_job_id from task_reclaim where org_id = ${ORG} and root_job_id = ${root}`;

const jobRowOf = async (id: string): Promise<{ status: string; done_at: Date | null; done_by: string | null }> => {
    const rows = await sql<{ status: string; done_at: Date | null; done_by: string | null }[]>`
        select status, done_at, done_by from job where org_id = ${ORG} and id = ${id}
    `;
    const row = rows[0];
    if (!row) throw new Error(`no job row ${id}`);
    return row;
};

/** A workflow thread whose entry claimed (running) or completed — the publication rides the completion. */
const startWorkflowThread = async (
    name: string,
    snapshot: WorkflowDefinition,
    publishPr: number | null
): Promise<string> => {
    const { id } = await mustCreate(
        store.create('walk the graph', null, {
            repo: REPO,
            executor: null,
            workflow: { id: randomUUID(), name, node: snapshot.entry, snapshot, params: {} },
        })
    );
    const claim = await claimOf(id);
    if (publishPr === null) return id;
    await store.session(id, claim.leaseToken, SESSION);
    await store.complete(id, claim.leaseToken, {
        status: 'succeeded',
        exitCode: 0,
        output: 'published',
        publication: {
            repo: REPO,
            prNumber: publishPr,
            prUrl: `https://github.com/${REPO}/pull/${publishPr}`,
            headBranch: `factory/${id}`,
            baseBranch: 'main',
        },
    });
    return id;
};

describe.skipIf(!enabled)('a merged PR closes its published threads (issue #390)', () => {
    it('closes every root published to the PR: done, no actor, audit preserved, reclaim queued', async () => {
        const okRoot = await finishPublished('the ok task');
        const failedRoot = await finishPublished('the failed task', 'failed');
        await prs.enterWait({ root: failedRoot, reason: 'review', repo: REPO, prNumber: PULL });

        const result = await store.closeMergedPr(REPO, PULL, 'guid-multi');
        expect(result).toEqual({ outcome: 'applied', closedRoots: 2 });

        for (const root of [okRoot, failedRoot]) {
            for (const member of (await store.thread(root)) ?? []) {
                const row = await jobRowOf(member.id);
                expect(row.done_at).not.toBeNull();
                expect(row.done_by).toBeNull();
            }
            // Statuses, outputs and the publication link survive the closure — this is a done
            // stamp, not a rewrite of the audit record.
            expect(await store.get(root)).toMatchObject({
                doneAt: expect.any(String),
                publication: expect.objectContaining({ prNumber: PULL }),
            });
            expect((await reclaimRowsOf(root)).length).toBe(1);
        }
        const failedRow = await jobRowOf(failedRoot);
        expect(failedRow.status).toBe('failed');
        const wait = await prs.waitOf(failedRoot);
        expect(wait?.terminalReason).toBe('pr merged');
        expect(wait?.cancelledAt).not.toBeNull();
    });

    it('an ordinary close cancels the wait but never stamps done', async () => {
        const root = await finishPublished('a merely closed task');
        await prs.cancelForRepoPr(REPO, PULL, 'pr closed');

        expect((await jobRowOf(root)).done_at).toBeNull();
        expect((await reclaimRowsOf(root)).length).toBe(0);
    });

    it('closes only what the delivery addresses: other repo, other PR, other org untouched', async () => {
        const root = await finishPublished('the addressed task');
        const elsewhere = await finishPublished('a task on another pr');
        await prs.recordPublication({
            root: elsewhere,
            repo: REPO,
            prNumber: 8,
            prUrl: `https://github.com/${REPO}/pull/8`,
            headBranch: `factory/${elsewhere}`,
            baseBranch: 'main',
        });
        const otherOrgPrs = createPrLifecycleStore({ sql, orgId: OTHER_ORG });
        await otherOrgPrs.recordPublication({
            root,
            repo: REPO,
            prNumber: PULL,
            prUrl: `https://github.com/${REPO}/pull/${PULL}`,
            headBranch: 'factory/other',
            baseBranch: 'main',
        });

        expect(await store.closeMergedPr(OTHER_REPO, PULL, 'guid-repo')).toEqual({
            outcome: 'applied',
            closedRoots: 0,
        });
        expect(await store.closeMergedPr(REPO, 999, 'guid-pr')).toEqual({ outcome: 'applied', closedRoots: 0 });

        await store.closeMergedPr(REPO, PULL, 'guid-org');
        expect((await jobRowOf(root)).done_at).not.toBeNull();
        // The other PR's thread and the other org's ledger were never this delivery's business.
        expect(await store.closeMergedPr(REPO, 8, 'guid-after')).toEqual({ outcome: 'applied', closedRoots: 1 });
        expect((await jobRowOf(elsewhere)).done_at).not.toBeNull();
        expect(await otherOrgPrs.publicationOf(root)).not.toBeNull();
    });

    it('a parked review-wait thread closes: done, wait cancelled `pr merged`, nothing claimable', async () => {
        const root = await startWorkflowThread('park-merge', waitingWorkflow, PULL);
        // Parked: no successor row exists, the wait is open.
        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        expect((await prs.waitOf(root))?.terminalReason).toBeNull();

        const result = await store.closeMergedPr(REPO, PULL, 'guid-parked');
        expect(result).toEqual({ outcome: 'applied', closedRoots: 1 });

        expect((await jobRowOf(root)).done_at).not.toBeNull();
        const wait = await prs.waitOf(root);
        expect(wait?.terminalReason).toBe('pr merged');
        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        expect((await reclaimRowsOf(root)).length).toBe(1);
    });

    it('a queued successor settles stopped: terminal, finished, never claimed', async () => {
        const root = await startWorkflowThread('queued-merge', chainWorkflow, PULL);
        const successor = await sql<{ id: string }[]>`
            select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'second'
        `;
        const successorId = successor[0]!.id;
        expect((await jobRowOf(successorId)).status).toBe('queued');

        await store.closeMergedPr(REPO, PULL, 'guid-queued');

        const row = await jobRowOf(successorId);
        expect(row.status).toBe('stopped');
        expect(row.done_at).not.toBeNull();
        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        expect((await reclaimRowsOf(root)).length).toBe(1);
    });

    it('a member running at merge time settles normally into the closed thread — and publishes nothing forward', async () => {
        // The entry completed and published; its SUCCESSOR is running when the merge lands:
        // the terminal entry takes the done stamp, the running successor is untouched, and
        // no reclaim is queued while a runner owns the worktree.
        const root = await startWorkflowThread('running-merge', chainWorkflow, PULL);
        const successorId = (
            await sql<{ id: string }[]>`
                select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'second'
            `
        )[0]!.id;
        const claim = await claimOf(successorId);
        await store.session(successorId, claim.leaseToken, SESSION);
        await store.closeMergedPr(REPO, PULL, 'guid-running');
        expect((await jobRowOf(successorId)).status).toBe('running');
        expect((await jobRowOf(successorId)).done_at).toBeNull();
        expect((await reclaimRowsOf(root)).length).toBe(0);

        // The run completes and reports its publication: the closure already applied at merge
        // time, the transition sees the marker and rests — no successor, no parked round.
        const done = await store.complete(successorId, claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'published late',
            publication: {
                repo: REPO,
                prNumber: PULL,
                prUrl: `https://github.com/${REPO}/pull/${PULL}`,
                headBranch: `factory/${successorId}`,
                baseBranch: 'main',
            },
        });
        expect(done).toEqual({ result: 'ok', threadDone: true });

        const members = await sql<{ n: number }[]>`
            select count(*)::int as n from job where org_id = ${ORG} and root_job_id = ${root}
        `;
        expect(members[0]!.n).toBe(2);
        const rounds = await sql<{ n: number }[]>`
            select count(*)::int as n from workflow_round where org_id = ${ORG} and root_job_id = ${root}
        `;
        expect(rounds[0]!.n).toBe(0);
        // threadDone-true verdict: the reclaim order rode the answer, so no queue row — the
        // marker on the root is the record.
        expect((await reclaimRowsOf(root)).length).toBe(0);
        const [reclaimed] = await sql<{ worktree_reclaimed_at: Date | null }[]>`
            select worktree_reclaimed_at from job where org_id = ${ORG} and id = ${root}
        `;
        expect(reclaimed!.worktree_reclaimed_at).not.toBeNull();
        expect(await prs.publicationOf(root)).not.toBeNull();
    });

    it('a member running at merge time that publishes nothing still closes at its verdict', async () => {
        const root = await startWorkflowThread('running-quiet-merge', chainWorkflow, PULL);
        const successorId = (
            await sql<{ id: string }[]>`
                select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'second'
            `
        )[0]!.id;
        const lease = (await claimOf(successorId)).leaseToken;
        await store.closeMergedPr(REPO, PULL, 'guid-quiet');
        expect((await jobRowOf(successorId)).status).toBe('running');

        // No publication report — the closure still lands: the marker rests the transition and
        // the entry's merge-time stamp makes the thread done at this verdict.
        const done = await store.complete(successorId, lease, {
            status: 'succeeded',
            exitCode: 0,
            output: 'no publication',
        });
        expect(done).toEqual({ result: 'ok', threadDone: true });
        const members = await sql<{ n: number }[]>`
            select count(*)::int as n from job where org_id = ${ORG} and root_job_id = ${root}
        `;
        expect(members[0]!.n).toBe(2);
        const [reclaimed] = await sql<{ worktree_reclaimed_at: Date | null }[]>`
            select worktree_reclaimed_at from job where org_id = ${ORG} and id = ${root}
        `;
        expect(reclaimed!.worktree_reclaimed_at).not.toBeNull();
    });

    it('a stop settling the last moving member reclaims the merge-marked thread', async () => {
        const root = await startWorkflowThread('stop-merge', chainWorkflow, PULL);
        const successorId = (
            await sql<{ id: string }[]>`
                select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'second'
            `
        )[0]!.id;
        const claim = await claimOf(successorId);
        await store.session(successorId, claim.leaseToken, SESSION);
        await store.closeMergedPr(REPO, PULL, 'guid-stop');
        expect((await reclaimRowsOf(root)).length).toBe(0);

        // An expired lease makes the stop settle the row here instead of stamping a request.
        await sql`update job set lease_expires_at = now() - interval '1 second' where org_id = ${ORG} and id = ${successorId}`;
        expect(await store.stop(successorId, null)).toEqual({ result: 'stopped' });

        // The thread's done rode the merge (the terminal entry); the settle's work is the
        // reclaim, which the terminal aggregate — true only since this stop — now admits.
        expect((await jobRowOf(root)).done_at).not.toBeNull();
        expect((await reclaimRowsOf(root)).length).toBe(1);
    });

    it('a suspend settling the last moving member reclaims the merge-marked thread', async () => {
        const root = await startWorkflowThread('suspend-merge', chainWorkflow, PULL);
        const successorId = (
            await sql<{ id: string }[]>`
                select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'second'
            `
        )[0]!.id;
        const claim = await claimOf(successorId);
        await store.closeMergedPr(REPO, PULL, 'guid-suspend');
        expect((await reclaimRowsOf(root)).length).toBe(0);

        expect(await store.suspend(successorId, claim.leaseToken)).toEqual({ result: 'ok', status: 'stopped' });

        expect((await jobRowOf(root)).done_at).not.toBeNull();
        expect((await reclaimRowsOf(root)).length).toBe(1);
    });

    it('the dead retirement of the last moving member reclaims the merge-marked thread', async () => {
        const root = await startWorkflowThread('dead-merge', chainWorkflow, PULL);
        const successorId = (
            await sql<{ id: string }[]>`
                select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'second'
            `
        )[0]!.id;
        await claimOf(successorId);
        await store.closeMergedPr(REPO, PULL, 'guid-dead');
        expect((await reclaimRowsOf(root)).length).toBe(0);

        // Burn the attempt and expire the lease: the claim's dead sweep retires the row.
        await sql`update job set attempts = max_attempts, lease_expires_at = now() - interval '1 second'
                  where org_id = ${ORG} and id = ${successorId}`;
        expect(await store.claim('worker-dead', LEASE_SECONDS)).toBeNull();

        expect((await jobRowOf(successorId)).status).toBe('dead');
        expect((await jobRowOf(root)).done_at).not.toBeNull();
        expect((await reclaimRowsOf(root)).length).toBe(1);
    });

    it('the claim-time fence settles a woken continuation of a plainly closed PR, and over-closes nothing', async () => {
        // The fifth settle arm: a parked round woken by review traffic, its wait cancelled
        // afterwards by a PLAIN close — the claim lands the continuation at the fence, which
        // settles it stopped. No merge marker exists, so the shared settle must no-op: a plain
        // close never closes a thread.
        const root = await startWorkflowThread('fence-plain-close', waitingWorkflow, PULL);
        await prs.recordDelivery({
            deliveryId: 'd-fence',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: PULL,
        });
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });
        const continuation = (
            await sql<{ id: string; status: string }[]>`
                select id, status from job
                where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'review'
            `
        )[0]!;
        expect(continuation.status).toBe('queued');

        await prs.cancelForRepoPr(REPO, PULL, 'pr closed');
        expect(await store.claim('worker-fence', LEASE_SECONDS)).toBeNull();

        const settled = await jobRowOf(continuation.id);
        expect(settled.status).toBe('stopped');
        expect((await jobRowOf(root)).done_at).toBeNull();
        expect((await reclaimRowsOf(root)).length).toBe(0);
    });

    it('a redelivery — same or different GUID — answers duplicate and repeats nothing', async () => {
        const root = await finishPublished('the deduped task');
        const first = await store.closeMergedPr(REPO, PULL, 'guid-first');
        expect(first).toEqual({ outcome: 'applied', closedRoots: 1 });
        const stampedAt = (await jobRowOf(root)).done_at;

        expect(await store.closeMergedPr(REPO, PULL, 'guid-first')).toEqual({ outcome: 'duplicate', closedRoots: 0 });
        expect(await store.closeMergedPr(REPO, PULL, 'guid-second')).toEqual({ outcome: 'duplicate', closedRoots: 0 });

        expect((await jobRowOf(root)).done_at).toEqual(stampedAt);
        expect((await reclaimRowsOf(root)).length).toBe(1);
    });

    it('an earlier manual Done survives the merge: actor and instant are the first writer’s', async () => {
        const root = await finishPublished('the manually done task');
        await store.markDone(root, ALICE.id);
        const manual = await jobRowOf(root);

        await store.closeMergedPr(REPO, PULL, 'guid-manual');

        const after = await jobRowOf(root);
        expect(after.done_at).toEqual(manual.done_at);
        expect(after.done_by).toBe(ALICE.id);
    });

    it('a merge delivery before any publication waits in the ledger and applies when the association lands', async () => {
        // The delivery names a PR nothing has published to yet: applied honestly with zero roots,
        // the fact kept durably.
        const before = await store.closeMergedPr(REPO, PULL, 'guid-early');
        expect(before).toEqual({ outcome: 'applied', closedRoots: 0 });

        const root = await startWorkflowThread('early-merge', waitingWorkflow, PULL);
        // The publishing completion applied the closure inline: no park, no successor, thread done.
        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        const wait = await prs.waitOf(root);
        expect(wait).toBeNull();
        expect((await jobRowOf(root)).done_at).not.toBeNull();
        // The closure's inline settle queued a reclaim row moments before the threadDone stamp;
        // the verdict's direct order superseded it — one tree, one work order.
        expect((await reclaimRowsOf(root)).length).toBe(0);
        const [reclaimed] = await sql<{ worktree_reclaimed_at: Date | null }[]>`
            select worktree_reclaimed_at from job where org_id = ${ORG} and id = ${root}
        `;
        expect(reclaimed!.worktree_reclaimed_at).not.toBeNull();
        // A redelivery of the early GUID is a duplicate — the closure ran exactly once.
        expect(await store.closeMergedPr(REPO, PULL, 'guid-early')).toEqual({ outcome: 'duplicate', closedRoots: 0 });
    });

    it('follow-up and retry refuse a merge-closed thread with task_done — until Reopen', async () => {
        const root = await finishPublished('the reopened task');
        await store.closeMergedPr(REPO, PULL, 'guid-reopen');
        expect(await store.createFollowUp(root, 'after merge', null)).toBe('task_done');
        expect(await store.createRetry(root, null)).toBe('task_done');

        expect(await store.reopen(root)).toEqual({ result: 'ok' });
        expect((await jobRowOf(root)).done_at).toBeNull();
        const marker = await sql<{ n: number }[]>`
            select count(*)::int as n from job_merge_close where org_id = ${ORG} and root_job_id = ${root}
        `;
        expect(marker[0]!.n).toBe(0);
        // Retry first: the retry's head-eligibility reads the thread head, and the follow-up
        // queued below would otherwise be that head.
        await mustRetry(root);
        await mustFollowUp(root, 'after reopen');

        // The ledger row survives reopen: the redelivered merge cannot re-close the thread.
        expect(await store.closeMergedPr(REPO, PULL, 'guid-reopen-again')).toEqual({
            outcome: 'duplicate',
            closedRoots: 0,
        });
        expect((await jobRowOf(root)).done_at).toBeNull();
    });

    it('a reopened workflow thread walks again: its completion inserts the successor the merge withheld', async () => {
        const root = await startWorkflowThread('walk-again', chainWorkflow, PULL);
        const secondId = (
            await sql<{ id: string }[]>`
                select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'second'
            `
        )[0]!.id;

        // The merge stops the queued `second`; the thread is closed and reopen clears both the
        // stamps and the marker.
        await store.closeMergedPr(REPO, PULL, 'guid-walk');
        expect((await jobRowOf(secondId)).status).toBe('stopped');
        await store.reopen(root);

        // A retried attempt is off-graph: its completion re-fires the HALTED node's edges —
        // `second`'s — and the transition runs again now that the marker is gone, inserting
        // the `third` row the closure's shape would have withheld forever.
        const retried = await mustRetry(root);
        const claim = await claimOf(retried.id);
        await store.complete(retried.id, claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'again',
        });
        const thirds = await sql<{ n: number }[]>`
            select count(*)::int as n from job
            where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'third'
        `;
        expect(thirds[0]!.n).toBe(1);
    });

    it('reopen refuses once the worktree is gone (reclaim acked)', async () => {
        const root = await finishPublished('the reclaimed task');
        await store.closeMergedPr(REPO, PULL, 'guid-ack');
        const claimed = await store.claimReclaim('reaper-1', LEASE_SECONDS);
        expect(claimed?.rootJobId).toBe(root);
        expect(await store.ackReclaim(claimed!.id, 'reaper-1')).toBe('ok');

        expect(await store.reopen(root)).toBe('reclaimed');
    });

    it('two concurrent merge deliveries apply exactly once', async () => {
        const root = await finishPublished('the raced task');
        const outcomes = await Promise.all([
            store.closeMergedPr(REPO, PULL, 'guid-race-a'),
            store.closeMergedPr(REPO, PULL, 'guid-race-b'),
        ]);
        const applied = outcomes.filter((o) => o.outcome === 'applied');
        expect(applied.length).toBe(1);
        expect(outcomes.map((o) => o.outcome).sort()).toEqual(['applied', 'duplicate']);
        expect(applied[0]!.closedRoots).toBe(1);
        expect((await jobRowOf(root)).done_at).not.toBeNull();
        expect((await reclaimRowsOf(root)).length).toBe(1);
    });
});
