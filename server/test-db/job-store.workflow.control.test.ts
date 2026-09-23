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

describe.skipIf(!enabled)('workflow execution: dead rows and stop', () => {
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
