import { OBJECTIVE_MODE } from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, GateReport, JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';

/**
 * Issue 543: a task created without a workflow is OBJECTIVE mode — an ordinary claimable job with
 * no workflow snapshot, node, successor or wait. The mode is stored on the root row and inherited
 * by every follow-up and retry.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = 'test-org';
const WORKER = 'worker-1';
const db = useTestDb({ orgs: [ORG], max: 8 });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

const failedGate: GateReport[] = [{ name: 'test', status: 'failed', exitCode: 1, output: 'red' }];

async function queueObjective(command = 'scaffold the project'): Promise<string> {
    const created = await store.create(command, null, { repo: null, executor: null });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
}

const claim = async (): Promise<Claim> => {
    const claimed = (await store.claim(WORKER, 60)) as Claim | null;
    expect(claimed).not.toBeNull();
    return claimed!;
};

const modesOf = async (): Promise<{ mode: string; workflow_node: string | null }[]> =>
    sql`select mode, workflow_node from job order by created_at, id`;

describe.skipIf(!enabled)('objective mode — database', () => {
    it('creates a plain claimable row: mode objective, no workflow columns', async () => {
        const id = await queueObjective();
        const [row] = await sql<
            {
                mode: string;
                workflow_id: string | null;
                workflow_name: string | null;
                workflow_node: string | null;
                workflow_snapshot: unknown;
                workflow_params: unknown;
            }[]
        >`select mode, workflow_id, workflow_name, workflow_node, workflow_snapshot, workflow_params
          from job where id = ${id}`;
        expect(row).toEqual({
            mode: OBJECTIVE_MODE,
            workflow_id: null,
            workflow_name: null,
            workflow_node: null,
            workflow_snapshot: null,
            workflow_params: null,
        });
        expect((await store.get(id))?.mode).toBe(OBJECTIVE_MODE);
    });

    it('claims with no publish key and an objective master prompt', async () => {
        await queueObjective();
        const claimed = await claim();
        expect('publish' in claimed && claimed.publish !== undefined).toBe(false);
        expect(claimed.masterPrompt).toContain('- Mode: objective');
    });

    it.each([
        ['succeeded', { status: 'succeeded' as const, exitCode: 0, output: 'done' }],
        [
            'failed',
            { status: 'failed' as const, exitCode: 1, output: 'red', failureKind: 'gate' as const, treeChanged: true },
        ],
        ['failed', { status: 'failed' as const, exitCode: 1, output: 'stuck', failureKind: 'blocked' as const }],
    ])('a %s verdict leaves a one-row thread — no successor, no wait', async (status, verdict) => {
        const root = await queueObjective();
        const claimed = await claim();
        if (verdict.status === 'failed' && verdict.failureKind === 'gate') {
            await store.gates(claimed.id, claimed.leaseToken, failedGate);
        }
        await store.complete(claimed.id, claimed.leaseToken, verdict);
        const rows = (await store.thread(root))!;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe(status);
        expect(rows[0]!.mode).toBe(OBJECTIVE_MODE);
    });

    it('marking done stamps doneAt and keeps the run status', async () => {
        const root = await queueObjective();
        const claimed = await claim();
        await store.complete(claimed.id, claimed.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const done = await store.markDone(root, null);
        expect(done).toMatchObject({ status: 'succeeded' });
        const [head] = (await store.thread(root))!;
        expect(head!.status).toBe('succeeded');
        expect(head!.doneAt).not.toBeNull();
    });

    it('a follow-up inherits the objective mode', async () => {
        const root = await queueObjective();
        const claimed = await claim();
        await store.complete(claimed.id, claimed.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const followUp = await store.createFollowUp(root, 'now add tests', null);
        if (typeof followUp === 'string') throw new Error(`follow-up refused: ${followUp}`);
        expect(await modesOf()).toEqual([
            { mode: OBJECTIVE_MODE, workflow_node: null },
            { mode: OBJECTIVE_MODE, workflow_node: null },
        ]);
    });

    it('a retry inherits the objective mode', async () => {
        const root = await queueObjective();
        const claimed = await claim();
        await store.complete(claimed.id, claimed.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: 'boom',
            failureKind: 'runner_error',
        });
        const retry = await store.createRetry(root, null);
        if (typeof retry === 'string') throw new Error(`retry refused: ${retry}`);
        expect(await modesOf()).toEqual([
            { mode: OBJECTIVE_MODE, workflow_node: null },
            { mode: OBJECTIVE_MODE, workflow_node: null },
        ]);
    });

    it('refuses an objective row carrying a workflow node (job_mode_node_ck)', async () => {
        await expect(
            sql`insert into job (org_id, id, root_job_id, command, mode, workflow_node)
                select ${ORG}, x, x, 'x', 'objective', 'task' from (select gen_random_uuid() as x) s`
        ).rejects.toMatchObject({ constraint_name: 'job_mode_node_ck' });
    });

    it('refuses an unknown mode (job_mode_ck)', async () => {
        await expect(
            sql`insert into job (org_id, id, root_job_id, command, mode)
                select ${ORG}, x, x, 'x', 'freeform' from (select gen_random_uuid() as x) s`
        ).rejects.toMatchObject({ constraint_name: 'job_mode_ck' });
    });
});
