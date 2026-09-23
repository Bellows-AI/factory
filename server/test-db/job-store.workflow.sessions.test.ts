import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim } from '../src/db/job-store-types.js';
import type { JobStore } from '../src/db/job-store-types.js';
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

/** Five plain nodes chained a→b→c→d→e, all feeding a sixth whose prompt interpolates every output. */
const PRECEDING_NODE_COUNT = 5;
/** Long enough that five interpolated copies of it blow the successor prompt's length cap. */
const OVERFLOWING_TAIL_LENGTH = 4096;
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

describe.skipIf(!enabled)('workflow execution: sessions and publish', () => {
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
        const tail = 'x'.repeat(OVERFLOWING_TAIL_LENGTH);
        for (let i = 0; i < PRECEDING_NODE_COUNT; i++) {
            await runNext('succeeded', tail); // a..e; the fifth completion's edge into f overflows
        }
        expect(await nodesOf(root)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
});
