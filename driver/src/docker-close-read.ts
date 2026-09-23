/**
 * The docker side of the close-time reads and the live cache watch: the argv of each throwaway
 * container that scrapes a run's session database, and the runner steps that spawn them and fold
 * the answer into the outcome. The parsing and the policy are executor-neutral, in close-read.ts.
 */

import type { BoardJob } from './board.js';
import { UUID, workspacePath, transcriptDir, opencodeDbPath } from './claim.js';
import {
    CACHE_WATCH_TURNS,
    mergeOpencodeOutcome,
    opencodeReadFailed,
    parseOpencodeRunOutcome,
    readOpencodeWithRetries,
    readsAgentTurns,
    parseClaudeCloseRead,
    parseOpencodeCacheProbe,
    cacheCollapse,
} from './close-read.js';
import { type DriverConfig, executorImage } from './config.js';
import { claudeTurnsScript, opencodeCacheProbeScript } from './container-scripts.js';
import type { ExecDocker } from './docker-runner-support.js';
import { workspacesMountArgs, opencodeSessionReadoutArgs, CLOSE_READ_DEADLINE_MS } from './docker.js';
import type { RunOutcome, RunSession } from './runner.js';
import { OPENCODE } from './executors.js';

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

/** What every close-time read needs: how to reach the daemon, and which run it is reading. */
export interface CloseReadContext {
    execDocker: ExecDocker;
    config: DriverConfig;
    job: BoardJob;
    startedAt: string;
}

/**
 * Fills in what opencode's own exit code cannot answer: the session id the loop had none to
 * report at spawn, the finish reason (a zero exit with a finish reason that is not `stop` is the
 * model's context limit, or an abort, cutting a task short), and the context stats — all read
 * from the database the run just closed. A failed read is not a failed run: it costs the task
 * its follow-ups and this verdict-check, never its verdict.
 */
async function applyOpencodeCloseRead(outcome: RunOutcome, ctx: CloseReadContext): Promise<void> {
    const readOnce = () =>
        ctx.execDocker(opencodeSessionReadoutArgs(ctx.config, ctx.job, ctx.startedAt)).then(
            (read) => parseOpencodeRunOutcome(read.stdout),
            (err: Error) => opencodeReadFailed(`the readout container failed: ${err.message}`)
        );
    const { scraped, reason } = await readOpencodeWithRetries(readOnce, (ms) => new Promise((r) => setTimeout(r, ms)));
    mergeOpencodeOutcome(outcome, scraped, reason);
}

/**
 * The claude-code turn count: one throwaway container over the workspaces volume, reading the
 * transcript the CLI wrote onto it while it lived. Best-effort like every close-time read — a
 * failed read costs the task its agent-turn figure, never its verdict, and a missing transcript
 * answers null rather than zero. Remote Control is excluded by readsAgentTurns: its conversation
 * continues after this read would run, so its count stays unmeasured.
 */
async function applyClaudeCloseRead(
    outcome: RunOutcome,
    ctx: CloseReadContext,
    session: RunSession | null
): Promise<void> {
    if (!readsAgentTurns(ctx.config, ctx.job, session)) return;
    const read = await ctx
        .execDocker(claudeTurnsArgs(ctx.config, ctx.job, (session as RunSession).id, ctx.startedAt), {
            timeout: CLOSE_READ_DEADLINE_MS,
        })
        .then(
            (out) => parseClaudeCloseRead(out.stdout),
            (): { turns: number | null; summary: string | null } => ({ turns: null, summary: null })
        );
    outcome.agentTurns = read.turns;
    if (read.summary) outcome.summary = read.summary;
}

/**
 * Every close-time read this runner performs after a container exits: opencode's session scrape
 * (job.executorType === OPENCODE only), then claude-code's agent-turn count (readsAgentTurns
 * decides). Mutates and answers the same outcome object verdict() produced.
 */
export async function applyCloseTimeReadout(
    outcome: RunOutcome,
    ctx: CloseReadContext,
    session: RunSession | null
): Promise<RunOutcome> {
    if (ctx.job.executorType === OPENCODE) {
        await applyOpencodeCloseRead(outcome, ctx);
    }
    await applyClaudeCloseRead(outcome, ctx, session);
    return outcome;
}

/**
 * One cache-watch tick: probes the run's live opencode session and kills the job once
 * `cacheCollapse` says the provider has stopped serving cache hits. A probe that fails once (the
 * daemon is busy, the session is not there yet) just waits for the next tick — the trigger itself
 * needs consecutive damning turns, so no single answer is fatal. A no-op once `cacheLost` is
 * already set: the kill already fired, and there is nothing left to detect.
 */
export async function tickCacheWatch(
    ctx: { execDocker: ExecDocker; config: DriverConfig; job: BoardJob; kill: (job: BoardJob) => Promise<void> },
    state: { cacheLost: string | null }
): Promise<void> {
    const probe = await ctx
        .execDocker(opencodeCacheProbeArgs(ctx.config, ctx.job))
        .then((read) => parseOpencodeCacheProbe(read.stdout))
        .catch(() => null);
    if (!probe || !probe.sessionId || state.cacheLost) return;
    const collapse = cacheCollapse(probe.turns);
    if (collapse) {
        state.cacheLost = collapse;
        void ctx.kill(ctx.job);
    }
}
