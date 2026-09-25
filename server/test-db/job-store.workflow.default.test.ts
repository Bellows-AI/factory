import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, JobStore } from '../src/db/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { compileDefaultWorkflow, DEFAULT_ENTRY_NODE, DEFAULT_WORKFLOW_NAME } from '../src/db/default-workflow.js';
import { useTestDb } from './harness.js';

/**
 * The code-owned default workflow (issue #209) against a real database: the frozen root row (name,
 * null workflow_id, snapshot, the selected pair), the claim's publish flag, the transition into a
 * selected block with and without a recorded publication (the section-6 integration-bug guard),
 * both-excluded leaving a single row, and follow-up inheritance. `default-workflow.test.ts` covers
 * the assembler and the pure transition walk offline; `routes.jobs.default-workflow.test.ts` covers
 * the HTTP contract. `job.workflow_id` carries no foreign key (docs/workflows.md), so this suite
 * hands `store.create` a hand-built snapshot directly, the same shortcut
 * `job-store.block-wait.test.ts` and `job-store.helper-plans.test.ts` take.
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
    repo: string | null = null
): Promise<string> {
    const snapshot = compileDefaultWorkflow(pair);
    const job = await store.create('do the thing', null, {
        repo,
        executor: null,
        workflow: {
            id: null,
            name: DEFAULT_WORKFLOW_NAME,
            node: DEFAULT_ENTRY_NODE,
            snapshot,
            params: {},
            defaultOptions: pair,
        },
    });
    return job.id;
}

const thread = async (rootId: string) => (await store.thread(rootId))!;
const nodesOf = (rootId: string) => thread(rootId).then((rows) => rows.map((row) => row.workflowNode));

async function rootRow(id: string) {
    const [row] = await sql<
        {
            workflow_id: string | null;
            workflow_name: string | null;
            workflow_node: string | null;
            workflow_snapshot: unknown;
            default_review_reconciliation: boolean | null;
            default_merge_conflict_autofix: boolean | null;
        }[]
    >`
        select workflow_id, workflow_name, workflow_node, workflow_snapshot,
               default_review_reconciliation, default_merge_conflict_autofix
        from job where id = ${id}
    `;
    return row!;
}

describe.skipIf(!enabled)('the code-owned default workflow, against a real database (issue #209)', () => {
    it('freezes name/null-id/node/snapshot/pair onto the root row at create', async () => {
        const pair = { reviewReconciliation: false, mergeConflictAutofix: true };
        const id = await queueDefaultJob(pair);
        const row = await rootRow(id);

        expect(row.workflow_name).toBe(DEFAULT_WORKFLOW_NAME);
        expect(row.workflow_id).toBeNull();
        expect(row.workflow_node).toBe(DEFAULT_ENTRY_NODE);
        expect(row.workflow_snapshot).toEqual(compileDefaultWorkflow(pair));
        expect(row.default_review_reconciliation).toBe(false);
        expect(row.default_merge_conflict_autofix).toBe(true);
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

    it('succeeded with a recorded publication enters the selected block (review-reconciliation)', async () => {
        const id = await queueDefaultJob({ reviewReconciliation: true, mergeConflictAutofix: false }, REPO);
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
        const id = await queueDefaultJob({ reviewReconciliation: false, mergeConflictAutofix: true }, REPO);
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
        const id = await queueDefaultJob(BOTH, REPO);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'no publish' });
        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE]);
        expect(await store.claim(WORKER, 60)).toBeNull();
    });

    it('failed (publish failure) never enters the block either', async () => {
        const id = await queueDefaultJob(BOTH, REPO);
        const claim = (await store.claim(WORKER, 60)) as Claim;
        await store.complete(claim.id, claim.leaseToken, { status: 'failed', exitCode: 1, output: 'publish failed' });
        expect(await nodesOf(id)).toEqual([DEFAULT_ENTRY_NODE]);
    });

    it('a follow-up inherits the default name, resumes the primary session, and leaves the root untouched', async () => {
        const pair = { reviewReconciliation: true, mergeConflictAutofix: false };
        const id = await queueDefaultJob(pair);
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
        expect(rootAfter.workflow_snapshot).toEqual(compileDefaultWorkflow(pair));
        expect(rootAfter.default_review_reconciliation).toBe(true);
        expect(rootAfter.default_merge_conflict_autofix).toBe(false);
    });

    it('the check constraint refuses a half-null pair', async () => {
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
                    workflow_name, workflow_snapshot, default_review_reconciliation, default_merge_conflict_autofix
                )
                select ${ORG}, 'x', null, null, x, x, 'fix-issue', ${sql.json(compileDefaultWorkflow(BOTH) as never)}, true, true
                from (select gen_random_uuid() as x) s
            `
        ).rejects.toThrow();
    });
});
