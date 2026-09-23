/**
 * Reading a run's outcome back out of its own session store — executor-neutral. The opencode
 * readout parser, the claude-code turn-count parser and the rule for when that read applies, and
 * the live cache watch's policy (`cacheCollapse`) with its probe parser. Each executor supplies
 * only the transport: throwaway containers in `docker-close-read.ts`, Jobs in `k8s-podspec.ts` /
 * `k8s-runner.ts`. The kubernetes runner does not run the cache watch yet (docs/kubernetes.md).
 */

import type { BoardJob } from './board.js';
import { UUID } from './claim.js';
import type { DriverConfig } from './config.js';
import type { RunOutcome, RunSession } from './runner.js';
import { CLAUDE_CODE } from './executors.js';

/** What the readout answers: the session the run used, how it ended, and the context it reached. */
export interface OpencodeRunOutcome {
    sessionId: string | null;
    finishReason: string | null;
    contextTokens: number | null;
    costUsd: number | null;
    /**
     * The agent turns the root conversation took. Null when the readout answered no count —
     * unmeasured, never zero.
     */
    agentTurns: number | null;
    /** The run's last assistant text, or null when the read answered none — unmeasured, never empty. */
    summary: string | null;
    /**
     * What the readout says went wrong, when it says anything. The script prints one on every
     * failure it can name; a readout that answers nothing at all parses with this null.
     */
    error: string | null;
}

/** A finite, non-negative number, or null for anything else — the shape a readout's cost/tokens field must have. */
function finiteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A non-negative integer, or null for anything else — the shape a readout's turn count must have. */
function nonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** A non-empty string, or null for anything else. */
function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value ? value : null;
}

/** Pulls the session id, finish reason and context stats out of the readout, tolerating anything else. */
export function parseOpencodeRunOutcome(stdout: string): OpencodeRunOutcome {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    const nothing = {
        sessionId: null,
        finishReason: null,
        contextTokens: null,
        costUsd: null,
        agentTurns: null,
        summary: null,
        error: null,
    };
    try {
        const parsed = JSON.parse(line) as {
            id?: unknown;
            finish?: unknown;
            tokens?: unknown;
            cost?: unknown;
            turns?: unknown;
            summary?: unknown;
            error?: unknown;
        };
        const sessionId = typeof parsed.id === 'string' && /^ses_[A-Za-z0-9._-]+$/.test(parsed.id) ? parsed.id : null;
        const finishReason = nonEmptyString(parsed.finish);
        const rawTokens = finiteNonNegativeNumber(parsed.tokens);
        const contextTokens = rawTokens === null ? null : Math.round(rawTokens);
        const costUsd = finiteNonNegativeNumber(parsed.cost);
        const agentTurns = nonNegativeInteger(parsed.turns);
        const summary = nonEmptyString(parsed.summary);
        const error = nonEmptyString(parsed.error);
        return { sessionId, finishReason, contextTokens, costUsd, agentTurns, summary, error };
    } catch {
        return nothing;
    }
}

/** The empty `OpencodeRunOutcome` a failed or empty readout answers — every field unmeasured but `error`. */
export function opencodeReadFailed(error: string | null): OpencodeRunOutcome {
    return {
        sessionId: null,
        finishReason: null,
        contextTokens: null,
        costUsd: null,
        agentTurns: null,
        summary: null,
        error,
    };
}

/**
 * Retries one opencode close-time session readout up to three times, half a second apart —
 * shared by both executors' scrapes (docker: a throwaway container; kubernetes: a Job). NOT
 * single-shot, and not only when the readout fails outright: the CLI exited a moment ago, and its
 * session database may still be mid-checkpoint — a read-only open of a WAL that needs recovery
 * fails, then succeeds milliseconds later. `readOnce` answers one of three ways — a session, an
 * error, or nothing — and ALL but the first read as "no session yet", so the retries fire on the
 * session being missing, whatever the reason. The reason carried back is the LATEST non-null
 * error seen across attempts, for when every one of them came up empty.
 */
const OPENCODE_SESSION_READOUT_RETRIES = 3;
const OPENCODE_SESSION_READOUT_RETRY_DELAY_MS = 500;

export async function readOpencodeWithRetries(
    readOnce: () => Promise<OpencodeRunOutcome>,
    sleep: (ms: number) => Promise<void>
): Promise<{ scraped: OpencodeRunOutcome; reason: string | null }> {
    let scraped = opencodeReadFailed(null);
    let reason: string | null = null;
    for (let attempt = 0; attempt < OPENCODE_SESSION_READOUT_RETRIES && !scraped.sessionId; attempt += 1) {
        if (attempt > 0) await sleep(OPENCODE_SESSION_READOUT_RETRY_DELAY_MS);
        scraped = await readOnce();
        reason = scraped.error ?? reason;
    }
    return { scraped, reason };
}

/**
 * Merges one opencode session scrape onto the run's outcome, in place — shared by both executors,
 * whose close-time reads answer the same `OpencodeRunOutcome` shape. A session-less scrape
 * carries no verdict of its own: `reason` (the read's own failure, when it has one) or a generic
 * "nothing in the database" rides `readoutError`. A scraped session's own trailing error is the
 * RUN's last provider error, not the read's failure — carried as its own field so the verdict can
 * name the cause of a premature stop.
 */
export function mergeOpencodeOutcome(outcome: RunOutcome, scraped: OpencodeRunOutcome, reason: string | null): void {
    if (!scraped.sessionId) {
        outcome.readoutError = reason ?? 'the readout answered nothing (no session in the database)';
        return;
    }
    outcome.sessionId = scraped.sessionId;
    if (scraped.finishReason) outcome.finishReason = scraped.finishReason;
    if (scraped.contextTokens !== null) outcome.contextTokens = scraped.contextTokens;
    if (scraped.costUsd !== null) outcome.costUsd = scraped.costUsd;
    // The readout's turn count rides the same line: assistant response cycles of the root
    // session, already scoped by the parent_id-is-null selection the script makes.
    if (scraped.agentTurns !== null) outcome.agentTurns = scraped.agentTurns;
    if (scraped.summary) outcome.summary = scraped.summary;
    if (scraped.error) outcome.providerError = scraped.error;
}

/** What the claude close-time read answered: the turn count and the run's last words, or nulls. */
export function parseClaudeCloseRead(stdout: string): { turns: number | null; summary: string | null } {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
        const parsed = JSON.parse(line) as { turns?: unknown; summary?: unknown };
        return {
            turns:
                typeof parsed.turns === 'number' && Number.isInteger(parsed.turns) && parsed.turns >= 0
                    ? parsed.turns
                    : null,
            summary: typeof parsed.summary === 'string' && parsed.summary ? parsed.summary : null,
        };
    } catch {
        return { turns: null, summary: null };
    }
}

/**
 * Whether this run gets a close-time agent-turn read at all. Opencode's count rides its own
 * readout; claude-code's needs the session id the runner minted and a HEADLESS run — Remote
 * Control keeps an interactive conversation that continues after any single read, so its count
 * stays unmeasured rather than freezing a mid-conversation number (the design's null posture).
 */
export function readsAgentTurns(
    config: DriverConfig,
    job: Pick<BoardJob, 'executorType'>,
    session: RunSession | null
): boolean {
    return job.executorType === CLAUDE_CODE && !config.remoteControl && session !== null && UUID.test(session.id);
}

/*
 * The cache watch. A model provider that silently stops serving prompt-cache hits mid-run turns
 * every following turn into a full re-ingestion of the context at a fraction of the speed — the
 * first observed case went from ~25s turns to 2.5-4.5 minute turns and ground into the job
 * timeout having explored and edited nothing. The watch reads the same session database the
 * close-time readout does, but WHILE the run is live, and kills the job when enough turns have
 * completed with no cache reads over a real context and each of them itself slow — the point
 * where "no cache" has become "no progress". Killing early reports the cause; the timeout
 * reports only a corpse.
 */

/** Completed assistant turns the watch inspects, as the session database records them. */
export interface OpencodeCacheTurn {
    /** Input tokens that were NOT served from cache — the whole context, when the cache is dead. */
    input: number;
    /** Input tokens served from cache. Zero on every turn is the signature of a dead cache. */
    cacheRead: number;
    /** How long the turn took, wall clock. A dead cache is only a problem when it costs time. */
    ms: number;
}

/** The numbers the trigger fires on, each named for the test that pins it. */
export const CACHE_WATCH_TURNS = 3;

export const CACHE_WATCH_MIN_INPUT_TOKENS = 20_000;

export const CACHE_WATCH_MIN_TURN_MS = 60_000;

/**
 * The cache watch's verdict over the newest completed turns: a human-readable reason when they
 * show a provider that has stopped caching, null otherwise. Every turn must fail on all three
 * axes — no cached input, a real context, and a slow turn — so a provider that never cached but
 * answers quickly is left alone, and one fluke turn cannot kill a job. The reason carries the
 * observed numbers, because "failed" alone would send its reader down the wrong path.
 */
/** What a turn's input token count is divided by to print as "Nk" in the collapse reason. */
const TOKENS_PER_K = 1000;

const MS_PER_SECOND = 1000;

export function cacheCollapse(turns: OpencodeCacheTurn[]): string | null {
    if (turns.length < CACHE_WATCH_TURNS) return null;
    const dead = turns.every(
        (t) => t.cacheRead === 0 && t.input >= CACHE_WATCH_MIN_INPUT_TOKENS && t.ms >= CACHE_WATCH_MIN_TURN_MS
    );
    if (!dead) return null;
    const inputs = turns.map((t) => `${Math.round(t.input / TOKENS_PER_K)}k`).join('/');
    const seconds = turns.map((t) => Math.round(t.ms / MS_PER_SECOND));
    const span =
        Math.min(...seconds) === Math.max(...seconds)
            ? `${Math.min(...seconds)}s`
            : `${Math.min(...seconds)}-${Math.max(...seconds)}s`;
    return `${turns.length} consecutive turns with no prompt-cache reads ` + `(input ${inputs} tokens, ${span} each)`;
}

/** What the probe answers: the session it found, its newest completed turns, and any failure. */
export interface OpencodeCacheProbe {
    sessionId: string | null;
    turns: OpencodeCacheTurn[];
    error: string | null;
}

const isTurn = (value: unknown): value is OpencodeCacheTurn => {
    if (typeof value !== 'object' || value === null) return false;
    const t = value as Record<string, unknown>;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    return num(t.input) && num(t.cacheRead) && num(t.ms);
};

/** Pulls the session id and turns out of the probe's answer, tolerating anything else. */
export function parseOpencodeCacheProbe(stdout: string): OpencodeCacheProbe {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    const nothing = { sessionId: null, turns: [], error: null };
    try {
        const parsed = JSON.parse(line) as { id?: unknown; turns?: unknown; error?: unknown };
        const sessionId = typeof parsed.id === 'string' && /^ses_[A-Za-z0-9._-]+$/.test(parsed.id) ? parsed.id : null;
        const turns = Array.isArray(parsed.turns) ? parsed.turns.filter(isTurn).slice(0, CACHE_WATCH_TURNS) : [];
        const error = typeof parsed.error === 'string' && parsed.error ? parsed.error : null;
        return { sessionId, turns, error };
    } catch {
        return nothing;
    }
}
