import { GATE_LABEL, JOB_LABEL, LEASE_LABEL, SERVICE_LABEL } from './labels.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DriverConfig, executorImage } from './config.js';
import type { BoardJob } from './board.js';
import {
    UUID,
    GATE_UID,
    GATE_GID,
    GATE_HOME,
    opencodeDbPath,
    workspacePath,
    runWorkingDir,
    runnerClaimEnv,
} from './claim.js';
import { opencodeReadoutScript } from './container-scripts.js';
import type { ServiceStatus } from './board.js';
import { BYTES_PER_KIB, type RuntimeSample, type RunSession } from './runner.js';
import { GATE_IMAGE, GATE_KEY } from './publish.js';
import { assertWorktreeResolvable, runnerPlan } from './runner-plan.js';

/**
 * The close-time claude-code turn read's whole budget, matching the kubernetes twin's
 * `activeDeadlineSeconds`. The runner's timeout is long gone by the time this read runs, so
 * without a bound of its own a stalled daemon would hold the verdict — and the worker slot —
 * open forever. On expiry the read answers null: unmeasured, never a wrong number.
 */
export const CLOSE_READ_DEADLINE_MS = 120_000;

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
            .find((pair) => pair.startsWith(`${SERVICE_LABEL}=`))
            ?.slice(`${SERVICE_LABEL}=`.length);
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
 * legally-named checkout. GATE_KEY and GATE_IMAGE live in publish.ts, shared with the kubernetes
 * gate manager.
 */

/**
 * A container name this process will `docker exec` into: one token, no shell metacharacters. The
 * ceiling is above the longest name `gateEnvContainerName` can emit (12-char prefix + the 124
 * characters GATE_KEY allows ≈ 136) — a cap BELOW that would create containers every gate then
 * refuses to exec into, a checkout that can never pass.
 */
const GATE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/;

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
    if (!UUID.test(job.leaseToken)) {
        throw new Error(`refusing to write an env file for a lease token that is not a uuid: ${job.leaseToken}`);
    }
    return join(tmpdir(), `factory-env-${job.id}-${job.leaseToken}.env`);
};

/**
 * Pushes the runner's credential onto the argv: the driver's passEnv names plus the claim's
 * `--env-file`.
 */
function pushRunnerCredentialArgs(args: string[], config: DriverConfig, job: BoardJob, envFile?: string): void {
    // The driver's own credentials: `-e NAME` without a value, docker reads it
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
    // passEnv — the claim must win. `runnerClaimEnv`, not `claimEnv`: this argv always builds the
    // REAL runner (dockerArgs is never called for an aux container), so an operator who lists
    // `OPENCODE_CONFIG_CONTENT` in RUNNER_ENV must not win a collision against the reserved
    // agent's own merged value the same way any other claim name would.
    const claim = runnerClaimEnv(job);
    // The file is not optional any more, even for a claim that resolves to nothing: the
    // runner's own branch-ingest credential — this attempt's job id + lease token pair —
    // rides it (envFileBody appends it after the claim's and gate lines), and a runner
    // without its file would report 401s into silence.
    if (!envFile) {
        throw new Error(`refusing to run job ${job.id}: no env file was given`);
    }
    for (const name of config.passEnv.filter((n) => !Object.hasOwn(claim, n))) {
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
     * started, and the argv stays byte-identical for it). Asserted from the same line the
     * kubernetes runner asserts it from.
     */
    assertWorktreeResolvable(config, job);
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
        `${JOB_LABEL}=${job.id}`,
        '--label',
        `${LEASE_LABEL}=${job.leaseToken}`,
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
    // OTEL endpoint beside it: a literal URL, not a credential. Unset in the config would have
    // refused at boot; the default names the board JOB_BOARD_URL names.
    args.push('-e', `FACTORY_STATS_URL=${config.statsUrl}`);

    // What the executor is asked to do, decided once for both platforms (runner-plan.ts) and
    // RENDERED here in docker's own vocabulary: every env pair as a `-e NAME=value` BEFORE the
    // image name — docker stops option parsing there, and an `-e` past it would be the CLI's own
    // argv — and the plan's cliArgs after it, which is exactly what the image's ENTRYPOINT
    // receives. The values are paths and session ids, never credentials; member-scoped values
    // travel in the --env-file above.
    const plan = runnerPlan(config, job, session);
    for (const [name, value] of plan.envPairs) args.push('-e', `${name}=${value}`);
    args.push(executorImage(config, job.executorType), ...plan.cliArgs);
    return args;
}
