import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, GateReport, JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import {
    compileDefaultWorkflow,
    DEFAULT_ENTRY_NODE,
    DEFAULT_GATE_FIX_NODE,
    DEFAULT_WORKFLOW_NAME,
} from '../src/db/default-workflow.js';
import { useTestDb } from './harness.js';

/** Gremlin (board) repros against a real database: each `it` asserts the CORRECT behaviour. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = 'test-org';
const WORKER = 'worker-1';
const db = useTestDb({ orgs: [ORG], max: 8 });

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG, prs: createPrLifecycleStore({ sql, orgId: ORG }) });
});

const NEITHER = { reviewReconciliation: false, mergeConflictAutofix: false };
const failedGate = (output: string): GateReport[] => [{ name: 'test', status: 'failed', exitCode: 1, output }];

async function queueDefault(rounds = 3): Promise<string> {
    const snapshot = compileDefaultWorkflow(NEITHER, rounds);
    const job = await store.create('do the thing', null, {
        repo: null,
        executor: null,
        workflow: {
            id: null,
            name: DEFAULT_WORKFLOW_NAME,
            node: DEFAULT_ENTRY_NODE,
            snapshot,
            params: {},
            defaultOptions: { ...NEITHER, gateFixRounds: rounds },
        },
    });
    if (typeof job === 'string') throw new Error(job);
    return job.id;
}

const claim = async (): Promise<Claim> => {
    const c = (await store.claim(WORKER, 60)) as Claim;
    expect(c).not.toBeNull();
    return c;
};
const queuedGateFix = async (root: string) =>
    (await store.thread(root))!.filter((r) => r.workflowNode === DEFAULT_GATE_FIX_NODE && r.status === 'queued');

describe.skipIf(!enabled)('gremlin board — database', () => {
    // G2: a Stop stamped on a running row loses to a verdict that lands before the next beat:
    // complete() clears cancel_requested_at and still walks the graph, queuing a successor.
    it('a verdict racing a Stop does not queue the next workflow row', async () => {
        const root = await queueDefault();
        const c = await claim();
        await store.gates(c.id, c.leaseToken, failedGate('red'));
        const stop = await store.stop(c.id, null);
        expect(stop).toMatchObject({ result: 'requested' });
        await store.complete(c.id, c.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: null,
            failureKind: 'gate',
            treeChanged: true,
        });
        expect(await queuedGateFix(root)).toHaveLength(0);
    });

    // G1 (database half): claim() never clears `gates`; an attempt that skips its gates (timeout)
    // inherits the reclaimed attempt's failed report, and the board queues a gate-fix for it.
    it("a reclaimed attempt that skipped its gates does not inherit the previous attempt's gate failure", async () => {
        const root = await queueDefault();
        const first = await claim();
        await store.gates(first.id, first.leaseToken, failedGate('attempt 1 red'));
        // The first worker dies mid-run: its lease expires (aged in SQL, never slept).
        await sql`update job set lease_expires_at = now() - interval '1 second' where id = ${first.id}`;
        const second = await claim();
        expect(second.id).toBe(first.id);
        await store.complete(second.id, second.leaseToken, {
            status: 'failed',
            exitCode: 124,
            output: 'timed out',
            failureKind: 'timeout',
        });
        expect(await queuedGateFix(root)).toHaveLength(0);
    });

    // G3: a human follow-up is accepted while a gate-fix is queued (only the PARENT must be
    // terminal). It is claimed between graph rows, halts "at" the newest queued gate-fix and
    // inserts another: two gate-fix rounds queued at once in one thread.
    it('a follow-up queued while gate-fix is queued never leaves two gate-fix rows queued', async () => {
        const root = await queueDefault(5);
        const task = await claim();
        await store.session(task.id, task.leaseToken, 'sess-1');
        await store.gates(task.id, task.leaseToken, failedGate('red'));
        await store.complete(task.id, task.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: null,
            failureKind: 'gate',
            treeChanged: true,
        });
        expect(await queuedGateFix(root)).toHaveLength(1);

        const follow = await store.createFollowUp(task.id, 'also fix the lint', null);
        expect(follow).toMatchObject({ id: expect.any(String) });

        const g1 = await claim();
        expect(g1.id).not.toBe((follow as { id: string }).id);
        await store.gates(g1.id, g1.leaseToken, failedGate('still red'));
        await store.complete(g1.id, g1.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: null,
            failureKind: 'gate',
            treeChanged: true,
        });

        const f = await claim();
        expect(f.id).toBe((follow as { id: string }).id);
        await store.gates(f.id, f.leaseToken, failedGate('red again'));
        await store.complete(f.id, f.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: null,
            failureKind: 'gate',
            treeChanged: true,
        });

        expect((await queuedGateFix(root)).length).toBeLessThanOrEqual(1);
    });
});
