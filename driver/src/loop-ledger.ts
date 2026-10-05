/**
 * The attempt's fault ledger: every terminal condition one attempt hit, as data. The verdict's
 * status, failure kind, gate eligibility, publish eligibility and annotated output are all
 * functions of this list, so no path can forget one check — adding a condition is adding a
 * `Fault`, never another if-chain. Pure: nothing here touches the board, a runner or the clock.
 */

import type { FailureKind } from './board.js';
import type { HelperFailureReport } from './helpers.js';
import type { GateFailure } from './loop-gates.js';
import type { PublishResult } from './publish.js';
import type { DeadService, RunOutcome } from './runner.js';

/** One terminal condition of the attempt. */
export interface Fault {
    kind: FailureKind;
    /** The line the verdict output carries (after `[driver] `), or null when the kind needs none. */
    note: string | null;
    /** Whether the declared gates still run over this fault — a timeout leaves work worth judging. */
    gatesStillRun: boolean;
    /** Why the gates were skipped over this fault; set exactly when `gatesStillRun` is false. */
    skipWhy: string | null;
}

export type Ledger = readonly Fault[];

/**
 * Which kind a verdict names when several faults stand, most decisive first. A non-zero exit
 * outranks a helper failure: post-helpers run after an unclean run too, so the exit is the cause.
 */
export const RANK: readonly FailureKind[] = [
    'timeout',
    'cache_lost',
    'blocked',
    'services',
    'gate',
    'runner_error',
    'helper',
    'publish',
];

/** The line the master prompt (server/src/db/master-prompt.ts) tells a blocked agent to end on. */
export const BLOCKED_MARKER = 'FACTORY_BLOCKED:';
/** How far back in the output tail a marker line still counts as the run's final message. */
const BLOCKED_TAIL_LINES = 20;
const BLOCKED_REASON_MAX_CHARS = 300;

const blockedText = (rest: string): string => rest.trim().slice(0, BLOCKED_REASON_MAX_CHARS) || 'no reason given';

/**
 * The reason the agent reported it is blocked, or null. A close-time read that found the final
 * message settles it (`blockedLine`, its last line — never a mention inside the collapsed
 * summary); only a run with no such read falls back to a marker line among the output tail's last.
 */
function blockedReason(outcome: RunOutcome): string | null {
    if (outcome.blockedLine !== undefined) return blockedText(outcome.blockedLine);
    if (outcome.summary) return null;
    const lines = outcome.output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-BLOCKED_TAIL_LINES);
    const marker = lines.findLast((line) => line.startsWith(BLOCKED_MARKER));
    return marker === undefined ? null : blockedText(marker.slice(BLOCKED_MARKER.length));
}

const skips = (kind: FailureKind, note: string | null, skipWhy: string): Fault => ({
    kind,
    note,
    gatesStillRun: false,
    skipWhy,
});

/**
 * What the agent's own run left behind. An agent that did not finish cleanly left no work for a
 * gate to judge — a failed gate over it would fire the workflow's `gate-failed` edge on work that
 * never happened — so only a timeout keeps the gates running.
 */
export function agentFaults(outcome: RunOutcome): Fault[] {
    const faults: Fault[] = [];
    if (outcome.timedOut) faults.push({ kind: 'timeout', note: null, gatesStillRun: true, skipWhy: null });
    if (outcome.cacheLost) {
        faults.push(
            skips(
                'cache_lost',
                `killed — the model provider stopped serving prompt cache: ${outcome.cacheLost}. ` +
                    'Every turn was re-reading the whole context, so the run was burning its time budget ' +
                    'without progressing. Retry when the cache is healthy again, or on another model.',
                'the run was killed for prompt-cache loss'
            )
        );
    }
    if (outcome.exitCode !== 0) {
        const why = `the agent's run exited ${outcome.exitCode ?? 'without an exit code'}`;
        faults.push(
            outcome.timedOut
                ? { kind: 'runner_error', note: null, gatesStillRun: true, skipWhy: null }
                : skips('runner_error', null, why)
        );
    }
    const finish = outcome.finishReason;
    // A cache-killed run was cut mid-tool-call, so its finish reason reads as one more
    // premature stop — the cache fault already says the whole story.
    if (typeof finish === 'string' && finish !== 'stop' && !outcome.cacheLost) {
        // The finish reason says the run stopped talking; the session's last provider error,
        // when the scrape lifted one, says WHY.
        const cause = outcome.providerError ? ` The session's last provider error: ${outcome.providerError}.` : '';
        faults.push(
            skips(
                'runner_error',
                `the agent's run ended before it finished (opencode finish reason: "${finish}") — ` +
                    `exit 0, but no completed final message.${cause} Re-queue the task, or follow up to continue the session.`,
                "the agent's run ended before it finished"
            )
        );
    }
    const blocked = blockedReason(outcome);
    if (blocked !== null) {
        faults.push(
            skips('blocked', `the agent reported it is blocked: ${blocked}`, 'the agent reported it is blocked')
        );
    }
    return faults;
}

/** One dead service in the verdict output: how it ended, then what it last printed. */
function deadServiceNote(dead: DeadService): string {
    const how = `exit ${dead.exitCode ?? 'unknown'}${dead.reason ? ` (${dead.reason})` : ''}`;
    const tail = dead.logTail.trim() ? `\n${dead.logTail.trimEnd()}` : '';
    return `service "${dead.name}" (${dead.image}) ${dead.state} — ${how}; declared gates skipped${tail}`;
}

/** Everything the phases after the agent found, beside its own outcome. */
export interface LedgerParts {
    outcome: RunOutcome;
    failure: GateFailure | null;
    deadServices: readonly DeadService[];
    helperFailure: HelperFailureReport | null;
    /** The publish result, once a publish has been attempted; null before or without one. */
    published: PublishResult | null;
}

/** The whole ledger, in the order its notes read in the verdict output. */
export function ledgerOf(parts: LedgerParts): Ledger {
    const { outcome, failure, deadServices, helperFailure, published } = parts;
    const faults = agentFaults(outcome);
    const done = { gatesStillRun: true, skipWhy: null };
    if (published && !published.ok) {
        faults.unshift({
            kind: 'publish',
            note: `publish failed — the work did not land: ${published.reason}`,
            ...done,
        });
    }
    for (const dead of deadServices) faults.push({ kind: 'services', note: deadServiceNote(dead), ...done });
    if (failure) {
        faults.push({
            kind: 'gate',
            note: `gate "${failure.name}" failed (exit ${failure.exitCode})\n${failure.output}`,
            ...done,
        });
    }
    if (helperFailure) {
        faults.push({
            kind: 'helper',
            note: `helper "${helperFailure.helperId}" failed (${helperFailure.result.reason}): ${helperFailure.result.message}`,
            ...done,
        });
    }
    return faults;
}

/** Succeeded only when nothing at all went wrong: the run, the gates, the helpers, the publish. */
export const statusOf = (ledger: Ledger): 'succeeded' | 'failed' => (ledger.length === 0 ? 'succeeded' : 'failed');

/** The structured failure kind the most decisive fault names; a success carries none. */
export function kindOf(ledger: Ledger): FailureKind | null {
    return RANK.find((kind) => ledger.some((fault) => fault.kind === kind)) ?? null;
}

/** Whether the declared gates run over this ledger. */
export const gatesEligible = (ledger: Ledger): boolean => ledger.every((fault) => fault.gatesStillRun);

/** Why the gates were skipped, or null when they were eligible — the most decisive blocking fault's reason. */
export function skipWhyOf(ledger: Ledger): string | null {
    const blocking = ledger.filter((fault) => !fault.gatesStillRun);
    const top = [...blocking].sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind))[0];
    return top?.skipWhy ?? null;
}

/**
 * Why the post-run helpers must not run, or null when they should: a run that did not finish
 * cleanly has no verdict for a helper to contribute, and a github-writing one would speak for
 * work that did not land. Unlike the gates, a timeout counts; a failed gate over a clean run
 * does not, since that failure is what such a helper reports on.
 */
export function postHelperSkipWhy(outcome: RunOutcome): string | null {
    if (outcome.timedOut) return 'the agent timed out';
    return skipWhyOf(agentFaults(outcome));
}

/** Whether a finished run is publish-due: nothing at all went wrong before the publish. */
export const publishEligible = (ledger: Ledger): boolean => ledger.length === 0;

/**
 * The `[driver]` lines the ledger's faults add to the verdict output. `gatesSkipped`, when the
 * declared gates were skipped, reads right after the last fault that skipped them.
 */
export function outputOf(ledger: Ledger, gatesSkipped: string | null = null): string {
    const lines = ledger.flatMap((fault) => (fault.note === null ? [] : [`\n[driver] ${fault.note}`]));
    if (gatesSkipped === null) return lines.join('');
    const lastSkip = ledger.findLastIndex((fault) => !fault.gatesStillRun);
    const at = ledger.slice(0, lastSkip + 1).filter((fault) => fault.note !== null).length;
    lines.splice(at, 0, `\n[driver] gates skipped — ${gatesSkipped}`);
    return lines.join('');
}
