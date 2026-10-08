import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, GateReport, JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { GATE_FIX_NODE, gateFixTarget } from './gate-fix-workflow.js';
import { useTestDb } from './harness.js';

/** Issue #427 (G2): the verdict transaction against a Stop stamp no heartbeat has delivered yet. */
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

const failedGate = (output: string): GateReport[] => [{ name: 'test', status: 'failed', exitCode: 1, output }];

async function queueDefault(rounds = 3): Promise<string> {
    const job = await store.create('do the thing', null, {
        repo: null,
        executor: null,
        workflow: gateFixTarget(rounds),
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
    (await store.thread(root))!.filter((r) => r.workflowNode === GATE_FIX_NODE && r.status === 'queued');

describe.skipIf(!enabled)('a verdict racing a Stop — database', () => {
    // A Stop stamped on a running row loses to a verdict that lands before the next beat:
    // complete() clears cancel_requested_at and must not walk the graph for it.
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
});
