import { execFile, spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';

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
    /** Stops a container mid-run. Used when the lease is lost, and on shutdown. */
    kill(job: BoardJob): Promise<void>;
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
 * command.
 */
export function remoteSessionArgs(job: BoardJob, sessionId: string): string[] {
    if (!UUID.test(sessionId)) throw new Error(`refusing to read a session id that is not a uuid: ${sessionId}`);
    return [
        'exec',
        containerName(job),
        'sh',
        '-c',
        // A glob over projects/, rather than deriving the slug from WORKDIR: the CLI builds that
        // directory name itself, and reimplementing the rule here would break silently the day it
        // changes. The file name is the session id, which is unique enough on its own.
        `cat "$CLAUDE_CONFIG_DIR"/projects/*/${sessionId}.jsonl 2>/dev/null | grep bridge-session | tail -1`,
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

export const containerName = (job: BoardJob): string => `factory-job-${job.id}`;

/**
 * The gate environment container's identity: `<checkout key>` under a label, `factory-env-…` as a
 * name. The KEY is the checkout the gates share with the coding agent — `<org>/<uuid>/<repo>` —
 * and it is asserted before it is interpolated into argv or a container name, exactly like
 * `workspacePathOf` above: it arrives from the board's claim plus a repo label, and a `..` in it
 * would work the parent of every member's tree into a container that runs arbitrary commands.
 *
 * The segments mirror what the system legally produces: org ≤ 39 (ORG_ID_PATTERN) and repo ≤ 100
 * (the create route's REPO_SEGMENT_LIMIT under the same first-char rules as `badSegment`) — a
 * validator narrower than the input domain would fail every job on a legally-named checkout.
 */
const GATE_KEY =
    /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/i;

/** Same shape the board's `.bellows.yaml` parser enforces; re-asserted here, before argv. */
const GATE_IMAGE = /^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/;

/**
 * A container name this process will `docker exec` into: one token, no shell metacharacters. The
 * ceiling is above the longest name `gateEnvContainerName` can emit (12-char prefix + the 177
 * characters GATE_KEY allows ≈ 189) — a cap BELOW that would create containers every gate then
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
        throw new Error(`refusing to run a gate environment from a checkout key that is not <org>/<uuid>/<repo>: ${key}`);
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
 * The full `docker run` argv that reads the session id a finished opencode run left behind —
 * pure, and exported, because it is the part worth pinning: the readout is a throwaway container
 * over the workspaces volume, entrypoint swapped for node, whose only work is one read-only
 * query for the newest root session.
 *
 * It runs AFTER the job container exits (docker exec cannot), and against the volume rather than
 * inside any container, which is why the run may be over before the id is known and why the
 * runner reports it in the outcome instead of mid-run.
 */
export function opencodeSessionReadoutArgs(config: DriverConfig, job: BoardJob): string[] {
    const db = opencodeDbPath(config, job);
    return [
        'run',
        '--rm',
        '-v',
        `${config.workspaceVolume}:${config.workspaceMount}`,
        '--entrypoint',
        'node',
        config.image,
        '-e',
        // CommonJS: `node -e` is CommonJS unless told otherwise. The query takes the newest ROOT
        // session — subagents create children under a parent_id, and the conversation a follow-up
        // continues is the run's own root.
        `const {DatabaseSync}=require("node:sqlite");` +
            `try{` +
            `const db=new DatabaseSync(${JSON.stringify(db)},{readOnly:true});` +
            `const row=db.prepare("select id from session where parent_id is null order by time_created desc limit 1").get();` +
            `if(row&&row.id)console.log(row.id);` +
            `}catch{}`,
    ];
}

/** Pulls a session id out of the readout's stdout, tolerating anything that is not one. */
export function parseOpencodeSessionId(stdout: string): string | null {
    const id = stdout.trim().split('\n')[0]?.trim() ?? '';
    // The shape opencode mints (`ses_…`), and the shape SESSION_ID in dockerArgs will re-assert
    // before the id is handed to a runner argv on the follow-up claim.
    return /^ses_[A-Za-z0-9._-]+$/.test(id) ? id : null;
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
 * The `--env-file` body for the claim env: one `NAME=value` line per variable. Pure and exported
 * for the same pinning as dockerArgs.
 *
 * A value containing a newline is REFUSED, never mangled: the file is line-structured and docker
 * has no quoting for it, so a multiline value would arrive truncated with no error anywhere. The
 * board refuses one at PUT time; this is the driver's own line of defence against rows that
 * predate that check.
 */
export function envFileBody(job: BoardJob): string {
    const lines = Object.entries(claimEnv(job)).map(([name, value]) => {
        if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
            throw new Error(
                `refusing to write env file for job ${job.id}: "${name}" contains a newline, which an env file cannot carry`,
            );
        }
        return `${name}=${value}`;
    });
    // The driver's own gate credentials go LAST. Docker's --env-file is last-duplicate-wins, so
    // the order is the precedence rule: a `BELLOWS_GATE_TOKEN` a member configured in any env
    // scope was already dropped from the claim lines (reserved names), and the lines here are the
    // driver's minted values — but keeping them visually and structurally after the claim's is
    // what makes "the driver wins a collision" readable in one place.
    for (const [name, value] of Object.entries(job.gateEnv ?? {})) {
        if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
            throw new Error(
                `refusing to write env file for job ${job.id}: "${name}" contains a newline, which an env file cannot carry`,
            );
        }
        lines.push(`${name}=${value}`);
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

export function dockerArgs(config: DriverConfig, job: BoardJob, session: RunSession | null, envFile?: string): string[] {
    const args = [
        'run',
        '--name',
        containerName(job),
        // Lets `docker ps --filter label=factory.job` find a runner that outlived its driver.
        '--label',
        `factory.job=${job.id}`,
        '-e',
        // The AUTHOR's checkouts sit one directory down. A command-only job names no repo, so the
        // agent starts at the root of that person's workspace and can see everything they selected
        // — and nothing anybody else selected.
        //
        // This used to be `<mount>/<orgId>`, one tree shared by every member. Neither `<mount>` nor
        // `<mount>/<orgId>` is a safe fallback now: both are the PARENT of every member's tree, and
        // handing that to a container that may be running --dangerously-skip-permissions is a
        // cross-tenant read. So a job with no workspace fails instead — see loop.ts.
        `WORKDIR=${config.workspaceMount}/${workspacePath(job)}`,
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
        if (claimNames.length && !envFile) {
            throw new Error(`refusing to run job ${job.id}: the claim carries env but no env file was given`);
        }
        for (const name of config.passEnv.filter((n) => !Object.prototype.hasOwnProperty.call(claim, n))) {
            args.push('-e', name);
        }
        if (claimNames.length && envFile) args.push('--env-file', envFile);
    }

    if (config.network) args.push('--network', config.network);

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
    const kill = async (job: BoardJob): Promise<void> => {
        // Killing the `docker run` process would only detach the CLI; the container keeps running
        // and the workspace keeps being written to. The daemon has to be told.
        await run('docker', ['kill', containerName(job)]).catch(() => undefined);
    };

    return {
        kill,

        async remoteSessionId(job, sessionId) {
            // Every failure here is the ordinary case, not an error: the container may have exited,
            // the transcript may not exist yet, or the bridge may simply not have connected.
            const read = await run('docker', remoteSessionArgs(job, sessionId)).catch(() => null);
            return read ? parseRemoteSessionId(read.stdout) : null;
        },

        async run(job, session, onOutput) {
            // The re-claim fence, the docker twin of the kubernetes runner's delete-before-create:
            // the container name is derived from the job id, so anything already holding it is a
            // leftover of a previous attempt — a driver that died before it could kill its runner,
            // which is what a compose restart does. This claim exists only because that attempt's
            // lease is gone, so removing the leftover delivers the same verdict its heartbeat would
            // have, had the driver survived to receive it. Without this the next attempt dies on
            // the name conflict (docker exit 125) and the job terminal-fails blaming a command
            // that never ran.
            await execDocker(['rm', '-f', containerName(job)]).catch(() => undefined);

            /*
             * The claim env's ride: a 0600 file in the OS temp directory, written just before the spawn
             * and removed as soon as the run is over — a crash leaves it in tmpdir at worst, never
             * in argv and never in this process's environment. Skipped under Remote Control,
             * exactly like every other forwarded credential.
             */
            const claim = config.remoteControl ? {} : claimEnv(job);
            const file = Object.keys(claim).length ? envFilePath(job) : null;
            if (file) await writeFile(file, envFileBody(job), { mode: 0o600 });

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
                    return { exitCode: code, output, timedOut, idled, started };
                };

                const child = spawnFn('docker', dockerArgs(config, job, session, file ?? undefined), {
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let timedOut = false;
                let idled = false;

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

                const done = () => {
                    if (timer) clearTimeout(timer);
                    if (idleTimer) clearTimeout(idleTimer);
                };

                child.on('error', (error) => {
                    done();
                    reject(error);
                });
                child.on('close', (code) => {
                    done();
                    void verdict(code)
                        .then(async (outcome) => {
                            /*
                             * opencode mints its own session id, so the loop had none to report at
                             * spawn — this is where it comes from instead: one throwaway container
                             * over the workspaces volume, one read-only query against the
                             * database the run just closed. A failed read is not a failed run:
                             * it costs the task its follow-ups, not its verdict.
                             */
                            if (config.cli === 'opencode') {
                                const read = await execDocker(opencodeSessionReadoutArgs(config, job)).catch(
                                    () => null,
                                );
                                const id = read ? parseOpencodeSessionId(read.stdout) : null;
                                if (id) outcome.sessionId = id;
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
