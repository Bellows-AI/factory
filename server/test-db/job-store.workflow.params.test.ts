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
});
