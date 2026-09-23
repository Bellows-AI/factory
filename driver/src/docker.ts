import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import { worktreeDir, type PublishResult, type ReclaimResult, type SyncResult } from './publish.js';

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

/** The close-time claude-code turn count: see scripts/claude-turns.cjs. */
export const claudeTurnsScript = script('claude-turns.cjs');

/**
 * The close-time claude-code turn read's whole budget, matching the kubernetes twin's
 * `activeDeadlineSeconds`. The runner's timeout is long gone by the time this read runs, so
 * without a bound of its own a stalled daemon would hold the verdict — and the worker slot —
 * open forever. On expiry the read answers null: unmeasured, never a wrong number.
 */
export const CLOSE_READ_DEADLINE_MS = 120_000;

/** The live cache probe: see scripts/opencode-cache-probe.cjs. */
export const opencodeCacheProbeScript = script('opencode-cache-probe.cjs');

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
     * Undefined when no scrape happened (claude-code, or an opencode run whose scrape never
     * ran); null when the scrape ran but read nothing. A zero exit code with a finish reason
     * that is not `stop` is a run that STOPPED TALKING, not one that finished — the loop
     * reports it failed rather than letting the exit code call a truncated run a success.
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
     * Undefined for claude-code, which never scrapes.
     */
    readoutError?: string | null;
    /**
     * The last provider error the scraped session recorded — the rejection the provider returned
     * as the run's dying word (an HTTP 429 rate limit, observed 2026-09-11, cutting a run off
     * mid-tool-call with exit 0). Lifted from the session database beside the finish reason; set
     * only when the scrape found the session, and absent for claude-code, which never scrapes.
     * The loop names it in the premature-stop note, because a finish reason of `tool-calls` says
     * the run stopped talking without saying what stopped it.
     */
    providerError?: string | null;
    /**
     * Why the cache watch killed the run, when it did — the observed turns, so the verdict the
     * author reads names what the provider stopped doing instead of just "failed". Undefined
     * when the watch is off or never fired; never set by claude-code, and the watch itself is
     * docker-only (config refuses it under EXECUTOR=kubernetes).
     */
    cacheLost?: string | null;
    /**
     * The run's agent turns — one assistant response cycle in the run's ROOT conversation,
     * counted from the session's own records at close (opencode: the session database the
     * readout walks; claude-code: the transcript on the workspaces volume). Null when the read
     * ran and could not measure — the transcript was gone, or the container died first; absent
     * when no read was attempted (claude-code's Remote Control keeps an interactive
     * conversation no single read may freeze mid-flight). The board stores what arrives: absent
     * and null both land as null — unmeasured, never zero.
     */
    agentTurns?: number | null;
    /**
     * What the run did, in the agent's own last words — the run's final assistant text, read
     * from the same records as `agentTurns` (opencode: the session database's part rows;
     * claude-code: the transcript's text blocks), collapsed to one line by the script. Null
     * when the read ran and found none — a run cut off mid-tool-call has no final text; absent
     * when no read was attempted. Reported with the verdict and stored on the job row, where
     * the recently-completed view shows what a task did without opening its output.
     */
    summary?: string | null;
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
     * "this platform does not publish". `publishToken` is the board's publish-fresh credential
     * (the claim's can be an hour past expiry by push time); both transports lay it over the
     * claim env through withPublishToken, so neither can drift.
     */
    publishGit?(job: BoardJob, publishToken?: string): Promise<PublishResult>;
    /**
     * Prepares the job's task worktree before the run. A STARTING claim syncs it with the
     * remote default: fetch, create the worktree branched off `origin/<default>` (first attempt
     * of the thread) or rebase it onto the new default, keeping its commits. A claim that
     * CONTINUES a session (a follow-up, or a parked job resumed) RESTORES instead: no fetch, no
     * rebase — the tree is kept exactly as the run before it left it, or recreated from the
     * surviving thread branch (issue #58: git operations that touch the remote belong to the
     * task's beginning and end, never its middle). Called before the runner spawns, so a task
     * starts from the code it is meant to continue. Answers { ok: false, reason } rather than
     * throwing; the loop turns that into the verdict.
     */
    syncCheckout(job: BoardJob): Promise<SyncResult>;
    /**
     * Reclaims the task worktree after the thread's LAST job is terminal: removes the per-thread
     * tree and prunes its admin entry, so a finished or deleted task does not leave its tree
     * squatting on the member volume forever (issue #47). Best-effort by contract: the loop calls
     * it after a verdict precisely because the verdict is already safe on the board — a reclaim
     * that refuses (a path that is not the sync's own worktree, a daemon that says no) must never
     * turn a done task back into a failed one, and the loop logs and moves on. Refusal keeps the
     * tree by design: the script it runs deletes only what the sync itself created, and the
     * surviving factory/<root> branch lets a later follow-up recreate the tree with a fresh sync.
     */
    reclaimWorktree(job: BoardJob): Promise<ReclaimResult>;
    /**
     * Hands back whatever the startup sync's fence took — the kubernetes checkout claim, which
     * syncCheckout acquires and HOLDS through the run. The loop calls this only on the terminal
     * pre-run refusals that complete the job failed WITHOUT runner.run, where run()'s finally —
     * the ordinary release path — never executes; a refusal that never runs must not hold the
     * checkout. Ownership-checked inside the runner: only the exact claim this attempt still
     * holds is released, never one that moved on. Optional: docker's fence leaves nothing
     * behind to release, so its runner implements nothing and a loop facing it never calls.
     */
    releaseFence?(job: BoardJob): Promise<void>;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What an agent session id may look like before it is interpolated into runner argv — claude's
 * uuids and opencode's `ses_…` both qualify, and nothing shell-shaped does. The id on a resume
 * claim comes from the board, and a board is not something this process trusts with a fragment of
 * a command. Copied from server/src/routes/jobs.ts, which states the same rule for the report:
 * this package depends on nothing, deliberately. Exported because the kubernetes runner asserts
 * the same id before the same interpolation.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/**
 * `<org>/<user id>` and nothing else, asserted before it is interpolated into a `docker run`.
 *
 * The board is not something this process trusts with a fragment of a command line — the same rule
 * `remoteSessionArgs` applies to a session id. Here the stakes are higher: the value becomes the
 * agent's working directory, and `..` in it would point at the parent of every member's tree.
 *
 * The two halves restate the org-id shape server/src/auth/github.ts documents (≤ 39 chars) and the uuid above. COPIED rather
 * than imported: this package depends on nothing, deliberately (see AGENTS.md), and sharing a
 * constant with the server would give a process that needs only `fetch` and `docker` the whole
 * server dependency tree.
 */
const WORKSPACE_PATH = /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `--mount` argv that scopes the workspaces volume to one member's `<orgId>/<userId>` subtree
 * — the kernel-enforced boundary every container this runner starts works behind (docker ≥ 26.1,
 * where `volume-subpath` landed). One shape for the runner and every aux container, so the
 * executors and the containers cannot drift on what a job may reach: the selected subtree is what
 * the mount serves, and a target that does not exist yet fails the container loudly — never a
 * fallback to the whole volume, which would be the cross-tenant read this exists to close.
 *
 * The target is the subtree's OWN volume path (`${mount}/${subPath}`, review finding on #151):
 * every consumer path this driver composes — WORKDIR, the sync's REPO/WORKTREE, the readouts'
 * database and transcript paths, BELLOWS_ROOT, the gate's working directory — is the string
 * `${config.workspaceMount}/${subPath}/…`, shared verbatim between argv/env and the scripts.
 * Mounting the subtree there keeps every one of those paths resolving inside the container,
 * while the rest of the volume is absent from its filesystem entirely: `/workspaces` holds only
 * the member's own `bellows/<user>` and no sibling or foreign path resolves.
 *
 * `readOnly` is the readout variant (the `.bellows.yaml` read), which the `--mount` form spells
 * as an option rather than a `:ro` suffix. services.ts builds the same string itself — it cannot
 * import this module (one direction only), the same copied-regex rule the workspace path
 * assertions already follow.
 */
export const workspacesMountArgs = (config: DriverConfig, subPath: string, readOnly = false): string[] => [
    '--mount',
    `type=volume,src=${config.workspaceVolume},volume-subpath=${subPath},target=${config.workspaceMount}/${subPath}${
        readOnly ? ',readonly' : ''
    }`,
];

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
    return ['exec', containerName(job), 'sh', '-c', remoteSessionScript, 'sh', sessionId];
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
const BYTES_PER_KIB = 1024;
const OUTPUT_LIMIT_KIB = 64;
export const OUTPUT_LIMIT = OUTPUT_LIMIT_KIB * BYTES_PER_KIB;

/**
 * The tail of a runner's output that is safe to put on a complete POST. The board refuses a body
 * over its 128 KiB limit, and JSON escaping can inflate text up to six bytes per byte of log — a
 * control character becomes `\u0001` — so the bound is 16 KiB of UTF-8: 96 KiB fully escaped, plus
 * the rest of the report, still fits. Capping by CHARACTERS instead — 64 KiB of them, the naive
 * reading of OUTPUT_LIMIT — could triple that with CJK text and sextuple it with control
 * characters, and the refused report would leave the job to its lease and re-run finished work:
 * the one outcome worse than a short log.
 */
const REPORT_LIMIT_KIB = 16;
const REPORT_BYTE_LIMIT = REPORT_LIMIT_KIB * BYTES_PER_KIB;

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
 * One declared service of the attempt's `.bellows.yaml`, as the platform reports it right now:
 * the declared name (the DNS name inside the job), the image, and a lowercase state word —
 * docker's container State, or the pod phase under kubernetes. Platform-native on purpose:
 * `restarting` and `pending` carry real, platform-specific meaning the panel renders verbatim.
 */
export interface ServiceStatus {
    name: string;
    image: string;
    state: string;
}

/**
 * The runner container's vitals at one sample: the "is it actually doing anything" answer the
 * dashboard renders beside the output tail. Taken with `docker stats --no-stream` — the same
 * daemon access every other per-attempt operation here uses.
 */
export interface RuntimeSample {
    /** Whole-container CPU, percent of one host core; can exceed 100 on multi-core hosts. */
    cpuPercent: number | null;
    /** Resident memory, in MiB. */
    memUsedMb: number | null;
    /** Resident memory against the container's limit, percent; null when the daemon reports none. */
    memPercent: number | null;
    /**
     * The attempt's declared services and their current states — present only when the attempt
     * declared any and their states could be read.
     */
    services?: ServiceStatus[];
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
const BYTES_PER_MIB = 1_048_576;
const TO_MIB: Record<string, number> = {
    B: 1 / BYTES_PER_MIB,
    kB: 1e-3,
    KB: 1e-3,
    KiB: 1 / BYTES_PER_KIB,
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
 * Joins the two reads a vitals sample is made of — the runner's CPU/memory and the attempt's
 * service fleet — under the rule that a failed read costs its half, never the sample. An empty
 * or failed fleet is NO KEY at all, so a job whose attempt declared no services puts exactly the
 * pre-services wire shape out; unreadable vitals are null numbers beside real service states,
 * because the fleet must not depend on the metrics API (a kind cluster runs none). Both halves
 * gone → null, "no fresh sample", exactly the answer a failed read has always answered.
 */
export function composeRuntimeSample(
    vitals: Pick<RuntimeSample, 'cpuPercent' | 'memUsedMb' | 'memPercent'> | null,
    services: ServiceStatus[] | null | undefined
): Omit<RuntimeSample, 'sampledAt'> | null {
    const fleet = services && services.length > 0 ? services : undefined;
    if (!vitals && !fleet) return null;
    return {
        cpuPercent: vitals?.cpuPercent ?? null,
        memUsedMb: vitals?.memUsedMb ?? null,
        memPercent: vitals?.memPercent ?? null,
        ...(fleet ? { services: fleet } : {}),
    };
}

/**
 * Pulls the service fleet out of `docker ps -a --format '{{json .}}'` over this attempt's label
 * pair. Pure and exported for the pinning. Rows without the `factory.service` label, an image or
 * a state are skipped — never a row the panel could not name — and garbage lines are skipped for
 * the same reason a stats parse skips them. `-a` is what lets an exited service answer honestly:
 * "came up and died" is a state, not an absence.
 */
export function parseDockerServicePs(stdout: string): ServiceStatus[] {
    const out: ServiceStatus[] = [];
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let fields: { Labels?: unknown; Image?: unknown; State?: unknown };
        try {
            fields = JSON.parse(trimmed) as { Labels?: unknown; Image?: unknown; State?: unknown };
        } catch {
            continue;
        }
        const labels = typeof fields.Labels === 'string' ? fields.Labels : '';
        const name = labels
            .split(',')
            .find((pair) => pair.startsWith('factory.service='))
            ?.slice('factory.service='.length);
        const image = typeof fields.Image === 'string' ? fields.Image : null;
        const state = typeof fields.State === 'string' ? fields.State.toLowerCase() : null;
        if (!name || !image || !state) continue;
        out.push({ name, image, state });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
 * The segments mirror what the system legally produces: org ≤ 39 (the org-id shape
 * server/src/auth/github.ts documents) and both ids
 * uuids (36) — a validator narrower than the input domain would fail every job on a
 * legally-named checkout.
 */
const GATE_KEY =
    /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\.worktrees\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same shape the board's `.bellows.yaml` parser enforces; re-asserted here, before argv. */
const GATE_IMAGE = /^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/;

/**
 * The uid:gid the gate environment runs as, and the HOME it gets: the executor images' `USER
 * node` (uid 1000 in both Dockerfiles), which the runner, the sync and the reclaim containers all
 * run as. Gates write the shared task worktree, and every other writer on that tree is uid 1000 —
 * a gate writing as the declared image's own default (root, usually) would leave files the
 * uid-1000 reclaim can never remove. Exported because the kubernetes gate Job states the same
 * numbers as a securityContext (executor parity).
 */
export const GATE_UID = 1000;
export const GATE_GID = 1000;
/** HOME for the gate env's non-root uid — /tmp is world-writable where the image's own is not. */
export const GATE_HOME = '/tmp';

/**
 * A container name this process will `docker exec` into: one token, no shell metacharacters. The
 * ceiling is above the longest name `gateEnvContainerName` can emit (12-char prefix + the 124
 * characters GATE_KEY allows ≈ 136) — a cap BELOW that would create containers every gate then
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
        throw new Error(
            `refusing to run a gate environment from a checkout key that is not <org>/<uuid>/.worktrees/<uuid>: ${key}`
        );
    }
    if (!GATE_IMAGE.test(image)) {
        throw new Error(
            `refusing to run a gate environment from an image that is not a plain docker reference: "${image}"`
        );
    }
    const args = [
        'run',
        '-d',
        '--name',
        gateEnvContainerName(key),
        '--label',
        `${GATE_LABEL}=${key}`,
        // The gate env is a WRITER on the shared task worktree, so it writes as the same
        // uid:gid every other writer on that tree uses — the executor images' `USER node`
        // (uid 1000), which the runner, the sync and the reclaim containers all run as.
        // The declared image's own default (usually root) would leave gate-written files
        // root-owned, and the uid-1000 reclaim would then die with EACCES trying to remove
        // them — the tree stuck for every later turn of the thread (observed 2026-09-13: a
        // gate-built core/dist left the worktree unremovable and its thread unresumable).
        // HOME moves to /tmp with the user: the image's own HOME (/root) is unwritable for
        // a non-root uid, and a gate that npm-installs needs a writable cache directory.
        '--user',
        `${GATE_UID}:${GATE_GID}`,
        '-e',
        `HOME=${GATE_HOME}`,
        // Scoped to the checkout key's own `<orgId>/<userId>` half — the same subtree the
        // runner mounts, asserted by GATE_KEY above before the split.
        ...workspacesMountArgs(config, key.split('/').slice(0, 2).join('/')),
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
 * The working directory the runner gives a run: the task worktree when the job names a repository,
 * the member root where a command-only job always started. This is the exact string opencode
 * records as the session's `directory` column, which makes it the close-time readout's scope key
 * too — one expression here because the run's WORKDIR and the readout's OPENCODE_DIR must never
 * drift apart: a scope key that misses is a scrape that answers nothing.
 */
export function runWorkingDir(config: DriverConfig, job: BoardJob): string {
    return worktreeDir(config, job) ?? `${config.workspaceMount}/${workspacePath(job)}`;
}

/**
 * The transcript store a headless claude-code run is pointed at: one directory per THREAD ROOT on
 * the workspaces volume, passed to the runner as `FACTORY_TRANSCRIPT_DIR`. The entrypoint makes it
 * `CLAUDE_CONFIG_DIR` (guarded, headless only), so the CLI writes its transcripts onto the volume
 * the moment it writes them — no post-run copy, nothing dies with the container — and a follow-up's
 * `--resume` finds the thread's earlier sessions in the same directory it runs in. The root is the
 * claim's worktree key (`rootJobId ?? id`), which is what makes every attempt and follow-up of one
 * thread land in one directory.
 *
 * Both board-supplied halves are asserted before they join the path, exactly like `runWorkingDir`:
 * the value becomes a filesystem path inside a container that runs the agent, and neither the
 * workspace path nor the root id (which a board predating the field omits, making the job its own
 * root) is something this process trusts unasserted.
 */
export function transcriptDir(config: DriverConfig, job: BoardJob): string {
    const path = workspacePath(job);
    const root = job.rootJobId ?? job.id;
    if (!UUID.test(root)) {
        throw new Error(`refusing to run job ${job.id}: a thread root id that is not a uuid: ${root}`);
    }
    return `${config.workspaceMount}/${path}/.factory/transcripts/${root}`;
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
export function opencodeSessionReadoutArgs(config: DriverConfig, job: BoardJob, startedAt: string): string[] {
    const db = opencodeDbPath(config, job);
    return [
        'run',
        '--rm',
        ...workspacesMountArgs(config, workspacePath(job)),
        // The database path and the directory scope travel as env VALUES — the script
        // (opencode-readout.cjs) is static, so nothing board-derived is ever part of its text.
        // The scope is the run's own working directory (runWorkingDir — the same string opencode
        // records on the session), because the database is per MEMBER: without it, two
        // concurrent tasks of one member share the file and the newest-root-session scrape
        // answers whichever task closed last, recording one task's session on both rows.
        '-e',
        `OPENCODE_DB=${db}`,
        '-e',
        `OPENCODE_DIR=${runWorkingDir(config, job)}`,
        // The run's start, as epoch ms: the readout counts only the turns created at or after
        // it, because a follow-up resumes the SAME root conversation and counting the whole
        // session would book earlier runs' turns again.
        '-e',
        `RUN_STARTED_MS=${Date.parse(startedAt)}`,
        '--entrypoint',
        'node',
        executorImage(config, job.executorType),
        '-e',
        opencodeReadoutScript,
    ];
}

// The opencode/claude-code close-time reads and the live cache probe: moved to
// docker-close-read.ts (AGENTS.md's file-length budget), re-exported here so every existing
// import of `./docker.js` keeps resolving the same names.
export {
    cacheCollapse,
    CACHE_WATCH_MIN_INPUT_TOKENS,
    CACHE_WATCH_MIN_TURN_MS,
    CACHE_WATCH_TURNS,
    claudeTurnsArgs,
    opencodeCacheProbeArgs,
    parseClaudeCloseRead,
    parseOpencodeCacheProbe,
    parseOpencodeRunOutcome,
    readsAgentTurns,
} from './docker-close-read.js';
export type { OpencodeCacheProbe, OpencodeCacheTurn, OpencodeRunOutcome } from './docker-close-read.js';

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

export function workspacePath(job: BoardJob): string {
    const path = workspacePathOf(job);
    if (!path) {
        throw new Error(
            `refusing to run job ${job.id}: the board reported no usable workspace path (${job.workspacePath ?? 'null'})`
        );
    }
    return path;
}

/**
 * The names the runner's own contract claims — WORKDIR is the working directory dockerArgs itself
 * sets, TRUST_WORKDIR is the Remote Control trust answer, the two BELLOWS_GATE_ names are the
 * ad-hoc gate credentials the loop mints per attempt, CRED_HELPER is the credential-helper CODE
 * the sync fetch runs, RESTORE is the sync's restore-mode switch (a member value there would
 * flip starting claims into restore mode, silently skipping the fetch and rebase issue #58
 * reserves for continuations), FACTORY_TRANSCRIPT_DIR is where the headless transcript store
 * lives — the driver composes it (transcriptDir), and a member value would steer transcripts,
 * and through the entrypoint's redirect the CLI's whole config dir, somewhere else — and the
 * three reporter names steer the branch reporter — where it posts, which attempt it speaks for,
 * and which session it claims. A member value in any of them is a cross-tenant write into the
 * telemetry store; CRED_HELPER above all: a member value there is member-controlled code the
 * sync container's git executes as helper code. Mirrored at the board (RESERVED_ENV_NAMES in
 * server/src/routes/env.ts, where a PUT is refused); copied rather than imported, per this
 * package's zero-dependency rule. The board's list is a superset by two names:
 * OPENCODE_CONFIG_CONTENT and CLAUDE_CODE_CONFIG_CONTENT are reserved THERE — the claim
 * synthesizes each from the author's executor row, and a member env var would be silently
 * shadowed — but deliberately absent here, because `claimEnv` must let that synthesized value
 * flow to reach the runner.
 */
export const RESERVED_ENV_NAMES = [
    'WORKDIR',
    'TRUST_WORKDIR',
    'BELLOWS_GATE_URL',
    'BELLOWS_GATE_TOKEN',
    'CRED_HELPER',
    'RESTORE',
    'FACTORY_TRANSCRIPT_DIR',
    'FACTORY_STATS_URL',
    'RUNNER_JOB_ID',
    'RUNNER_LEASE_TOKEN',
    'BELLOWS_SESSION_ID',
] as const;

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
 * Whether the claim env carries a NON-EMPTY GITHUB_TOKEN — the condition under which the startup
 * sync's fetch is handed the credential-helper CODE. Git reads no token from the environment, and
 * the executor images ship no helper, so a private-repo fetch needs one; a public repo with no
 * token must keep its plain unauthenticated fetch, which a helper answering an empty password
 * would break. A present-but-empty token therefore counts as no token: the helper would break the
 * public-repo fetch it exists to preserve, and a private repo with an empty token fails auth
 * either way, honestly. Shared with the kubernetes syncJobSpec, which embeds the same code as a
 * literal.
 */
export const claimCarriesGithubToken = (job: BoardJob): boolean => Boolean(claimEnv(job).GITHUB_TOKEN);

/**
 * Whether the claim CONTINUES a session rather than starting a task: a follow-up, or a parked
 * job resumed. Either way the task is mid-flight, and the startup git work is a RESTORE, not a
 * sync — no fetch, no rebase onto the remote default (issue #58): the conversation's tree is
 * what the run continues from, and moving its base underneath it is the mid-task "sync with
 * main" the follow-up flow must not do. Lease-expired RE-claims of ordinary jobs are not
 * continuation: the claim clears a dead attempt's session, so the run starts — and syncs —
 * fresh. Shared with the kubernetes runner, which must restore identically.
 */
export const claimContinuesSession = (job: BoardJob): boolean => job.followUp || job.resumeSessionId !== null;

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
            `refusing to write env file for job ${job.id}: the ${part} of "${name}" contains a newline, which an env file cannot carry`
        );
    }
    return `${name}=${value}`;
};

/**
 * The `--env-file` body for the runner: the claim env's lines, then the loop's minted gate
 * credentials, then the runner's own branch-ingest credential. Pure and exported for the same
 * pinning as dockerArgs. The config argument is optional and only ever adds the attempt pair —
 * aux containers (sync, publish, gates) are called without it and get no credential, because
 * none of them reports telemetry.
 */
export function envFileBody(job: BoardJob, config?: DriverConfig): string {
    const lines = Object.entries(claimEnv(job)).map(([name, value]) => envLine(job, name, value));
    // The driver's own gate credentials go LAST. Docker's --env-file is last-duplicate-wins, so
    // the order is the precedence rule: a `BELLOWS_GATE_TOKEN` a member configured in any env
    // scope was already dropped from the claim lines (reserved names), and the lines here are the
    // driver's minted values — but keeping them visually and structurally after the claim's is
    // what makes "the driver wins a collision" readable in one place.
    for (const [name, value] of Object.entries(job.gateEnv ?? {})) {
        lines.push(envLine(job, name, value));
    }
    // The attempt pair is the one driver-side credential in the file, and it goes after
    // everything: same precedence rule, and the lines a reader audits for "what can authenticate
    // as this runner" are always the last ones. The reporter presents them as headers, and the
    // board resolves the org from the live attempt itself — never from the report's repo.
    if (config) {
        lines.push(envLine(job, 'RUNNER_JOB_ID', job.id));
        lines.push(envLine(job, 'RUNNER_LEASE_TOKEN', job.leaseToken));
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Where the run's env file lives — one per ATTEMPT, lease token included, so a re-claimed
 * attempt's write can never race a previous attempt's cleanup on the same path. Both halves of the
 * name are asserted before they join a path: the file write is the one place a board-supplied id
 * becomes a filesystem operation. Exported so the argv pins can name the exact file a real run
 * passes to `docker run`.
 */
export const envFilePath = (job: BoardJob): string => {
    if (!UUID.test(job.id)) {
        throw new Error(`refusing to write an env file for a job id that is not a uuid: ${job.id}`);
    }
    if (job.leaseToken !== undefined && !UUID.test(job.leaseToken)) {
        throw new Error(`refusing to write an env file for a lease token that is not a uuid: ${job.leaseToken}`);
    }
    const token = UUID.test(job.leaseToken ?? '') ? `-${job.leaseToken}` : '';
    return join(tmpdir(), `factory-env-${job.id}${token}.env`);
};

/**
 * Pushes the runner's credential onto the argv: the auth volume under Remote Control, or the
 * driver's passEnv names plus the claim's `--env-file` for a headless run.
 */
function pushRunnerCredentialArgs(args: string[], config: DriverConfig, job: BoardJob, envFile?: string): void {
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
        return;
    }
    // The driver's own credentials ride as before: `-e NAME` without a value, docker reads it
    // from THIS process's environment. `-e NAME=value` would put the credential in an argv
    // every `ps` on the host can read — the same distinction the workspace reconcile makes for
    // the git token.
    //
    // The claim's env does NOT ride as `-e NAME`. Its names are member-controlled, and `-e
    // NAME` reads the value from this process's own environment — a member-configured PATH,
    // DOCKER_HOST or HOME there steers the docker CLI the driver executes on the host, which
    // is host code execution rather than a runner environment. So the claim travels in a
    // --env-file (written and removed by createDockerRunner), the values never touching this
    // process's environment at all. Reserved names are already gone (claimEnv); docker gives
    // `-e` precedence over `--env-file`, so a name the claim also carries is dropped from
    // passEnv — the claim must win.
    const claim = claimEnv(job);
    // The file is not optional any more, even for a claim that resolves to nothing: the
    // runner's own branch-ingest credential — this attempt's job id + lease token pair —
    // rides it (envFileBody appends it after the claim's and gate lines), and a runner
    // without its file would report 401s into silence.
    if (!envFile) {
        throw new Error(`refusing to run job ${job.id}: no env file was given`);
    }
    for (const name of config.passEnv.filter((n) => !Object.prototype.hasOwnProperty.call(claim, n))) {
        args.push('-e', name);
    }
    args.push('--env-file', envFile);
}

export function dockerArgs(
    config: DriverConfig,
    job: BoardJob,
    session: RunSession | null,
    options: { servicesNetwork?: string | null; envFile?: string } = {}
): string[] {
    const { servicesNetwork = null, envFile } = options;
    /*
     * The run happens in the job's task worktree (issue #35) — one per task thread, branched off
     * the remote default — when the job names a repository, and at the member root when it does
     * not (a command-only job names no repo, so no worktree exists; the root is where it always
     * started, and the argv stays byte-identical for it).
     */
    const worktree = job.repo ? worktreeDir(config, job) : null;
    if (job.repo && !worktree) {
        throw new Error(
            `refusing to run job ${job.id}: the board reported a repo label this driver cannot resolve a task worktree for (${job.repo})`
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
        `WORKDIR=${runWorkingDir(config, job)}`,
        // Scoped to the job's own `<orgId>/<userId>` subtree, mounted AT the path WORKDIR names:
        // every consumer path below it resolves, and the rest of the volume — every other
        // member's and org's tree — is absent from the container's filesystem. Enforced by the
        // mount itself; an agent running arbitrary code inside cannot cross it.
        ...workspacesMountArgs(config, workspacePath(job)),
    ];

    // A gated job's runner reaches the driver's gate endpoint by the default
    // `http://host.docker.internal:<port>`, which resolves only if the daemon is told what that
    // name means — automatic on Docker Desktop, not on Linux. Mapped iff the job has gates, so
    // an ungated runner's argv stays exactly what it always was.
    if (job.gates?.gates?.length) {
        args.push('--add-host', 'host.docker.internal:host-gateway');
    }

    pushRunnerCredentialArgs(args, config, job, envFile);

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

    // Where the runner's branch reporter posts. The board's own URL — the same reasoning as the
    // OTEL endpoint beside it: a literal URL, not a credential, forwarded under Remote Control
    // too (attribution is as wanted on a drivable session as on a headless one). Unset in the
    // config would have refused at boot; the default names the board JOB_BOARD_URL names.
    args.push('-e', `FACTORY_STATS_URL=${config.statsUrl}`);

    if (job.executorType === 'opencode') {
        return pushOpencodeArgs(args, config, job, session);
    }
    return pushClaudeCodeArgs(args, config, job, session);
}

/**
 * Appends the opencode invocation to the argv, and answers it. Headless only — Remote Control is
 * refused in the config, so there is no RC branch here and no permissions flag either (the
 * image's baked opencode.json decides them).
 *
 * Sessions: opencode mints its own (`ses_…`) and cannot adopt one minted in advance, so a fresh
 * run is given none — the runner scrapes the id the run actually used after it ends and the loop
 * reports it. A follow-up is the exception to "cannot adopt": its claim carries the session
 * opencode ITSELF created (persisted via XDG_DATA_HOME below), and `run --session <id> <command>`
 * continues that conversation with the new adjustment. A resume claim with nothing to deliver is
 * a parked claude-code session — standby is a Remote Control feature — and is refused by loop.ts
 * before it gets here.
 */
function pushOpencodeArgs(args: string[], config: DriverConfig, job: BoardJob, session: RunSession | null): string[] {
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
    // Only a follow-up has a session here, and the reporter must name it: the follow-up's
    // tokens belong to the SAME conversation the parent ran. A fresh run is discovered live
    // by the reporter from the session database this argv's XDG_DATA_HOME keeps. BEFORE the
    // image name — docker stops option parsing there, and an `-e` past it is the CLI's argv.
    if (session) {
        if (!SESSION_ID.test(session.id)) {
            throw new Error(`refusing to run job ${job.id}: a session id that is not a safe token: ${session.id}`);
        }
        args.push('-e', `BELLOWS_SESSION_ID=${session.id}`);
    }
    args.push(executorImage(config, job.executorType), 'run');
    if (session) args.push('--session', session.id);
    args.push(job.command);
    return args;
}

/** Appends the claude-code invocation to the argv, and answers it. Every job runs as a session. */
function pushClaudeCodeArgs(args: string[], config: DriverConfig, job: BoardJob, session: RunSession | null): string[] {
    if (!session) {
        throw new Error(`refusing to run job ${job.id}: the claude-code runner runs every job as a session`);
    }
    // The transcript store, HEADLESS claude-code only — fresh runs and resumes alike, because the
    // resume is the run that needs the thread's earlier transcripts sitting in its config dir.
    // Remote Control is excluded: its CLAUDE_CONFIG_DIR must stay the auth volume (standby/park
    // depends on the transcript surviving there), which is also why the entrypoint refuses the
    // combination outright. A path literal like WORKDIR and XDG_DATA_HOME, never a credential.
    if (!config.remoteControl) {
        args.push('-e', `FACTORY_TRANSCRIPT_DIR=${transcriptDir(config, job)}`);
    }
    // The session id the reporter claims. It is safe by construction — minted here as a uuid, or
    // arriving on the claim only after the board's own token check — which is the same guarantee
    // `--session-id` below has always ridden on.
    args.push('-e', `BELLOWS_SESSION_ID=${session.id}`);

    // Restoring a session versus starting one. `--resume` keeps the original id — forking it is a
    // separate flag — which is what makes a parked job's link survive being parked.
    args.push(executorImage(config, job.executorType), session.resume ? '--resume' : '--session-id', session.id);
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

export { createDockerRunner, type RunnerFiles } from './docker-runner.js';
