/**
 * The merge half of issue #390: what a verified `pull_request closed, merged: true` delivery does
 * to the threads published to that PR. Split from `job-store-actions.ts` because its entry point
 * is the webhook's, not a person route's — there is no caller id, no command, and the dedupe gate
 * is the delivery, not the click.
 */

import type { Sql, TransactionSql } from 'postgres';
import { queueReclaimIfThreadDone } from './job-store-rows.js';
import type { JobStoreContext } from './job-store-types.js';

export type CloseMergedPrResult = { outcome: 'applied' | 'duplicate'; closedRoots: number };

/** The wait terminal reason a merge stamps — distinct from a plain close's `pr closed`. */
const MERGE_TERMINAL_REASON = 'pr merged';

/**
 * The PR-scoped advisory lock both merge writers take FIRST (issue #390's concurrent race): a
 * merge delivery and the publishing verdict that names the same PR serialize on it, so whichever
 * commits second sees the other's rows — a verdict landing after the delivery reads the ledger
 * and applies the closure inline; a delivery landing after the verdict finds the fresh `job_pr`
 * row and closes the thread, cancelling the wait it just parked. Keyed per (org, repo, PR); the
 * per-root locks every path takes AFTER it keep one lock order, so there is no cycle.
 */
export const prLockKey = (orgId: string, repo: string, prNumber: number): string => `${orgId}/${repo}/${prNumber}`;

export async function closeMergedPr(
    ctx: JobStoreContext,
    repo: string,
    prNumber: number,
    deliveryId: string
): Promise<CloseMergedPrResult> {
    const { sql, orgId, prs } = ctx;
    // One transaction: the ledger insert is the dedupe gate AND the durable merge state, and the
    // cleanup it orders commits or rolls back with it. A redelivery — same or different GUID —
    // conflicts on the primary key and answers `duplicate` without repeating a thing, which is
    // also what keeps a redelivered merge from undoing a manual Reopen (the row survives reopen).
    return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${prLockKey(orgId, repo, prNumber)}::text, 0))`;

        const [recorded] = await tx<{ org_id: string }[]>`
            insert into pr_merge (org_id, repo, pr_number, delivery_id)
            values (${orgId}, ${repo}, ${prNumber}, ${deliveryId})
            on conflict (org_id, repo, pr_number) do nothing
            returning org_id
        `;
        if (!recorded) return { outcome: 'duplicate', closedRoots: 0 };

        // The merge-specific cancel: every open wait addressed to this PR ends here, so parked
        // rounds become permanently unwakeable and a continuation woken before this commit is
        // settled at claim by the existing cancellation fence.
        if (prs) {
            await prs.cancelForRepoPr(repo, prNumber, MERGE_TERMINAL_REASON, tx);
        }

        // The association is `job_pr` — the publication identity a publishing verdict recorded —
        // and nothing else: never branch names, PR text or runner output. Every matching root
        // closes, workflow or not, wait or not. The exists keeps a removed thread's orphaned
        // `job_pr` row (nothing deletes them) from being counted — or marked — as closed. The
        // order is deterministic so two closures of one PR cannot take the same root locks in
        // opposite orders.
        const roots = await tx<{ root_job_id: string }[]>`
            select p.root_job_id from job_pr p
            where p.org_id = ${orgId} and p.repo = ${repo} and p.pr_number = ${prNumber}
              and exists (select 1 from job j where j.org_id = ${orgId} and j.id = p.root_job_id)
            order by p.root_job_id
        `;
        let closedRoots = 0;
        for (const root of roots) {
            if (await applyMergeCloseToRoot(tx, ctx, root.root_job_id)) closedRoots += 1;
        }
        return { outcome: 'applied', closedRoots };
    });
}

/**
 * The merge-before-publication half (issue #390): the publishing verdict's transaction calls this
 * right after the `job_pr` row upserts — if a merge delivery already landed for the PR this
 * publication names, the closure it ordered applies HERE, in the verdict's own transaction. The
 * caller has already taken the PR-scoped advisory lock (the serialization point with the
 * delivery), and the per-root advisory lock inside `applyMergeCloseToRoot` is re-entrant within
 * one transaction, so this is safe beside the transition that follows it; the marker it stamps is
 * what makes that transition rest instead of inserting a successor or parking a wait on the
 * merged PR.
 */
export async function applyMergeClosureIfMerged(
    tx: TransactionSql,
    ctx: JobStoreContext,
    publication: { repo: string; prNumber: number },
    rootJobId: string
): Promise<void> {
    const { orgId } = ctx;
    const [merged] = await tx<{ one: number }[]>`
        select 1 as one from pr_merge
        where org_id = ${orgId} and repo = ${publication.repo} and pr_number = ${publication.prNumber}
    `;
    if (merged) await applyMergeCloseToRoot(tx, ctx, rootJobId);
}

/**
 * One thread's closure, under the same per-root advisory lock the claim, done, remove and reopen
 * take — a closure must not interleave with a claim of this thread, and its decisions must see
 * every earlier writer's commit. The `job_merge_close` marker is the idempotence gate per thread:
 * already marked (a prior close) or reopened since (reopen deletes the marker) both answer "no
 * row" and skip, so a second merge delivery or a straggler root cannot re-close what a user
 * reopened. Never invents a local user: `done_by` is not written, so a pure merge close reads
 * authorless and an earlier manual Done keeps its actor.
 */
async function applyMergeCloseToRoot(tx: TransactionSql, ctx: JobStoreContext, rootJobId: string): Promise<boolean> {
    const { orgId } = ctx;
    await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;

    const [marked] = await tx<{ root_job_id: string }[]>`
        insert into job_merge_close (org_id, root_job_id)
        values (${orgId}, ${rootJobId})
        on conflict (org_id, root_job_id) do nothing
        returning root_job_id
    `;
    if (!marked) return false;

    // Queued work stops: the thread is closed, and a queued member settled `stopped` is exactly
    // what the user's own stop lands — terminal, never claimed afterwards. No actor (nobody here
    // asked as a person), and no wall-clock: the row never executed, and a settle of a row that
    // never ran banks nothing.
    await tx`
        update job set status = 'stopped', finished_at = now()
        where org_id = ${orgId} and root_job_id = ${rootJobId}
          and status = 'queued'
    `;

    // The done stamp rides markDone's shape — terminal rows only, coalesce keeps an earlier
    // manual Done's instant and actor. Running attempts are NOT touched: they settle normally,
    // and the settle points below close the thread behind them.
    await tx`
        update job set done_at = coalesce(done_at, now())
        where org_id = ${orgId} and root_job_id = ${rootJobId}
          and status in ('succeeded','failed','dead','stopped')
    `;

    // The shared reclaim rule: queues only when EVERY member is terminal — a member still
    // running keeps the tree, and its own settle reclaims it.
    await queueReclaimIfThreadDone(tx, orgId, ctx.hasWorkspaces, rootJobId);
    return true;
}

/**
 * The conditional settle every non-verdict settle point shares (issue #390): a merge-marked thread
 * whose LAST moving member just went terminal — by a stop, a suspend, the dead retirement, the
 * claim-time cancellation fence, or the verdict itself — closes here: the done stamp lands on
 * every terminal member when the thread carries none yet (no actor), and the worktree reclaim
 * queues EITHER way, because the terminal aggregate is the reclaim point whatever wrote the done.
 * Without it, a running member at merge time that settles by anything but a verdict leaves the
 * tree unreclaimed forever. No-op on every other thread, and idempotent (coalesce + the reclaim's
 * own not-exists) whatever the concurrency.
 *
 * `exec` follows the pr-lifecycle-store's rule on an OPTIONAL parameter: handed a transaction the
 * settle runs on it (the claim fence, the verdict, the dead sweep — all inside a caller's
 * transaction, whose locks and atomicity it joins); omitted, it opens its own — the bare settle
 * points (`stop`, `suspend`) are not inside one, and per-statement autocommit would make the
 * advisory lock a no-op.
 */
export async function settleIfMergeClosed(
    ctx: JobStoreContext,
    rootJobId: string,
    exec?: Sql | TransactionSql
): Promise<boolean> {
    const run = (tx: TransactionSql): Promise<boolean> => closeMarkedThreadIfTerminal(tx, ctx, rootJobId);
    if (exec !== undefined) return run(exec as TransactionSql);
    return ctx.sql.begin(run);
}

/** `settleIfMergeClosed`'s body: the marker check, the lock, the aggregate, stamp, reclaim. */
async function closeMarkedThreadIfTerminal(
    tx: TransactionSql,
    ctx: JobStoreContext,
    rootJobId: string
): Promise<boolean> {
    const { orgId } = ctx;
    // Cheap pre-check so an unmarked thread never queues on the lock — but the DECISION is the
    // re-read below: reopen deletes the marker under this same lock, so a settle that waited on
    // a reopen must not stamp what the user just took back (the wakeOneRound precedent).
    if (!(await mergeClosureMarkerSet(tx, orgId, rootJobId))) return false;

    await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;
    if (!(await mergeClosureMarkerSet(tx, orgId, rootJobId))) return false;

    const [thread] = await tx<{ total: number; terminal: number; done: number }[]>`
        select count(*)::int as total,
               count(*) filter (where status in ('succeeded','failed','dead','stopped'))::int as terminal,
               count(*) filter (where done_at is not null)::int as done
        from job
        where org_id = ${orgId} and root_job_id = ${rootJobId}
    `;
    if (!thread || thread.total !== thread.terminal) return false;
    // The done stamp only when the thread carries none yet — an earlier stamp (the closure's own,
    // or a manual Done) keeps its instant and actor. The reclaim queues EITHER way: the terminal
    // aggregate is the reclaim point, whatever wrote the done.
    if (thread.done === 0) {
        await tx`
            update job set done_at = coalesce(done_at, now())
            where org_id = ${orgId} and root_job_id = ${rootJobId}
              and status in ('succeeded','failed','dead','stopped')
        `;
    }
    await queueReclaimIfThreadDone(tx, ctx.orgId, ctx.hasWorkspaces, rootJobId);
    return true;
}

/** Whether the thread carries the merge-closure marker (`job_merge_close`, issue #390). */
export async function mergeClosureMarkerSet(tx: TransactionSql, orgId: string, rootJobId: string): Promise<boolean> {
    const [marked] = await tx<{ one: number }[]>`
        select 1 as one from job_merge_close
        where org_id = ${orgId} and root_job_id = ${rootJobId}
    `;
    return marked !== undefined;
}
