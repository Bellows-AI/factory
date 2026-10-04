/**
 * The verdict half of one attempt: whether a finished run is publish-due, the publish itself,
 * and the report that lands the outcome on the board — split out of `loop-run.ts` purely for
 * that file's line budget. The attempt's own fencing (the setup, the run, the stand-downs)
 * stays there; everything from "is a publish due" to "the verdict is reported" lives here, and
 * `loop-run.ts` is the only importer.
 */

import type { Board, BoardJob, FailureKind, LeaseState } from './board.js';
import type { HelperFailureReport } from './helpers.js';
import type { GateFailure } from './loop-gates.js';
import type { LoopRuntime } from './loop-types.js';
import type { PublishResult } from './publish.js';
import type { DeadService, RunOutcome } from './runner.js';
import type { GateRunNote, TimeoutActivity } from './timeout-note.js';
import { timeoutNote } from './timeout-note.js';

/** Whether the finish reason names a run that stopped talking before it was done. */
function isPrematureFinish(outcome: RunOutcome): boolean {
    const finish = outcome.finishReason;
    // A cache-killed run was cut mid-tool-call, so its finish reason reads as one more
    // premature stop — the cache note already says the whole story.
    return typeof finish === 'string' && finish !== 'stop' && !outcome.cacheLost;
}

/** What decides whether a finished run is publish-due: its own outcome plus every failure kind. */
interface PublishGate {
    outcome: RunOutcome;
    failure: GateFailure | null;
    deadServices: readonly DeadService[];
    helperFailure: HelperFailureReport | null;
}

/**
 * Publishes a succeeded, ungated-or-passed run — the deterministic end of a task. Answers null
 * when the run does not qualify (a failure, a timeout, a premature stop, or publish disabled).
 */
export async function publishIfDue(rt: LoopRuntime, job: BoardJob, gate: PublishGate): Promise<PublishResult | null> {
    const { outcome, failure, deadServices, helperFailure } = gate;
    const { board, runner, log } = rt;
    if (
        outcome.exitCode !== 0 ||
        outcome.timedOut ||
        isPrematureFinish(outcome) ||
        failure ||
        deadServices.length > 0 ||
        helperFailure ||
        job.publish === false ||
        !runner.publishGit
    ) {
        return null;
    }
    // The claim's GITHUB_TOKEN was minted at claim time, and a run can outlive its hour. Ask the
    // board for a publish-fresh one; null keeps the claim env, the shape every short run still
    // publishes with.
    const publishToken = await board.publishToken(job);
    if (!publishToken) {
        log(`job ${job.id}: publish-token ask answered nothing fresh — publishing with the claim env`);
    }
    return runner.publishGit(job, publishToken ?? undefined);
}

/** The publication identity to ride the verdict, only when the publish really happened and landed. */
function publicationOf(
    published: PublishResult | null
): NonNullable<Parameters<Board['complete']>[1]['publication']> | null {
    if (
        published?.published &&
        published.repository &&
        published.prNumber &&
        published.prUrl &&
        published.branch &&
        published.baseBranch
    ) {
        return {
            repo: published.repository,
            prNumber: published.prNumber,
            prUrl: published.prUrl,
            headBranch: published.branch,
            baseBranch: published.baseBranch,
        };
    }
    return null;
}

/** What one attempt's conclusion needs to build and report its verdict. */
export interface FinishCtx {
    job: BoardJob;
    outcome: RunOutcome;
    failure: GateFailure | null;
    /** The declared services found dead before the gates, which skipped them (issue #423). */
    deadServices: readonly DeadService[];
    helperFailure: HelperFailureReport | null;
    published: PublishResult | null;
    /** When the run ended — the stamp the timeout note's ages are measured from. */
    endedAt: number;
    /** The pump's liveness read at the moment the run ended — the timeout note's raw material. */
    activity: TimeoutActivity;
    /** The ad-hoc gate server's latest verdicts, read before the session's teardown clears them. */
    gateRuns: readonly GateRunNote[];
}

/** The structured failure kind a verdict's terminal conditions name, in precedence order. */
export function verdictFailureKind(
    finish: Pick<FinishCtx, 'outcome' | 'failure' | 'deadServices' | 'helperFailure'>,
    publishUnlanded: boolean,
    status: 'succeeded' | 'failed'
): FailureKind | null {
    if (finish.outcome.timedOut) return 'timeout';
    if (finish.outcome.cacheLost) return 'cache_lost';
    if (finish.deadServices.length > 0) return 'services';
    if (finish.failure) return 'gate';
    if (finish.helperFailure) return 'helper';
    if (publishUnlanded) return 'publish';
    // Everything else that lands failed — a non-zero exit, a premature finish, a refused
    // `.bellows.yaml` — is the runner erroring. A success carries no kind at all.
    return status === 'failed' ? 'runner_error' : null;
}

/** One dead service in the verdict output: how it ended, then what it last printed. */
function deadServiceNote(dead: DeadService): string {
    const how = `exit ${dead.exitCode ?? 'unknown'}${dead.reason ? ` (${dead.reason})` : ''}`;
    const tail = dead.logTail.trim() ? `\n${dead.logTail.trimEnd()}` : '';
    return `\n[driver] service "${dead.name}" (${dead.image}) ${dead.state} — ${how}; declared gates skipped${tail}`;
}

/** The verdict output text, annotated with every terminal condition worth telling the author about. */
function buildOutput(rt: LoopRuntime, finish: FinishCtx, publishUnlanded: boolean): string {
    const { job, outcome, failure, helperFailure, published } = finish;
    const { config, log } = rt;
    let output = outcome.timedOut
        ? `${outcome.output}\n${timeoutNote(config.jobTimeoutMs, finish.activity, finish.gateRuns, finish.endedAt)}`
        : outcome.output;
    if (published?.published) {
        output = `${output}\n[driver] published ${published.branch}${published.prUrl ? ` — ${published.prUrl}` : ''}`;
    }
    if (published && published.ok && !published.published) {
        // A silent no-op is how a missing `docker run` once hid behind "the checkout has not
        // been cloned yet" — the reason is the only way to tell an ordinary clean tree from a
        // publisher that cannot see the tree at all.
        log(`job ${job.id}: nothing to publish: ${published.reason}`);
    }
    if (publishUnlanded) {
        output = `${output}\n[driver] publish failed — the work did not land: ${published?.reason}`;
    }
    if (outcome.cacheLost) {
        output =
            `${output}\n[driver] killed — the model provider stopped serving prompt cache: ` +
            `${outcome.cacheLost}. Every turn was re-reading the whole context, so the run was ` +
            'burning its time budget without progressing. Retry when the cache is healthy again, or on another model.';
    }
    if (isPrematureFinish(outcome)) {
        // The finish reason says the run stopped talking; the session's last provider error,
        // when the scrape lifted one, says WHY.
        const cause = outcome.providerError ? ` The session's last provider error: ${outcome.providerError}.` : '';
        output =
            `${output}\n[driver] the agent's run ended before it finished (opencode finish reason: "${outcome.finishReason}") — ` +
            `exit 0, but no completed final message.${cause} Re-queue the task, or follow up to continue the session.`;
    }
    output += finish.deadServices.map(deadServiceNote).join('');
    if (failure) {
        output = `${output}\n[driver] gate "${failure.name}" failed (exit ${failure.exitCode})\n${failure.output}`;
    }
    if (helperFailure) {
        output =
            `${output}\n[driver] helper "${helperFailure.helperId}" failed ` +
            `(${helperFailure.result.reason}): ${helperFailure.result.message}`;
    }
    return output;
}

/** Reports the run's final verdict to the board, after settle() and any publish attempt. */
export async function reportFinish(rt: LoopRuntime, finish: FinishCtx): Promise<void> {
    const { job, outcome, failure, helperFailure, published } = finish;
    const { log } = rt;
    const publishUnlanded = published !== null && !published.ok;
    const status =
        outcome.exitCode === 0 &&
        !outcome.timedOut &&
        !outcome.cacheLost &&
        !failure &&
        finish.deadServices.length === 0 &&
        !helperFailure &&
        !isPrematureFinish(outcome) &&
        !publishUnlanded
            ? 'succeeded'
            : 'failed';
    const exitCode = failure ? failure.exitCode : outcome.exitCode;
    const output = buildOutput(rt, finish, publishUnlanded);
    const publication = publicationOf(published);
    const failureKind = verdictFailureKind(finish, publishUnlanded, status);

    const verdict = await report(rt, job, {
        status,
        exitCode,
        output,
        contextTokens: outcome.contextTokens ?? null,
        contextCostUsd: outcome.costUsd ?? null,
        // A number only: an unmeasured read stays off the report and the board stores null.
        ...(typeof outcome.agentTurns === 'number' ? { agentTurns: outcome.agentTurns } : {}),
        // The run's last words, when the close-time read lifted them; absent stays absent.
        ...(outcome.summary ? { summary: outcome.summary } : {}),
        // The structured failure reason (issue #339); a success reports no kind at all.
        ...(failureKind ? { failureKind } : {}),
        ...(publication ? { publication } : {}),
    });
    log(
        verdict === 'lost'
            ? `job ${job.id}: finished ${status}, but the board had already reclaimed it`
            : `job ${job.id}: ${status} (exit ${exitCode}${failure ? ', gates' : ''}${helperFailure ? ', helper' : ''})`
    );
}

export async function report(
    rt: LoopRuntime,
    job: BoardJob,
    result: Parameters<Board['complete']>[1]
): Promise<LeaseState> {
    return rt.report(job, result);
}
