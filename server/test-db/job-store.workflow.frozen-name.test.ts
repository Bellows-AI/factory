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
/** One character over the constraint's max length, so the insert exercises the check, not luck. */
const OVER_MAX_NAME_LENGTH = 101;

const db = useTestDb({ orgs: [ORG], max: 8 });

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
        { from: 'review', to: 'fix', when: { marker: 'VERDICT: BLOCKERS' } },
        { from: 'review', to: 'publish', when: { marker: 'VERDICT: CLEAN' } },
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

describe.skipIf(!enabled)('the frozen workflow name', () => {
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
                values (${ORG}, gen_random_uuid(), gen_random_uuid(), 'x', ${'w'.repeat(OVER_MAX_NAME_LENGTH)})`
        ).rejects.toThrow(/job_workflow_name_ck/);
    });
});
