import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { collectServices, networkName, readBellowsArgs, serviceRunArgs, splitBellowsSections } from './services.js';
import type { ServiceSpec } from './services.js';
import {
    CREDENTIAL_HELPER,
    gitProbeScript,
    gitWorktreeScript,
    isBranchName,
    parseGitState,
    publishFailed,
    publishNothing,
    publishPlan,
    repoPath,
    worktreeBranch,
    worktreeDir,
    type PublishResult,
    type SyncResult,
} from './publish.js';

/**
 * The container scripts this module ships: real files under `driver/src/scripts/`, read at load
 * time and passed to the container by content (`node -e`, `sh -c`) — never inline template
 * strings in TS, and never by mounting a path (the driver talks to a remote daemon and has no
 * host path into the volumes it names). Under tsx and vitest this resolves into `src/scripts/`;
 * in the built driver into `dist/scripts/`, where the build copies the directory — forgetting
 * THAT copy fails only in the container, the server/migrations trap.
 */
const script = (name: string): string => readFileSync(new URL(`./scripts/${name}`, import.meta.url), 'utf8');

/** The `sh -c` command that reads the Remote Control id out of a live transcript: see scripts/remote-session.sh. */
export const remoteSessionScript = script('remote-session.sh');

/** The close-time opencode readout: see scripts/opencode-readout.cjs. */
export const opencodeReadoutScript = script('opencode-readout.cjs');

/** The live cache probe: see scripts/opencode-cache-probe.cjs. */
export const opencodeCacheProbeScript = script('opencode-cache-probe.cjs');

const run = promisify(execFile);

/**
 * What the board is told afterwards. `timedOut` is reported as a failure, with a reason; `idled` is
 * not a failure at all — the job is parked and keeps its session.
 */
export interface RunOutcome {
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    idled: boolean;
    /**
     * False only when the runner knows the container never ran — the daemon refused to accept
     * it. The docker runner does not guess from the shared stderr stream, where the CLI's errors
     * and the command's own output are indistinguishable: on an exit 125 it asks the daemon
     * whether the container exists, and a container that exists ran, whatever it printed. A
     * kubernetes runner always reports started, because a resolved outcome there means the pod
     * was created, ran and exited. The shared loop interprets no exit codes: a run that started
     * and exited 125 is a verdict, reported like any other.
     */
    started: boolean;
    /**
     * The session the run actually used, when the runner could only know it after the fact —
     * opencode mints its own (`ses_…`) and the runner scrapes it out of the session database the
     * run left behind. Null for claude-code, whose session is minted up front and reported
     * before the container starts, and for every run whose scrape found nothing.
     */
    sessionId?: string | null;
    /**
     * The finish reason opencode recorded for the run's LAST root assistant message — `stop` for
     * a run that ended itself, `length` for one that hit the model's context limit mid-task.
     * Undefined when no scrape happened (claude-code, kubernetes); null when the scrape ran but
     * read nothing. A zero exit code with a finish reason that is not `stop` is a run that
     * STOPPED TALKING, not one that finished — the loop reports it failed rather than letting
     * the exit code call a truncated run a success.
     */
    finishReason?: string | null;
    /**
     * The context the run reached, read from the same session database as `finishReason`: the
     * last root assistant message's token total — the model's window fill at the run's end — and
     * the sum of the per-message costs. Undefined when no scrape happened; null when the scrape
     * read nothing. Reported with the verdict and stored beside the attempt's vitals, where a
     * run that died at a full window tells its own story.
     */
    contextTokens?: number | null;
    costUsd?: number | null;
    /**
     * Why the post-run session scrape failed, when it failed: the readout's own error line, the
     * docker rejection, or null when it answered nothing at all. The loop logs it beside the
     * empty-scrape notice, because a lost session presents later as "this task cannot take a
     * follow-up" and the reason is the only way to tell a broken query from an empty database.
     * Undefined for claude-code and kubernetes, which never scrape.
     */
    readoutError?: string | null;
    /**
     * Why the cache watch killed the run, when it did — the observed turns, so the verdict the
     * author reads names what the provider stopped doing instead of just "failed". Undefined
     * when the watch is off or never fired; never set by claude-code or kubernetes.
     */
    cacheLost?: string | null;
}

/**
 * The session a run is to use. `resume` restores an existing one rather than starting it, which is
 * how a parked job picks up where it left off — under the same id, so its link does not move.
 *
 * Null for a runner that takes no session at all: opencode mints its own ids and cannot adopt one
 * (`run --session <id>` continues an existing session, it never creates one with a given id), so
 * there is nothing honest to pass it.
 */
export interface RunSession {
    id: string;
    resume: boolean;
}

export interface Runner {
    /**
     * Runs the job. `onOutput` is the live-output hook: the runner calls it with its newest output
     * tail whenever fresh output arrives, and the loop decides what reaches the board and how
     * often. Optional — a caller that does not stream simply never gets a call.
     */
    run(job: BoardJob, session: RunSession | null, onOutput?: (tail: string) => void): Promise<RunOutcome>;
    /**
     * The Remote Control id the Claude UI addresses this session by, or null while the bridge has
     * not connected yet — which is the ordinary answer for the first few seconds of a run, and the
     * permanent one for a headless job.
     */
    remoteSessionId(job: BoardJob, sessionId: string): Promise<string | null>;
    /**
     * The runner container's vitals right now — the liveness signal the dashboard renders — or
     * null when none can be taken. Sampling failures are the ordinary case (the container can be
     * gone between the ask and the read), so null is "no fresh sample", never an error.
     */
    sampleRuntime(job: BoardJob): Promise<Omit<RuntimeSample, 'sampledAt'> | null>;
    /** Stops a container mid-run. Used when the lease is lost, and on shutdown. */
    kill(job: BoardJob): Promise<void>;
    /**
     * Publishes the work the run produced: task branch (when the checkout sits on the default
     * one), commit, push, and a PR. The deterministic end of a task — a succeeded verdict may not
     * describe work that exists only in a local checkout. The loop decides WHEN this is called (a
     * succeeded run, gates passed, and nothing else); a runner that cannot publish answers the
     * refusal in the result — or does not implement the method at all, which the loop reads as
     * "this platform does not publish".
     */
    publishGit?(job: BoardJob): Promise<PublishResult>;
    /**
     * Brings the job's task worktree up to the remote default before the run: fetch, create the
     * worktree branched off `origin/<default>` (first attempt of the thread) or rebase it onto
     * the new default, keeping its commits (every later one). Called before the runner spawns, so
     * a task starts from the code — and the declared gates — that main actually has. Answers
     * { ok: false, reason } rather than throwing; the loop turns that into the verdict.
     */
    syncCheckout(job: BoardJob): Promise<SyncResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What an agent session id may look like before it is interpolated into runner argv — claude's
 * uuids and opencode's `ses_…` both qualify, and nothing shell-shaped does. The id on a resume
 * claim comes from the board, and a board is not something this process trusts with a fragment of
 * a command. Copied from server/src/routes/jobs.ts, which states the same rule for the report:
 * this package depends on nothing, deliberately.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/**
 * `<org>/<user id>` and nothing else, asserted before it is interpolated into a `docker run`.
 *
 * The board is not something this process trusts with a fragment of a command line — the same rule
 * `remoteSessionArgs` applies to a session id. Here the stakes are higher: the value becomes the
 * agent's working directory, and `..` in it would point at the parent of every member's tree.
 *
 * The two halves restate ORG_ID_PATTERN from server/src/config.ts and the uuid above. COPIED rather
 * than imported: this package depends on nothing, deliberately (see AGENTS.md), and sharing a
 * constant with the server would give a process that needs only `fetch` and `docker` the whole
 * server dependency tree.
 */
const WORKSPACE_PATH = /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `docker exec` argv for reading the bridge record out of a running runner. Pure and exported for
 * the same reason dockerArgs is: it interpolates a value into a shell command, and that is worth
 * pinning in one place.
 *
 * The transcript is the only place the remote id appears — the CLI prints it into a TUI, not onto
 * stdout — and the container is where it is legible, so this reads it in place rather than trying
 * to locate the auth volume on the host.
 *
 * The session id is asserted to be a uuid before it is interpolated. It comes from the board on a
 * resume, and a board is not something this process should trust with a fragment of a shell
 * command. It travels as the script's FIRST POSITIONAL PARAMETER (`sh -c <script> sh <id>` →
 * `$1`), a plain argv value — the script text itself (remote-session.sh) is static, so nothing
 * board-supplied is ever part of it.
 */
export function remoteSessionArgs(job: BoardJob, sessionId: string): string[] {
    if (!UUID.test(sessionId)) throw new Error(`refusing to read a session id that is not a uuid: ${sessionId}`);
    return [
        'exec',
        containerName(job),
        'sh',
        '-c',
        remoteSessionScript,
        'sh',
        sessionId,
    ];
}

/** Pulls `bridgeSessionId` out of the transcript line, tolerating anything that is not one. */
export function parseRemoteSessionId(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed) as { bridgeSessionId?: unknown };
        return typeof parsed.bridgeSessionId === 'string' && parsed.bridgeSessionId ? parsed.bridgeSessionId : null;
    } catch {
        return null;
    }
}

/**
 * The most of a runner's output this process will hold in memory — the board truncates too; this
 * is about not holding an unbounded string in the first place. Exported because the kubernetes
 * runner's transport uses it as its sliding-window bound.
 */
export const OUTPUT_LIMIT = 64 * 1024;

/**
 * The tail of a runner's output that is safe to put on a complete POST. The board refuses a body
 * over its 128 KiB limit, and JSON escaping can inflate text up to six bytes per byte of log — a
 * control character becomes `\u0001` — so the bound is 16 KiB of UTF-8: 96 KiB fully escaped, plus
 * the rest of the report, still fits. Capping by CHARACTERS instead — 64 KiB of them, the naive
 * reading of OUTPUT_LIMIT — could triple that with CJK text and sextuple it with control
 * characters, and the refused report would leave the job to its lease and re-run finished work:
 * the one outcome worse than a short log.
 */
const REPORT_BYTE_LIMIT = 16 * 1024;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8');

/**
 * The last `limit` UTF-8 bytes of `text`, as a string. A multibyte character cut at the boundary
 * decodes to one U+FFFD — at most three extra bytes, once — which is why the bound is stated in
 * bytes and not approximated by a character count.
 */
export function tailBytes(text: string, limit: number): string {
    const bytes = ENCODER.encode(text);
    if (bytes.length <= limit) return text;
    return DECODER.decode(bytes.subarray(bytes.length - limit));
}

/** The tail of a runner's log that fits a complete POST, whatever the log contained. */
export function reportTail(logText: string): string {
    return tailBytes(logText, REPORT_BYTE_LIMIT);
}

/**
 * The runner container's vitals at one sample: the "is it actually doing anything" answer the
 * dashboard renders beside the output tail. Taken with `docker stats --no-stream` — the same
 * daemon access every other per-attempt operation here uses.
 */
export interface RuntimeSample {
    /** Whole-container CPU, percent of one host core; can exceed 100 on multi-core hosts. */
    cpuPercent: number;
    /** Resident memory, in MiB. */
    memUsedMb: number;
    /** Resident memory against the container's limit, percent; null when the daemon reports none. */
    memPercent: number | null;
    /** When the sample was taken, stamped by the sampler. A reader sees staleness from this. */
    sampledAt: string;
}

/** How many characters of one output line the activity report may carry. */
const ACTIVITY_LIMIT = 200;

/** Strips ANSI/OSC escapes — the stream is a CLI's, and the board renders it as text. */
export function stripAnsi(text: string): string {
    // CSI sequences, OSC sequences (BEL- or ST-terminated), and any other lone escape.
    return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g, '');
}

/**
 * The agent's current activity, read off the newest output tail: its last non-empty line, escapes
 * stripped and capped. That line is the tool call most of the time (`→ Read src/x.ts`,
 * `$ npm test`), which is exactly the "is it working, and on what" answer wanted here. A heuristic
 * by design — the stream is the CLI's to format, and parsing deeper would couple this process to
 * one renderer's redraws.
 */
export function currentActivity(tail: string | null): string | null {
    if (tail === null) return null;
    const lines = stripAnsi(tail).split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!.trim();
        if (line) return line.slice(0, ACTIVITY_LIMIT);
    }
    return null;
}

const PERCENT = /^([0-9.]+)%/;
const MEMORY = /^([0-9.]+)\s*([A-Za-z]+)/;

/** Docker's stats units, to MiB. Both the binary and the decimal spellings are seen in the wild. */
const TO_MIB: Record<string, number> = {
    B: 1 / 1048576,
    kB: 1e-3,
    KB: 1e-3,
    KiB: 1 / 1024,
    MB: 1,
    MiB: 1,
    GB: 1e3,
    GiB: 1024,
    TB: 1e6,
    TiB: 1048576,
};

const percentOf = (field: unknown): number | null => {
    const match = typeof field === 'string' ? PERCENT.exec(field.trim()) : null;
    return match ? Number.parseFloat(match[1]!) : null;
};

const memMbOf = (field: string | undefined): number | null => {
    const match = field === undefined ? null : MEMORY.exec(field.trim());
    if (!match) return null;
    const factor = TO_MIB[match[2]!];
    return factor === undefined ? null : Number.parseFloat(match[1]!) * factor;
};

/**
 * Pulls the vitals out of `docker stats --no-stream --format '{{json .}}'` output. Pure and
 * exported for the pinning: the fields are display strings ("93.00%", "544MiB / 7.754GiB") and
 * their parse deserves its own test. Null for anything it cannot read — a missed sample costs
 * freshness, never the run.
 */
export function parseDockerStats(stdout: string): Omit<RuntimeSample, 'sampledAt'> | null {
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    if (!line) return null;
    let fields: Record<string, unknown>;
    try {
        fields = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return null;
    }
    const cpuPercent = percentOf(fields.CPUPerc);
    const usage = typeof fields.MemUsage === 'string' ? fields.MemUsage.split('/') : [];
    const memUsedMb = memMbOf(usage[0]);
    if (cpuPercent === null || memUsedMb === null) return null;
    return { cpuPercent, memUsedMb, memPercent: percentOf(fields.MemPerc) };
}

/**
 * The runner container's name — one per ATTEMPT. The naming contract every per-attempt
 * operation in this file relies on: the lease token is minted fresh on every claim and never
 * repeats, so a name can only ever resolve to the container the attempt that computed it
 * created. A stale attempt can compute the name it used, but that name is structurally incapable
 * of addressing a replacement attempt's runner — which is why its kill, its verdict cleanup and
 * its teardown need no ownership gate. The one job-scoped identifier is the `factory.job` label,
 * and the only thing allowed to act on it is the re-claim fence.
 */
export const containerName = (job: BoardJob): string => `factory-job-${job.id}-${job.leaseToken}`;

/**
 * The gate environment container's identity: `<checkout key>` under a label, `factory-env-…` as a
 * name. The KEY is the checkout the gates share with the coding agent — the task worktree
 * `<org>/<uuid>/.worktrees/<root id>` (issue #35), the tree the run actually edits — and it is
 * asserted before it is interpolated into argv or a container name, exactly like
 * `workspacePathOf` above: it arrives from the board's claim plus a repo label, and a `..` in it
 * would work the parent of every member's tree into a container that runs arbitrary commands.
 *
 * The segments mirror what the system legally produces: org ≤ 39 (ORG_ID_PATTERN) and both ids
 * uuids (36) — a validator narrower than the input domain would fail every job on a
 * legally-named checkout.
 */
const GATE_KEY =
    /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\.worktrees\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same shape the board's `.bellows.yaml` parser enforces; re-asserted here, before argv. */
const GATE_IMAGE = /^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/;

/**
 * A container name this process will `docker exec` into: one token, no shell metacharacters. The
 * ceiling is above the longest name `gateEnvContainerName` can emit (12-char prefix + the 123
 * characters GATE_KEY allows ≈ 135) — a cap BELOW that would create containers every gate then
 * refuses to exec into, a checkout that can never pass.
 */
const GATE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/;

/** The label an orphan sweep filters on — `docker ps --filter label=factory.gates`. */
export const GATE_LABEL = 'factory.gates';

export function gateEnvContainerName(key: string): string {
    if (!GATE_KEY.test(key)) {
        throw new Error(`refusing to name a gate environment container from "${key}"`);
    }
    return `factory-env-${key.replaceAll('/', '-')}`;
}

/**
 * The full `docker run` argv for one gate environment container. Pure, and exported for the same
 * pinning as dockerArgs.
 *
 * `-d` + `--entrypoint sleep <image> infinity`: the container's only job is to BE an environment.
 * Gates enter it by `docker exec` (gateExecArgs), which is what keeps `npm install`'s state and
 * any warm cache alive across gates — and across coding-task turns, for as long as the cooldown
 * keeps the container up.
 *
 * The claim env rides the same way it rides into a runner: a 0600 `--env-file`, never `-e
 * NAME=value` — the values are member-scoped secrets and argv is world-readable. No env file, no
 * `--env-file`: the container then starts with the image's own environment.
 */
export function gateEnvArgs(config: DriverConfig, key: string, image: string, envFile?: string): string[] {
    if (!GATE_KEY.test(key)) {
        throw new Error(`refusing to run a gate environment from a checkout key that is not <org>/<uuid>/.worktrees/<uuid>: ${key}`);
    }
    if (!GATE_IMAGE.test(image)) {
        throw new Error(`refusing to run a gate environment from an image that is not a plain docker reference: "${image}"`);
    }
    const args = [
        'run',
        '-d',
        '--name',
        gateEnvContainerName(key),
        '--label',
        `${GATE_LABEL}=${key}`,
        '-v',
        `${config.workspaceVolume}:${config.workspaceMount}`,
        // The checkout the coding agent works in is the checkout the gates run in.
        '-w',
        `${config.workspaceMount}/${key}`,
    ];
    if (envFile) args.push('--env-file', envFile);
    if (config.network) args.push('--network', config.network);
    args.push('--entrypoint', 'sleep', image, 'infinity');
    return args;
}

/**
 * One gate, inside the environment container. Pure and exported for the pinning; the command is
 * authored by the repository that declared it — the same trust level as the job command itself —
 * but it still travels as ONE argv element into `sh -c`, never through an interpolating shell.
 */
export function gateExecArgs(name: string, command: string): string[] {
    if (!GATE_CONTAINER.test(name)) {
        throw new Error(`refusing to exec into a container named "${name}"`);
    }
    return ['exec', name, 'sh', '-c', command];
}

/**
 * The session database opencode writes under XDG_DATA_HOME, as the runner sets it: one directory
 * per member, next to their checkouts, on the workspaces volume.
 */
export function opencodeDbPath(config: DriverConfig, job: BoardJob): string {
    return `${config.workspaceMount}/${workspacePath(job)}/.opencode/opencode/opencode.db`;
}

/**
 * The full `docker run` argv that reads what a finished opencode run left behind — pure, and
 * exported, because it is the part worth pinning: the readout is a throwaway container over the
 * workspaces volume, entrypoint swapped for node, whose only work is one read-only query pair for
 * the newest root session and the finish reason of its last assistant message.
 *
 * It runs AFTER the job container exits (docker exec cannot), and against the volume rather than
 * inside any container, which is why the run may be over before any of this is known and why the
 * runner reports both in the outcome instead of mid-run. The finish reason is what tells a run
 * that ended itself (`stop`) from one the model's context limit cut short (`length`) — the exit
 * code reads 0 for both, and only one of them is a success.
 */
export function opencodeSessionReadoutArgs(config: DriverConfig, job: BoardJob): string[] {
    const db = opencodeDbPath(config, job);
    return [
        'run',
        '--rm',
        '-v',
        `${config.workspaceVolume}:${config.workspaceMount}`,
        // The database path travels as an env VALUE — the script (opencode-readout.cjs) is
        // static, so nothing board-derived is ever part of its text.
        '-e',
        `OPENCODE_DB=${db}`,
        '--entrypoint',
        'node',
        config.image,
        '-e',
        opencodeReadoutScript,
    ];
}

/** What the readout answers: the session the run used, how it ended, and the context it reached. */
export interface OpencodeRunOutcome {
    sessionId: string | null;
    finishReason: string | null;
    contextTokens: number | null;
    costUsd: number | null;
    /**
     * What the readout says went wrong, when it says anything. The script prints one on every
     * failure it can name; a readout that answers nothing at all parses with this null.
     */
    error: string | null;
}

/** Pulls the session id, finish reason and context stats out of the readout, tolerating anything else. */
export function parseOpencodeRunOutcome(stdout: string): OpencodeRunOutcome {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    const nothing = { sessionId: null, finishReason: null, contextTokens: null, costUsd: null, error: null };
    try {
        const parsed = JSON.parse(line) as {
            id?: unknown;
            finish?: unknown;
            tokens?: unknown;
            cost?: unknown;
            error?: unknown;
        };
        const sessionId =
            typeof parsed.id === 'string' && /^ses_[A-Za-z0-9._-]+$/.test(parsed.id) ? parsed.id : null;
        const finishReason = typeof parsed.finish === 'string' && parsed.finish ? parsed.finish : null;
        const contextTokens =
            typeof parsed.tokens === 'number' && Number.isFinite(parsed.tokens) && parsed.tokens >= 0
                ? Math.round(parsed.tokens)
                : null;
        const costUsd =
            typeof parsed.cost === 'number' && Number.isFinite(parsed.cost) && parsed.cost >= 0 ? parsed.cost : null;
        const error = typeof parsed.error === 'string' && parsed.error ? parsed.error : null;
        return { sessionId, finishReason, contextTokens, costUsd, error };
    } catch {
        return nothing;
    }
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
export function cacheCollapse(turns: OpencodeCacheTurn[]): string | null {
    if (turns.length < CACHE_WATCH_TURNS) return null;
    const dead = turns.every(
        (t) => t.cacheRead === 0 && t.input >= CACHE_WATCH_MIN_INPUT_TOKENS && t.ms >= CACHE_WATCH_MIN_TURN_MS,
    );
    if (!dead) return null;
    const inputs = turns.map((t) => `${Math.round(t.input / 1000)}k`).join('/');
    const seconds = turns.map((t) => Math.round(t.ms / 1000));
    const span = Math.min(...seconds) === Math.max(...seconds)
        ? `${Math.min(...seconds)}s`
        : `${Math.min(...seconds)}-${Math.max(...seconds)}s`;
    return (
        `${turns.length} consecutive turns with no prompt-cache reads ` +
        `(input ${inputs} tokens, ${span} each)`
    );
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
        '-v',
        `${config.workspaceVolume}:${config.workspaceMount}`,
        // The database path and the turn count travel as env VALUES — the script
        // (opencode-cache-probe.cjs) is static, and the count comes from this module's constant,
        // so the trigger cannot drift between the probe and the code that judges the turns.
        '-e',
        `OPENCODE_DB=${db}`,
        '-e',
        `CACHE_WATCH_TURNS=${CACHE_WATCH_TURNS}`,
        '--entrypoint',
        'node',
        config.image,
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
        const sessionId =
            typeof parsed.id === 'string' && /^ses_[A-Za-z0-9._-]+$/.test(parsed.id) ? parsed.id : null;
        const turns = Array.isArray(parsed.turns) ? parsed.turns.filter(isTurn).slice(0, CACHE_WATCH_TURNS) : [];
        const error = typeof parsed.error === 'string' && parsed.error ? parsed.error : null;
        return { sessionId, turns, error };
    } catch {
        return nothing;
    }
}

/**
 * Where the image sets CLAUDE_CONFIG_DIR. The login lives under it, so that whole directory is what
 * the auth volume has to cover — mounting anything narrower hides the baked configuration behind an
 * empty volume without carrying the credential.
 */
const AUTH_MOUNT = '/home/node/.claude';

/**
 * The full `docker run` argument list. Pure, and exported, because it is the part worth pinning in
 * a test: everything security-relevant about a runner is decided here.
 *
 * The session id is minted by the caller, not read back out of the container. An interactive Remote
 * Control session reports its state into a TUI rather than onto stdout, so there is nothing
 * parseable to scrape — and a runner that dies early would leave the job with no session at all.
 */
/**
 * The job's workspace, or a refusal. Exported so `loop.ts` can fail a job cleanly rather than
 * letting `dockerArgs` throw halfway through building a command.
 */
export function workspacePathOf(job: BoardJob): string | null {
    return job.workspacePath && WORKSPACE_PATH.test(job.workspacePath) ? job.workspacePath : null;
}

function workspacePath(job: BoardJob): string {
    const path = workspacePathOf(job);
    if (!path) {
        throw new Error(
            `refusing to run job ${job.id}: the board reported no usable workspace path (${job.workspacePath ?? 'null'})`,
        );
    }
    return path;
}

/**
 * The names the runner's own contract claims — WORKDIR is the working directory dockerArgs itself
 * sets, TRUST_WORKDIR is the Remote Control trust answer, and the two BELLOWS_GATE_ names are the
 * ad-hoc gate credentials the loop mints per attempt — which a claim env must never carry.
 * Mirrored at the board (RESERVED_ENV_NAMES in server/src/routes/env.ts, where a PUT is refused);
 * copied rather than imported, per this package's zero-dependency rule.
 */
export const RESERVED_ENV_NAMES = ['WORKDIR', 'TRUST_WORKDIR', 'BELLOWS_GATE_URL', 'BELLOWS_GATE_TOKEN'] as const;

/**
 * The environment the board resolved for this job, minus the reserved names. Pure and exported for
 * the pinned-argv test — this is the boundary where a claim's secrets become this process's data.
 *
 * The accumulator is prototype-less and the passEnv filter below checks own properties: names like
 * `__proto__` or `toString` pass the board's name validation, and both would otherwise be silently
 * dropped or wrongly shadow an operator's `RUNNER_ENV` name.
 */
export function claimEnv(job: BoardJob): Record<string, string> {
    const env: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(job.env ?? {})) {
        if ((RESERVED_ENV_NAMES as readonly string[]).includes(name)) continue;
        env[name] = value;
    }
    return env;
}

/**
 * One `NAME=value` line, refusing a newline in either half: the file is line-structured and docker
 * has no quoting for it, so a multiline value would arrive truncated with no error anywhere. The
 * board refuses one at PUT time; this is the driver's own line of defence against rows that
 * predate that check. The refusal names WHICH half carries the newline — blaming the name for the
 * value's offence sends a reader hunting through the env scopes for a variable that is fine.
 */
const envLine = (job: BoardJob, name: string, value: string): string => {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        const part = /[\r\n]/.test(name) ? 'name' : 'value';
        throw new Error(
            `refusing to write env file for job ${job.id}: the ${part} of "${name}" contains a newline, which an env file cannot carry`,
        );
    }
    return `${name}=${value}`;
};

/**
 * The `--env-file` body for the runner: the claim env's lines, then the loop's minted gate
 * credentials. Pure and exported for the same pinning as dockerArgs.
 */
export function envFileBody(job: BoardJob): string {
    const lines = Object.entries(claimEnv(job)).map(([name, value]) => envLine(job, name, value));
    // The driver's own gate credentials go LAST. Docker's --env-file is last-duplicate-wins, so
    // the order is the precedence rule: a `BELLOWS_GATE_TOKEN` a member configured in any env
    // scope was already dropped from the claim lines (reserved names), and the lines here are the
    // driver's minted values — but keeping them visually and structurally after the claim's is
    // what makes "the driver wins a collision" readable in one place.
    for (const [name, value] of Object.entries(job.gateEnv ?? {})) {
        lines.push(envLine(job, name, value));
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Where the run's env file lives — one per ATTEMPT, lease token included, so a re-claimed
 * attempt's write can never race a previous attempt's cleanup on the same path. Both halves of the
 * name are asserted before they join a path: the file write is the one place a board-supplied id
 * becomes a filesystem operation.
 */
const envFilePath = (job: BoardJob): string => {
    if (!UUID.test(job.id)) {
        throw new Error(`refusing to write an env file for a job id that is not a uuid: ${job.id}`);
    }
    if (job.leaseToken !== undefined && !UUID.test(job.leaseToken)) {
        throw new Error(`refusing to write an env file for a lease token that is not a uuid: ${job.leaseToken}`);
    }
    const token = UUID.test(job.leaseToken ?? '') ? `-${job.leaseToken}` : '';
    return join(tmpdir(), `factory-env-${job.id}${token}.env`);
};

export function dockerArgs(config: DriverConfig, job: BoardJob, session: RunSession | null, servicesNetwork: string | null = null, envFile?: string): string[] {
    /*
     * The run happens in the job's task worktree (issue #35) — one per task thread, branched off
     * the remote default — when the job names a repository, and at the member root when it does
     * not (a command-only job names no repo, so no worktree exists; the root is where it always
     * started, and the argv stays byte-identical for it).
     */
    const worktree = job.repo ? worktreeDir(config, job) : null;
    if (job.repo && !worktree) {
        throw new Error(
            `refusing to run job ${job.id}: the board reported a repo label this driver cannot resolve a task worktree for (${job.repo})`,
        );
    }
    const args = [
        'run',
        '--name',
        containerName(job),
        // Two labels, two jobs. `factory.job` is shared by every attempt of the job: it is what
        // `docker ps --filter label=factory.job` finds a runner that outlived its driver by, and
        // what the re-claim fence sweeps by — the one identifier every attempt shares.
        // `factory.lease` is this attempt's alone, and it is what scopes every per-attempt
        // operation (kill, teardown, cleanup) to this attempt's containers: a stale attempt's
        // filters can only ever resolve its own fleet, never a replacement's.
        '--label',
        `factory.job=${job.id}`,
        '--label',
        `factory.lease=${job.leaseToken}`,
        '-e',
        // The AUTHOR's checkouts sit one directory down. A command-only job names no repo, so the
        // agent starts at the root of that person's workspace and can see everything they selected
        // — and nothing anybody else selected.
        //
        // This used to be `<mount>/<orgId>`, one tree shared by every member. Neither `<mount>` nor
        // `<mount>/<orgId>` is a safe fallback now: both are the PARENT of every member's tree, and
        // handing that to a container that may be running --dangerously-skip-permissions is a
        // cross-tenant read. So a job with no workspace fails instead — see loop.ts.
        `WORKDIR=${worktree ?? `${config.workspaceMount}/${workspacePath(job)}`}`,
        '-v',
        `${config.workspaceVolume}:${config.workspaceMount}`,
    ];

    // A gated job's runner reaches the driver's gate endpoint by the default
    // `http://host.docker.internal:<port>`, which resolves only if the daemon is told what that
    // name means — automatic on Docker Desktop, not on Linux. Mapped iff the job has gates, so
    // an ungated runner's argv stays exactly what it always was.
    if (job.gates?.gates?.length) {
        args.push('--add-host', 'host.docker.internal:host-gateway');
    }

    if (config.remoteControl) {
        // `-t` alone, and NOT `-i -t`. Remote Control is an interactive session and will not start
        // one without a tty — but the driver's own stdin is not a terminal, and `docker run -i`
        // from a process whose stdin is not a tty fails outright with "the input device is not a
        // TTY". With `-t` by itself the daemon allocates the pty anyway and never attaches the
        // client's stdin to it, so the container gets a terminal that simply never delivers input
        // or EOF — which is exactly what a session waiting to be driven from elsewhere needs.
        args.push('-t');
        // Deliberately NOT passEnv. Remote Control requires a claude.ai subscription login, and
        // forwarding a token instead degrades it in silence: `--remote-control` still starts a
        // perfectly ordinary local session, and the only symptom is that it never appears at
        // claude.ai/code. So the volume is the only credential a Remote Control runner gets.
        args.push('-v', `${config.authVolume}:${AUTH_MOUNT}`);
        // The trust dialog is a real prompt, and an interactive session started by a driver has
        // nobody to answer it. See docker/claude-executor/README.md for what accepting it implies
        // when the checkout ships a .claude/settings.local.json.
        args.push('-e', 'TRUST_WORKDIR=1');
    } else {
        // The driver's own credentials ride as before: `-e NAME` without a value, docker reads it
        // from THIS process's environment. `-e NAME=value` would put the credential in an argv
        // every `ps` on the host can read — the same distinction the workspace reconcile makes for
        // the git token.
        //
        // The claim's env does NOT ride that way. Its names are member-controlled, and `-e NAME`
        // reads the value from this process's own environment — a member-configured PATH,
        // DOCKER_HOST or HOME there steers the docker CLI the driver executes on the host, which
        // is host code execution rather than a runner environment. So the claim travels in a
        // --env-file (written and removed by createDockerRunner), the values never touching this
        // process's environment at all. Reserved names are already gone (claimEnv); docker gives
        // `-e` precedence over `--env-file`, so a name the claim also carries is dropped from
        // passEnv — the claim must win.
        const claim = claimEnv(job);
        const claimNames = Object.keys(claim);
        // The loop's minted gate credentials ride the same file — envFileBody appends them after
        // the claim's lines — so a gated job whose claim resolves to nothing needs one too:
        // without it the runner has neither credential and can never make an ad-hoc gate call.
        const needsFile = claimNames.length > 0 || Object.keys(job.gateEnv ?? {}).length > 0;
        if (needsFile && !envFile) {
            throw new Error(`refusing to run job ${job.id}: claim or gate env exists but no env file was given`);
        }
        for (const name of config.passEnv.filter((n) => !Object.prototype.hasOwnProperty.call(claim, n))) {
            args.push('-e', name);
        }
        if (needsFile && envFile) args.push('--env-file', envFile);
    }

    if (config.network) args.push('--network', config.network);

    // The per-job services network, when the job declared services and the driver honors them.
    // Repeated --network flags need Docker 25.0 (API 1.44), where multi-network create landed;
    // on older daemons the flag is single-valued and the LAST one silently wins — which here
    // would drop the runner's telemetry network without an error. The two networks do different
    // jobs: config.network carries telemetry out, this one carries the job's DNS names in.
    if (servicesNetwork) args.push('--network', servicesNetwork);
    // Where the runner's telemetry is pointed. The executor image bakes a default endpoint
    // (http://collector:4318), but RUNNER_OTEL_ENDPOINT overrides it for a collector the compose
    // network cannot name — the same override the kubernetes runner applies in the pod spec. A
    // literal value, not a credential: an OTLP endpoint is a URL, and the kubernetes runner
    // already names it in a spec anyone with `get pods` can read. Not `-e NAME`, which would make
    // docker read OTEL_EXPORTER_OTLP_ENDPOINT from this process's environment — a different
    // variable from the RUNNER_OTEL_ENDPOINT this config was built from.
    args.push('-e', `OTEL_EXPORTER_OTLP_ENDPOINT=${config.otelEndpoint}`);

    // opencode: headless only — Remote Control is refused in the config, so there is no RC branch
    // here and no permissions flag either (the image's baked opencode.json decides them).
    //
    // Sessions: opencode mints its own (`ses_…`) and cannot adopt one minted in advance, so a
    // fresh run is given none — the runner scrapes the id the run actually used after it ends and
    // the loop reports it. A follow-up is the exception to "cannot adopt": its claim carries the
    // session opencode ITSELF created (persisted via XDG_DATA_HOME below), and `run --session
    // <id> <command>` continues that conversation with the new adjustment. A resume claim with
    // nothing to deliver is a parked claude-code session — standby is a Remote Control feature —
    // and is refused by loop.ts before it gets here.
    if (config.cli === 'opencode') {
        if (session && !session.resume) {
            throw new Error(`refusing to run job ${job.id}: the opencode runner cannot adopt a minted session`);
        }
        if (session && !job.followUp) {
            // Unreachable through the loop, which refuses this state first — this is the runner
            // asserting it too, because `run --session <id>` with nothing to deliver would idle a
            // headless run to its deadline. Standby is a Remote Control feature; opencode has none.
            throw new Error(`refusing to run job ${job.id}: the opencode runner restores a session only for a follow-up`);
        }
        // The session database has to outlive the container or there is nothing to resume into:
        // a fresh container starts with an empty one. Pointing XDG_DATA_HOME at the member's own
        // tree on the workspaces volume persists it per member, next to their checkouts — a
        // dot-directory the workspace reconcile never mistakes for a checkout (it clones only
        // rows it selected, and its naming rules refuse a leading dot).
        args.push('-e', `XDG_DATA_HOME=${config.workspaceMount}/${workspacePath(job)}/.opencode`);
        args.push(config.image, 'run');
        if (session) {
            if (!SESSION_ID.test(session.id)) {
                throw new Error(`refusing to run job ${job.id}: a session id that is not a safe token: ${session.id}`);
            }
            args.push('--session', session.id);
        }
        args.push(job.command);
        return args;
    }

    if (!session) {
        throw new Error(`refusing to run job ${job.id}: the claude-code runner runs every job as a session`);
    }

    // Restoring a session versus starting one. `--resume` keeps the original id — forking it is a
    // separate flag — which is what makes a parked job's link survive being parked.
    args.push(config.image, session.resume ? '--resume' : '--session-id', session.id);
    if (config.skipPermissions) args.push('--dangerously-skip-permissions');

    // Interactive versus headless. The command is the session's opening prompt and is delivered
    // once: on a resume it is already in the transcript, and sending it again would re-run the job
    // the human has been driving. The exception is a follow-up — its command is the NEW
    // adjustment, and the restored transcript is the conversation it continues, so it goes out
    // even though the session is being resumed. It goes last, so a command that looks like a flag
    // is still read as a prompt.
    const deliver = !session.resume || job.followUp;
    if (config.remoteControl) args.push('--remote-control', containerName(job));
    else if (deliver) args.push('-p');
    if (deliver) args.push(job.command);
    return args;
}

type Spawn = typeof spawn;

/**
 * Everything the runner does through the daemon other than the `docker run` itself — the fence,
 * the post-run inspect and the cleanup — goes through this one seam, so a test can stand in for
 * the daemon instead of shelling out to it.
 */
type ExecDocker = (args: string[]) => Promise<{ stdout: string }>;

export function createDockerRunner(config: DriverConfig, spawnFn: Spawn = spawn, execDocker: ExecDocker = (args) => run('docker', args)): Runner {
    /*
     * Lease tokens whose kill() fired while that attempt may still be awaiting the daemon in its
     * services setup. Keyed by LEASE TOKEN, not job id: the token is the per-attempt identity —
     * one driver process can hold two attempts of the same id at once (the poll loop re-claims an
     * expired-lease job while the first attempt's setup is still in flight), and the loop's kill
     * names the one attempt it killed. Keyed by id, the two attempts would share one marker: the
     * sibling claim would either be aborted by a kill meant for the other, or — wiping the marker
     * on entry, as this once did — revive the killed attempt to compete for the same network and
     * containers. Tokens never repeat, so the set only ever grows, by one entry per lost lease.
     *
     * This set is EFFICIENCY and early abort, not correctness: every daemon call any path issues
     * is scoped to its own attempt — by the lease label in its filters and the token in its
     * names — so a dying setup could issue every call it has and still never touch a sibling
     * attempt's resources. What the checks buy is that a dying setup stops CREATING: it does not
     * go on building a network, starting services and spawning a runner over a lease that is
     * already gone.
     */
    const killed = new Set<BoardJob['leaseToken']>();
    /**
     * Tears down THIS attempt's services and network — and, by construction, nothing else. The
     * `ps` filters carry this attempt's lease token beside the job id, and the network it removes
     * is named after the token too, so every call here resolves only to resources this attempt
     * created. That is what makes it safe to run UNCONDITIONALLY, from every closing path: a
     * close that lands late, a kill that lands after a replacement claim stood its own fleet up,
     * a spawn error racing a newer attempt's setup — none of them can NAME anything but this
     * attempt's own fleet, so none of them needs an ownership gate. Daemon calls are arbitrarily
     * slow and attempts can supersede each other mid-call; attempt scoping is what holds at
     * execution time, because it is not a snapshot but a property of the argv itself.
     *
     * Every removal tolerates the thing already being gone, which makes the whole teardown
     * idempotent — it runs twice per attempt by design, as the fence's service half before the
     * run and as the teardown after it.
     */
    const serviceTeardown = async (job: BoardJob): Promise<void> => {
        if (!config.servicesEnabled) return;
        const found = await execDocker([
            'ps',
            '-aq',
            '--filter',
            `label=factory.job=${job.id}`,
            '--filter',
            `label=factory.lease=${job.leaseToken}`,
            '--filter',
            'label=factory.service',
        ]).catch(() => ({ stdout: '' }));
        const ids = found.stdout.split('\n').map((id) => id.trim()).filter(Boolean);
        for (const id of ids) {
            await execDocker(['rm', '-f', id]).catch(() => undefined);
        }
        await execDocker(['network', 'rm', networkName(job)]).catch(() => undefined);
    };

    const kill = async (job: BoardJob): Promise<void> => {
        // Recorded before anything is torn down: this attempt, sitting in its services setup,
        // reads this between awaited steps and aborts instead of creating more resources or
        // spawning the runner over a lease that is already gone. The token, not the id, is what
        // is recorded — a sibling attempt of the same job carries a different token and must
        // not read this one's cancellation.
        killed.add(job.leaseToken);
        // Killing the `docker run` process would only detach the CLI; the container keeps running
        // and the workspace keeps being written to. The daemon has to be told — by ID, resolved
        // through this attempt's own lease label, never by name: a kill that resolved a
        // job-derived name would address whatever owns that name at daemon-execution time, and
        // names are attempt-scoped now precisely so no such ambiguity exists. The label pair
        // (job, lease) resolves to this attempt's containers alone; a stale kill that finds
        // nothing has nothing of its own left to kill.
        const found = await execDocker([
            'ps',
            '-aq',
            '--filter',
            `label=factory.job=${job.id}`,
            '--filter',
            `label=factory.lease=${job.leaseToken}`,
        ]).catch(() => ({ stdout: '' }));
        for (const id of found.stdout.split('\n').map((id) => id.trim()).filter(Boolean)) {
            await execDocker(['kill', id]).catch(() => undefined);
        }
        // The declared services go with the runner: a killed job's database has no reason to
        // outlive the job, and the close handler's teardown would catch them anyway — this is so
        // a kill while nothing is reading the outcome (lost lease, shutdown) still reclaims them.
        // Attempt-scoped, like every teardown: whatever a replacement attempt is running is
        // invisible to these filters.
        await serviceTeardown(job);
    };

    /*
     * The re-claim fence — the only JOB-scoped sweep this runner performs, and the one component
     * allowed to be job-scoped: it runs BEFORE this attempt creates anything, so whatever it
     * finds is by construction a previous attempt's leftover. Names are attempt-scoped now, so
     * no name can find a previous attempt's leftovers — the `factory.job` label is the one
     * identifier every attempt of the job shares, and the sweep is by label: every leftover
     * container (runners and services alike), then every leftover network. This claim exists
     * only because those attempts' leases are gone, so removing them delivers the same verdict
     * their heartbeats would have, had the driver survived to receive it — and the alternative
     * to leaving a live leftover runner running is two writers on one checkout, which is the
     * thing actually worth preventing.
     *
     * It runs TWICE per attempt by design: once in syncCheckout — the loop calls the sync
     * before run(), and the sync is the first writer on the task worktree, so the previous
     * attempt's runner must be off the daemon before the worktree script starts, not only
     * before the runner does — and once in run(), which keeps its own call so the guarantee
     * never depends on the loop's ordering. The sweep is idempotent; removing twice what was
     * removed once removes nothing.
     */
    const reclaimFence = async (job: BoardJob): Promise<void> => {
        const leftovers = await execDocker(['ps', '-aq', '--filter', `label=factory.job=${job.id}`]).catch(
            () => ({ stdout: '' }),
        );
        for (const id of leftovers.stdout.split('\n').map((id) => id.trim()).filter(Boolean)) {
            await execDocker(['rm', '-f', id]).catch(() => undefined);
        }
        const staleNetworks = await execDocker([
            'network',
            'ls',
            '--filter',
            `label=factory.job=${job.id}`,
            '--format',
            '{{.Name}}',
        ]).catch(() => ({ stdout: '' }));
        for (const name of staleNetworks.stdout.split('\n').map((name) => name.trim()).filter(Boolean)) {
            await execDocker(['network', 'rm', name]).catch(() => undefined);
        }
        // TRANSITIONAL: networks created before the lease token joined the name carry no
        // labels at all, so the sweep above cannot see them. Remove the pre-redesign name
        // outright; tolerated absent. This line may be dropped once no pre-redesign leftover
        // can exist any more.
        await execDocker(['network', 'rm', `factory-job-${job.id}-services`]).catch(() => undefined);
    };

    return {
        kill,

        /*
         * The startup sync is one container, one script: fetch, then create the task's worktree
         * branched off origin/<default> or rebase the existing one onto it. The env names the
         * three paths the script needs — the clone (where origin lives), the worktree, the branch
         * — literal values, not credentials; the claim env rides the env file exactly as before.
         * A conflicting rebase aborts itself in the script and answers { ok: false } with the
         * reason — the loop fails the run before it starts rather than leaving the worktree
         * mid-rebase for every later turn to trip over.
         */
        async syncCheckout(job: BoardJob): Promise<SyncResult> {
            const clone = repoPath(config, job);
            const worktree = worktreeDir(config, job);
            if (!clone || !worktree) return { ok: true, reason: null }; // nothing synced, nothing to fail either

            /*
             * The fence BEFORE the sync: the loop calls syncCheckout before run(), so without
             * this the worktree script would start while a previous attempt's runner was still
             * writing the same shared task worktree — mixed edits, or a rebase conflict nobody
             * is awake to resolve. The sweep is idempotent, and run() keeps its own: twice per
             * attempt is already the fence's documented shape, the same way the service
             * teardown half runs twice.
             */
            await reclaimFence(job);
            let file: string | null = null;
            try {
                file = envFilePath(job);
                await writeFile(file, envFileBody(job), { mode: 0o600 });
            } catch (e) {
                return { ok: false, reason: `could not write the sync env file: ${(e as Error).message}` };
            }
            try {
                // 'run' and '--rm' INCLUDED — every execDocker argv here is a full `docker run`:
                // this exact call once shipped as `docker -v ... -w ...`, which is not a command
                // docker knows, and the sync failed on every job while the compile and the flow
                // tests (which match argv by shape, not by head) stayed green.
                const out = await execDocker([
                    'run',
                    '--rm',
                    '-v',
                    `${config.workspaceVolume}:${config.workspaceMount}`,
                    '--env-file',
                    file,
                    '-e',
                    `REPO=${clone}`,
                    '-e',
                    `WORKTREE=${worktree}`,
                    '-e',
                    `BRANCH=${worktreeBranch(job)}`,
                    '--entrypoint',
                    'node',
                    config.image,
                    '-e',
                    gitWorktreeScript,
                ]);
                const line = out.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
                try {
                    return JSON.parse(line) as SyncResult;
                } catch {
                    return { ok: false, reason: 'the worktree sync answered nothing readable' };
                }
            } catch (e) {
                const err = e as { stderr?: string | Buffer; message?: string };
                const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf8') ?? '';
                const detail =
                    stderr.trim() ||
                    (err.message ?? '').split('\n').slice(1).join('\n').trim() ||
                    (err.message ?? 'failed');
                return { ok: false, reason: `the worktree sync container failed: ${detail.slice(0, 300)}` };
            } finally {
                if (file) await rm(file).catch(() => undefined);
            }
        },

        /*
         * Publishing is attempt-scoped like everything else here: the env file is named after the
         * lease token, every container is a throwaway over the workspaces volume (this process has
         * no host path into it), and the credential travels by --env-file — GITHUB_TOKEN from the
         * claim env is in no argv anywhere, only inside the container's environment where the
         * credential helper reads it. The steps are separate daemon round-trips rather than one
         * shell script, so a failure names its step, and no board-supplied or checkout-supplied
         * value ever passes through a shell.
         *
         * Every step runs in the task worktree (issue #35) — the tree the run actually edited.
         */
        async publishGit(job: BoardJob): Promise<PublishResult> {
            const repo = worktreeDir(config, job);
            if (!repo) return publishFailed('the job names no checkout this driver can publish');
            let file: string | null = null;
            try {
                file = envFilePath(job);
                await writeFile(file, envFileBody(job), { mode: 0o600 });
            } catch (e) {
                return publishFailed(`could not write the publish env file: ${(e as Error).message}`);
            }
            try {
                const plan = publishPlan(job);
                // 'run' and '--rm' INCLUDED — the same full-command rule the sync above states.
                const vol = ['run', '--rm', '-v', `${config.workspaceVolume}:${config.workspaceMount}`];
                const inRepo = [...vol, '-w', repo];

                /*
                 * Every failure names its step and carries the tool's own STDERR, never the echoed
                 * command. The execFile message is "Command failed: <the whole docker run argv>" —
                 * 400 characters of that leaves no room for the one line a human can act on
                 * ("remote: Permission to ... denied to bellows-ai[bot]" lives in git's stderr),
                 * which is exactly how a credential problem once shipped as an unreadable verdict.
                 */
                const runStep = async (name: string, args: string[]): Promise<{ stdout: string }> => {
                    try {
                        return await execDocker(args);
                    } catch (e) {
                        const err = e as { stderr?: string | Buffer; message?: string };
                        const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf8') ?? '';
                        const detail =
                            stderr.trim() ||
                            (err.message ?? '').split('\n').slice(1).join('\n').trim() ||
                            (err.message ?? 'failed');
                        throw new Error(`${name}: ${detail.slice(0, 300)}`);
                    }
                };

                // What is there to publish? A checkout that was never cloned and a clean,
                // fully-pushed tree are the two ordinary no-ops; everything else flows.
                const probe = await execDocker([
                    ...vol,
                    '-e',
                    `REPO=${repo}`,
                    '--entrypoint',
                    'node',
                    config.image,
                    '-e',
                    gitProbeScript,
                ]).catch(() => null);
                const state = parseGitState(probe?.stdout ?? '');
                if (!state.cloned) return publishNothing('the checkout has not been cloned yet');
                if (!state.dirty && state.unpushed === 0) {
                    return publishNothing('no uncommitted changes and nothing unpushed');
                }

                // A task never lands on the default branch. An existing task branch is reused —
                // `switch -c` only when the branch is not there yet, so earlier attempts' commits
                // survive.
                const onDefault = !state.branch || state.branch === state.defaultBranch;
                const branch = onDefault ? plan.branch : state.branch;
                if (!isBranchName(branch)) {
                    return publishFailed(`refusing to publish a branch named "${branch}"`);
                }
                if (onDefault) {
                    const switched = await execDocker([
                        ...inRepo,
                        '--entrypoint',
                        'git',
                        config.image,
                        'switch',
                        branch,
                    ]).catch(() => null);
                    if (!switched) {
                        await runStep('git switch', [...inRepo, '--entrypoint', 'git', config.image, 'switch', '-c', branch]);
                    }
                }

                if (state.dirty) {
                    await runStep('git add', [...inRepo, '--entrypoint', 'git', config.image, 'add', '-A']);
                    // The checkout usually has no committer identity (the agent does not need one
                    // to edit); a fallback is applied only when the probe found none, so a
                    // member-configured identity is never overridden.
                    const identity = state.hasIdentity
                        ? []
                        : ['-c', 'user.name=factory-ai', '-c', 'user.email=factory-ai@users.noreply.github.com'];
                    await runStep('git commit', [...inRepo, '--entrypoint', 'git', config.image, ...identity, 'commit', '-m', plan.title]);
                }

                await runStep('git push', [
                    ...inRepo,
                    '--env-file',
                    file,
                    '--entrypoint',
                    'git',
                    config.image,
                    '-c',
                    `credential.helper=${CREDENTIAL_HELPER}`,
                    'push',
                    '-u',
                    '--force-with-lease',
                    'origin',
                    'HEAD',
                ]);

                // Reuse the branch's PR when one exists — a task that already shipped its PR gets
                // idempotent publishes, not duplicates.
                let prUrl: string | null = null;
                const existing = await execDocker([
                    ...inRepo,
                    '--env-file',
                    file,
                    '--entrypoint',
                    'gh',
                    config.image,
                    'pr',
                    'view',
                    branch,
                    '--json',
                    'url',
                    '-q',
                    '.url',
                ]).catch(() => null);
                if (existing) {
                    prUrl = existing.stdout.trim().split('\n').filter(Boolean).pop() ?? null;
                }
                if (!prUrl) {
                    const body = plan.issueNumber
                        ? `Closes #${plan.issueNumber}.\n\nPublished by the factory board after the declared gates passed.`
                        : 'Published by the factory board after the declared gates passed.';
                    const created = await runStep('gh pr create', [
                        ...inRepo,
                        '--env-file',
                        file,
                        '--entrypoint',
                        'gh',
                        config.image,
                        'pr',
                        'create',
                        '--head',
                        branch,
                        '--title',
                        plan.title,
                        '--body',
                        body,
                    ]);
                    prUrl = created.stdout.trim().split('\n').filter(Boolean).pop() ?? null;
                }
                return { ok: true, published: true, branch, prUrl, reason: null };
            } catch (e) {
                return publishFailed(`${(e as Error).message}`.slice(0, 400));
            } finally {
                if (file) await rm(file).catch(() => undefined);
            }
        },

        async remoteSessionId(job, sessionId) {
            // Every failure here is the ordinary case, not an error: the container may have exited,
            // the transcript may not exist yet, or the bridge may simply not have connected.
            const read = await run('docker', remoteSessionArgs(job, sessionId)).catch(() => null);
            return read ? parseRemoteSessionId(read.stdout) : null;
        },

        // The container is named by this attempt's lease token, so a sample can only ever resolve
        // its own attempt's runner — the same attempt-scoping every per-attempt operation here
        // leans on. A refused read (the container exited between the ask and the stats round-trip,
        // the daemon is busy) answers null, which the loop reads as "report no vitals this round".
        async sampleRuntime(job) {
            const read = await execDocker(['stats', '--no-stream', '--format', '{{json .}}', containerName(job)]).catch(
                () => null,
            );
            return read ? parseDockerStats(read.stdout) : null;
        },

        async run(job, session, onOutput) {
            // No entry-time clearing of the killed set: a fresh claim carries a fresh lease
            // token that was never recorded, so nothing recorded for an earlier attempt can
            // reach this one — and clearing by id would revive exactly the dead attempt the
            // token keying exists to keep down. See the killed set above.

            /*
             * The fence before anything this attempt creates — the job-scoped sweep documented
             * on reclaimFence above. It already ran once, in syncCheckout; run() keeps its own
             * call so the guarantee never depends on the loop's ordering.
             */
            await reclaimFence(job);

            /*
             * Auxiliary services (issue #6): read the checkouts' .bellows.yaml, then network and
             * containers, each step with its own verdict.
             *
             * A refused read and a refused service start are INFRASTRUCTURE — the daemon said no
             * to a container this process spawned, the same class as a refused runner spawn — so
             * they throw, and the loop leaves the job to its lease instead of blaming the command.
             * A partial fleet is torn down on the way out. A parse refusal, by contrast, is the
             * AUTHOR's: deterministic, and fully said by the message, so it is returned as a
             * failed run rather than thrown — retrying a file that cannot change would burn
             * attempts on an error no retry fixes. (`started: true` there means "this verdict is
             * final", not "a container ran"; the loop reads it only to decide between reporting
             * and leaving the job to its lease.)
             */
            let servicesNetwork: string | null = null;
            let refusal: string | null = null;
            /*
             * A kill that lands while this setup is awaiting the daemon must stop the attempt.
             * Throwing loses nothing: the loop discards a lost-lease outcome, and the next
             * attempt's fence removes whatever was already created. Correctness does not depend
             * on these checks — every daemon call this setup could go on to issue is scoped to
             * this attempt's own lease, so running to completion could not touch a sibling
             * attempt's resources. What they buy is that a dying attempt stops CREATING: it does
             * not go on to the network, the services and the runner spawn over a lease this
             * driver no longer holds. So the flag is checked after every awaited step below, and
             * once more after the claim-env file write — the last await before the spawn — so
             * the gap between that final check and spawnFn is synchronous, and nothing can land
             * inside it unobserved.
             *
             * The abort is deliberately teardown-FREE. kill() ran the attempt-scoped teardown
             * when the lease was lost; anything THIS attempt created after that point is a
             * leftover, and leftovers belong to the NEXT attempt's fence — the one sweep that
             * runs BEFORE the newer attempt creates anything, so it can tell a dead attempt's
             * leftovers from a live fleet. A teardown fired from this dying attempt would be
             * harmless (attempt-scoped) but redundant, and it would only hold up the rejection
             * the loop is waiting for.
             */
            const assertNotKilled = async (): Promise<void> => {
                if (!killed.has(job.leaseToken)) return;
                throw new Error(`job ${job.id}: killed while setting up services`);
            };
            if (config.servicesEnabled) {
                // The fence's service half. Everything job-scoped is already gone, and this
                // attempt has created nothing yet, so this is a no-op by construction — kept
                // because it makes "the fleet starts clean" hold by the same attempt-scoped code
                // that enforces it at teardown, not by the fence's special-casing.
                await serviceTeardown(job);
                let raw: string;
                try {
                    raw = (await execDocker(readBellowsArgs(config, job))).stdout;
                } catch (e) {
                    throw new Error(`could not read .bellows.yaml: ${(e as Error).message}`);
                }
                await assertNotKilled();
                let specs: ServiceSpec[];
                try {
                    specs = collectServices(splitBellowsSections(raw));
                } catch (e) {
                    refusal = (e as Error).message;
                    specs = [];
                }
                if (specs.length) {
                    servicesNetwork = networkName(job);
                    // The fence already swept the job's stale networks, and this name carries
                    // this attempt's own token — a create here cannot collide with anything.
                    try {
                        // Labeled like everything else the attempt creates: factory.job is
                        // what the next attempt's fence sweeps networks by, factory.lease
                        // what scopes the teardown's removal to this attempt's own.
                        await execDocker([
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
                    await assertNotKilled();
                    for (const spec of specs) {
                        try {
                            await execDocker(serviceRunArgs(job, spec));
                        } catch (e) {
                            await serviceTeardown(job);
                            throw new Error(`could not start service "${spec.name}": ${(e as Error).message}`);
                        }
                        await assertNotKilled();
                    }
                }
            }
            if (refusal !== null) {
                return { exitCode: null, output: refusal, timedOut: false, idled: false, started: true };
            }

            // The runner container is the last resource this attempt creates, and the spawn is
            // what a killed setup must never reach — see assertNotKilled for why a throw is the
            // right verdict here.
            await assertNotKilled();

            /*
             * The env file's ride: a 0600 file in the OS temp directory, written just before the spawn
             * and removed as soon as the run is over — a crash leaves it in tmpdir at worst, never
             * in argv and never in this process's environment. The body is the claim env PLUS the
             * loop's minted gate credentials, so a gated job whose claim resolves to nothing still
             * carries its BELLOWS_GATE_URL/TOKEN. Skipped under Remote Control, exactly like every
             * other forwarded credential.
             */
            const body = config.remoteControl ? '' : envFileBody(job);
            const file = body ? envFilePath(job) : null;
            if (file) await writeFile(file, body, { mode: 0o600 });
            // The write above is an await, so the kill-check must run once more: a lease lost
            // while the write was pending would otherwise reach spawnFn — a runner started over
            // a dead lease, its job-derived container name colliding with the replacement's.
            // On this abort the just-written file is removed by hand: the cleanup below only
            // wraps a settled outcome, and this throw precedes it.
            try {
                await assertNotKilled();
            } catch (abort) {
                if (file) await rm(file).catch(() => undefined);
                throw abort;
            }

            const outcome = new Promise<RunOutcome>((resolve, reject) => {
                // The verdict for a close, decided after the process is gone. An exit 125 is
                // ambiguous on the shared stderr — the daemon's refusal and a command that
                // genuinely exited 125 are printed onto the same stream — so the daemon is asked
                // instead: a container that exists ran, and its State is the truth; "no such
                // container" means `docker run` never got one accepted, and nothing ran. Any
                // other exit code unambiguously belongs to the attached container.
                const verdict = async (code: number | null): Promise<RunOutcome> => {
                    let started = true;
                    if (code === 125) {
                        try {
                            const state = JSON.parse(
                                (await execDocker(['inspect', '--format', '{{json .State}}', containerName(job)])).stdout,
                            ) as { Status?: string };
                            started = state.Status === 'exited';
                        } catch {
                            started = false;
                        }
                    }
                    // Cleanup is explicit (--rm is gone, precisely so the inspect above can see
                    // the container): the fence on the next claim would catch it anyway, but
                    // leaving one daemon round-trip of litter behind is not tidiness worth
                    // keeping. Failed removals are the fence's business.
                    await execDocker(['rm', '-f', containerName(job)]).catch(() => undefined);
                    // The services outlive the runner by one teardown: the author's tests may
                    // have left their database mid-write, and nothing reads the workspace after
                    // the runner is gone, so nothing needs them anymore. UNCONDITIONAL, and safe
                    // unconditionally: the teardown is scoped to this attempt's lease, so a
                    // close that lands arbitrarily late — after a kill, after a replacement
                    // claim stood its own fleet up — can only ever name and remove what THIS
                    // attempt created. No knowledge of who claimed what in between is needed,
                    // and none would be reliable anyway: daemon calls are arbitrarily slow, and
                    // any snapshot of "who is current" is stale by the time it is checked.
                    await serviceTeardown(job);
                    return { exitCode: code, output, timedOut, idled, started, cacheLost };
                };

                const child = spawnFn('docker', dockerArgs(config, job, session, servicesNetwork, file ?? undefined), {
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let timedOut = false;
                let idled = false;
                let cacheLost: string | null = null;

                // Armed only under Remote Control, where a session sits waiting for a human and
                // silence means nobody is driving it. A headless run has nobody to come back to
                // it, so parking one would strand it.
                let idleTimer: NodeJS.Timeout | null = null;
                const idle = () => {
                    if (!config.remoteControl) return;
                    if (idleTimer) clearTimeout(idleTimer);
                    idleTimer = setTimeout(() => {
                        idled = true;
                        void kill(job);
                    }, config.idleMs);
                };
                idle();

                let output = '';
                const collect = (chunk: Buffer | string) => {
                    output += String(chunk);
                    // Keep the tail: a run that fails says why at the end, and the head is banner.
                    // Byte-true, because the report has to fit the board's body limit whatever the
                    // log contained — see reportTail.
                    output = reportTail(output);
                    // The same tail a complete report would carry, handed over as it grows. Every
                    // chunk calls back; throttling is the loop's business, not this runner's.
                    onOutput?.(output);
                    idle();
                };
                child.stdout?.on('data', collect);
                child.stderr?.on('data', collect);

                // Armed only under Remote Control: with both running the shorter one always wins, so
                // a drivable job would be killed and reported failed before it could ever be
                // parked. There, silence is the bound.
                const timer = config.remoteControl
                    ? null
                    : setTimeout(() => {
                          timedOut = true;
                          void kill(job);
                      }, config.jobTimeoutMs);

                /*
                 * The cache watch polls on a period while the run is live. Each tick is one
                 * throwaway probe container; a probe that fails once (the daemon is busy, the
                 * session is not there yet) just waits for the next tick, and the trigger itself
                 * needs three consecutive damning turns, so no single answer — or no single fluke —
                 * kills anything. The kill is this attempt's own, label-scoped like every other;
                 * config guarantees the watch is only armed for opencode on docker, headless.
                 */
                let cacheTimer: NodeJS.Timeout | null = null;
                if (config.cacheWatch) {
                    cacheTimer = setInterval(() => {
                        void (async () => {
                            const probe = await execDocker(opencodeCacheProbeArgs(config, job))
                                .then((read) => parseOpencodeCacheProbe(read.stdout))
                                .catch(() => null);
                            if (!probe || !probe.sessionId || cacheLost) return;
                            const collapse = cacheCollapse(probe.turns);
                            if (collapse) {
                                cacheLost = collapse;
                                void kill(job);
                            }
                        })();
                    }, config.cacheWatchPollMs);
                }

                const done = () => {
                    if (timer) clearTimeout(timer);
                    if (idleTimer) clearTimeout(idleTimer);
                    if (cacheTimer) clearInterval(cacheTimer);
                };

                /*
                 * A spawn failure makes Node deliver 'error' and then 'close' with a null code.
                 * The flag keeps the two apart: once it is set, close must not settle the
                 * promise, because verdict(null) would read as a started run with no exit code —
                 * terminally reported as a failed job — when the truth is infrastructure the
                 * loop should leave to its lease for retry.
                 */
                let spawnFailed = false;
                child.on('error', (error) => {
                    spawnFailed = true;
                    done();
                    // The spawn itself failed (docker missing, exec blew up). Whatever services
                    // were started before it are torn down BEFORE the rejection lands — teardown
                    // tolerates absence, so either way a rejection means cleanup is as done as
                    // it gets, and the rejection waits for the teardown's verdict. The teardown
                    // is attempt-scoped, so no supersession check is needed: even if a
                    // replacement claim landed while this attempt was failing, the filters carry
                    // this attempt's lease and the network is named after it — the teardown
                    // cannot reach the replacement's fleet.
                    serviceTeardown(job).then(
                        () => reject(error),
                        () => reject(error),
                    );
                });
                child.on('close', (code) => {
                    // The error handler owns this failure and its rejection is already deferred
                    // behind the service teardown; a close here carries only the null code of a
                    // process that never ran, and settling verdict(null) over the pending
                    // rejection would turn infrastructure into a terminal verdict.
                    if (spawnFailed) return;
                    done();
                    void verdict(code)
                        .then(async (outcome) => {
                            /*
                             * opencode mints its own session id, so the loop had none to report at
                             * spawn — this is where it comes from instead: one throwaway container
                             * over the workspaces volume, one read-only query against the
                             * database the run just closed. The same read answers HOW the run's
                             * last message ended — a zero exit code with a finish reason that is
                             * not `stop` is the model's context limit (or an abort) cutting a
                             * task short, which only the session database knows. A failed read is
                             * not a failed run: it costs the task its follow-ups and this
                             * verdict-check, not its verdict.
                             */
                            if (config.cli === 'opencode') {
                                /*
                                 * NOT single-shot, and not only when the container fails. The CLI
                                 * exited a moment ago, and its session database may still be
                                 * mid-checkpoint — a read-only open of a WAL that needs recovery
                                 * fails outright, then succeeds milliseconds later. The readout
                                 * script answers one of three ways — a session line, an error
                                 * line, or nothing — and ALL but the first read as "no session
                                 * yet", so the retries fire on the session being missing,
                                 * whatever the reason. One failed readout silently cost a run its
                                 * session, its finish reason and its context stats: a task that
                                 * could never be followed up, with nothing in any log saying why.
                                 * Three tries, half a second apart; a failed read is still not a
                                 * failed run.
                                 */
                                let scraped: OpencodeRunOutcome = {
                                    sessionId: null,
                                    finishReason: null,
                                    contextTokens: null,
                                    costUsd: null,
                                    error: null,
                                };
                                let reason: string | null = null;
                                for (let attempt = 0; attempt < 3 && !scraped.sessionId; attempt += 1) {
                                    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
                                    scraped = await execDocker(opencodeSessionReadoutArgs(config, job)).then(
                                        (read) => parseOpencodeRunOutcome(read.stdout),
                                        (err: Error): OpencodeRunOutcome => ({
                                            sessionId: null,
                                            finishReason: null,
                                            contextTokens: null,
                                            costUsd: null,
                                            error: `the readout container failed: ${err.message}`,
                                        }),
                                    );
                                    reason = scraped.error ?? reason;
                                }
                                if (scraped.sessionId) {
                                    outcome.sessionId = scraped.sessionId;
                                    if (scraped.finishReason) outcome.finishReason = scraped.finishReason;
                                    if (scraped.contextTokens !== null) outcome.contextTokens = scraped.contextTokens;
                                    if (scraped.costUsd !== null) outcome.costUsd = scraped.costUsd;
                                } else {
                                    outcome.readoutError =
                                        reason ?? 'the readout answered nothing (no session in the database)';
                                }
                            }
                            return outcome;
                        })
                        .then(resolve, reject);
                });
            });

            // The file dies with the run — verdict read or not, resolved or thrown. The CLI has
            // long since read it; the daemon has the values in the container's config.
            try {
                return await outcome;
            } finally {
                if (file) await rm(file).catch(() => undefined);
            }
        },
    };
}
