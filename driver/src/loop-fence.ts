/**
 * The attempt's two fences, and the only two places either is acted on: the kubernetes checkout
 * claim the attempt holds, and the stand-down that ends it. Every setup step and every phase
 * answers with data (`SetupHalt`, `STOOD_DOWN`) instead of settling, releasing or reporting for
 * itself, so no path can forget half of its own settlement (issue #472, steps 3 and 4 of #433).
 */

import { down } from './loop-attempt.js';
import { withBoardRetry } from './board-retry.js';
import type { BoardJob } from './board.js';
import type { RunOutcome } from './runner.js';
import { withConflictContext, type SyncResult } from './publish.js';
import type { AttemptCtx, LoopRuntime, SetupHalt } from './loop-types.js';
import { report } from './loop-verdict.js';

/**
 * Why the loop reports no verdict for this outcome and leaves the job to the lease, or null when it
 * reports: a container that never started. A runner the platform took away is an interruption
 * instead (`interruptAttempt`, issue #792).
 */
export function leaseLeftWhy(outcome: RunOutcome): string | null {
    if (outcome.started) return null;
    const said = outcome.output.trim();
    return `the runner reports the container never started${said ? `: ${said}` : ''}`;
}

/**
 * Hands the kubernetes checkout claim back — the ONE release in the loop. Only a successful sync
 * ever takes it (`ctx.fenced`) and the runner owns it from its launch onwards, so a refusal that
 * came before the sync releases nothing (the sync released its own) and nothing after the spawn
 * does either (`runner.run`'s finally and `publishGit` own that).
 */
export async function handBackFence(ctx: AttemptCtx): Promise<void> {
    if (!ctx.fenced) return;
    ctx.fenced = false;
    await ctx.rt.runner.releaseFence?.(ctx.job);
}

/**
 * A conflict the sync left in the tree reaches the agent through this attempt's turn context, which
 * the runner reads from the job at launch (master-prompt.ts); a sync with none changes nothing.
 */
export function handOverConflict(job: BoardJob, synced: SyncResult): void {
    if (synced.conflicts?.length) job.turnContext = withConflictContext(job.turnContext, synced.conflicts);
}

/**
 * The claim an ABANDONED sync still holds. The attempt walked away before the sync answered, so
 * `ctx.fenced` was never set and the stand-down fence has nothing to give back — yet an ok sync
 * takes the claim with no run coming to release it, and the next attempt's sync waits on it. So the
 * abandoned sync hands its own claim back the moment it lands, here where the release lives.
 */
export function releaseAbandonedSync(rt: LoopRuntime, job: BoardJob, syncing: Promise<SyncResult>): void {
    void syncing
        .then((result) => {
            if (result.ok) return rt.runner.releaseFence?.(job);
        })
        .catch(() => {});
}

/** `releaseAbandonedSync`'s twin for an abandoned adoption (issue #792): one that lands adopted holds the claim. */
export function releaseAbandonedAdoption(rt: LoopRuntime, job: BoardJob, adopting: Promise<unknown>): void {
    void adopting
        .then((run) => {
            if (run) return rt.runner.releaseFence?.(job);
        })
        .catch(() => {});
}

/**
 * The ONE stand-down fence. Called the moment a phase answers, it gives the claim back, settles the
 * attempt and parks a stopped one exactly once, and answers whether the attempt stood down here —
 * so nothing below it settles, releases or parks for itself. `phase` names where it landed.
 * `beforePark` runs once for a stopped attempt, after the settle and before the park: the work
 * that must land while the lease still lets it (a stop after the run still reports the session
 * and uploads the artifacts, issues #152 and #325 — the park lands the row terminal, and a call
 * refused after it is lost).
 */
export async function standDown(ctx: AttemptCtx, phase: string, beforePark?: () => Promise<void>): Promise<boolean> {
    if (!down(ctx.state)) return false;
    // Once per attempt (issue #820): a stand-down that threw lands in runJob's catch, which asks
    // again — and a second park would only repeat the call that just failed. Marked after the
    // settle, so a release or settle that threw is finished by that second ask.
    if (ctx.stoodDown) return true;
    await handBackFence(ctx);
    await ctx.settle();
    ctx.stoodDown = true;
    const { rt, job, state } = ctx;
    if (state.lost) {
        rt.log(`job ${job.id}: the lease was lost during ${phase}, leaving the job to its holder`);
    } else if (state.removed) {
        rt.log(`job ${job.id}: removed during ${phase}; the queue owns the tree`);
    } else {
        await beforePark?.().catch((e: Error) =>
            rt.log(`job ${job.id}: the work before the park failed, parking anyway: ${e.message}`)
        );
        await park(ctx, phase);
    }
    return true;
}

/**
 * Parks a stopped attempt, retried like a verdict. A board that never takes it leaves the attempt to
 * the lease: the claim settles a requested stop whose lease expired (`job-store-claim.ts`) and offers
 * anything else again, so the row is recoverable and nothing here may throw — the process carries
 * every other claim (issue #820).
 */
async function park(ctx: AttemptCtx, phase: string): Promise<void> {
    const { rt, job } = ctx;
    const verdict = await withBoardRetry(rt, `job ${job.id}: the stop was not accepted`, () =>
        rt.board.suspend(job)
    ).catch((e: Error) => {
        rt.log(`job ${job.id}: the board did not take the stop, left to the lease: ${e.message}`);
        return null;
    });
    if (verdict === null) return;
    rt.log(
        verdict === 'lost'
            ? `job ${job.id}: stopped during ${phase}, but the board had already reclaimed it`
            : `job ${job.id}: stopped during ${phase} — nothing more ran, the board has settled the turn`
    );
}

/**
 * The ONE setup conclusion: the claim goes back, the attempt settles, the line is said, the verdict
 * is reported (or the claim requeued) — in that order, because a replacement claimant may start the moment the job is
 * completed (issue #469).
 */
export async function concludeSetup(ctx: AttemptCtx, halt: SetupHalt): Promise<void> {
    const { rt, job } = ctx;
    await handBackFence(ctx);
    await ctx.settle();
    rt.log(`job ${job.id}: ${halt.log}`);
    if (halt.halt === 'leave') return;
    if (halt.halt === 'requeue') {
        // A refused requeue (a lost lease, a stop that won the race) leaves the board's answer
        // standing; retried like a verdict, and one that still fails leaves the job to its lease,
        // exactly like `leave`.
        await withBoardRetry(rt, `job ${job.id}: the requeue was not accepted`, () => rt.board.requeue(job)).catch(
            (e: Error) => rt.log(`job ${job.id}: could not requeue: ${e.message}`)
        );
        return;
    }
    const what = halt.halt === 'concluded' ? 'conclusion' : 'failure';
    await report(rt, job, halt.verdict).catch((e: Error) =>
        rt.log(`job ${job.id}: could not report the ${what}: ${e.message}`)
    );
}

/**
 * Leaves an attempt that ended without a verdict to the lease, saying why in the log. The board
 * recovers an expired lease as an interruption while it can, and retires the job `dead` with no
 * output once it cannot, so that LAST attempt (`lastAttempt` on the claim) reports a failed verdict
 * carrying `reason` instead: the reason is what `job investigate`, the web and a batch report show.
 */
export async function leaveToLease(
    ctx: AttemptCtx,
    reason: string,
    leaveLog: string,
    exitCode: number | null
): Promise<void> {
    await concludeSetup(ctx, leaveConclusion(ctx.job, reason, leaveLog, exitCode));
}

/**
 * Hands an attempt the infrastructure took away back to the board as an interruption (issue #792):
 * refunded and claimable at once, its reason recorded, no verdict. A spent interruption budget, or
 * a board that never answered, leaves it to the lease as before — the last attempt reports it.
 */
export async function interruptAttempt(ctx: AttemptCtx, reason: string, exitCode: number | null): Promise<void> {
    const { rt, job } = ctx;
    await handBackFence(ctx);
    await ctx.settle();
    const answer = await withBoardRetry(rt, `job ${job.id}: the interruption was not accepted`, () =>
        rt.board.interrupt(job, { reason, release: true })
    ).catch((e: Error) => {
        rt.log(`job ${job.id}: could not report the interruption: ${e.message}`);
        return null;
    });
    if (answer === 'held') {
        rt.log(`job ${job.id}: ${reason}, handed back as an interruption`);
        return;
    }
    if (answer === 'lost') {
        rt.log(`job ${job.id}: ${reason}, and the lease was already lost`);
        return;
    }
    const why = answer === 'exhausted' ? `${reason}, and the interruption budget is spent` : reason;
    await leaveToLease(ctx, why, `${why}, leaving it to the lease`, exitCode);
}

/**
 * Lands a run that has no verdict to report, answering whether it did: a runner the platform took
 * away is an interruption (`interruptAttempt`), one that never started is left to the lease.
 */
export async function concludeUnreported(ctx: AttemptCtx, outcome: RunOutcome): Promise<boolean> {
    if (outcome.infraLoss) {
        await interruptAttempt(ctx, `infrastructure loss: ${outcome.infraLoss}`, outcome.exitCode);
        return true;
    }
    const why = leaseLeftWhy(outcome);
    if (why === null) return false;
    await leaveToLease(ctx, why, `${why}, leaving it to the lease`, outcome.exitCode);
    return true;
}

/** `leaveToLease`'s conclusion, as data: left to the lease, or reported failed on the last attempt. */
export function leaveConclusion(job: BoardJob, reason: string, leaveLog: string, exitCode: number | null): SetupHalt {
    if (!job.lastAttempt) return { halt: 'leave', log: leaveLog };
    return {
        halt: 'fault',
        log: `${reason}, and no attempts are left: reporting it`,
        verdict: {
            status: 'failed',
            exitCode,
            output: `[driver] ${reason} (attempt ${job.attempts} of ${job.maxAttempts})`,
            failureKind: 'runner_error',
        },
    };
}
