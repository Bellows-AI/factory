import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import { workspacesMountArgs } from './docker.js';
import { UUID, opencodeDbPath, runWorkingDir, transcriptDir, workspacePath } from './claim.js';
import { opencodeCacheProbeScript, opencodeReadoutScript, claudeTurnsScript } from './container-scripts.js';
import type { RunSession } from './runner.js';

/**
 * The opencode and claude-code close-time reads and the live cache-health probe — the argv
 * builders and parsers for every throwaway container that scrapes a run's own session database
 * after (or during) the job container's life. Split from docker.ts (AGENTS.md's file-length
 * budget) along the seam that was already there: this is everything about reading a run's
 * OUTCOME back out, as opposed to docker.ts's job-container argv and env building.
 */

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

/**
 * The full `docker run` argv that counts the agent turns a finished claude-code run banked —
 * pure, and exported, because it is the part worth pinning. The same throwaway shape the
 * opencode readout runs: a container over the workspaces volume, entrypoint swapped for node,
 * reading the transcript the CLI wrote onto the volume under FACTORY_TRANSCRIPT_DIR (its
 * CLAUDE_CONFIG_DIR). It runs AFTER the job container exits; the volume outlives the container,
 * so there is no teardown to race and a killed run's transcript is still readable.
 */
export function claudeTurnsArgs(config: DriverConfig, job: BoardJob, sessionId: string, startedAt: string): string[] {
    if (!UUID.test(sessionId)) {
        throw new Error(`refusing to count turns for a session id that is not a uuid: ${sessionId}`);
    }
    return [
        'run',
        '--rm',
        ...workspacesMountArgs(config, workspacePath(job)),
        // Both travel as env VALUES — the script (claude-turns.cjs) is static, so nothing
        // board-derived is ever part of its text.
        '-e',
        `CLAUDE_TRANSCRIPT_DIR=${transcriptDir(config, job)}`,
        '-e',
        `CLAUDE_SESSION_ID=${sessionId}`,
        // The run's start as an ISO instant: the transcript carries every cycle the resumed
        // conversation ever had, so the count is bounded to the entries written at or after
        // this run began — its own delta, never the earlier runs' turns again.
        '-e',
        `RUN_STARTED_AT=${startedAt}`,
        '--entrypoint',
        'node',
        executorImage(config, job.executorType),
        '-e',
        claudeTurnsScript,
    ];
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
    return job.executorType === 'claude-code' && !config.remoteControl && session !== null && UUID.test(session.id);
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

/**
 * The full `docker run` argv that reads the cache health of a LIVE run — pure, and exported,
 * because it is the part worth pinning: one throwaway container over the workspaces volume,
 * entrypoint swapped for node, read-only query for the newest root session's newest completed
 * assistant turns. Runs every CACHE_WATCH_POLL_MS of the run's life; the same
 * concurrent-reader-with-a-live-writer property the close-time readout relies on, and the same
 * one-error-line rule — an answer that parses to no session is "not yet", not a verdict.
 */
export function opencodeCacheProbeArgs(config: DriverConfig, job: BoardJob): string[] {
    const db = opencodeDbPath(config, job);
    return [
        'run',
        '--rm',
        ...workspacesMountArgs(config, workspacePath(job)),
        // The database path and the turn count travel as env VALUES — the script
        // (opencode-cache-probe.cjs) is static, and the count comes from this module's constant,
        // so the trigger cannot drift between the probe and the code that judges the turns.
        '-e',
        `OPENCODE_DB=${db}`,
        '-e',
        `CACHE_WATCH_TURNS=${CACHE_WATCH_TURNS}`,
        '--entrypoint',
        'node',
        executorImage(config, job.executorType),
        '-e',
        opencodeCacheProbeScript,
    ];
}

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
