import type { BoardJob } from './board.js';
import type { HelperFailureReport, HelperPlan, HelperResult } from './helpers.js';
import { formatConcludeOutput, runHelperPlan } from './helpers.js';
import { down, raceStep } from './loop-attempt.js';
import type { JobState } from './loop-attempt.js';
import type { AttemptCtx, LoopRuntime } from './loop-types.js';
import { STOOD_DOWN } from './loop-types.js';

/**
 * The loop's own two ends of the block-helper transport (issue #207, extended by #230's conclude
 * control and composite helper programs): when a declared pre/post helper runs, fenced by the same
 * lease/stop state as sync/gates/publish. Split from `loop-run.ts` purely to keep that file under
 * AGENTS.md's line-count budget — the same seam `loop-gates.ts` already draws for the gate phase.
 * `runHelperPlan` (`helpers.ts`) owns the plain-vs-composite sequencing; this file supplies its own
 * `invokeChild` per phase — the exact fencing (and, for pre, standing the attempt down) each phase
 * already applied to a single plan, now applied identically to every child call a composite makes.
 */

/**
 * Runs the job's declared PRE block-helper steps, in the order the claim carries them, fenced by
 * the same lease/stop state every setup step races against. A required pre-helper that fails
 * reports a NAMED failure without ever launching the agent — the loop's own contract for this
 * phase — and releases the kubernetes checkout fence exactly like the other terminal setup
 * refusals in `loop-run.ts`, since no runner is coming to release it itself. A pre-helper that
 * succeeds with `control: 'conclude'` (issue #230) completes the job through the ordinary board
 * completion path right here — no agent, no gates, no post-helpers, no publish — and stands the
 * attempt down exactly like a failure does, minus the failed status. A job with no declared
 * pre-helpers, or a runner that does not implement `runHelper` (docker before this issue, or any
 * future platform that has not grown one), pays no extra work at all — the ordinary case for every
 * workflow-less and `agent`-node task today (docs/workflows.md: no producer wires a real plan onto
 * a claim yet).
 */
export async function preHelperStep(ctx: AttemptCtx): Promise<typeof STOOD_DOWN | null> {
    const { rt, job, state, settle, standDown } = ctx;
    const { runner, board, log } = rt;
    const plans = (job.helperPlans ?? []).filter((plan) => plan.phase === 'pre');
    if (!plans.length || !runner.runHelper) return null;

    // Applied to every child call a plan makes — one for a plain script plan, several in
    // declared order for a composite — so a stop or lost lease mid-composite is observed between
    // children, not just around the composite as a whole.
    const invokeChild = async (childPlan: HelperPlan): Promise<HelperResult | null> => {
        const token = childPlan.githubWriting ? ((await board.publishToken(job)) ?? undefined) : undefined;
        if (down(state)) {
            await runner.releaseFence?.(job);
            await standDown();
            return null;
        }
        const runningHelper = runner.runHelper!(job, childPlan, token);
        const resultOut = await raceStep(state, runningHelper);
        if (resultOut === null || down(state)) {
            await runner.releaseFence?.(job);
            await standDown();
            return null;
        }
        return resultOut.value;
    };

    for (const plan of plans) {
        const result = await runHelperPlan(plan, invokeChild);
        if (result === null) return STOOD_DOWN;
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
        if (result.control === 'conclude') {
            await runner.releaseFence?.(job);
            await settle();
            log(`job ${job.id}: pre-run helper "${plan.helperId}" concluded the job without launching the agent`);
            await rt
                .report(job, { status: 'succeeded', exitCode: 0, output: formatConcludeOutput(result.output) })
                .catch((e: Error) => log(`job ${job.id}: could not report the conclusion: ${e.message}`));
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
 * mid-helper, and everything after that is dead work the board will refuse anyway. `conclude`
 * (issue #230) is valid only for a PRE helper — a post-helper naming it fails the verdict with a
 * NAMED reason, exactly like any other post-helper failure, rather than being silently ignored.
 */
export async function runPostHelperPhase(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState
): Promise<HelperFailureReport | null> {
    const { runner, board, log } = rt;
    const plans = (job.helperPlans ?? []).filter((plan) => plan.phase === 'post');
    if (!plans.length || !runner.runHelper) return null;

    const invokeChild = async (childPlan: HelperPlan): Promise<HelperResult | null> => {
        if (state.lost) return null;
        const token = childPlan.githubWriting ? ((await board.publishToken(job)) ?? undefined) : undefined;
        if (state.lost) return null;
        return runner.runHelper!(job, childPlan, token);
    };

    for (const plan of plans) {
        const result = await runHelperPlan(plan, invokeChild);
        if (result === null) return null;
        if (!result.ok) {
            log(`job ${job.id}: post-run helper "${plan.helperId}" failed: ${result.reason} — ${result.message}`);
            return { helperId: plan.helperId, result };
        }
        if (result.control === 'conclude') {
            log(
                `job ${job.id}: post-run helper "${plan.helperId}" reported "conclude" — only a pre-run helper ` +
                    'may conclude the job, failing'
            );
            return {
                helperId: plan.helperId,
                result: {
                    ok: false,
                    reason: 'invalid_control',
                    message: 'a post-run helper reported "conclude", which is only valid for a pre-run helper',
                },
            };
        }
    }
    return null;
}
