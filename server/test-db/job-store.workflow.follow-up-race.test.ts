import { beforeAll, describe, expect, it } from 'vitest';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, GateReport, JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { GATE_FIX_NODE, gateFixTarget } from './gate-fix-workflow.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const ORG = 'test-org';
const WORKER = 'worker-1';
const db = useTestDb({ orgs: [ORG], max: 8 });

let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    store = createJobStore({ sql: db.sql, orgId: ORG, prs: createPrLifecycleStore({ sql: db.sql, orgId: ORG }) });
});

const failedGate = (output: string): GateReport[] => [{ name: 'test', status: 'failed', exitCode: 1, output }];

async function queueDefault(rounds: number): Promise<string> {
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
const failGates = async (c: Claim, output: string) => {
    await store.gates(c.id, c.leaseToken, failedGate(output));
    await store.complete(c.id, c.leaseToken, {
        status: 'failed',
        exitCode: 1,
        output: null,
        failureKind: 'gate',
        treeChanged: true,
    });
};

describe.skipIf(!enabled)('a follow-up racing a queued gate-fix (issue #429)', () => {
    // The follow-up is claimed between graph rows; its transition must rest, not insert a second
    // gate-fix beside the one the graph already queued.
    it('never leaves two gate-fix rows queued in one thread', async () => {
        const root = await queueDefault(5);
        const task = await claim();
        await store.session(task.id, task.leaseToken, 'sess-1');
        await failGates(task, 'red');
        expect(await queuedGateFix(root)).toHaveLength(1);

        const follow = await store.createFollowUp(task.id, 'also fix the lint', null);
        if (typeof follow === 'string') throw new Error(`follow-up refused: ${follow}`);

        const g1 = await claim();
        expect(g1.id).not.toBe(follow.id);
        await failGates(g1, 'still red');

        const f = await claim();
        expect(f.id).toBe(follow.id);
        await failGates(f, 'red again');

        expect((await queuedGateFix(root)).length).toBeLessThanOrEqual(1);
    });
});
