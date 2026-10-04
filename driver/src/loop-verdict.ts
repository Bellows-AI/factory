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
import type { RunOutcome } from './runner.js';
import type { GateRunNote, TimeoutActivity } from './timeout-note.js';
import { timeoutNote } from './timeout-note.js';

/** Whether the finish reason names a run that stopped talking before it was done. */
export function isPrematureFinish(outcome: RunOutcome): boolean {
    const finish = outcome.finishReason;
    // A cache-killed run was cut mid-tool-call, so its finish reason reads as one more
    // premature stop — the cache note already says the whole story.
    return typeof finish === 'string' && finish !== 'stop' && !outcome.cacheLost;
}

/** The line the master prompt (server/src/db/master-prompt.ts) tells a blocked agent to end on. */
export const BLOCKED_MARKER = 'FACTORY_BLOCKED:';
/** How far back in the output tail a marker line still counts as the run's final message. */
const BLOCKED_TAIL_LINES = 20;
const BLOCKED_REASON_MAX_CHARS = 300;

const blockedText = (rest: string): string => rest.trim().slice(0, BLOCKED_REASON_MAX_CHARS) || 'no reason given';

/**
 * The reason the agent reported it is blocked, or null. The close-time summary is the run's
 * final message collapsed to one line, so the marker counts anywhere in it; it is head-capped,
 * so a marker the cap cut off is still found as a line of the output tail's last lines.
 */
export function blockedReason(outcome: RunOutcome): string | null {
    const at = outcome.summary?.lastIndexOf(BLOCKED_MARKER) ?? -1;
    if (outcome.summary && at >= 0) return blockedText(outcome.summary.slice(at + BLOCKED_MARKER.length));
    const lines = outcome.output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-BLOCKED_TAIL_LINES);
    const marker = lines.findLast((line) => line.startsWith(BLOCKED_MARKER));
    return marker === undefined ? null : blockedText(marker.slice(BLOCKED_MARKER.length));
}

/**
 * Why the declared gates must not run over this run, or null when they should: an agent that
 * did not finish cleanly left no work for a gate to judge, and a failed gate over it would fire
 * the workflow's `gate-failed` edge on work that never happened. A timeout still runs them.
 */
export function gateSkipReason(outcome: RunOutcome, blocked: string | null): string | null {
    if (blocked !== null) return 'the agent reported it is blocked';
    if (outcome.cacheLost) return 'the run was killed for prompt-cache loss';
    if (outcome.exitCode !== 0 && !outcome.timedOut) {
        return `the agent's run exited ${outcome.exitCode ?? 'without an exit code'}`;
    }
    if (isPrematureFinish(outcome)) return "the agent's run ended before it finished";
    return null;
}

/** What decides whether a finished run is publish-due: its own outcome plus every failure kind. */
interface PublishGate {
    outcome: RunOutcome;
    failure: GateFailure | null;
    helperFailure: HelperFailureReport | null;
    /** The agent's own blocked report — no work to publish. */
    blocked: string | null;
}

/**
 * Publishes a succeeded, ungated-or-passed run — the deterministic end of a task. Answers null
 * when the run does not qualify (a failure, a timeout, a premature stop, or publish disabled).
 */
export async function publishIfDue(rt: LoopRuntime, job: BoardJob, gate: PublishGate): Promise<PublishResult | null> {
    const { outcome, failure, helperFailure, blocked } = gate;
    const { board, runner, log } = rt;
    if (
        blocked !== null ||
        outcome.exitCode !== 0 ||
        outcome.timedOut ||
        isPrematureFinish(outcome) ||
        failure ||
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
    helperFailure: HelperFailureReport | null;
    published: PublishResult | null;
    /** When the run ended — the stamp the timeout note's ages are measured from. */
    endedAt: number;
    /** The pump's liveness read at the moment the run ended — the timeout note's raw material. */
    activity: TimeoutActivity;
    /** The ad-hoc gate server's latest verdicts, read before the session's teardown clears them. */
    gateRuns: readonly GateRunNote[];
    /** The agent's blocked report (`blockedReason`), or null. */
    blocked: string | null;
    /** Why declared gates were skipped (`gateSkipReason`), or null when they ran or none exist. */
    gatesSkipped: string | null;
    /** Whether a failed gate's tree differs from the synced one; null when unmeasured. */
    treeChanged: boolean | null;
}

/** The structured failure kind a verdict's terminal conditions name, in precedence order. */
export function verdictFailureKind(
    finish: Pick<FinishCtx, 'outcome' | 'failure' | 'helperFailure' | 'blocked'>,
    publishUnlanded: boolean,
    status: 'succeeded' | 'failed'
): FailureKind | null {
    if (finish.outcome.timedOut) return 'timeout';
    if (finish.outcome.cacheLost) return 'cache_lost';
    if (finish.blocked !== null) return 'blocked';
    if (finish.failure) return 'gate';
    if (finish.helperFailure) return 'helper';
    if (publishUnlanded) return 'publish';
    // Everything else that lands failed — a non-zero exit, a premature finish, a refused
    // `.bellows.yaml` — is the runner erroring. A success carries no kind at all.
    return status === 'failed' ? 'runner_error' : null;
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
    if (finish.blocked !== null) {
        output = `${output}\n[driver] the agent reported it is blocked: ${finish.blocked}`;
    }
    if (finish.gatesSkipped !== null) {
        output = `${output}\n[driver] gates skipped — ${finish.gatesSkipped}`;
    }
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

/** Succeeded only when nothing at all went wrong: the run, the gates, the helpers, the publish. */
function verdictStatus(finish: FinishCtx, publishUnlanded: boolean): 'succeeded' | 'failed' {
    const { outcome } = finish;
    const clean =
        outcome.exitCode === 0 &&
        !outcome.timedOut &&
        !outcome.cacheLost &&
        !isPrematureFinish(outcome) &&
        finish.blocked === null;
    return clean && !finish.failure && !finish.helperFailure && !publishUnlanded ? 'succeeded' : 'failed';
}

/** Reports the run's final verdict to the board, after settle() and any publish attempt. */
export async function reportFinish(rt: LoopRuntime, finish: FinishCtx): Promise<void> {
    const { job, outcome, failure, helperFailure, published } = finish;
    const { log } = rt;
    const publishUnlanded = published !== null && !published.ok;
    const status = verdictStatus(finish, publishUnlanded);
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
        ...(finish.treeChanged !== null ? { treeChanged: finish.treeChanged } : {}),
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
