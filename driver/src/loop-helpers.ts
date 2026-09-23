import type { BoardJob } from './board.js';
import type { HelperFailureReport } from './helpers.js';
import { down, raceStep } from './loop-attempt.js';
import type { JobState } from './loop-attempt.js';
import type { AttemptCtx, LoopRuntime } from './loop-types.js';
import { STOOD_DOWN } from './loop-types.js';

/**
 * The loop's own two ends of the block-helper transport (issue #207): when a declared pre/post
 * helper runs, fenced by the same lease/stop state as sync/gates/publish. Split from `loop-run.ts`
 * purely to keep that file under AGENTS.md's line-count budget — the same seam `loop-gates.ts`
 * already draws for the gate phase.
 */

/**
 * Runs the job's declared PRE block-helper steps, in the order the claim carries them, fenced by
 * the same lease/stop state every setup step races against. A required pre-helper that fails
 * reports a NAMED failure without ever launching the agent — the loop's own contract for this
 * phase — and releases the kubernetes checkout fence exactly like the other terminal setup
 * refusals in `loop-run.ts`, since no runner is coming to release it itself. A job with no
 * declared pre-helpers, or a runner that does not implement `runHelper` (docker before this issue,
 * or any future platform that has not grown one), pays no extra work at all — the ordinary case
 * for every workflow-less and `agent`-node task today (docs/workflows.md: no producer wires a real
 * plan onto a claim yet).
 */
export async function preHelperStep(ctx: AttemptCtx): Promise<typeof STOOD_DOWN | null> {
    const { rt, job, state, settle, standDown } = ctx;
    const { runner, board, log } = rt;
    const plans = (job.helperPlans ?? []).filter((plan) => plan.phase === 'pre');
    if (!plans.length || !runner.runHelper) return null;

    for (const plan of plans) {
        const token = plan.githubWriting ? ((await board.publishToken(job)) ?? undefined) : undefined;
        if (down(state)) {
            await runner.releaseFence?.(job);
            await standDown();
            return STOOD_DOWN;
        }
        const runningHelper = runner.runHelper(job, plan, token);
        const resultOut = await raceStep(state, runningHelper);
        if (resultOut === null || down(state)) {
            await runner.releaseFence?.(job);
            await standDown();
            return STOOD_DOWN;
        }
        const result = resultOut.value;
        if (!result.ok) {
            await runner.releaseFence?.(job);
            await settle();
            log(
                `job ${job.id}: pre-run helper "${plan.helperId}" failed (${result.reason}), ` +
                    'failing without launching the agent'
            );
            await rt
                .report(job, {
                    status: 'failed',
                    exitCode: null,
                    output: `The declared pre-run helper "${plan.helperId}" failed (${result.reason}): ${result.message}`,
                })
                .catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
            return STOOD_DOWN;
        }
    }
    return null;
}

/**
 * Runs the job's declared POST block-helper steps, after the agent's run and its gates have
 * resolved and before publish is decided — the same window `runDeclaredGates` runs in, with the
 * heartbeat still live and `settle()` deliberately not yet called. Unlike the pre-phase, this runs
 * unconditionally once the run itself reached this point (a gate failure or a non-zero exit
 * already dooms the verdict; deciding otherwise would be block-specific policy this generic
 * transport must not encode — see the issue's "no review- or merge-specific branching" boundary).
 * Only `state.lost` is checked, exactly as `runOneGate` checks it: the lease can be reclaimed
 * mid-helper, and everything after that is dead work the board will refuse anyway.
 */
export async function runPostHelperPhase(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState
): Promise<HelperFailureReport | null> {
    const { runner, board, log } = rt;
    const plans = (job.helperPlans ?? []).filter((plan) => plan.phase === 'post');
    if (!plans.length || !runner.runHelper) return null;

    for (const plan of plans) {
        if (state.lost) return null;
        const token = plan.githubWriting ? ((await board.publishToken(job)) ?? undefined) : undefined;
        if (state.lost) return null;
        const result = await runner.runHelper(job, plan, token);
        if (!result.ok) {
            log(`job ${job.id}: post-run helper "${plan.helperId}" failed: ${result.reason} — ${result.message}`);
            return { helperId: plan.helperId, result };
        }
    }
    return null;
}
