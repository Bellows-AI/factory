import { execFile, spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import { CONTAINER_GONE } from './exec-codes.js';
import {
    CREDENTIAL_HELPER,
    gitWorktreeRemoveScript,
    gitWorktreeScript,
    publishCheckout,
    publishFailed,
    repoPath,
    withPublishToken,
    worktreeBranch,
    worktreeDir,
    type PublishResult,
    type ReclaimResult,
    type SyncResult,
} from './publish.js';
import { collectServices, networkName, readBellowsArgs, serviceRunArgs, splitBellowsSections } from './services.js';
import type { ServiceSpec } from './services.js';
import {
    CLOSE_READ_DEADLINE_MS,
    containerName,
    dockerArgs,
    envFilePath,
    opencodeSessionReadoutArgs,
    parseDockerServicePs,
    parseDockerStats,
    parseRemoteSessionId,
    remoteSessionArgs,
    workspacesMountArgs,
} from './docker.js';
import { claimCarriesGithubToken, claimContinuesSession, claimEnv, envFileBody, workspacePath } from './claim.js';
import { composeRuntimeSample, reportTail, type RunOutcome, type Runner, type RunSession } from './runner.js';
import {
    cacheCollapse,
    claudeTurnsArgs,
    opencodeCacheProbeArgs,
    parseClaudeCloseRead,
    parseOpencodeCacheProbe,
    parseOpencodeRunOutcome,
    readsAgentTurns,
    type OpencodeRunOutcome,
} from './docker-close-read.js';

/**
 * The docker executor's stateful runner: `createDockerRunner` and everything it alone needs — the
 * per-attempt fences and teardowns, the aux-services setup, the close-time reads, the spawn and
 * event wiring. Split from docker.ts (AGENTS.md's file-length budget) along the seam that was
 * already there: docker.ts keeps the pure, PINNED argv builders and parsers this module (and the
 * kubernetes runner, and the tests) import; this module is the one thing that actually holds a
 * docker daemon connection.
 */

export const run = promisify(execFile);

export type Spawn = typeof spawn;

/**
 * Everything the runner does through the daemon other than the `docker run` itself — the fence,
 * the post-run inspect and the cleanup — goes through this one seam, so a test can stand in for
 * the daemon instead of shelling out to it.
 */
/**
 * One `docker` invocation off the hot paths. `timeout` (ms) bounds the whole exec — the process
 * is killed and the promise rejects — which is what keeps a close-time read from holding a
 * runner's verdict open forever when the daemon stalls.
 */
export type ExecDocker = (args: string[], options?: { timeout?: number }) => Promise<{ stdout: string }>;

/** How much of a failed aux container's own error detail rides in a sync/reclaim/publish reason. */
export const ERROR_DETAIL_MAX_CHARS = 300;

/**
 * The tool's own output from a failed `execDocker` call, never the echoed command: the execFile
 * message is "Command failed: <the whole docker run argv>", which leaves no room for the one
 * line a human can act on ("remote: Permission to ... denied to bellows-ai[bot]" lives in git's
 * stderr).
 */
export function dockerErrorDetail(e: unknown): string {
    const err = e as { stderr?: string | Buffer; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString('utf8') ?? '');
    return stderr.trim() || (err.message ?? '').split('\n').slice(1).join('\n').trim() || (err.message ?? 'failed');
}

/** One name per non-blank line — the shape `docker ps -q` / `docker network ls` answer in. */
export function linesOf(stdout: string): string[] {
    return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * Docker's already-gone answer, in either of its spellings, on stderr or the execFile message.
 * Read from a REMOVAL's own error only — never from a list, where "not found" could never mean
 * anything.
 */
export function alreadyGone(e: unknown): boolean {
    const err = e as { stderr?: string | Buffer; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString('utf8') ?? '');
    return /no such (container|network)|not found/i.test(`${stderr} ${err.message ?? ''}`);
}

/** Lists names by label, or throws `${what}: <the daemon's own message>`. */
export async function listByLabelOrThrow(execDocker: ExecDocker, args: string[], what: string): Promise<string[]> {
    try {
        return linesOf((await execDocker(args)).stdout);
    } catch (e) {
        throw new Error(`${what}: ${(e as Error).message}`);
    }
}

/**
 * Removes each name, tolerating one that is already gone — a container or network that exited
 * between the list and its removal is the fence succeeding, not failing.
 */
export async function removeEachTolerantly(
    execDocker: ExecDocker,
    names: string[],
    removeArgsFor: (name: string) => string[],
    whatFailed: (name: string) => string
): Promise<void> {
    for (const name of names) {
        try {
            await execDocker(removeArgsFor(name));
        } catch (e) {
            if (alreadyGone(e)) continue;
            throw new Error(`${whatFailed(name)}: ${(e as Error).message}`);
        }
    }
}

/** The tail line of a container's stdout, parsed as JSON, or the fallback when it does not. */
export function parseLastJsonLine<T>(stdout: string, onUnparseable: () => T): T {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
        return JSON.parse(line) as T;
    } catch {
        return onUnparseable();
    }
}

/**
 * The full `docker run` argv for the startup sync/restore container. Pure, for the same pinning
 * as dockerArgs: a starting claim's fetch + create-or-rebase versus a continuing claim's
 * RESTORE=1 — no fetch, no rebase, nothing that touches the remote (issue #58) — is decided here.
 */
export function syncCheckoutArgs(
    config: DriverConfig,
    job: BoardJob,
    sync: { clone: string; worktree: string; restore: boolean; envFile: string | null }
): string[] {
    return [
        'run',
        '--rm',
        ...workspacesMountArgs(config, workspacePath(job)),
        ...(sync.envFile ? (['--env-file', sync.envFile] as string[]) : []),
        '-e',
        `REPO=${sync.clone}`,
        '-e',
        `WORKTREE=${sync.worktree}`,
        '-e',
        `BRANCH=${worktreeBranch(job)}`,
        // Restore mode, as a literal: the script's "keep the tree as the task left it, remote
        // untouched" switch (issue #58).
        ...(sync.restore ? ['-e', 'RESTORE=1'] : []),
        // The fetch's credential helper, as CODE in an env VALUE — the same class of value as
        // the three paths above, and the same mechanism as the push's `-c credential.helper=`.
        // Only when the claim env carries the token the helper reads; the token itself travels
        // the env file, never argv. A restore fetches nothing, so it never carries one.
        ...(!sync.restore && claimCarriesGithubToken(job) ? ['-e', `CRED_HELPER=${CREDENTIAL_HELPER}`] : []),
        '--entrypoint',
        'node',
        executorImage(config, job.executorType),
        '-e',
        gitWorktreeScript,
    ];
}

/**
 * Auxiliary services (issue #6) for one attempt: reads the checkout's `.bellows.yaml`, then
 * creates the network and starts each declared container, each step with its own verdict.
 *
 * A refused read and a refused service start are INFRASTRUCTURE — the daemon said no to a
 * container this process spawned, the same class as a refused runner spawn — so they throw, and
 * the caller leaves the job to its lease instead of blaming the command. A partial fleet is torn
 * down on the way out. A parse refusal, by contrast, is the AUTHOR's: deterministic and fully
 * said by the message, so it comes back as `refusal` rather than thrown — retrying a file that
 * cannot change would burn attempts on an error no retry fixes.
 *
 * `assertNotKilled` stops a dying attempt from creating more: a kill that lands mid-setup throws,
 * teardown-free by design (see run()'s own comment on the same rule).
 */
export async function setupJobServices(
    job: BoardJob,
    config: DriverConfig,
    deps: {
        execDocker: ExecDocker;
        killed: Set<BoardJob['leaseToken']>;
        serviceTeardown: (job: BoardJob) => Promise<void>;
    }
): Promise<{ servicesNetwork: string | null; refusal: string | null }> {
    if (!config.servicesEnabled) return { servicesNetwork: null, refusal: null };

    // The fence's service half. Everything job-scoped is already gone, and this attempt has
    // created nothing yet, so this is a no-op by construction — kept because it makes "the
    // fleet starts clean" hold by the same attempt-scoped code that enforces it at teardown,
    // not by the fence's special-casing.
    await deps.serviceTeardown(job);
    let raw: string;
    try {
        raw = (await deps.execDocker(readBellowsArgs(config, job))).stdout;
    } catch (e) {
        throw new Error(`could not read .bellows.yaml: ${(e as Error).message}`);
    }
    assertJobNotKilled(deps.killed, job);

    let specs: ServiceSpec[];
    let refusal: string | null = null;
    try {
        specs = collectServices(splitBellowsSections(raw));
    } catch (e) {
        refusal = (e as Error).message;
        specs = [];
    }
    if (refusal !== null || specs.length === 0) {
        return { servicesNetwork: null, refusal };
    }

    const servicesNetwork = networkName(job);
    // The fence already swept the job's stale networks, and this name carries this attempt's
    // own token — a create here cannot collide with anything.
    try {
        // Labeled like everything else the attempt creates: factory.job is what the next
        // attempt's fence sweeps networks by, factory.lease what scopes the teardown's removal
        // to this attempt's own.
        await deps.execDocker([
            'network',
            'create',
            '--label',
            `factory.job=${job.id}`,
            '--label',
            `factory.lease=${job.leaseToken}`,
            servicesNetwork,
        ]);
    } catch (e) {
        throw new Error(`could not create the services network: ${(e as Error).message}`);
    }
    assertJobNotKilled(deps.killed, job);
    for (const spec of specs) {
        try {
            await deps.execDocker(serviceRunArgs(job, spec));
        } catch (e) {
            await deps.serviceTeardown(job);
            throw new Error(`could not start service "${spec.name}": ${(e as Error).message}`);
        }
        assertJobNotKilled(deps.killed, job);
    }
    return { servicesNetwork, refusal: null };
}

/**
 * The verdict for a close, decided after the process is gone. An exit CONTAINER_GONE is
 * ambiguous on the shared stderr — the daemon's refusal and a command that genuinely exited that
 * code are printed onto the same stream — so the daemon is asked instead: a container that
 * exists ran, and its State is the truth; "no such container" means `docker run` never got one
 * accepted, and nothing ran. Any other exit code unambiguously belongs to the attached container.
 *
 * Cleanup is explicit (`--rm` is not on the spawn argv, precisely so the inspect above can see
 * the container): the fence on the next claim would catch it anyway, but leaving one daemon
 * round-trip of litter behind is not tidiness worth keeping. The services outlive the runner by
 * one teardown, UNCONDITIONALLY and safely so: the teardown is scoped to this attempt's lease, so
 * a close that lands arbitrarily late can only ever name and remove what THIS attempt created.
 */
export async function dockerRunVerdict(
    code: number | null,
    ctx: {
        execDocker: ExecDocker;
        job: BoardJob;
        serviceTeardown: (job: BoardJob) => Promise<void>;
        output: string;
        timedOut: boolean;
        idled: boolean;
        cacheLost: string | null;
    }
): Promise<RunOutcome> {
    let started = true;
    if (code === CONTAINER_GONE) {
        try {
            const state = JSON.parse(
                (await ctx.execDocker(['inspect', '--format', '{{json .State}}', containerName(ctx.job)])).stdout
            ) as { Status?: string };
            started = state.Status === 'exited';
        } catch {
            started = false;
        }
    }
    await ctx.execDocker(['rm', '-f', containerName(ctx.job)]).catch(() => undefined);
    await ctx.serviceTeardown(ctx.job);
    return {
        exitCode: code,
        output: ctx.output,
        timedOut: ctx.timedOut,
        idled: ctx.idled,
        started,
        cacheLost: ctx.cacheLost,
    };
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

/**
 * Throws when this attempt's lease has already been killed. Checked after every awaited setup
 * step so a dying attempt stops CREATING resources over a lease it no longer holds — see
 * setupJobServices and run() for why the abort is deliberately teardown-free.
 */
export function assertJobNotKilled(killed: Set<BoardJob['leaseToken']>, job: BoardJob): void {
    if (!killed.has(job.leaseToken)) return;
    throw new Error(`job ${job.id}: killed while setting up services`);
}

/**
 * The last kill-check before the spawn, after the env file write: a lease lost while the write
 * was pending would otherwise reach spawnFn. On this abort the just-written file is removed by
 * hand — the run's own cleanup only wraps a settled outcome, and this throw precedes it.
 */
export async function assertNotKilledAfterEnvWrite(
    ctx: { killed: Set<BoardJob['leaseToken']>; job: BoardJob; files: RunnerFiles },
    file: string | null
): Promise<void> {
    try {
        assertJobNotKilled(ctx.killed, ctx.job);
    } catch (abort) {
        if (file) await ctx.files.rm(file).catch(() => undefined);
        throw abort;
    }
}

/** The fs verbs the runner's env files need — injectable for the same reason spawn is. */
export interface RunnerFiles {
    writeFile: typeof writeFile;
    rm: typeof rm;
}

/** What every close-time read needs: how to reach the daemon, and which run it is reading. */
export interface CloseReadContext {
    execDocker: ExecDocker;
    config: DriverConfig;
    job: BoardJob;
    startedAt: string;
}

/**
 * Retries opencode's own close-time session readout up to OPENCODE_SESSION_READOUT_RETRIES
 * times, half a second apart. NOT single-shot, and not only when the container fails: the CLI
 * exited a moment ago, and its session database may still be mid-checkpoint — a read-only open
 * of a WAL that needs recovery fails outright, then succeeds milliseconds later. The readout
 * script answers one of three ways — a session line, an error line, or nothing — and ALL but the
 * first read as "no session yet", so the retries fire on the session being missing, whatever the
 * reason. `reason` carries the LATEST non-null error seen across attempts, for when every one of
 * them came up empty.
 */
const OPENCODE_SESSION_READOUT_RETRIES = 3;
const OPENCODE_SESSION_READOUT_RETRY_DELAY_MS = 500;

async function readOpencodeSessionWithRetries(
    ctx: CloseReadContext
): Promise<{ scraped: OpencodeRunOutcome; reason: string | null }> {
    let scraped: OpencodeRunOutcome = {
        sessionId: null,
        finishReason: null,
        contextTokens: null,
        costUsd: null,
        agentTurns: null,
        summary: null,
        error: null,
    };
    let reason: string | null = null;
    for (let attempt = 0; attempt < OPENCODE_SESSION_READOUT_RETRIES && !scraped.sessionId; attempt += 1) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, OPENCODE_SESSION_READOUT_RETRY_DELAY_MS));
        scraped = await ctx.execDocker(opencodeSessionReadoutArgs(ctx.config, ctx.job, ctx.startedAt)).then(
            (read) => parseOpencodeRunOutcome(read.stdout),
            (err: Error): OpencodeRunOutcome => ({
                sessionId: null,
                finishReason: null,
                contextTokens: null,
                costUsd: null,
                agentTurns: null,
                summary: null,
                error: `the readout container failed: ${err.message}`,
            })
        );
        reason = scraped.error ?? reason;
    }
    return { scraped, reason };
}

/**
 * Fills in what opencode's own exit code cannot answer: the session id the loop had none to
 * report at spawn, the finish reason (a zero exit with a finish reason that is not `stop` is the
 * model's context limit, or an abort, cutting a task short), and the context stats — all read
 * from the database the run just closed. A failed read is not a failed run: it costs the task
 * its follow-ups and this verdict-check, never its verdict.
 */
async function applyOpencodeCloseRead(outcome: RunOutcome, ctx: CloseReadContext): Promise<void> {
    const { scraped, reason } = await readOpencodeSessionWithRetries(ctx);
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
    // With a session scraped, the line's error is the RUN's last provider error, not the read's
    // failure — carried as its own field so the verdict can name the cause of a premature stop.
    if (scraped.error) outcome.providerError = scraped.error;
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
 * (job.executorType === 'opencode' only), then claude-code's agent-turn count (readsAgentTurns
 * decides). Mutates and answers the same outcome object verdict() produced.
 */
export async function applyCloseTimeReadout(
    outcome: RunOutcome,
    ctx: CloseReadContext,
    session: RunSession | null
): Promise<RunOutcome> {
    if (ctx.job.executorType === 'opencode') {
        await applyOpencodeCloseRead(outcome, ctx);
    }
    await applyClaudeCloseRead(outcome, ctx, session);
    return outcome;
}
