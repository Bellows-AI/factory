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
});
