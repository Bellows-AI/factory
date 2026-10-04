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

/**
 * A create whose refusal would be a broken setup, never a case under test: narrows the store's
 * honest union (`{ id } | 'purging'`, issue #92) so the call sites read as they did before.
 */
const mustCreate = (p: Promise<{ id: string } | 'purging'>): Promise<{ id: string }> =>
    p.then((ref) => {
        if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
        return ref;
    });

/**
 * The code-owned default workflow (issue #209) against a real database: the frozen root row (name,
 * null workflow_id, snapshot, the selected pair and the gate-repair round limit), the claim's
 * publish flag, the transition into a selected block with and without a recorded publication (the
 * section-6 integration-bug guard), both-excluded leaving a single row, and follow-up inheritance.
 * The gate-repair loop (issue #49) walks here end to end: a failed gate on `task` queues a
 * `gate-fix` round through the ordinary claim machinery, budget counted in rows, exhaustion resting
 * the thread with the last failed gate visible. `default-workflow.test.ts` covers the assembler and
 * the pure transition walk offline; `routes.jobs.default-workflow.test.ts` covers the HTTP
 * contract. `job.workflow_id` carries no foreign key (docs/workflows.md), so this suite hands
 * `store.create` a hand-built snapshot directly, the same shortcut `job-store.block-wait.test.ts`
 * and `job-store.helper-plans.test.ts` take.
 */

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
let prs: ReturnType<typeof createPrLifecycleStore>;

const ORG = 'test-org';
const WORKER = 'worker-1';
const REPO = 'acme/widgets';

const db = useTestDb({ orgs: [ORG], max: 8 });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    prs = createPrLifecycleStore({ sql, orgId: ORG });
    store = createJobStore({ sql, orgId: ORG, prs });
});

const BOTH = { reviewReconciliation: true, mergeConflictAutofix: true };
const NEITHER = { reviewReconciliation: false, mergeConflictAutofix: false };

/** Queues a default-workflow root exactly like `routes/jobs.ts`'s launch would. */
async function queueDefaultJob(
    pair: { reviewReconciliation: boolean; mergeConflictAutofix: boolean },
    gateFixRounds = 3,
    repo: string | null = null
): Promise<string> {
    const snapshot = compileDefaultWorkflow(pair, gateFixRounds);
    const job = await mustCreate(
        store.create('do the thing', null, {
            repo,
            executor: null,
            workflow: {
                id: null,
                name: DEFAULT_WORKFLOW_NAME,
                node: DEFAULT_ENTRY_NODE,
                snapshot,
                params: {},
                defaultOptions: { ...pair, gateFixRounds },
            },
        })
    );
    return job.id;
}

const thread = async (rootId: string) => (await store.thread(rootId))!;
const nodesOf = (rootId: string) => thread(rootId).then((rows) => rows.map((row) => row.workflowNode));

/** The gate report a genuine gate failure stores on the row before its failed verdict. */
const failedGate = (output: string): GateReport[] => [{ name: 'test', status: 'failed', exitCode: 1, output }];

/**
 * Runs the thread's OLDEST queued row to a failed verdict carrying a failed gate report — the
 * real shape `driver/src/loop-run.ts` lands on a gate failure (`status: 'failed'` beside it,
 * never `succeeded`). Returns the claim that ran, so the caller can keep walking the thread.
 */
async function runOneToGateFailure(): Promise<Claim> {
    const claim = (await store.claim(WORKER, 60)) as Claim;
    expect(claim).not.toBeNull();
    await store.gates(claim.id, claim.leaseToken, failedGate('3 tests failed'));
    await store.complete(claim.id, claim.leaseToken, { status: 'failed', exitCode: 1, output: null });
    return claim;
}

/** The queued claim after a transition, run to a green succeeded verdict. */
async function runOneToSuccess(output = 'done'): Promise<Claim> {
    const claim = (await store.claim(WORKER, 60)) as Claim;
    expect(claim).not.toBeNull();
    await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output });
    return claim;
}

async function rootRow(id: string) {
    const [row] = await sql<
        {
            workflow_id: string | null;
            workflow_name: string | null;
            workflow_node: string | null;
            workflow_snapshot: unknown;
            default_review_reconciliation: boolean | null;
            default_merge_conflict_autofix: boolean | null;
            default_gate_fix_rounds: number | null;
        }[]
    >`
        select workflow_id, workflow_name, workflow_node, workflow_snapshot,
               default_review_reconciliation, default_merge_conflict_autofix, default_gate_fix_rounds
        from job where id = ${id}
    `;
    return row!;
}

describe.skipIf(!enabled)('the code-owned default workflow, against a real database (issue #209)', () => {
    it('freezes name/null-id/node/snapshot/pair/round-limit onto the root row at create', async () => {
        const pair = { reviewReconciliation: false, mergeConflictAutofix: true };
        const id = await queueDefaultJob(pair, 5);
        const row = await rootRow(id);

        expect(row.workflow_name).toBe(DEFAULT_WORKFLOW_NAME);
        expect(row.workflow_id).toBeNull();
        expect(row.workflow_node).toBe(DEFAULT_ENTRY_NODE);
        expect(row.workflow_snapshot).toEqual(compileDefaultWorkflow(pair, 5));
        expect(row.default_review_reconciliation).toBe(false);
        expect(row.default_merge_conflict_autofix).toBe(true);
        expect(row.default_gate_fix_rounds).toBe(5);
    });

    it('the root claim carries publish: true, from the mandatory spine node', async () => {
        const id = await queueDefaultJob(BOTH);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        expect(claim.id).toBe(id);
        expect(claim.publish).toBe(true);
    });

    it('both excluded: a succeeded entry leaves exactly one row — the pre-209 unnamed shape', async () => {
        const id = await queueDefaultJob(NEITHER);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE]);
    });

    it('a failed gate on task queues a gate-fix round whose command names the gate and its output', async () => {
        const id = await queueDefaultJob(NEITHER);
        await runOneToGateFailure();

        const rows = await thread(id);
        expect(rows.map((row) => row.workflowNode)).toEqual([DEFAULT_ENTRY_NODE, DEFAULT_GATE_FIX_NODE]);
        // The repair prompt interpolated the stored gate report at insert time.
        expect(rows[1]!.command).toContain('test');
        expect(rows[1]!.command).toContain('3 tests failed');
        expect(rows[1]!.sessionId).toBeNull(); // resolved at claim: resumes the primary session
    });

    it('the gate-fix claim runs through the ordinary machinery: publish true, resuming the primary session', async () => {
        const id = await queueDefaultJob(NEITHER);
        // Run task to its failed gate, reporting a session on the way — the primary the repair
        // round must resume.
        const first = (await store.claim(WORKER, 60)) as Claim;
        await store.session(first.id, first.leaseToken, 'sess-1');
        await store.gates(first.id, first.leaseToken, failedGate('3 tests failed'));
        await store.complete(first.id, first.leaseToken, { status: 'failed', exitCode: 1, output: null });

        const second = (await store.claim(WORKER, 60)) as Claim;
        expect(second.id).not.toBe(first.id);
        const rows = await thread(id);

        // The docker/kubernetes parity pin (issue #49): a repair round's claim is byte-shape
        // identical to any gated publishing claim — the one shared loop in driver/src/loop.ts
        // drives both transports from exactly this shape, and no transport grew a gate of its
        // own (docs/workflows.md, "Publishing").
        expect(second.publish).toBe(true);
        expect(second.resumeSessionId).toBe('sess-1');
        expect(rows.find((row) => row.id === second.id)!.workflowNode).toBe(DEFAULT_GATE_FIX_NODE);
    });

    it('a repaired round continues the success path: into the selected block on a publication', async () => {
        const id = await queueDefaultJob({ reviewReconciliation: true, mergeConflictAutofix: false }, 3, REPO);
        await runOneToGateFailure();
        const repair = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(repair.id, repair.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'fixed',
            publication: {
                repo: REPO,
                prNumber: 3,
                prUrl: `https://github.com/${REPO}/pull/3`,
                headBranch: `factory/${id}`,
                baseBranch: 'main',
            },
        });

        expect(await nodesOf(id)).toEqual([
            DEFAULT_ENTRY_NODE,
            DEFAULT_GATE_FIX_NODE,
            'review-reconciliation--collect',
        ]);
    });

    it('a repaired round with no publication rests — the same no_publication guard task has', async () => {
        const id = await queueDefaultJob({ reviewReconciliation: true, mergeConflictAutofix: false });
        await runOneToGateFailure();
        await runOneToSuccess('fixed, no repo');

        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE, DEFAULT_GATE_FIX_NODE]);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('another failed gate on gate-fix queues the next round while budget remains (rounds 3)', async () => {
        const id = await queueDefaultJob(NEITHER, 3);
        await runOneToGateFailure(); // task fails -> round 1
        await runOneToGateFailure(); // round 1 fails -> round 2
        await runOneToGateFailure(); // round 2 fails -> round 3

        expect(await nodesOf(id)).toEqual([
            DEFAULT_ENTRY_NODE,
            DEFAULT_GATE_FIX_NODE,
            DEFAULT_GATE_FIX_NODE,
            DEFAULT_GATE_FIX_NODE,
        ]);
    });

    it('exhaustion (rounds 1): the second gate failure rests the thread, last report visible', async () => {
        const id = await queueDefaultJob(NEITHER, 1);
        await runOneToGateFailure(); // task fails -> the one round
        await runOneToGateFailure(); // the round fails -> budget spent

        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE, DEFAULT_GATE_FIX_NODE]);
        expect(await store.claim(WORKER, 60)).toBeNull();

        // The rested thread keeps the last failed gate report and its output readable.
        const rows = await thread(id);
        expect(rows[1]!.gates).toEqual(failedGate('3 tests failed'));
        expect(rows[1]!.status).toBe('failed');
    });

    it('exhaustion (rounds 3): the fourth gate failure rests, no fifth row', async () => {
        const id = await queueDefaultJob(NEITHER, 3);
        await runOneToGateFailure();
        await runOneToGateFailure();
        await runOneToGateFailure();
        await runOneToGateFailure();

        expect(await nodesOf(id)).toEqual([
            DEFAULT_ENTRY_NODE,
            DEFAULT_GATE_FIX_NODE,
            DEFAULT_GATE_FIX_NODE,
            DEFAULT_GATE_FIX_NODE,
        ]);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it("rounds zero: a gate failure rests the thread — today's behavior, no repair row", async () => {
        const id = await queueDefaultJob(NEITHER, 0);
        await runOneToGateFailure();

        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE]);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('a non-gate failure (crashed agent, green gates) queues no repair round', async () => {
        const id = await queueDefaultJob(NEITHER, 3);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.gates(claim.id, claim.leaseToken, [{ name: 'test', status: 'passed', exitCode: 0, output: 'ok' }]);
        await store.complete(claim.id, claim.leaseToken, { status: 'failed', exitCode: 1, output: 'agent died' });

        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE]);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('a stopped repair round fires no edge and queues nothing further', async () => {
        const id = await queueDefaultJob(NEITHER, 3);
        await runOneToGateFailure(); // round 1 queued
        const repair = (await store.claim(WORKER, 60)) as Claim;
        await store.stop(repair.id, null);

        // The human ended the turn: no verdict, no transition, no round 2 — the stop is the park.
        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE, DEFAULT_GATE_FIX_NODE]);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    // The driver's side of a stop during the gates: the gate in flight was cancelled and left
    // `running`, the turn parks through suspend — no verdict, so `gate-failed` cannot fire.
    it('a repair round stopped while its gate runs parks with no further round', async () => {
        const id = await queueDefaultJob(NEITHER, 3);
        await runOneToGateFailure(); // round 1 queued
        const repair = (await store.claim(WORKER, 60)) as Claim;
        await store.gates(repair.id, repair.leaseToken, [
            { name: 'test', status: 'running', exitCode: null, output: null },
        ]);
        await store.stop(repair.id, null);
        await store.suspend(repair.id, repair.leaseToken);

        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE, DEFAULT_GATE_FIX_NODE]);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    // The incident (task d0a4146f): gate-fix rounds that change nothing — the driver says so.
    it('a gate failure over an unchanged tree rests instead of queuing a repair round', async () => {
        const id = await queueDefaultJob(NEITHER, 3);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.gates(claim.id, claim.leaseToken, failedGate('3 tests failed'));
        await store.complete(claim.id, claim.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: null,
            failureKind: 'gate',
            treeChanged: false,
        });

        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE]);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('a gate failure over a changed tree still queues the repair round', async () => {
        const id = await queueDefaultJob(NEITHER, 3);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.gates(claim.id, claim.leaseToken, failedGate('3 tests failed'));
        await store.complete(claim.id, claim.leaseToken, {
            status: 'failed',
            exitCode: 1,
            output: null,
            failureKind: 'gate',
            treeChanged: true,
        });

        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE, DEFAULT_GATE_FIX_NODE]);
    });

    it('a blocked task rests, its failure kind stored', async () => {
        const id = await queueDefaultJob(NEITHER, 3);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(claim.id, claim.leaseToken, {
            status: 'failed',
            exitCode: 0,
            output: 'FACTORY_BLOCKED: acli is not authenticated',
            failureKind: 'blocked',
        });

        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE]);
        expect((await thread(id))[0]!.failureKind).toBe('blocked');
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('succeeded with a recorded publication enters the selected block (review-reconciliation)', async () => {
        const id = await queueDefaultJob({ reviewReconciliation: true, mergeConflictAutofix: false }, 3, REPO);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(claim.id, claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'done',
            publication: {
                repo: REPO,
                prNumber: 1,
                prUrl: `https://github.com/${REPO}/pull/1`,
                headBranch: `factory/${id}`,
                baseBranch: 'main',
            },
        });
        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE, 'review-reconciliation--collect']);
        const rows = await thread(id);
        // The successor is root-only-free: name inherited, no workflow_id, no pair columns of its
        // own (root-only, like workflow_params).
        const [successorDb] = await sql<{ workflow_id: string | null }[]>`
            select workflow_id from job where id = ${rows[1]!.id}
        `;
        expect(successorDb!.workflow_id).toBeNull();
        expect(rows[1]!.workflowName).toBe(DEFAULT_WORKFLOW_NAME);
    });

    it('succeeded with a recorded publication enters merge-conflict-autofix when that is the selected block', async () => {
        const id = await queueDefaultJob({ reviewReconciliation: false, mergeConflictAutofix: true }, 3, REPO);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(claim.id, claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'done',
            publication: {
                repo: REPO,
                prNumber: 2,
                prUrl: `https://github.com/${REPO}/pull/2`,
                headBranch: `factory/${id}`,
                baseBranch: 'main',
            },
        });
        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE, 'merge-conflict-autofix--repair']);
    });

    it('succeeded with NO recorded publication rests instead of entering the block (the section-6 guard)', async () => {
        const id = await queueDefaultJob(BOTH, 3, REPO);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'no publish' });
        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE]);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('failed (publish failure) never enters the block either', async () => {
        const id = await queueDefaultJob(BOTH, 3, REPO);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(claim.id, claim.leaseToken, { status: 'failed', exitCode: 1, output: 'publish failed' });
        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE]);
    });

    it('a follow-up inherits the default name, resumes the primary session, and leaves the root untouched', async () => {
        const pair = { reviewReconciliation: true, mergeConflictAutofix: false };
        const id = await queueDefaultJob(pair, 2);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.session(claim.id, claim.leaseToken, 'sess-1');
        await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        // No publication was recorded, so the entry rested rather than entering review-reconciliation.
        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE]);

        const followUp = await store.createFollowUp(id, 'one more thing', null);
        expect(followUp).toHaveProperty('id');
        const rows = await thread(id);
        const added = rows[rows.length - 1]!;
        expect(added.workflowNode).toBeNull();
        expect(added.sessionId).toBe('sess-1');

        const rootAfter = await rootRow(id);
        expect(rootAfter.workflow_snapshot).toEqual(compileDefaultWorkflow(pair, 2));
        expect(rootAfter.default_review_reconciliation).toBe(true);
        expect(rootAfter.default_merge_conflict_autofix).toBe(false);
        expect(rootAfter.default_gate_fix_rounds).toBe(2);
    });

    it('the check constraint refuses a half-null triple', async () => {
        await expect(
            sql`
                insert into job (org_id, command, repo, executor, id, root_job_id, default_review_reconciliation)
                select ${ORG}, 'x', null, null, x, x, true
                from (select gen_random_uuid() as x) s
            `
        ).rejects.toThrow();
    });

    it('the check constraint refuses a pair stamped on a row that is not the default workflow', async () => {
        // Every OTHER clause of the pair branch is satisfied (a real snapshot, no workflow_id) —
        // only workflow_name is wrong ('fix-issue' instead of 'default') — so this insert isolates
        // the name clause: it would pass on a constraint that forgot to check it.
        await expect(
            sql`
                insert into job (
                    org_id, command, repo, executor, id, root_job_id,
                    workflow_name, workflow_snapshot, default_review_reconciliation, default_merge_conflict_autofix, default_gate_fix_rounds
                )
                select ${ORG}, 'x', null, null, x, x, 'fix-issue', ${sql.json(compileDefaultWorkflow(BOTH, 3) as never)}, true, true, 3
                from (select gen_random_uuid() as x) s
            `
        ).rejects.toThrow();
    });

    it('the check constraint refuses a round limit stamped without the pair', async () => {
        await expect(
            sql`
                insert into job (
                    org_id, command, repo, executor, id, root_job_id,
                    workflow_name, workflow_snapshot, default_gate_fix_rounds
                )
                select ${ORG}, 'x', null, null, x, x, 'default', ${sql.json(compileDefaultWorkflow(BOTH, 3) as never)}, 3
                from (select gen_random_uuid() as x) s
            `
        ).rejects.toThrow();
    });
});
