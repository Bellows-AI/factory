/**
 * The attempt's two fences, and the only two places either is acted on: the kubernetes checkout
 * claim the attempt holds, and the stand-down that ends it. Every setup step and every phase
 * answers with data (`SetupHalt`, `STOOD_DOWN`) instead of settling, releasing or reporting for
 * itself, so no path can forget half of its own settlement (issue #472, steps 3 and 4 of #433).
 */

import { down } from './loop-attempt.js';
import type { BoardJob } from './board.js';
import type { SyncResult } from './publish.js';
import type { AttemptCtx, LoopRuntime, SetupHalt } from './loop-types.js';
import { report } from './loop-verdict.js';

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
    await handBackFence(ctx);
    await ctx.settle();
    const { rt, job, state } = ctx;
    if (state.lost) {
        rt.log(`job ${job.id}: the lease was lost during ${phase}, leaving the job to its holder`);
    } else if (state.removed) {
        rt.log(`job ${job.id}: removed during ${phase}; the queue owns the tree`);
    } else {
        await beforePark?.();
        const verdict = await rt.board.suspend(job);
        rt.log(
            verdict === 'lost'
                ? `job ${job.id}: stopped during ${phase}, but the board had already reclaimed it`
                : `job ${job.id}: stopped during ${phase} — nothing more ran, the board has settled the turn`
        );
    }
    return true;
}

/**
 * The ONE setup conclusion: the claim goes back, the attempt settles, the line is said, the verdict
 * is reported — in that order, because a replacement claimant may start the moment the job is
 * completed (issue #469).
 */
export async function concludeSetup(ctx: AttemptCtx, halt: SetupHalt): Promise<void> {
    const { rt, job } = ctx;
    await handBackFence(ctx);
    await ctx.settle();
    rt.log(`job ${job.id}: ${halt.log}`);
    if (halt.halt === 'leave') return;
    const what = halt.halt === 'concluded' ? 'conclusion' : 'failure';
    await report(rt, job, halt.verdict).catch((e: Error) =>
        rt.log(`job ${job.id}: could not report the ${what}: ${e.message}`)
    );
}
