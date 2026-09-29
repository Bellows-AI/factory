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
 * A create whose refusal would be a broken setup, never a case under test: narrows the store's
 * honest union (`{ id } | 'purging'`, issue #92) so the call sites read as they did before.
 */
const mustCreate = (p: Promise<{ id: string } | 'purging'>): Promise<{ id: string }> =>
    p.then((ref) => {
        if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
        return ref;
    });

/**
 * Durable block waits against a real database (issue #231): a workflow transition into a node
 * carrying a private `runtime` descriptor parks in `workflow_round` instead of inserting a
 * runnable job, and the claim preamble's wake sweep is what turns folded GitHub deliveries into
 * exactly one claimable continuation. `workflow-block-runtime.test.ts` covers the dispatcher's pure
 * half; `workflow-block-compiler.test.ts` covers how a block's expansion attaches the descriptor.
 * `job.workflow_id` carries no foreign key (docs/workflows.md), so these tests skip
 * `workflow-store.ts` entirely and hand `store.create` a hand-built snapshot directly — the same
 * shortcut `job-store.helper-plans.test.ts` takes for #122's claim-time injection.
 */

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
let prs: ReturnType<typeof createPrLifecycleStore>;

const ORG = 'test-org';
const WORKER = 'worker-1';
const REPO = 'acme/widgets';

const HEX_RADIX = 16;
const UUID_HEX_SLICE_LENGTH = 8;
const ALICE = {
    id: randomUUID(),
    githubUserId: Number.parseInt(randomUUID().slice(0, UUID_HEX_SLICE_LENGTH), HEX_RADIX),
    login: 'alice-wait',
};
const BOB = {
    id: randomUUID(),
    githubUserId: Number.parseInt(randomUUID().slice(0, UUID_HEX_SLICE_LENGTH), HEX_RADIX),
    login: 'bob-wait',
};

const db = useTestDb({ orgs: [ORG], users: [ALICE, BOB], max: 8 });

/** entry (publish: true) -> review (a `pr-delivery-wait` boundary, private `runtime` attached). */
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

async function queueWaitingThread(name: string, createdBy: string | null = null): Promise<string> {
    // The job's own repo label must match a completion's reported publication.repo — completeJob's
    // maybeRecordPublication cross-checks it (a payload may not claim a repo the board never gave
    // the job), so a real end-to-end park needs the label set, unlike helper-plans.test.ts's
    // repo: null fixture, which calls recordPublication directly and never goes through complete().
    const job = await mustCreate(
        store.create('start the thread', createdBy, {
            repo: REPO,
            executor: null,
            workflow: { id: randomUUID(), name, node: waitingWorkflow.entry, snapshot: waitingWorkflow, params: {} },
        })
    );
    return job.id;
}

/** Claims and completes the entry node, publishing the given PR — the transition this suite
 *  exercises always runs off the back of this. Returns the root id. */
async function publishAndTransition(name: string, prNumber: number, createdBy: string | null = null): Promise<string> {
    const root = await queueWaitingThread(name, createdBy);
    const claim = (await store.claim(WORKER, 60)) as Claim;
    expect(claim).not.toBeNull();
    // A session on the entry row, so a follow-up created off it (the "active follow-up" case
    // below) is one `createFollowUp` legitimately accepts — unrelated to this suite's own concern.
    await store.session(claim.id, claim.leaseToken, `sess-${name}`);
    await store.complete(claim.id, claim.leaseToken, {
        status: 'succeeded',
        exitCode: 0,
        output: 'published',
        publication: {
            repo: REPO,
            prNumber,
            prUrl: `https://github.com/${REPO}/pull/${prNumber}`,
            headBranch: `factory/${root}`,
            baseBranch: 'main',
        },
    });
    return root;
}

async function roundRows(root: string): Promise<{ round: number; woken_at: Date | null; job_id: string | null }[]> {
    return sql`select round, woken_at, job_id from workflow_round where org_id = ${ORG} and root_job_id = ${root}`;
}

/** Delivers one review event to a parked thread and sweeps; returns the continuation rows it inserted. */
async function deliverAndSweep(root: string, deliveryId: string, prNumber: number): Promise<{ id: string }[]> {
    await prs.recordDelivery({
        deliveryId,
        event: 'pull_request_review',
        action: 'submitted',
        repo: REPO,
        prNumber,
    });
    // The sweep skips a wait with nothing pending, so without this a caller's no-wake assertion
    // would pass for the wrong reason.
    expect((await prs.waitOf(root))?.pending).toBeGreaterThan(0);
    await sweepRuntimeWakes({ sql, orgId: ORG, prs });
    return sql<{ id: string }[]>`
        select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'review'
    `;
}

describe.skipIf(!enabled)('durable block waits — parking the transition (issue #231)', () => {
    it('parks instead of inserting a runnable row: no claim, an open wait, one parked round', async () => {
        const root = await publishAndTransition('park-basic', 1);

        expect(await store.claim(WORKER, 60)).toBeNull();

        const wait = await prs.waitOf(root);
        expect(wait).toMatchObject({ reason: 'review', repo: REPO, prNumber: 1, pending: 0 });
        expect(wait?.completedAt).toBeNull();
        expect(wait?.cancelledAt).toBeNull();

        const rounds = await roundRows(root);
        expect(rounds).toEqual([{ round: 1, woken_at: null, job_id: null }]);
    });

    it('rests the thread instead of parking when the node has no recorded publication', async () => {
        const root = await queueWaitingThread('park-no-publication');
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'no pr' });

        expect(await store.claim(WORKER, 60)).toBeNull();
        expect(await prs.waitOf(root)).toBeNull();
        expect(await roundRows(root)).toEqual([]);
    });

    it('an ordinary workflow with no runtime-carrying node is entirely unaffected', async () => {
        const plain: WorkflowDefinition = {
            entry: 'work',
            params: [],
            nodes: [{ name: 'work', kind: 'agent', session: 'fresh', publish: true, prompt: 'work' }],
            edges: [],
        };
        const job = await mustCreate(
            store.create('go', null, {
                repo: null,
                executor: null,
                workflow: { id: randomUUID(), name: 'plain', node: plain.entry, snapshot: plain, params: {} },
            })
        );
        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim.id).toBe(job.id);
        await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        expect(await roundRows(job.id)).toEqual([]);
    });
});

describe.skipIf(!enabled)('durable block waits — the wake sweep', () => {
    it('zero pending deliveries: no continuation, ever', async () => {
        await publishAndTransition('wake-zero', 2);
        expect(await store.claim(WORKER, 60)).toBeNull();
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('one delivery wakes exactly one claimable continuation with a deterministic count', async () => {
        const root = await publishAndTransition('wake-one', 3);
        await prs.recordDelivery({
            deliveryId: 'd-1',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 3,
        });

        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim).not.toBeNull();
        expect(claim.rootJobId).toBe(root);
        expect(claim.command).toBe('react to review');
        expect(claim).not.toHaveProperty('runtime');

        const rounds = await roundRows(root);
        expect(rounds).toHaveLength(1);
        expect(rounds[0]!.woken_at).not.toBeNull();
        expect(rounds[0]!.job_id).toBe(claim.id);

        const [audit] = await sql<
            { delivery_count: number; last_delivery_id: string; repo: string; pr_number: number }[]
        >`
            select delivery_count, last_delivery_id, repo, pr_number from workflow_round
            where org_id = ${ORG} and root_job_id = ${root} and round = 1
        `;
        expect(audit).toMatchObject({ delivery_count: 1, last_delivery_id: 'd-1', repo: REPO, pr_number: 3 });
    });

    it('many deliveries, plus a redelivered GUID, coalesce into one continuation with the true count', async () => {
        const root = await publishAndTransition('wake-many', 4);
        await prs.recordDelivery({
            deliveryId: 'd-a',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 4,
        });
        await prs.recordDelivery({
            deliveryId: 'd-b',
            event: 'issue_comment',
            action: 'created',
            repo: REPO,
            prNumber: 4,
        });
        await prs.recordDelivery({
            deliveryId: 'd-a',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 4,
        }); // redelivery
        await prs.recordDelivery({
            deliveryId: 'd-c',
            event: 'issue_comment',
            action: 'created',
            repo: REPO,
            prNumber: 4,
        });

        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim).not.toBeNull();
        const [audit] = await sql<{ delivery_count: number; last_delivery_id: string }[]>`
            select delivery_count, last_delivery_id from workflow_round
            where org_id = ${ORG} and root_job_id = ${root} and round = 1
        `;
        expect(audit).toMatchObject({ delivery_count: 3, last_delivery_id: 'd-c' });

        // Claiming again finds nothing left — the wait was reset to zero in the same lock it woke.
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('a thread with an active follow-up is never woken', async () => {
        const root = await publishAndTransition('wake-active-follow-up', 5);
        // The follow-up composer's own row: off-graph, no workflow_node, queued.
        const followUp = await store.createFollowUp(root, 'one more thing', null);
        expect(typeof followUp === 'object' && 'id' in followUp).toBe(true);

        await prs.recordDelivery({
            deliveryId: 'd-follow',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 5,
        });
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });

        const rounds = await roundRows(root);
        expect(rounds[0]!.woken_at).toBeNull();
    });

    it('mark done on a terminal parked wait stops wakes', async () => {
        const root = await publishAndTransition('wake-marked-done', 17);
        expect(await store.markDone(root, null)).toMatchObject({ status: 'succeeded' });

        expect(await deliverAndSweep(root, 'd-marked-done', 17)).toEqual([]);
        expect((await roundRows(root))[0]!.woken_at).toBeNull();
    });

    it('control: the same parked wait without mark done wakes one continuation', async () => {
        const root = await publishAndTransition('wake-not-marked-done', 18);

        const continuations = await deliverAndSweep(root, 'd-not-marked-done', 18);
        expect(continuations).toHaveLength(1);
        expect((await roundRows(root))[0]!.woken_at).not.toBeNull();
    });
});

describe.skipIf(!enabled)('durable block waits — concurrency and cancellation', () => {
    it('concurrent claimers cannot wake the same round twice', async () => {
        const root = await publishAndTransition('race-concurrent', 6);
        await prs.recordDelivery({
            deliveryId: 'd-race',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 6,
        });

        const claims = await Promise.all(Array.from({ length: 6 }, () => store.claim(`w-${Math.random()}`, 60)));
        const nonNull = claims.filter((c): c is Claim => c !== null);
        expect(nonNull).toHaveLength(1);
        expect(nonNull[0]!.rootJobId).toBe(root);

        const rounds = await roundRows(root);
        expect(rounds).toHaveLength(1);
        expect(rounds[0]!.job_id).toBe(nonNull[0]!.id);

        // The round-row and single-non-null-claim checks above would both stay green even if a
        // second continuation were inserted and simply never claimed (the round's own `woken_at`
        // update matching zero rows on a loser). Count the job rows directly: exactly one, ever.
        const woken = await sql<{ count: string }[]>`
            select count(*) from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'review'
        `;
        expect(Number(woken[0]!.count)).toBe(1);
    });

    it('a PR close before any delivery leaves the wait cancelled — never wakes', async () => {
        const root = await publishAndTransition('cancel-before-delivery', 7);
        await prs.cancelForRepoPr(REPO, 7, 'pr closed');
        await prs.recordDelivery({
            deliveryId: 'd-after-close',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 7,
        });

        expect(await store.claim(WORKER, 60)).toBeNull();
        const wait = await prs.waitOf(root);
        expect(wait?.cancelledAt).not.toBeNull();
    });

    it('a PR close after the wake but before the claim settles the continuation stopped instead of handing it out', async () => {
        const root = await publishAndTransition('cancel-after-wake', 8);
        await prs.recordDelivery({
            deliveryId: 'd-close-race',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 8,
        });

        // Wake it directly, without going through claim — simulating the sweep having already
        // committed a continuation before the close lands.
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });
        const [round] = await roundRows(root);
        expect(round!.job_id).not.toBeNull();

        await prs.cancelForRepoPr(REPO, 8, 'pr closed');

        expect(await store.claim(WORKER, 60)).toBeNull();
        const [job] = await sql<
            { status: string }[]
        >`select status from job where org_id = ${ORG} and id = ${round!.job_id}`;
        expect(job!.status).toBe('stopped');
    });

    it('stopping the woken continuation cancels the wait — no further wake', async () => {
        const root = await publishAndTransition('stop-continuation', 9);
        await prs.recordDelivery({
            deliveryId: 'd-stop',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 9,
        });
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });
        const [round] = await roundRows(root);

        const stopped = await store.stop(round!.job_id!, null);
        expect(stopped).toMatchObject({ result: 'stopped' });

        const wait = await prs.waitOf(root);
        expect(wait?.cancelledAt).not.toBeNull();
    });

    it('removing the thread while parked cancels the wait and drops the round — a later delivery wakes nothing', async () => {
        const root = await publishAndTransition('remove-while-parked', 10);
        const removed = await store.removeThread(root, null);
        expect(removed).toMatchObject({ result: 'ok' });

        expect(await roundRows(root)).toEqual([]);

        // The delivery still folds nowhere useful — the wait row is gone with the thread.
        const outcome = await prs.recordDelivery({
            deliveryId: 'd-orphan',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 10,
        });
        expect(outcome).toBe('unmatched');
    });

    it('re-parking the same wait node before it wakes refreshes the round in place — no duplicate round', async () => {
        // A loop that routes back into the same wait node twice before either wake is unusual but
        // legal; the second transition must not orphan the first park or double the round count.
        const root = await publishAndTransition('re-park', 11);
        const [before] = await roundRows(root);
        expect(before!.round).toBe(1);

        // Re-enter the boundary directly: a second completed row transitioning into "review" again
        // before any wake, exactly as a graph edge back into it would.
        const { enterRuntimeBoundary } = await import('../src/db/workflow-blocks/runtime.js');
        await sql.begin(async (tx) => {
            await enterRuntimeBoundary(tx, prs, waitingWorkflow.nodes[1]!, {
                orgId: ORG,
                rootJobId: root,
                parentJobId: root,
                repo: null,
                executor: null,
                sessionId: null,
                workflowNode: 'review',
                command: 'react to review, again',
            });
        });

        const rounds = await roundRows(root);
        expect(rounds).toHaveLength(1);
        expect(rounds[0]!.round).toBe(1);

        await prs.recordDelivery({
            deliveryId: 'd-reparked',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 11,
        });
        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim.command).toBe('react to review, again');
    });

    it('waking round 1, then re-entering the wait boundary once it is clear, parks an independent round 2', async () => {
        const root = await publishAndTransition('round-two', 14);
        await prs.recordDelivery({
            deliveryId: 'd-r2-a',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 14,
        });
        const claim1 = (await store.claim(WORKER, 60)) as Claim;
        expect(claim1).not.toBeNull();
        // Settle round 1's continuation — its own "review" node declares no outgoing edge, so this
        // rests the thread, clearing the active-member predicate the next park/wake shares.
        await store.complete(claim1.id, claim1.leaseToken, { status: 'succeeded', exitCode: 0, output: 'handled' });

        const { enterRuntimeBoundary } = await import('../src/db/workflow-blocks/runtime.js');
        await sql.begin(async (tx) => {
            await enterRuntimeBoundary(tx, prs, waitingWorkflow.nodes[1]!, {
                orgId: ORG,
                rootJobId: root,
                parentJobId: claim1.id,
                repo: null,
                executor: null,
                sessionId: null,
                workflowNode: 'review',
                command: 'react to review, round two',
            });
        });

        const rounds = await roundRows(root);
        expect(rounds).toHaveLength(2);
        const round1 = rounds.find((r) => r.round === 1)!;
        const round2 = rounds.find((r) => r.round === 2)!;
        expect(round1.woken_at).not.toBeNull();
        expect(round1.job_id).toBe(claim1.id);
        expect(round2.woken_at).toBeNull();
        expect(round2.job_id).toBeNull();

        await prs.recordDelivery({
            deliveryId: 'd-r2-b',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 14,
        });
        const claim2 = (await store.claim(WORKER, 60)) as Claim;
        expect(claim2).not.toBeNull();
        expect(claim2.command).toBe('react to review, round two');

        const [audit2] = await sql<{ delivery_count: number }[]>`
            select delivery_count from workflow_round
            where org_id = ${ORG} and root_job_id = ${root} and round = 2
        `;
        expect(audit2!.delivery_count).toBe(1);
    });

    it('a crash mid-wake leaves pending and the parked round untouched — the next poll retries it', async () => {
        const root = await publishAndTransition('crash-mid-wake', 15);
        await prs.recordDelivery({
            deliveryId: 'd-crash',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 15,
        });

        await expect(
            sql.begin(async (tx) => {
                await tx`select pg_advisory_xact_lock(hashtextextended(${root}::text, 0))`;
                // The same primitive the real sweep uses to claim the folded count, inside the
                // same per-root lock — then a simulated crash before the transaction can commit.
                await prs.claimReview(root, 'review', tx);
                throw new Error('simulated crash before the wake commits');
            })
        ).rejects.toThrow('simulated crash');

        const wait = await prs.waitOf(root);
        expect(wait?.pending).toBe(1);
        expect(await roundRows(root)).toEqual([{ round: 1, woken_at: null, job_id: null }]);

        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim).not.toBeNull();
    });

    it('a continuation whose lease goes stale is reclaimed as the same row — no new round, no new job', async () => {
        const root = await publishAndTransition('stale-lease', 16);
        await prs.recordDelivery({
            deliveryId: 'd-stale',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 16,
        });
        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim.attempts).toBe(1);

        await sql`update job set lease_expires_at = now() - interval '1 second' where id = ${claim.id}`;

        const reclaimed = (await store.claim('worker-2', 60)) as Claim;
        expect(reclaimed).not.toBeNull();
        expect(reclaimed.id).toBe(claim.id);
        expect(reclaimed.attempts).toBe(2);

        const rounds = await roundRows(root);
        expect(rounds).toHaveLength(1);
        expect(rounds[0]!.job_id).toBe(claim.id);
    });
});

describe.skipIf(!enabled)('durable block waits — user control (issue #328)', () => {
    it('cancel ends the open wait with the user reason and records the acting caller', async () => {
        const root = await publishAndTransition('control-cancel-basic', 19, ALICE.id);

        expect(await store.cancelWait(root, ALICE.id)).toEqual({ result: 'ok' });

        const wait = await prs.waitOf(root);
        expect(wait?.cancelledAt).not.toBeNull();
        expect(wait?.terminalReason).toBe('cancelled by user');
        const [row] = await sql<{ cancelled_by: string | null }[]>`
            select cancelled_by from workflow_wait where org_id = ${ORG} and root_job_id = ${root}
        `;
        expect(row!.cancelled_by).toBe(ALICE.id);
    });

    it('cancel addresses the thread through any member id — the wait belongs to the root', async () => {
        const root = await publishAndTransition('control-cancel-member', 20, ALICE.id);
        await prs.recordDelivery({
            deliveryId: 'd-cancel-member',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 20,
        });
        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim).not.toBeNull();

        expect(await store.cancelWait(claim.id, ALICE.id)).toEqual({ result: 'ok' });
        expect((await prs.waitOf(root))?.cancelledAt).not.toBeNull();
    });

    it('cancel answers no_wait for a thread that never waited and one whose wait already ended', async () => {
        // An entry completion with no publication rests the thread — nothing parked, no wait row.
        // Authored by ALICE, so ALICE gets past the scoping check and reaches the no_wait answer.
        const never = await queueWaitingThread('control-cancel-never', ALICE.id);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'no pr' });
        expect(await prs.waitOf(never)).toBeNull();
        expect(await store.cancelWait(never, ALICE.id)).toBe('no_wait');

        const root = await publishAndTransition('control-cancel-terminal', 22, ALICE.id);
        expect(await store.cancelWait(root, ALICE.id)).toEqual({ result: 'ok' });
        // A replay after the first cancel finds nothing open — honest 409 material, not a rewrite.
        expect(await store.cancelWait(root, ALICE.id)).toBe('no_wait');
    });

    it('cancel is author-scoped: another member and the anonymous caller are refused', async () => {
        const root = await publishAndTransition('control-cancel-scoped', 23, ALICE.id);
        expect(await store.cancelWait(root, BOB.id)).toBe('forbidden');
        expect(await store.cancelWait(root, null)).toBe('forbidden');
        // An un-authored thread (queued before accounts, or AUTH_MODE=none) accepts the
        // anonymous caller — the null-safe pairing the follow-up route uses.
        const anonymous = await publishAndTransition('control-cancel-anonymous', 24, null);
        expect(await store.cancelWait(anonymous, null)).toEqual({ result: 'ok' });
    });

    it('cancel answers missing for an id that does not exist', async () => {
        expect(await store.cancelWait(randomUUID(), ALICE.id)).toBe('missing');
    });

    it('a cancelled wait never wakes — a later delivery folds into nothing', async () => {
        const root = await publishAndTransition('control-cancel-no-wake', 25, ALICE.id);
        expect(await store.cancelWait(root, ALICE.id)).toEqual({ result: 'ok' });

        const outcome = await prs.recordDelivery({
            deliveryId: 'd-after-user-cancel',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 25,
        });
        expect(outcome).toBe('unmatched');
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('a cancel landing between the wake and the claim settles the continuation stopped — the fence', async () => {
        const root = await publishAndTransition('control-cancel-fence', 26, ALICE.id);
        await prs.recordDelivery({
            deliveryId: 'd-cancel-fence',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 26,
        });
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });
        const [round] = await roundRows(root);
        expect(round!.job_id).not.toBeNull();

        expect(await store.cancelWait(root, ALICE.id)).toEqual({ result: 'ok' });

        expect(await store.claim(WORKER, 60)).toBeNull();
        const [job] = await sql<{ status: string }[]>`
            select status from job where org_id = ${ORG} and id = ${round!.job_id}
        `;
        expect(job!.status).toBe('stopped');
    });

    it('poke force-wakes the parked round with its folded deliveries — exactly one continuation', async () => {
        const root = await publishAndTransition('control-poke-folded', 27, ALICE.id);
        await prs.recordDelivery({
            deliveryId: 'd-poke-a',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 27,
        });
        await prs.recordDelivery({
            deliveryId: 'd-poke-b',
            event: 'issue_comment',
            action: 'created',
            repo: REPO,
            prNumber: 27,
        });

        expect(await store.pokeWait(root, ALICE.id)).toEqual({ result: 'ok', woken: true });

        const woken = await sql<{ id: string }[]>`
            select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'review'
        `;
        expect(woken).toHaveLength(1);
        const [audit] = await sql<
            { woken_at: Date | null; job_id: string | null; delivery_count: number; last_delivery_id: string }[]
        >`
            select woken_at, job_id, delivery_count, last_delivery_id from workflow_round
            where org_id = ${ORG} and root_job_id = ${root} and round = 1
        `;
        expect(audit!.woken_at).not.toBeNull();
        expect(audit!.job_id).toBe(woken[0]!.id);
        expect(audit!.delivery_count).toBe(2);
        expect(audit!.last_delivery_id).toBe('d-poke-b');
        // The claim reset the wait's pending — the deliveries became the continuation's.
        expect((await prs.waitOf(root))?.pending).toBe(0);

        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim).not.toBeNull();
        expect(claim.id).toBe(woken[0]!.id);
        expect(claim.rootJobId).toBe(root);
    });

    it('poke wakes even with nothing folded — the missed-webhook case (delivery_count 0 is an honest zero)', async () => {
        const root = await publishAndTransition('control-poke-nothing', 28, ALICE.id);

        expect(await store.pokeWait(root, ALICE.id)).toEqual({ result: 'ok', woken: true });

        const woken = await sql<{ id: string }[]>`
            select id from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'review'
        `;
        expect(woken).toHaveLength(1);
        const [audit] = await sql<{ delivery_count: number; last_delivery_id: string | null }[]>`
            select delivery_count, last_delivery_id from workflow_round
            where org_id = ${ORG} and root_job_id = ${root} and round = 1
        `;
        expect(audit!.delivery_count).toBe(0);
        expect(audit!.last_delivery_id).toBeNull();
    });

    it('poke answers no_wait for a thread with no open wait', async () => {
        const root = await publishAndTransition('control-poke-terminal', 29, ALICE.id);
        expect(await store.cancelWait(root, ALICE.id)).toEqual({ result: 'ok' });
        expect(await store.pokeWait(root, ALICE.id)).toBe('no_wait');
        expect(await store.pokeWait(randomUUID(), ALICE.id)).toBe('missing');
    });

    it('poke with nothing parked answers woken: false and inserts nothing — replay-safe', async () => {
        const root = await publishAndTransition('control-poke-replay', 30, ALICE.id);
        await prs.recordDelivery({
            deliveryId: 'd-poke-first',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: 30,
        });
        await sweepRuntimeWakes({ sql, orgId: ORG, prs });

        // The same thread, addressed through the woken continuation's id.
        const [round] = await roundRows(root);
        expect(round!.job_id).not.toBeNull();
        expect(await store.pokeWait(round!.job_id!, ALICE.id)).toEqual({ result: 'ok', woken: false });

        const woken = await sql<{ count: string }[]>`
            select count(*) from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'review'
        `;
        expect(Number(woken[0]!.count)).toBe(1);
    });

    it('poke skips a thread with an active member — one-thread-one-claim holds', async () => {
        const root = await publishAndTransition('control-poke-active', 31, ALICE.id);
        // The follow-up is author-scoped too: it resumes the thread's session in the author's
        // tree, so ALICE (the author) queues it.
        const followUp = await store.createFollowUp(root, 'one more thing', ALICE.id);
        expect(typeof followUp === 'object' && 'id' in followUp).toBe(true);

        expect(await store.pokeWait(root, ALICE.id)).toEqual({ result: 'ok', woken: false });
        expect((await roundRows(root))[0]!.woken_at).toBeNull();
    });

    it('poke skips a thread the user already marked done — the other active-member arm', async () => {
        const root = await publishAndTransition('control-poke-done', 34, ALICE.id);
        expect(await store.markDone(root, ALICE.id)).toMatchObject({ status: 'succeeded' });

        expect(await store.pokeWait(root, ALICE.id)).toEqual({ result: 'ok', woken: false });
        expect((await roundRows(root))[0]!.woken_at).toBeNull();
    });

    it('poke is author-scoped like cancel', async () => {
        const root = await publishAndTransition('control-poke-scoped', 32, ALICE.id);
        expect(await store.pokeWait(root, BOB.id)).toBe('forbidden');
        expect(await store.pokeWait(root, null)).toBe('forbidden');
    });

    it('two concurrent pokes wake exactly one round', async () => {
        const root = await publishAndTransition('control-poke-race', 33, ALICE.id);

        const results = await Promise.all([
            store.pokeWait(root, ALICE.id),
            store.pokeWait(root, ALICE.id),
            store.pokeWait(root, ALICE.id),
        ]);
        const wokenTrue = results.filter((r) => typeof r === 'object' && r.result === 'ok' && r.woken);
        expect(wokenTrue).toHaveLength(1);

        const woken = await sql<{ count: string }[]>`
            select count(*) from job where org_id = ${ORG} and root_job_id = ${root} and workflow_node = 'review'
        `;
        expect(Number(woken[0]!.count)).toBe(1);
    });
});
