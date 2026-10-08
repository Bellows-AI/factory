/**
 * The verdict half of one attempt: the publish itself and the report that lands the outcome on
 * the board — split out of `loop-run.ts` purely for that file's line budget. The attempt's own
 * fencing (the setup, the run, the stand-downs) stays there; what is publish-due, the status, the
 * failure kind and the annotations all come from the fault ledger (`loop-ledger.ts`).
 * `loop-run.ts` is the only importer.
 */

import type { Board, BoardJob, LeaseState, VerdictEvidence } from './board.js';
import { runTimeoutMs } from './claim.js';
import type { HelperFailureReport } from './helpers.js';
import type { GateFailure } from './loop-gates.js';
import {
    deadServiceNote,
    kindOf,
    ledgerOf,
    type Ledger,
    outputOf,
    publishEligible,
    servicesOnly,
    statusOf,
} from './loop-ledger.js';
import type { LoopRuntime } from './loop-types.js';
import { type PublishOptions, type PublishResult, publishFailed } from './publish.js';
import type { DeadService, RunOutcome } from './runner.js';
import type { GateRunNote, TimeoutActivity } from './timeout-note.js';
import { timeoutNote } from './timeout-note.js';

/**
 * Whether this attempt's ledger calls for a publish at all: succeeded, ungated or passed, publish
 * not disabled, and a runner that can push. The caller fences around the two halves below.
 */
function publishDue(rt: LoopRuntime, job: BoardJob, ledger: Ledger): boolean {
    return publishEligible(ledger) && job.publish !== false && Boolean(rt.runner.publishGit);
}

/**
 * What this ledger publishes: the end-of-run publish, a draft of finished work the services alone
 * failed — kept recoverable rather than stranded (issue #560) — or nothing.
 */
export function publishModeOf(rt: LoopRuntime, job: BoardJob, ledger: Ledger): 'publish' | 'draft' | null {
    if (publishDue(rt, job, ledger)) return 'publish';
    return servicesOnly(ledger) && job.publish !== false && rt.runner.publishGit ? 'draft' : null;
}

/** The push's options for `mode`, bound to `revision` when the policy named one; none for a plain publish. */
export function publishOptionsOf(mode: 'publish' | 'draft', revision: string | null): PublishOptions | undefined {
    if (mode === 'draft') return revision === null ? { draft: true } : { draft: true, revision };
    return revision === null ? undefined : { revision };
}

/**
 * The publish-fresh token for the push: the claim's GITHUB_TOKEN was minted at claim time, and a run
 * can outlive its hour, so the board is asked for a new one. Null keeps the claim env, the shape
 * every short run still publishes with.
 */
export async function askPublishToken(rt: LoopRuntime, job: BoardJob): Promise<string | null> {
    const publishToken = await rt.board.publishToken(job);
    if (!publishToken)
        rt.log(`job ${job.id}: publish-token ask answered nothing fresh — publishing with the claim env`);
    return publishToken;
}

/**
 * Pushes the branch and opens the PR. Deliberately NOT raced against the stand-down and not
 * abortable: a push already in flight is not a thing the driver can take back, and half a push is
 * worse than a fenced one. The caller fences before asking for the token instead (issue #472).
 */
export async function publishBranch(
    rt: LoopRuntime,
    job: BoardJob,
    publishToken: string | null,
    options?: PublishOptions
): Promise<PublishResult | null> {
    if (!rt.runner.publishGit) return null;
    return rt.runner
        .publishGit(job, publishToken ?? undefined, options)
        .catch((e: Error) => publishFailed(`the publish threw: ${e.message}`));
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
    /** The services found dead before the gates and restarted for them (issue #560): noted, never faults. */
    recoveredServices: readonly DeadService[];
    helperFailure: HelperFailureReport | null;
    published: PublishResult | null;
    /** When the run ended — the stamp the timeout note's ages are measured from. */
    endedAt: number;
    /** How far the agent's questions pushed the run deadline out — the timeout note reports the extended one. */
    deadlineExtensionMs: number;
    /** The pump's liveness read at the moment the run ended — the timeout note's raw material. */
    activity: TimeoutActivity;
    /** The ad-hoc gate server's latest verdicts, read before the session's teardown clears them. */
    gateRuns: readonly GateRunNote[];
    /** Why declared gates were skipped (`skipWhyOf`), or null when they ran or none exist. */
    gatesSkipped: string | null;
    /** Whether a failed gate's tree differs from the synced one; null when unmeasured. */
    treeChanged: boolean | null;
    /** The revision-bound evidence record (set only under a policy); null when none was taken. */
    evidence: VerdictEvidence | null;
    /** Why the evidence policy refused the publish before anything was pushed; null when it did not. */
    policyRefusal: string | null;
}

/** The verdict output text, annotated with every fault on the ledger. */
function buildOutput(rt: LoopRuntime, finish: FinishCtx, ledger: Ledger): string {
    const { job, outcome, published } = finish;
    const { config, log } = rt;
    let output = outcome.timedOut
        ? `${outcome.output}\n${timeoutNote(
              runTimeoutMs(config, job) + finish.deadlineExtensionMs,
              finish.activity,
              finish.gateRuns,
              finish.endedAt
          )}`
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
    const recovered = finish.recoveredServices.map((dead) => `\n[driver] ${deadServiceNote(dead, false, true)}`);
    return output + recovered.join('') + outputOf(ledger, finish.gatesSkipped);
}

/** Reports the run's final verdict to the board, after settle() and any publish attempt. */
export async function reportFinish(rt: LoopRuntime, finish: FinishCtx): Promise<void> {
    const { job, outcome, failure, helperFailure, published } = finish;
    const { log } = rt;
    const ledger = ledgerOf(finish);
    const status = statusOf(ledger);
    const exitCode = failure ? failure.exitCode : outcome.exitCode;
    const output = buildOutput(rt, finish, ledger);
    const publication = publicationOf(published);
    const failureKind = kindOf(ledger);

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
        ...(finish.evidence ? { evidence: finish.evidence } : {}),
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
