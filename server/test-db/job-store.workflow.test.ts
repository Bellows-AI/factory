import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore, type Claim, type JobStore } from '../src/db/job-store.js';
import { createWorkflowStore } from '../src/db/workflow-store.js';
import type { ParamValues, WorkflowDefinition } from '../src/db/workflow-schema.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
let workflows: ReturnType<typeof createWorkflowStore>;

const ORG = 'test-org';
const WORKER = 'worker-1';

const db = useTestDb({ orgs: [ORG], max: 8 });

const BLOCKERS = 'VERDICT: BLOCKERS';
const CLEAN = 'VERDICT: CLEAN';

/** A four-node graph with one review/fix loop, one publish node, and the base session policies. */
const walk: WorkflowDefinition = {
    entry: 'implement',
    params: [],
    nodes: [
        { name: 'implement', kind: 'agent', session: 'resume', prompt: 'implement' },
        { name: 'review', kind: 'agent', session: 'fresh', prompt: 'review the work' },
        { name: 'fix', kind: 'agent', session: 'resume', prompt: 'fix: {{review.output}}' },
        { name: 'publish', kind: 'agent', session: 'resume', publish: true, prompt: 'preflight' },
    ],
    edges: [
        { from: 'implement', to: 'review', when: 'succeeded' },
        { from: 'review', to: 'fix', when: { marker: BLOCKERS } },
        { from: 'review', to: 'publish', when: { marker: CLEAN } },
        { from: 'fix', to: 'review', when: 'succeeded', max: 3 },
    ],
};

const INTERP_CAP: WorkflowDefinition = {
    entry: 'a',
    params: [],
    nodes: [
        ...['a', 'b', 'c', 'd', 'e'].map((name) => ({
            name,
            kind: 'agent' as const,
            session: 'resume' as const,
            prompt: `run ${name}`,
        })),
        {
            name: 'f',
            kind: 'agent',
            session: 'resume',
            prompt: '{{a.output}} {{b.output}} {{c.output}} {{d.output}} {{e.output}}',
        },
    ],
    edges: [
        { from: 'a', to: 'b', when: 'succeeded' },
        { from: 'b', to: 'c', when: 'succeeded' },
        { from: 'c', to: 'd', when: 'succeeded' },
        { from: 'd', to: 'e', when: 'succeeded' },
        { from: 'e', to: 'f', when: 'succeeded' },
    ],
};

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    workflows = createWorkflowStore({ sql, orgId: ORG });
});

/** Seeds the named definition, queues a task on it, and returns the root id. */
async function queueWorkflowJob(
    definition: WorkflowDefinition,
    name = 'walk',
    params: ParamValues = {}
): Promise<string> {
    const created = await workflows.create({ name, scope: { kind: 'org' }, definition, createdBy: null });
    expect(created).toHaveProperty('id');
    const job = await store.create('fix the thing', null, {
        repo: null,
        executor: null,
        workflow: {
            id: (created as { id: string }).id,
            name,
            node: definition.entry,
            snapshot: definition,
            params,
        },
    });
    return job.id;
}

/** Claims the board's oldest claimable row and reports it, the way a driver would. */
async function runNext(status: 'succeeded' | 'failed', output: string | null): Promise<Claim> {
    const claim = await store.claim(WORKER, 60);
    expect(claim).not.toBeNull();
    const held = claim as Claim;
    await store.complete(held.id, held.leaseToken, {
        status,
        exitCode: status === 'succeeded' ? 0 : 1,
        output,
    });
    return held;
}

const thread = async (rootId: string) => (await store.thread(rootId))!;
const nodesOf = (rootId: string) => thread(rootId).then((rows) => rows.map((row) => row.workflowNode));

describe.skipIf(!enabled)('workflow execution', () => {
    it('lands the workflow triple on the root row at create, and nothing on a workflow-less one', async () => {
        const id = await queueWorkflowJob(walk);
        const [row] = await sql<{ workflow_id: string | null; workflow_node: string | null; snapshot: unknown }[]>`
            select workflow_id, workflow_node, workflow_snapshot as snapshot from job where id = ${id}
        `;
        expect(row!.workflow_node).toBe('implement');
        expect(row!.workflow_id).not.toBeNull();
        expect(row!.snapshot).toEqual(walk);

        const plain = await store.create('plain', null, { repo: null, executor: null });
        const [bare] = await sql<{ workflow_id: string | null; workflow_node: string | null; snapshot: unknown }[]>`
            select workflow_id, workflow_node, workflow_snapshot as snapshot from job where id = ${plain.id}
        `;
        expect(bare!.workflow_id).toBeNull();
        expect(bare!.workflow_node).toBeNull();
        expect(bare!.snapshot).toBeNull();
    });

    it('inserts the next row in the verdict transaction: review follows implement', async () => {
        const root = await queueWorkflowJob(walk);
        const claim = (await store.claim(WORKER, 60))!;
        expect(await nodesOf(root)).toEqual(['implement']);

        await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        // The same transaction landed the verdict and the successor: both visible the moment
        // complete returns, and no read ever saw one without the other.
        expect(await nodesOf(root)).toEqual(['implement', 'review']);
        expect((await thread(root)).map((row) => row.status)).toEqual(['succeeded', 'queued']);
    });

    it('walks review → fix on the BLOCKERS marker, then review → publish on CLEAN', async () => {
        const root = await queueWorkflowJob(walk);
        await runNext('succeeded', 'implemented'); // implement
        await runNext('succeeded', `findings\n${BLOCKERS}`); // review round one
        expect(await nodesOf(root)).toEqual(['implement', 'review', 'fix']);

        await runNext('succeeded', 'fixed'); // fix
        await runNext('succeeded', `fine\n${CLEAN}`); // review round two
        expect(await nodesOf(root)).toEqual(['implement', 'review', 'fix', 'review', 'publish']);
    });

    it('rests when no rule matches — marker absence never silently continues', async () => {
        const root = await queueWorkflowJob(walk);
        await runNext('succeeded', 'implemented');
        await runNext('succeeded', 'review said nothing machine-readable');
        expect(await nodesOf(root)).toEqual(['implement', 'review']);
    });

    it('never inserts the fourth review round — the bound rests the loop', async () => {
        const root = await queueWorkflowJob(walk);
        await runNext('succeeded', 'implemented'); // implement → review 1
        for (const round of [1, 2]) {
            await runNext('succeeded', `blockers ${round}\n${BLOCKERS}`); // review N → fix N
            await runNext('succeeded', `fixed ${round}`); // fix N → review N+1
        }
        await runNext('succeeded', `blockers 3\n${BLOCKERS}`); // review 3 → fix 3
        // fix 3 completes: the fix→review edge (max 3) matches a FOURTH time — three review rows
        // exist — so no fourth review row is inserted and the thread rests with its verdicts.
        await runNext('succeeded', 'fixed 3');
        expect(await nodesOf(root)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review', 'fix']);
        const rows = await thread(root);
        expect(rows[rows.length - 1]!.status).toBe('succeeded');
    });

    it('carries the primary session across a fresh-eyes branch', async () => {
        const root = await queueWorkflowJob(walk);
        const first = (await store.claim(WORKER, 60))!;
        await store.session(first.id, first.leaseToken, 'sess-implement', null);
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        // The review row is `fresh`: no session on the claim; its run mints its own.
        const review = (await store.claim(WORKER, 60))!;
        expect(review.resumeSessionId).toBeNull();
        await store.session(review.id, review.leaseToken, 'sess-review-side-branch', null);
        await store.complete(review.id, review.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `blockers\n${BLOCKERS}`,
        });

        // The fix row is `resume`: it carries the IMPLEMENT session, not the review's branch.
        const fix = (await thread(root)).find((row) => row.workflowNode === 'fix');
        expect(fix?.sessionId).toBe('sess-implement');
    });

    it("copies the primary session — not the last row's — onto a user follow-up", async () => {
        const root = await queueWorkflowJob(walk);
        const first = (await store.claim(WORKER, 60))!;
        await store.session(first.id, first.leaseToken, 'sess-primary', null);
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        // The review mints a side-branch session, then says nothing machine-readable: the thread
        // RESTS at the review, whose row is the thread's newest — and carries the branch session.
        const review = (await store.claim(WORKER, 60))!;
        await store.session(review.id, review.leaseToken, 'sess-fresh-branch', null);
        await store.complete(review.id, review.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'no marker',
        });

        const followUp = await store.createFollowUp(review.id, 'adjust', null);
        expect(followUp).toHaveProperty('id');
        const child = await store.get((followUp as { id: string }).id);
        expect(child?.sessionId).toBe('sess-primary');
        expect(child?.workflowNode).toBeNull();
    });

    it('publish flag: true only on the publish node, false on every other, absent without a workflow', async () => {
        await queueWorkflowJob(walk);
        const implementClaim = (await store.claim(WORKER, 60))!;
        expect(implementClaim.publish).toBe(false);
        await store.complete(implementClaim.id, implementClaim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'done',
        });
        const reviewClaim = (await store.claim(WORKER, 60))!;
        expect(reviewClaim.publish).toBe(false);
        await store.complete(reviewClaim.id, reviewClaim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `fine\n${CLEAN}`,
        });
        const publishClaim = (await store.claim(WORKER, 60))!;
        expect(publishClaim.publish).toBe(true);

        // A workflow-less task carries NO flag at all: byte-identical to the pre-027 claim.
        await store.create('plain', null, { repo: null, executor: null });
        const plainClaim = (await store.claim(WORKER, 60))!;
        expect('publish' in plainClaim).toBe(false);
    });

    it('rests the insert when the interpolated command exceeds the cap, with no successor', async () => {
        const capped: WorkflowDefinition = {
            ...INTERP_CAP,
            nodes: INTERP_CAP.nodes.map((node) => (node.name === 'f' ? { ...node, publish: true } : node)),
        };
        const root = await queueWorkflowJob(capped, 'cap');
        const tail = 'x'.repeat(4096);
        for (let i = 0; i < 5; i++) {
            await runNext('succeeded', tail); // a..e; the fifth completion's edge into f overflows
        }
        expect(await nodesOf(root)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('a dead review row still counts as a round against the bound', async () => {
        // The loop bounded at ONE review round: a single review row — dead included — exhausts it.
        const boundedOnce: WorkflowDefinition = {
            ...walk,
            edges: walk.edges.map((edge) => (edge.to === 'review' ? { ...edge, max: 1 } : edge)),
        };
        const root = await queueWorkflowJob(boundedOnce, 'bound-once');
        const first = (await store.claim(WORKER, 60))!;
        await store.session(first.id, first.leaseToken, 'sess-implement', null);
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

        // Review 1 runs, reports its session, then burns its attempts and dies.
        const review1 = (await store.claim(WORKER, 60))!;
        await store.session(review1.id, review1.leaseToken, 'sess-review', null);
        await sql`update job set status = 'dead', finished_at = now(), lease_token = null where id = ${review1.id}`;

        // The human follows up the dead review row; the completion re-fires the halted node's
        // (review's) edges: BLOCKERS matches review→fix and a fix row is inserted.
        const followUp = await store.createFollowUp(review1.id, 'run it by hand', null);
        expect(followUp).toHaveProperty('id');
        const child = (await store.claim(WORKER, 60))!;
        expect(child.id).toBe((followUp as { id: string }).id);
        await store.complete(child.id, child.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `blockers\n${BLOCKERS}`,
        });
        // The off-graph follow-up sits between the dead review and the fix it triggered.
        expect(await nodesOf(root)).toEqual(['implement', 'review', null, 'fix']);

        // The fix completes: the fix→review edge matches, but the DEAD review row already counts
        // as review round one against a bound of one — no second review row is inserted. Were
        // dead rows excluded from the count, the loop would walk right past its limit.
        await runNext('succeeded', 'fixed');
        expect(await nodesOf(root)).toEqual(['implement', 'review', null, 'fix']);
    });

    it("a user follow-up re-fires the halted node's edges so the graph continues", async () => {
        const root = await queueWorkflowJob(walk);
        const first = (await store.claim(WORKER, 60))!;
        await store.session(first.id, first.leaseToken, 'sess-implement', null);
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        // The review says nothing machine-readable: the thread rests AT the review.
        const review = (await store.claim(WORKER, 60))!;
        await store.session(review.id, review.leaseToken, 'sess-review', null);
        await store.complete(review.id, review.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'no marker, the human steps in',
        });
        expect(await nodesOf(root)).toEqual(['implement', 'review']);

        // The human's follow-up completes; the halted node's (review's) outgoing edges are
        // evaluated from THIS completion, and the BLOCKERS marker continues the graph.
        const followUp = await store.createFollowUp(review.id, 'i also checked, still blockers', null);
        const child = (await store.claim(WORKER, 60))!;
        expect(child.id).toBe((followUp as { id: string }).id);
        await store.complete(child.id, child.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `confirmed blockers\n${BLOCKERS}`,
        });
        // The off-graph follow-up sits between the halted review and the fix it triggered.
        expect(await nodesOf(root)).toEqual(['implement', 'review', null, 'fix']);
    });

    it('stop fires no edge: a queued row settles stopped, a running one on the suspend', async () => {
        const root = await queueWorkflowJob(walk);
        await runNext('succeeded', 'implemented'); // implement → review queued

        // A QUEUED row never started: /stop settles it here, no successor ever inserted.
        const review = (await thread(root)).find((row) => row.workflowNode === 'review')!;
        const stopped = await store.stop(review.id, null);
        expect(stopped).toMatchObject({ result: 'stopped' });
        expect(await nodesOf(root)).toEqual(['implement', 'review']);
        expect((await thread(root))[1]!.status).toBe('stopped');
    });

    it('a running stop is a request the settle lands: still no edge, thread rests', async () => {
        const root = await queueWorkflowJob(walk);
        await runNext('succeeded', 'implemented');
        const review = (await store.claim(WORKER, 60))!;
        const asked = await store.stop(review.id, null);
        expect(asked).toMatchObject({ result: 'requested' });
        const parked = await store.suspend(review.id, review.leaseToken);
        expect(parked).toMatchObject({ result: 'ok', status: 'stopped' });
        expect(await nodesOf(root)).toEqual(['implement', 'review']);
    });

    it('a workflow-less complete inserts nothing, threadDone answering exactly as before', async () => {
        const job = await store.create('plain', null, { repo: null, executor: null });
        const claim = (await store.claim(WORKER, 60))!;
        const verdict = await store.complete(claim.id, claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'done',
        });
        // No member carries the user's done_at, so the thread is not DONE — the pre-027 answer.
        expect(verdict).toMatchObject({ result: 'ok', threadDone: false });
        expect(await thread(job.id)).toHaveLength(1);
    });
});

describe.skipIf(!enabled)('workflow parameters', () => {
    /** A two-node graph whose successor prompt names the declared param and the root command. */
    const parammed: WorkflowDefinition = {
        entry: 'fetch',
        params: [{ name: 'issue', pattern: '#\\d+' }],
        nodes: [
            { name: 'fetch', kind: 'agent', session: 'resume', prompt: 'fetch {{param.issue}}' },
            {
                name: 'work',
                kind: 'agent',
                session: 'resume',
                prompt: 'issue {{param.issue}}; asked: {{command}}',
                publish: true,
            },
        ],
        edges: [{ from: 'fetch', to: 'work', when: 'succeeded' }],
    };

    it('freezes the given param values on the root row beside the snapshot, and null without a workflow', async () => {
        const root = await queueWorkflowJob(parammed, 'parammed', { issue: '#42' });
        const [row] = await sql<{ params: unknown }[]>`
            select workflow_params as params from job where id = ${root}
        `;
        expect(row!.params).toEqual({ issue: '#42' });

        const plain = await store.create('plain', null, { repo: null, executor: null });
        const [bare] = await sql<{ params: unknown }[]>`
            select workflow_params as params from job where id = ${plain.id}
        `;
        expect(bare!.params).toBeNull();
    });

    it("fills {{param.*}} in a successor prompt from the root's frozen values, {{command}} from the root command", async () => {
        const root = await queueWorkflowJob(parammed, 'parammed-walk', { issue: '#42' });
        await runNext('succeeded', 'the issue body'); // fetch → work
        const rows = await thread(root);
        expect(rows.map((row) => row.workflowNode)).toEqual(['fetch', 'work']);
        // `{{command}}` is the ROOT row's command — for a workflow thread launched through the
        // route, the interpolated entry prompt the member's words rode in on.
        expect(rows[1]!.command).toBe('issue #42; asked: fix the thing');
    });

    describe('the frozen workflow name', () => {
        it('stamps the resolved workflow name on the root create, and null on a workflow-less one', async () => {
            const root = await queueWorkflowJob(walk);
            const [row] = await sql<{ workflow_name: string | null }[]>`
                select workflow_name from job where id = ${root}
            `;
            expect(row!.workflow_name).toBe('walk');

            const plain = await store.create('plain', null, { repo: null, executor: null });
            const [bare] = await sql<{ workflow_name: string | null }[]>`
                select workflow_name from job where id = ${plain.id}
            `;
            expect(bare!.workflow_name).toBeNull();
        });

        it('the graph successor inherits the root name', async () => {
            const root = await queueWorkflowJob(walk);
            await runNext('succeeded', 'implemented'); // implement → review
            const names = await thread(root).then((rows) => rows.map((row) => row.workflowName));
            expect(names).toEqual(['walk', 'walk']);
        });

        it('a user follow-up inherits the thread name', async () => {
            const root = await queueWorkflowJob(walk);
            const first = (await store.claim(WORKER, 60))!;
            await store.session(first.id, first.leaseToken, 'sess-primary', null);
            await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
            const review = (await store.claim(WORKER, 60))!;
            await store.session(review.id, review.leaseToken, 'sess-fresh-branch', null);
            await store.complete(review.id, review.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: 'no marker',
            });

            const followUp = await store.createFollowUp(review.id, 'adjust', null);
            expect(followUp).toHaveProperty('id');
            const child = await store.get((followUp as { id: string }).id);
            expect(child?.workflowName).toBe('walk');
            expect(child?.workflowNode).toBeNull();
        });

        it('a follow-up of a follow-up inherits it too — the parent row always carries the name', async () => {
            const root = await queueWorkflowJob(walk);
            const first = (await store.claim(WORKER, 60))!;
            await store.session(first.id, first.leaseToken, 'sess-primary', null);
            await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
            const review = (await store.claim(WORKER, 60))!;
            await store.session(review.id, review.leaseToken, 'sess-branch', null);
            await store.complete(review.id, review.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: 'no marker',
            });

            const one = await store.createFollowUp(review.id, 'adjust', null);
            const oneId = (one as { id: string }).id;
            // The first follow-up must FINISH before a second can queue on it.
            const childClaim = (await store.claim(WORKER, 60))!;
            expect(childClaim.id).toBe(oneId);
            await store.complete(childClaim.id, childClaim.leaseToken, {
                status: 'succeeded',
                exitCode: 0,
                output: 'done again',
            });
            const two = await store.createFollowUp(oneId, 'adjust again', null);
            expect(two).toHaveProperty('id');
            const grandchild = await store.get((two as { id: string }).id);
            expect(grandchild?.workflowName).toBe('walk');
        });

        it('a follow-up on a workflow-less thread keeps null', async () => {
            const job = await store.create('plain', null, { repo: null, executor: null });
            const claim = (await store.claim(WORKER, 60))!;
            await store.session(claim.id, claim.leaseToken, 'sess-plain', null);
            await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
            const followUp = await store.createFollowUp(job.id, 'adjust', null);
            expect(followUp).toHaveProperty('id');
            expect((await store.get((followUp as { id: string }).id))?.workflowName).toBeNull();
        });

        it('a root whose name cannot be recovered inserts null successors — the honest value', async () => {
            // The pre-033 shape: a snapshot on the root, no name (the definition was already gone
            // when 033 backfilled). The successor inherits what the root carries — null, never a
            // guess.
            const root = await queueWorkflowJob(walk);
            await sql`update job set workflow_name = null where id = ${root}`;
            await runNext('succeeded', 'implemented'); // implement → review
            expect(await thread(root).then((rows) => rows.map((r) => r.workflowName))).toEqual([null, null]);
        });

        it('renaming the workflow does not rewrite the thread history', async () => {
            const root = await queueWorkflowJob(walk);
            const [row] = await sql<{ workflow_id: string }[]>`select workflow_id from job where id = ${root}`;
            await sql`update workflow set name = 'renamed' where id = ${row!.workflow_id}`;

            const names = await thread(root).then((rows) => rows.map((r) => r.workflowName));
            expect(names).toEqual(['walk']);
        });

        it('deleting the workflow leaves the name on the thread', async () => {
            const root = await queueWorkflowJob(walk);
            const [row] = await sql<{ workflow_id: string }[]>`select workflow_id from job where id = ${root}`;
            expect(await workflows.remove(row!.workflow_id)).toBe(true);

            expect(await thread(root).then((rows) => rows.map((r) => r.workflowName))).toEqual(['walk']);
            expect((await store.get(root))?.workflowName).toBe('walk');
        });

        it('a workflow-less thread stays null end to end', async () => {
            const job = await store.create('plain', null, { repo: null, executor: null });
            const claim = (await store.claim(WORKER, 60))!;
            await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
            const rows = await thread(job.id);
            expect(rows.map((row) => row.workflowName)).toEqual([null]);
            expect((await store.get(job.id))?.workflowName).toBeNull();
        });

        it('the name constraint landed NOT VALID in 033 and was validated by 034', async () => {
            // The split deploy: 033 adds the check without scanning the table under a
            // write-blocking lock, 034 validates the backfilled rows after. If 034 is ever lost,
            // the constraint still guards every new row — but convalidated would read false here.
            const [row] = await sql<{ convalidated: boolean }[]>`
                select convalidated from pg_constraint where conname = 'job_workflow_name_ck'
            `;
            expect(row!.convalidated).toBe(true);
            // And it enforces new writes either way.
            await expect(
                sql`insert into job (org_id, id, root_job_id, command, workflow_name)
                    values (${ORG}, gen_random_uuid(), gen_random_uuid(), 'x', ${'w'.repeat(101)})`
            ).rejects.toThrow(/job_workflow_name_ck/);
        });
    });
});
