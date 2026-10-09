import type { Board, BoardJob, Reclaim, ReclaimAck } from './board.js';
import type { DriverConfig } from './config.js';
import type { Runner } from './runner.js';
import type { ReclaimResult } from './publish.js';
import { TERMINAL_JOB_STATUSES } from './reaper.js';
import { CLAUDE_CODE } from './executors.js';

/** Whole minutes are as fine as a claim's age needs to read; the log line rounds up. */
const MS_PER_MINUTE = 60_000;

/**
 * The worktree-reclaim queue's worker half (issue #41), split out of `loop.ts` for the same
 * line-count reason `runJob` was (#223): the drain loop stays in the loop, and everything one
 * claimed row does — the removal, the orphaned-claim proof and reap (issue #344), the throttled
 * failure logging, the ack — lives here.
 */

/**
 * A `BoardJob` synthesised from a claimed reclaim row, for the same runner call a terminal
 * thread's report() uses: the thread's identity — its root id, repo label and workspace path — is
 * all the tree is filed under. The row's own id rides as the lease token, which is exactly what
 * makes the removal hold the checkout against a live attempt's startup sync under kubernetes (the
 * claim ConfigMap is keyed by the job id, and its holder data carries the lease token). No agent
 * is ever spawned for a reclaim, so it carries no executor selection worth naming and no prompt.
 */
function reclaimJob(reclaim: Reclaim): BoardJob {
    return {
        id: reclaim.rootJobId,
        command: '',
        attempts: 1,
        claimSeq: 1,
        leaseToken: reclaim.id,
        leaseExpiresAt: reclaim.leaseExpiresAt,
        resumeSessionId: null,
        followUp: false,
        userId: null,
        workspacePath: reclaim.workspacePath,
        rootJobId: reclaim.rootJobId,
        rootCommand: '',
        repo: reclaim.repo,
        executorType: CLAUDE_CODE,
        executorRefusal: null,
        skillRefusal: null,
        masterPrompt: null,
    };
}

/** Everything one claimed reclaim row needs from the loop. `failureLog` is the loop's own throttle state. */
export interface ReclaimContext {
    board: Pick<Board, 'leases' | 'ackReclaim'>;
    runner: Runner;
    config: DriverConfig;
    log: (message: string) => void;
    /** The last failure digest logged per thread root — see `loop.ts`'s `reclaimFailureLog`. */
    failureLog: Map<string, string>;
    /**
     * Whether the loop has a verdict-time reclaim of this root in flight — the one legitimate
     * live holder of the root's claim this queue path can race (`report()` holds the claim for
     * its whole removal, and a second done can queue a row for the same root meanwhile). True
     * skips the orphan arm: the in-flight reclaim releases the claim itself when it settles,
     * and the row is simply offered again.
     */
    inFlightReclaim: (rootId: string) => boolean;
}

/** Logs a reclaim failure only when what refused has changed since the last logged line. */
function logReclaimFailure(ctx: ReclaimContext, reclaim: Reclaim, digest: string, message: string): void {
    if (ctx.failureLog.get(reclaim.rootJobId) === digest) return;
    ctx.failureLog.set(reclaim.rootJobId, digest);
    ctx.log(message);
}

/**
 * The orphaned-claim proof and reap (issue #344). A reclaim refused BY THE CHECKOUT CLAIM is
 * only interesting when the holder can never let go: asks the board about the root job —
 * absent, or terminal, means no attempt of that thread exists or can ever come, so the claim
 * is a leak from a driver that died holding it. Anything else (a live row, a refused lookup)
 * cannot prove the leak, and nothing is reaped — the failure logs, throttled, and a later
 * offer asks again. The reap itself is the runner's uid-preconditioned delete; when it lands,
 * the caller retries the removal once. Answers true only when the claim was reaped AND the
 * removal should be retried.
 */
async function clearOrphanedClaim(
    ctx: ReclaimContext,
    reclaim: Reclaim,
    removed: BoardJob,
    heldClaim: NonNullable<ReclaimResult['heldClaim']>
): Promise<boolean> {
    const leases = await ctx.board.leases([reclaim.rootJobId]).catch(() => null);
    if (leases === null) return false;
    const row = leases.find((lease) => lease.id === reclaim.rootJobId);
    if (row !== undefined && !TERMINAL_JOB_STATUSES.includes(row.status)) return false;
    if (!(await ctx.runner.reapOrphanedClaim?.(removed))) return false;
    const holder = row === undefined ? 'the board has no row for it' : `its row is ${row.status}`;
    const age =
        heldClaim.createdMs === null
            ? 'age unknown'
            : `held for ${Math.max(1, Math.round((Date.now() - heldClaim.createdMs) / MS_PER_MINUTE))}m`;
    ctx.log(
        `reclaim ${reclaim.id}: orphaned checkout claim ${heldClaim.name} — claim ` +
            `${heldClaim.claimSeq ?? 'unknown'}, ${age}, ${holder}. The claim was reaped; retrying the removal once.`
    );
    return true;
}

/** Acks a settled row, logging the two refusal shapes the ack can answer. */
async function ackSettledReclaim(ctx: ReclaimContext, reclaim: Reclaim): Promise<void> {
    let ack: ReclaimAck;
    try {
        ack = await ctx.board.ackReclaim(reclaim.id, ctx.config.worker);
    } catch (e) {
        ctx.log(`reclaim ${reclaim.id}: the ack threw, leaving it to the lease: ${(e as Error).message}`);
        return;
    }
    if (ack === 'lost') {
        ctx.log(`reclaim ${reclaim.id}: ack refused, the row is re-leased to another worker`);
    } else if (ack === 'missing') {
        ctx.log(`reclaim ${reclaim.id}: already acked elsewhere`);
    }
}

/**
 * Removes one claimed reclaim row's tree and acks it, so the row stops being offered. The
 * tree is reclaimed with the same runner call a terminal thread's report() uses, fed the job
 * `reclaimJob` synthesises from the row.
 *
 * A removed thread has no follow-ups — every row was deleted — so there is no reclaim barrier
 * entry to take here: nothing can claim that root again, and this loop's owns each root it is
 * handed once. A refused tree or a throw — in the reclaim or its ack — simply skips the ack,
 * and the row is offered again when its lease expires; a refused tree also stays on the disk,
 * exactly as a refused terminal reclaim leaves it. A refusal the checkout CLAIM answered goes
 * through the orphaned-claim proof first (issue #344), so a claim nothing else can ever
 * release does not turn this row into a log line every five minutes forever.
 */
export async function processReclaim(ctx: ReclaimContext, reclaim: Reclaim): Promise<void> {
    const removed = reclaimJob(reclaim);
    let outcome: ReclaimResult;
    try {
        outcome = await ctx.runner.reclaimWorktree(removed);
    } catch (e) {
        logReclaimFailure(
            ctx,
            reclaim,
            `throw: ${(e as Error).message}`,
            `reclaim ${reclaim.id}: the worktree reclaim threw, leaving it to the lease: ${(e as Error).message}`
        );
        return;
    }
    if (
        !outcome.ok &&
        outcome.heldClaim &&
        ctx.runner.reapOrphanedClaim &&
        !ctx.inFlightReclaim(reclaim.rootJobId) &&
        (await clearOrphanedClaim(ctx, reclaim, removed, outcome.heldClaim))
    ) {
        try {
            outcome = await ctx.runner.reclaimWorktree(removed);
        } catch (e) {
            logReclaimFailure(
                ctx,
                reclaim,
                `retry throw: ${(e as Error).message}`,
                `reclaim ${reclaim.id}: the retry after the orphaned-claim reap threw, ` +
                    `leaving it to the lease: ${(e as Error).message}`
            );
            return;
        }
    }
    if (!outcome.ok) {
        logReclaimFailure(
            ctx,
            reclaim,
            `${outcome.reason ?? ''}|${outcome.heldClaim?.name ?? ''}`,
            `reclaim ${reclaim.id}: the task worktree could not be reclaimed: ${outcome.reason}`
        );
        return;
    }
    ctx.failureLog.delete(reclaim.rootJobId);
    await ackSettledReclaim(ctx, reclaim);
}
