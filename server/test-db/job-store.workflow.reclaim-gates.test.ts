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

/** A reclaimed attempt never inherits the previous attempt's gate report (#428). */
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
const redGate: GateReport[] = [{ name: 'test', status: 'failed', exitCode: 1, output: 'attempt 1 red' }];

describe.skipIf(!enabled)('claim: a reclaimed attempt starts without gates', () => {
    it("does not inherit the previous attempt's gate failure", async () => {
        const rounds = 3;
        const created = await store.create('do the thing', null, {
            repo: null,
            executor: null,
            workflow: {
                id: null,
                name: DEFAULT_WORKFLOW_NAME,
                node: DEFAULT_ENTRY_NODE,
                snapshot: compileDefaultWorkflow(NEITHER, rounds),
                params: {},
                defaultOptions: { ...NEITHER, gateFixRounds: rounds },
            },
        });
        if (typeof created === 'string') throw new Error(created);

        const first = (await store.claim(WORKER, 60)) as Claim;
        await store.gates(first.id, first.leaseToken, redGate);
        // The first worker dies mid-run: its lease expires (aged in SQL, never slept).
        await sql`update job set lease_expires_at = now() - interval '1 second' where id = ${first.id}`;
        const second = (await store.claim(WORKER, 60)) as Claim;
        expect(second.id).toBe(first.id);

        await store.complete(second.id, second.leaseToken, {
            status: 'failed',
            exitCode: 124,
            output: 'timed out',
            failureKind: 'timeout',
        });
        const gateFixes = (await store.thread(created.id))!.filter((r) => r.workflowNode === DEFAULT_GATE_FIX_NODE);
        expect(gateFixes).toHaveLength(0);
    });
});
