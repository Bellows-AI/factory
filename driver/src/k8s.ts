import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { claimCarriesGithubToken, claimEnv, containerName, envFileBody, opencodeDbPath, opencodeReadoutScript, OUTPUT_LIMIT, parseOpencodeRunOutcome, reportTail, runWorkingDir, SESSION_ID, workspacePathOf } from './docker.js';
import type { OpencodeRunOutcome, RunOutcome, RunSession, Runner, RuntimeSample } from './docker.js';
import { CONTAINER_GONE } from './gates.js';
import type { GateManager, GateRun } from './gates.js';
import { CREDENTIAL_HELPER, gitWorktreeRemoveScript, gitWorktreeScript, publishCheckout, publishFailed, repoPath, worktreeBranch, worktreeDir } from './publish.js';
import type { PublishResult, PublishStep, ReclaimResult, SyncResult } from './publish.js';
import { bellowsReadEnv, bellowsReadScript, collectServices, splitBellowsSections } from './services.js';
import type { ServiceSpec } from './services.js';

/**
 * The kubernetes executor: the second Runner, talking to the API server the way the docker one
 * talks to the daemon.
 *
 * The shape follows docker.ts exactly, because the two answer the same questions:
 *
 * - `runnerJobSpec` is the `dockerArgs` analogue — a pure, exported function where everything
 *   security-relevant about a runner is decided, and pinned by tests for that reason.
 * - The transport is injected, the way `createBoard` takes `fetch`, so this suite spawns nothing
 *   and needs no cluster.
 * - The driver's zero-dependency rule holds: a handful of API calls (sweep/create/get/list Jobs,
 *   read a pod's log) do not justify a client library with its transitive tree, and `node:https`
 *   is what carries the cluster CA without hoping an env var pointed Node at it.
 *
 * Remote Control has no counterpart here — a tty held open, an auth volume, idle parking — so
 * `loadDriverConfig` refuses the combination outright rather than running a half-mode.
 */

/** One env entry for the runner container. A `valueFrom` entry names a Secret key; it never carries one. */
interface EnvVar {
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef: { name: string; key: string; optional?: boolean } };
}

/**
 * The batch/v1 Job object. Structural on purpose: this package depends on nothing, so there is no
 * kubernetes types package to import and none is missed — the API server validates the rest.
 */
export interface RunnerJobSpec {
    apiVersion: 'batch/v1';
    kind: 'Job';
    metadata: {
        name: string;
        labels: Record<string, string>;
    };
    spec: {
        backoffLimit: 0;
        completions: 1;
        parallelism: 1;
        activeDeadlineSeconds: number;
        ttlSecondsAfterFinished: number;
        template: {
            metadata: { labels: Record<string, string> };
            spec: {
                restartPolicy: 'Never';
                automountServiceAccountToken: false;
                containers: {
                    name: string;
                    image: string;
                    imagePullPolicy: string;
                    env: EnvVar[];
                    args: string[];
                    volumeMounts: { name: string; mountPath: string }[];
                }[];
                volumes: { name: string; persistentVolumeClaim: { claimName: string } }[];
            };
        };
    };
}

/** Finished Job objects are reaped after an hour: the log is on the board, the pod is not worth keeping. */
const TTL_SECONDS = 3_600;

/** How often the finished/failed status of the Job is polled. */
const POLL_MS = 2_000;

/**
 * Consecutive failed reads before the run is abandoned to its lease. About half a minute when the
 * API server answers fast, up to about eight minutes when every attempt hangs out its request
 * timeout — enough to ride out an upgrade or a dropped connection, short enough that a half-dead
 * API server hands the job back to its lease instead of holding a worker slot for an hour. The
 * kubelet's deadline guarantees the JOB reaches a terminal state, but not that this driver can keep
 * READING it; an apiserver that answers 503 forever would otherwise renew a lease around a run
 * nobody can observe.
 */
export const POLL_MAX_CONSECUTIVE_FAILURES = 15;

/**
 * How long create() will wait for the fence's label sweep to actually empty the selector —
 * about five minutes at POLL_MS, the same patience the status poll has. A list that answers
 * nothing is what frees the checkout for the replacement; exceeding the bound is a throw, which
 * leaves the job to its lease — burning an attempt is the alternative to two writers on one
 * checkout.
 */
const REPLACE_MAX_POLLS = 150;

/**
 * One API-server request, in milliseconds. The docker runner's child process answers the same
 * guarantee by exiting or not; a socket that never answers would otherwise wedge run() forever,
 * and the lease would be renewed around a run nobody can see.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** The tail of the runner's output the board is told about — bounded in lines and, below, in bytes. */
const LOG_TAIL_LINES = 1_000;

/**
 * The full Job object. Pure, and exported, because it is the part worth pinning in a test:
 * everything security-relevant about a runner is decided here, exactly as everything about the
 * docker runner is decided in `dockerArgs`.
 *
 * The session id is minted by the caller, not read back out of the pod, and the workspace path is
 * re-asserted here rather than trusted from the board — the same refusals the docker runner makes,
 * because the API server changing the runtime does not change who is trusted with what.
 */
export function runnerJobSpec(config: DriverConfig, job: BoardJob, session: RunSession | null): RunnerJobSpec {
    // The id becomes the Job object's name; assert it before it lands in the spec, the same way
    // the workspace path is asserted before it becomes a working directory.
    if (!JOB_ID.test(job.id)) {
        throw new Error(`refusing to run job ${job.id}: a job id must be a uuid`);
    }
    const path = workspacePathOf(job);
    if (!path) {
        throw new Error(
            `refusing to run job ${job.id}: the board reported no usable workspace path (${job.workspacePath ?? 'null'})`,
        );
    }

    // WORKDIR is the one literal value: a path, not a credential. Every forwarded credential is a
    // NAME only — the value lives in a Secret the cluster already holds, and `valueFrom` is what
    // keeps it out of the pod spec, which anyone who can `get pods` can read.
    //
    // A repo job starts in its task worktree (issue #35), the same tree the docker runner's
    // WORKDIR names; a command-only job starts at the member root, where it always did. One
    // expression with docker's (runWorkingDir), because the close-time readout scopes the session
    // scrape by this exact string — a scope key that drifted from the runner's would answer nothing.
    const worktree = job.repo ? worktreeDir(config, job) : null;
    if (job.repo && !worktree) {
        throw new Error(
            `refusing to run job ${job.id}: the board reported a repo label this driver cannot resolve a task worktree for (${job.repo})`,
        );
    }
    const env: EnvVar[] = [{ name: 'WORKDIR', value: runWorkingDir(config, job) }];
    if (config.credentialsSecret) {
        for (const name of config.passEnv) {
            env.push({
                name,
                valueFrom: {
                    secretKeyRef: {
                        name: config.credentialsSecret,
                        key: name,
                        // A bring-your-own Secret missing a key would hold the pod in
                        // CreateContainerConfigError, burning the attempt on a configuration
                        // problem. The docker runner's missing credential is an empty `-e NAME`
                        // and a warning; optional is the closest kubernetes gets to that.
                        optional: true,
                    },
                },
            });
        }
    }
    // The board's stacked environment plus the loop's minted gate credentials, same discipline:
    // names in the pod spec, values in the per-attempt Secret (created before the Job — see
    // create()). claimEnv has already dropped the reserved names, and the BELLOWS_* gate names
    // are disjoint from it, so a gated job whose claim resolves to nothing still gets its gate
    // credentials. NOT optional: this driver created this exact Secret moments earlier under
    // this attempt's own lease token, so a missing key is a bug and must fail loud
    // (CreateContainerConfigError) rather than start the pod silently without its env.
    const secretEnv = { ...claimEnv(job), ...(job.gateEnv ?? {}) };
    for (const name of Object.keys(secretEnv)) {
        env.push({ name, valueFrom: { secretKeyRef: { name: secretName(job), key: name } } });
    }

    // Where a runner's telemetry goes. A literal value like WORKDIR, because an OTLP endpoint is a
    // path, not a credential — and unlike docker, a pod has no network to join that would make the
    // image's baked `collector:4318` resolve, so this process names the collector its spec runs on.
    // The chart overrides it; the default names the compose collector, which is what keeps
    // telemetry flowing wherever a runtime can reach it.
    env.push({ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: config.otelEndpoint });

    // Where the runner's branch reporter posts — the board's own URL, a literal like the OTEL
    // endpoint beside it. A URL is a path, not a credential, in a spec anyone with `get pods`
    // can read; the same default-and-override the docker runner forwards.
    env.push({ name: 'FACTORY_STATS_URL', value: config.statsUrl });

    // The ingest token is a CREDENTIAL: the name travels in the pod spec, the value rides the
    // per-attempt Secret by reference — never a value here, and absent entirely when unconfigured.
    if (config.ingestToken) {
        env.push({
            name: 'INGEST_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'INGEST_TOKEN' } },
        });
    }

    // opencode persists its session database under XDG_DATA_HOME, and a fresh container starts
    // with an empty one — pointing it at the member's own tree on the workspaces PVC is what
    // makes a follow-up's `--session <id>` resumable at all, exactly as the docker runner's env
    // does (docker.ts). A path literal like WORKDIR, never a credential.
    if (config.cli === 'opencode') {
        env.push({ name: 'XDG_DATA_HOME', value: `${config.workspaceMount}/${path}/.opencode` });
    }

    // The argv each CLI speaks. The docker runner composes the same two shapes in dockerArgs —
    // the ENTRYPOINT of either executor image receives exactly these arguments after the image
    // name, so the platform below the container is the only difference.
    let args: string[];
    if (config.cli === 'opencode') {
        // Headless only, and opencode mints its own session ids: a fresh run is `run <command>`
        // with no session at all, and a follow-up is `run --session <id> <command>` — the
        // session opencode ITSELF created on the earlier run, persisted via XDG_DATA_HOME above.
        // Restoring a session for anything but a follow-up would deliver nothing into the run
        // and idle it to the deadline; the loop refuses that state first, and this is the
        // runner asserting it too, exactly as dockerArgs does.
        if (session && !job.followUp) {
            throw new Error(`refusing to run job ${job.id}: the opencode runner restores a session only for a follow-up`);
        }
        args = ['run'];
        if (session) {
            if (!SESSION_ID.test(session.id)) {
                throw new Error(`refusing to run job ${job.id}: a session id that is not a safe token: ${session.id}`);
            }
            args.push('--session', session.id);
            // Only a follow-up has a session here, and the reporter must name it — the follow-up's
            // tokens belong to the SAME conversation the parent ran. A fresh run is discovered
            // live by the reporter from the session database XDG_DATA_HOME above keeps.
            env.push({ name: 'BELLOWS_SESSION_ID', value: session.id });
        }
        args.push(job.command);
    } else {
        // The claude-code argv: `--resume` keeps the original session id, and the command is NOT
        // re-delivered — it is already in the transcript. A follow-up is the exception, on this
        // platform exactly as on docker: its command is the new adjustment, and it goes into the
        // restored transcript. It goes last, so a command that looks like a flag is still read
        // as a prompt.
        if (!session) {
            throw new Error(`refusing to run job ${job.id}: the kubernetes runner runs every job as a session`);
        }
        // The session id the reporter claims — asserted above as a safe token before it lands in
        // a spec, the same rule the argv below is held to.
        env.push({ name: 'BELLOWS_SESSION_ID', value: session.id });
        const deliver = !session.resume || job.followUp;
        args = [session.resume ? '--resume' : '--session-id', session.id];
        if (config.skipPermissions) args.push('--dangerously-skip-permissions');
        if (deliver) args.push('-p', job.command);
    }

    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
            name: containerName(job),
            // factory.job is shared by every attempt of the job: it is what `kubectl get jobs -l
            // factory.job=<id>` finds a runner that outlived its driver by, and what the re-claim
            // fence sweeps by. factory.lease is this attempt's alone — the label form of the
            // naming contract that scopes every per-attempt operation to its own objects.
            labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
        },
        spec: {
            // A failed runner pod is never re-run by the cluster — a kubelet retry would re-send
            // the prompt and run the work twice. The board owns retries: the lease expires and the
            // job is offered again, visible in `attempts`.
            backoffLimit: 0,
            completions: 1,
            parallelism: 1,
            // DRIVER_JOB_TIMEOUT_MS maps onto the kubelet-enforced deadline, so a runner that
            // outlives its driver still dies — the k8s form of `docker kill` after the timeout.
            activeDeadlineSeconds: Math.max(1, Math.round(config.jobTimeoutMs / 1000)),
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: { labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken } },
                spec: {
                    restartPolicy: 'Never',
                    // The runner gets no ServiceAccount token: automounting one would hand the
                    // Claude container the driver's own job-creating credentials — the docker
                    // socket riding along with the dashboard, refused here for the same reason.
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            name: containerName(job),
                            image: config.image,
                            // Stated, never defaulted: kubernetes reads a missing or :latest tag as
                            // `Always` and would reach for a registry, past the image the node
                            // already holds — which is how the docker runner finds it.
                            imagePullPolicy: config.imagePullPolicy,
                            env,
                            args,
                            volumeMounts: [{ name: 'workspaces', mountPath: config.workspaceMount }],
                        },
                    ],
                    volumes: [
                        { name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } },
                    ],
                },
            },
        },
    };
}

export const jobsPath = (namespace: string): string => `/apis/batch/v1/namespaces/${namespace}/jobs`;

/**
 * A batch Job this driver creates for its own auxiliary work — one gate run, or the
 * `.bellows.yaml` readout — as opposed to a runner. Structural like `RunnerJobSpec`, and
 * deliberately a second interface rather than a widening of it: the runner's shape is pinned
 * field by field (claude argv, WORKDIR, per-name secretKeyRef), and an aux Job decides different
 * things. Sharing a type would make "the runner has no envFrom" unreadable.
 */
export interface AuxJobSpec {
    apiVersion: 'batch/v1';
    kind: 'Job';
    metadata: { name: string; labels: Record<string, string> };
    spec: {
        backoffLimit: 0;
        completions: 1;
        parallelism: 1;
        activeDeadlineSeconds: number;
        ttlSecondsAfterFinished: number;
        template: {
            metadata: { labels: Record<string, string> };
            spec: {
                restartPolicy: 'Never';
                automountServiceAccountToken: false;
                containers: {
                    name: string;
                    image: string;
                    imagePullPolicy: string;
                    /** One gate run: `sh -c` with the command as the single argv element. */
                    command?: string[];
                    workingDir?: string;
                    /**
                     * A handful of literal entries (the sync's three paths), never a
                     * credential — values travel by `envFrom` below.
                     */
                    env?: EnvVar[];
                    /** The whole claim env at once, by reference — never the values. */
                    envFrom?: { secretRef: { name: string } }[];
                    volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
                }[];
                volumes: { name: string; persistentVolumeClaim: { claimName: string } }[];
            };
        };
    };
}

/**
 * The checkout key a gated job's environment is filed under, and the declared image — both
 * COPIED from docker.ts, which states the full why: the key is the task worktree the agent
 * edits — `<org>/<uuid>/.worktrees/<root id>` (issue #35) — and is interpolated into a working
 * directory every gate command runs in, and the image is repo content naming what executes.
 * A validator narrower than the input domain would fail every job on a legally-named checkout,
 * so the patterns travel unchanged rather than being "improved" here.
 */
const GATE_KEY =
    /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\.worktrees\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GATE_IMAGE = /^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/;

/** Eight hex characters naming one attempt-scoped run: readable in `kubectl get jobs`, unique by construction. */
const hash8 = (input: string): string => createHash('sha256').update(input).digest('hex').slice(0, 8);

/**
 * The raw gate name is repo content, so it never joins a k8s name directly: lowercased, every
 * character outside the DNS-subdomain alphabet folded to `-`, and anything leading rejected.
 * Uniqueness across runs of the same gate comes from the hash beside it, not from the
 * sanitization being invertible — it is not, and must not need to be.
 */
const sanitizeNamePart = (value: string): string =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-')
        .replace(/^[^a-z0-9]+/, '')
        .slice(0, 100);

/** One gate run's Job name. The run counter keeps a second ad-hoc call of the same gate off the first's name. */
export const gateJobName = (job: BoardJob, gateName: string, run: number): string =>
    `factory-gate-${sanitizeNamePart(gateName)}-${hash8(`${job.id}|${job.leaseToken}|${gateName}|${run}`)}`;

/**
 * The gated attempt's Secret carrying the gate environment. Per ATTEMPT, not per run — the env
 * is the claim's stacked resolution and is identical for every gate run of the attempt, so one
 * Secret created at acquire serves them all, and a driver crash leaks at most one, the same
 * accepted-leak posture (and the same `factory.job` cleanup label) the runner's env Secret has.
 */
export const gateEnvSecretName = (job: BoardJob): string => `factory-gate-${hash8(`${job.id}|${job.leaseToken}`)}-env`;

/**
 * One gate run, as a Job. Pure and exported for the pinning, exactly like `runnerJobSpec`:
 *
 * - The declared image runs the declared command — `sh -c` with the command as ONE argv
 *   element, the same single element docker exec's gate runs receive.
 * - `workingDir` is the checkout itself — the same tree the coding agent edits, via the same
 *   workspaces PVC at the same mount point.
 * - The env travels by reference (`envFrom` against the per-run Secret), because the same rule
 *   that keeps claim values out of the runner pod spec keeps them out of a gate pod spec —
 *   anyone who can `get pods` can read one, and the values are member-scoped.
 * - The deadline is the kubelet's: `GATE_TIMEOUT_MS` maps onto `activeDeadlineSeconds`, so a
 *   hung gate dies even if this driver dies first. The driver reads the
 *   `DeadlineExceeded` condition and reports exit 124 — the convention the docker manager's
 *   own timeout kill uses.
 *
 * What it deliberately does NOT carry: the checkout claim (the gate runs while the runner holds
 * the checkout and is swept by the same `factory.job` fence if it outlives its attempt), and any
 * ServiceAccount token (the pin every pod this driver creates shares).
 */
export function gateJobSpec(
    config: DriverConfig,
    job: BoardJob,
    key: string,
    image: string,
    gateName: string,
    command: string,
    run: number,
    envSecretName: string | null,
    gateTimeoutMs: number,
): AuxJobSpec {
    if (!JOB_ID.test(job.id) || !JOB_ID.test(job.leaseToken)) {
        throw new Error(`refusing to run a gate of job ${job.id}: its ids are not the uuids the board claims`);
    }
    if (!GATE_KEY.test(key)) {
        throw new Error(`refusing to run a gate in a checkout key that is not <org>/<uuid>/.worktrees/<uuid>: ${key}`);
    }
    if (!GATE_IMAGE.test(image)) {
        throw new Error(`refusing to run a gate in an image that is not a plain image reference: "${image}"`);
    }
    const jobName = gateJobName(job, gateName, run);
    const labels = { 'factory.job': job.id, 'factory.lease': job.leaseToken };
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: jobName, labels },
        spec: {
            backoffLimit: 0,
            completions: 1,
            parallelism: 1,
            activeDeadlineSeconds: Math.max(1, Math.round(gateTimeoutMs / 1000)),
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: { labels },
                spec: {
                    restartPolicy: 'Never',
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            // A container name is a 63-char DNS label — the Job name's roomy
                            // subdomain bound does not apply to it, so the short hash stands in.
                            name: `gate-${hash8(`${jobName}|${command}`)}`,
                            image,
                            imagePullPolicy: config.imagePullPolicy,
                            command: ['sh', '-c', command],
                            workingDir: `${config.workspaceMount}/${key}`,
                            ...(envSecretName ? { envFrom: [{ secretRef: { name: envSecretName } }] } : {}),
                            volumeMounts: [{ name: 'workspaces', mountPath: config.workspaceMount }],
                        },
                    ],
                    volumes: [
                        { name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } },
                    ],
                },
            },
        },
    };
}

/**
 * The env-file body becomes Secret stringData. Lines were written by `envFileBody` on this
 * side and are re-asserted here line by line, because this function is the one place the body
 * becomes cluster objects: a line without a `=`, or a name outside what a Secret key may hold,
 * is a bug or a forged claim, and both must fail loud rather than start a gate with half an env.
 */
export const envBodyToData = (body: string): Record<string, string> => {
    const data: Record<string, string> = Object.create(null);
    for (const line of body.split('\n')) {
        if (!line) continue;
        const eq = line.indexOf('=');
        const name = eq > 0 ? line.slice(0, eq) : '';
        if (!name || !/^[-._a-zA-Z0-9]+$/.test(name)) {
            throw new Error(`refusing to build a gate env Secret: "${line.slice(0, 64)}" is not a NAME=value line`);
        }
        data[name] = line.slice(eq + 1);
    }
    return data;
};

/**
 * The `.bellows.yaml` readout under kubernetes: the same shell script docker runs in a
 * throwaway container, as a Job over the read-only PVC mount. The readout must finish before
 * anything else about the job's services happens, so it gets a tight deadline of its own.
 */
const BELLOWS_READ_DEADLINE_SECONDS = 120;

export const bellowsJobName = (job: BoardJob): string => `factory-bellows-${hash8(`${job.id}|${job.leaseToken}`)}`;

export function bellowsJobSpec(config: DriverConfig, job: BoardJob): AuxJobSpec {
    if (!job.workspacePath || !WORKSPACE_PATH.test(job.workspacePath)) {
        throw new Error(
            `refusing to read .bellows.yaml for job ${job.id}: ` +
                `the board reported no usable workspace path (${job.workspacePath ?? 'null'})`,
        );
    }
    const jobName = bellowsJobName(job);
    const labels = { 'factory.job': job.id, 'factory.lease': job.leaseToken };
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: jobName, labels },
        spec: {
            backoffLimit: 0,
            completions: 1,
            parallelism: 1,
            activeDeadlineSeconds: BELLOWS_READ_DEADLINE_SECONDS,
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: { labels },
                spec: {
                    restartPolicy: 'Never',
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            name: 'bellows-read',
                            image: config.image,
                            imagePullPolicy: config.imagePullPolicy,
                            command: ['sh', '-c', bellowsReadScript],
                            // The readout's parameters as literal env values — a path and two
                            // constants shared with the splitter, never a credential (the same
                            // justification the sync's REPO/WORKTREE/BRANCH literals give).
                            env: Object.entries(bellowsReadEnv(config, job)).map(([name, value]) => ({ name, value })),
                            volumeMounts: [
                                { name: 'workspaces', mountPath: config.workspaceMount, readOnly: true },
                            ],
                        },
                    ],
                    volumes: [
                        { name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } },
                    ],
                },
            },
        },
    };
}

/**
 * `<org>/<user id>` — COPIED from services.ts (which copied it from docker.ts): the path becomes
 * an env value the readout script globs under, and the board is not something this process trusts
 * with a fragment of a shell command.
 */
const WORKSPACE_PATH = /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The close-time opencode session readout under kubernetes: the same script docker runs in a
 * throwaway container (opencode-readout.cjs, passed by content), as one aux Job over the PVC.
 * The database path travels as an env VALUE — the script is static, so nothing board-derived is
 * ever part of its text. The mount is READ-WRITE on purpose, unlike the bellows readout's:
 * opening a sqlite database whose WAL needs recovery has to write the recovery, and the run
 * that died mid-checkpoint is exactly the readout this exists for. The docker readout mounts
 * the same volume read-write for the same reason.
 */
const OPENCODE_READOUT_DEADLINE_SECONDS = 120;

export const opencodeReadoutJobName = (job: BoardJob): string =>
    `factory-ocread-${hash8(`${job.id}|${job.leaseToken}`)}`;

export function opencodeReadoutJobSpec(config: DriverConfig, job: BoardJob): AuxJobSpec {
    if (!job.workspacePath || !WORKSPACE_PATH.test(job.workspacePath)) {
        throw new Error(
            `refusing to read the opencode session database for job ${job.id}: ` +
                `the board reported no usable workspace path (${job.workspacePath ?? 'null'})`,
        );
    }
    const jobName = opencodeReadoutJobName(job);
    const labels = { 'factory.job': job.id, 'factory.lease': job.leaseToken };
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: jobName, labels },
        spec: {
            backoffLimit: 0,
            completions: 1,
            parallelism: 1,
            activeDeadlineSeconds: OPENCODE_READOUT_DEADLINE_SECONDS,
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: { labels },
                spec: {
                    restartPolicy: 'Never',
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            name: 'opencode-readout',
                            image: config.image,
                            imagePullPolicy: config.imagePullPolicy,
                            command: ['node', '-e', opencodeReadoutScript],
                            // Both travel as env VALUES — the script is static, so nothing
                            // board-derived is ever part of its text. The directory scope is the
                            // run's own working directory (the same string opencode records on the
                            // session), because the database is per MEMBER: without it, two
                            // concurrent tasks of one member scrape each other's runs.
                            env: [
                                { name: 'OPENCODE_DB', value: opencodeDbPath(config, job) },
                                { name: 'OPENCODE_DIR', value: runWorkingDir(config, job) },
                            ],
                            volumeMounts: [{ name: 'workspaces', mountPath: config.workspaceMount }],
                        },
                    ],
                    volumes: [
                        { name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } },
                    ],
                },
            },
        },
    };
}

/**
 * The startup sync (issue #35), ported: the docker runner creates the task worktree by running
 * the worktree script in a throwaway container; this executor runs the SAME script as a Job —
 * the same aux shape the gates and the `.bellows.yaml` readout use, over the same PVC. The one
 * deliberate difference: the mount is READ-WRITE, because the whole point is creating the
 * worktree the run will edit. The executor image carries both node and git, as the docker
 * sync container does.
 */
const SYNC_DEADLINE_SECONDS = 600;

export const syncJobName = (job: BoardJob): string => `factory-sync-${hash8(`${job.id}|${job.leaseToken}`)}`;

/**
 * The per-attempt Secret carrying the claim env for the sync's fetch — the credential travels
 * by reference (`envFrom`), the way it does for the runner and every gate. Created before the
 * Job, reaped with the verdict (or on a throw), the same accepted-leak posture as the other
 * attempt-scoped Secrets. Null when the claim resolved to nothing — the spec then names no
 * Secret at all, because a pod that references a missing Secret sits in
 * `CreateContainerConfigError`, and an env-less claim is a supported board configuration.
 */
export const syncEnvSecretName = (job: BoardJob): string => `factory-sync-${hash8(`${job.id}|${job.leaseToken}`)}-env`;

export function syncJobSpec(config: DriverConfig, job: BoardJob, envSecret: string | null): AuxJobSpec {
    if (!JOB_ID.test(job.id) || !JOB_ID.test(job.leaseToken)) {
        throw new Error(`refusing to sync job ${job.id}: its ids are not the uuids the board claims`);
    }
    const clone = repoPath(config, job);
    const worktree = worktreeDir(config, job);
    if (!clone || !worktree) {
        throw new Error(`refusing to sync job ${job.id}: the board reported a repo label this driver cannot resolve a task worktree for (${job.repo ?? 'none'})`);
    }
    const labels = { 'factory.job': job.id, 'factory.lease': job.leaseToken };
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: syncJobName(job), labels },
        spec: {
            backoffLimit: 0,
            completions: 1,
            parallelism: 1,
            activeDeadlineSeconds: SYNC_DEADLINE_SECONDS,
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: { labels },
                spec: {
                    restartPolicy: 'Never',
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            name: 'worktree-sync',
                            image: config.image,
                            imagePullPolicy: config.imagePullPolicy,
                            command: ['node', '-e', gitWorktreeScript],
                            env: [
                                { name: 'REPO', value: clone },
                                { name: 'WORKTREE', value: worktree },
                                { name: 'BRANCH', value: worktreeBranch(job) },
                                // The fetch's credential helper CODE — a literal that is code,
                                // the same class as the three path literals above (the pin on
                                // literal credentials stays intact). Only when the claim env
                                // carries the token the helper reads; the token itself travels
                                // the Secret below, which git's spawned helper reads from the
                                // pod's environment.
                                ...(claimCarriesGithubToken(job)
                                    ? [{ name: 'CRED_HELPER', value: CREDENTIAL_HELPER }]
                                    : []),
                            ],
                            ...(envSecret ? { envFrom: [{ secretRef: { name: envSecret } }] } : {}),
                            volumeMounts: [{ name: 'workspaces', mountPath: config.workspaceMount }],
                        },
                    ],
                    volumes: [
                        { name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } },
                    ],
                },
            },
        },
    };
}

/**
 * The terminal reclaim (issue #47), ported to the aux shape like every other one-off: the SAME
 * worktree-remove script the docker runner passes to its container, as a Job over the same
 * read-write PVC. Like the sync it undoes, it runs UNDER the checkout claim (see
 * reclaimWorktree) — a thread that looks terminal can gain a follow-up between the board's
 * answer and the removal, so the removal must not race that follow-up's sync on the shared
 * root-scoped tree. Still no Secret, no env: removing needs nothing the claim held. The juice is
 * the name carrying the lease token, so a superseded attempt can never remove anything of a
 * replacement's.
 */
const RECLAIM_DEADLINE_SECONDS = 600;

export const reclaimJobName = (job: BoardJob): string => `factory-reclaim-${hash8(`${job.id}|${job.leaseToken}`)}`;

export function reclaimJobSpec(config: DriverConfig, job: BoardJob): AuxJobSpec {
    if (!JOB_ID.test(job.id) || !JOB_ID.test(job.leaseToken)) {
        throw new Error(`refusing to reclaim job ${job.id}: its ids are not the uuids the board claims`);
    }
    const clone = repoPath(config, job);
    const worktree = worktreeDir(config, job);
    if (!clone || !worktree) {
        throw new Error(`refusing to reclaim job ${job.id}: the board reported a repo label this driver cannot resolve a task worktree for (${job.repo ?? 'none'})`);
    }
    const labels = { 'factory.job': job.id, 'factory.lease': job.leaseToken };
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: reclaimJobName(job), labels },
        spec: {
            backoffLimit: 0,
            completions: 1,
            parallelism: 1,
            activeDeadlineSeconds: RECLAIM_DEADLINE_SECONDS,
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: { labels },
                spec: {
                    restartPolicy: 'Never',
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            name: 'worktree-reclaim',
                            image: config.image,
                            imagePullPolicy: config.imagePullPolicy,
                            command: ['node', '-e', gitWorktreeRemoveScript],
                            env: [
                                { name: 'REPO', value: clone },
                                { name: 'WORKTREE', value: worktree },
                            ],
                            volumeMounts: [{ name: 'workspaces', mountPath: config.workspaceMount }],
                        },
                    ],
                    volumes: [
                        { name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } },
                    ],
                },
            },
        },
    };
}

/**
 * One publish step, as a Job — the ported half of docker's sibling-container publish: the same
 * `publishCheckout` workflow (publish.ts) decides what runs; here it runs as one aux Job per
 * step, `workingDir` at the task worktree over the same workspaces PVC. The steps carry the
 * attempt's `factory.job`/`factory.lease` labels, which puts them inside the re-claim fence's
 * sweep: a driver that dies mid-publish leaves Jobs the next claimant deletes before its own
 * sync touches the tree — a cleaner handover than docker's, whose publish containers are
 * anonymous and bounded only by their own exit.
 *
 * The argv is the SAME argv the docker runner passes after the image name — including, on the
 * push, the credential-helper CODE as one `-c` argv element. A program, not a credential: the
 * same class as the sync's `CRED_HELPER` literal, and as readable in a pod spec as it already
 * is in a `docker run` argv. The token itself travels the per-attempt Secret, read through
 * `envFrom` by the helper git spawns.
 */
const PUBLISH_STEP_DEADLINE_SECONDS = 600;

/** The publish steps' per-attempt env Secret — same name discipline as the sync's. */
export const publishEnvSecretName = (job: BoardJob): string =>
    `factory-publish-${hash8(`${job.id}|${job.leaseToken}`)}-env`;

/** One step's Job name: attempt-scoped by the hash, sequential by the counter. */
export const publishStepJobName = (job: BoardJob, step: number): string =>
    `factory-pub-${hash8(`${job.id}|${job.leaseToken}`)}-${step}`;

export function publishStepJobSpec(
    config: DriverConfig,
    job: BoardJob,
    step: number,
    publish: PublishStep,
    envSecret: string | null,
    repo: string,
): AuxJobSpec {
    if (!JOB_ID.test(job.id) || !JOB_ID.test(job.leaseToken)) {
        throw new Error(`refusing to publish job ${job.id}: its ids are not the uuids the board claims`);
    }
    const labels = { 'factory.job': job.id, 'factory.lease': job.leaseToken };
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: publishStepJobName(job, step), labels },
        spec: {
            backoffLimit: 0,
            completions: 1,
            parallelism: 1,
            activeDeadlineSeconds: PUBLISH_STEP_DEADLINE_SECONDS,
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: { labels },
                spec: {
                    restartPolicy: 'Never',
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            name: `publish-${step}`,
                            image: config.image,
                            imagePullPolicy: config.imagePullPolicy,
                            // The workflow's argv verbatim — the executable the docker runner
                            // swaps in as --entrypoint is this command's head.
                            command: [publish.entrypoint, ...publish.args],
                            ...(publish.inRepo ? { workingDir: repo } : {}),
                            ...(publish.envLiterals
                                ? { env: Object.entries(publish.envLiterals).map(([name, value]) => ({ name, value })) }
                                : {}),
                            ...(publish.env && envSecret ? { envFrom: [{ secretRef: { name: envSecret } }] } : {}),
                            // Read-write: add/commit write the tree the run edited.
                            volumeMounts: [{ name: 'workspaces', mountPath: config.workspaceMount }],
                        },
                    ],
                    volumes: [
                        { name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } },
                    ],
                },
            },
        },
    };
}

/**
 * One declared service, as a Pod. A Pod and not a Job because a Job is a unit of WORK — a
 * service is a long-running neighbor the tests talk to, the k8s twin of docker's detached
 * container. `restartPolicy: Never` mirrors docker exactly: a detached container that crashes
 * stays crashed, and so does this pod.
 *
 * Environment values travel as literals, unlike every credential this driver forwards: they
 * were already world-readable in the author's `.bellows.yaml`, and no secret of this process's
 * own ever reaches them — the same reasoning docker's `-e KEY=value` argv states.
 */
export const servicePodName = (job: BoardJob, name: string): string =>
    `factory-job-${job.id}-${job.leaseToken}-svc-${name}`;

const SERVICE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function servicePodSpec(config: DriverConfig, job: BoardJob, spec: ServiceSpec): {
    apiVersion: 'v1';
    kind: 'Pod';
    metadata: { name: string; labels: Record<string, string> };
    spec: {
        restartPolicy: 'Never';
        automountServiceAccountToken: false;
        containers: {
            name: string;
            image: string;
            imagePullPolicy: string;
            env: { name: string; value: string }[];
        }[];
    };
} {
    const labels = {
        'factory.job': job.id,
        'factory.lease': job.leaseToken,
        'factory.service': spec.name,
    };
    return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: servicePodName(job, spec.name), labels },
        spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            containers: [
                {
                    name: spec.name,
                    image: spec.image,
                    imagePullPolicy: config.imagePullPolicy,
                    env: spec.environment.map(({ key, value }) => {
                        if (!SERVICE_ENV_KEY.test(key)) {
                            throw new Error(`refusing to run job ${job.id}: "${key}" is not a valid environment variable name`);
                        }
                        return { name: key, value };
                    }),
                },
            ],
        },
    };
}

/**
 * The service's DNS name, as a headless Service. THIS is the whole feature under kubernetes:
 * `postgres://db:5432` resolves because an object named `db` exists, so the name is exactly the
 * declared service name and is therefore NAMESPACE-global — two concurrent jobs declaring `db`
 * collide at the apiserver, and the collision is refused, never resolved by an ordering rule.
 * The bellows parser already constrains names to lowercase DNS labels, so the declared name is
 * a legal Service name unchanged.
 *
 * Headless (`clusterIP: None`) because the gate endpoint aside, the runner must reach the
 * service's EPHEMERAL container ports, and no port list was declared — `ports:` is an unknown
 * key in `.bellows.yaml` by design. A headless Service publishes A records straight to the
 * matching pods, which is exactly the "any port, direct to the container" semantics docker's
 * network alias had.
 */
export function serviceDnsSpec(job: BoardJob, spec: ServiceSpec): {
    apiVersion: 'v1';
    kind: 'Service';
    metadata: { name: string; labels: Record<string, string> };
    spec: { clusterIP: 'None'; selector: Record<string, string> };
} {
    return {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
            name: spec.name,
            labels: {
                'factory.job': job.id,
                'factory.lease': job.leaseToken,
                'factory.service': spec.name,
            },
        },
        spec: {
            clusterIP: 'None',
            selector: { 'factory.job': job.id, 'factory.service': spec.name },
        },
    };
}

export const podsPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/pods`;

/**
 * Label-scoped collection paths: by JOB for the re-claim fence, by LEASE for this attempt's own
 * teardown. The teardown selectors additionally require the `factory.service` key to exist —
 * the set-based `,factory.service` at the end — because the runner pod and every gate pod carry
 * the same lease label, and only the service fleet may die at teardown.
 */
const byJob = (path: string, job: BoardJob): string => `${path}?labelSelector=${encodeURIComponent(`factory.job=${job.id}`)}`;
const byLease = (path: string, job: BoardJob): string =>
    `${path}?labelSelector=${encodeURIComponent(`factory.lease=${job.leaseToken}`)},factory.service`;

export const podsSelectorPath = (namespace: string, job: BoardJob): string => byJob(podsPath(namespace), job);
export const servicesPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/services`;
export const servicesSelectorPath = (namespace: string, job: BoardJob): string => byJob(servicesPath(namespace), job);
export const podsByLeasePath = (namespace: string, job: BoardJob): string => byLease(podsPath(namespace), job);
export const servicesByLeasePath = (namespace: string, job: BoardJob): string => byLease(servicesPath(namespace), job);

export const jobPath = (namespace: string, name: string): string => `${jobsPath(namespace)}/${name}`;

/**
 * The label-scoped collection path every attempt of a job shares. The lease token never repeats,
 * so attempt-scoped names cannot find a previous attempt's leftovers — the `factory.job` label is
 * the one identifier they all carry, and it is what the fence selects on.
 */
export const jobsSelectorPath = (namespace: string, job: BoardJob): string =>
    `${jobsPath(namespace)}?labelSelector=${encodeURIComponent(`factory.job=${job.id}`)}`;

/**
 * The per-attempt Secret carrying the board's resolved environment. One per ATTEMPT — the lease
 * token is part of the name — created before the Job and reaped with it: the pod spec references
 * it by `secretKeyRef`, so the values are readable only through the API server's RBAC — never off
 * the Job object itself. The token in the name is what keeps a reclaimed job's superseded worker
 * from deleting the replacement attempt's Secret: its `kill()` can only ever address the Secret
 * of the attempt it actually ran.
 *
 * Both halves are asserted before they join an API path, the same way the Job name's is.
 */
export const secretName = (job: BoardJob): string => {
    if (!JOB_ID.test(job.id)) {
        throw new Error(`refusing to address a job id that is not a uuid: ${job.id}`);
    }
    if (!JOB_ID.test(job.leaseToken)) {
        throw new Error(`refusing to address a lease token that is not a uuid: ${job.leaseToken}`);
    }
    return `factory-job-${job.id}-${job.leaseToken}-env`;
};

/** The Secret object the claim env becomes. Values ride in stringData, nowhere else. */
const secretBody = (job: BoardJob, env: Record<string, string>) => ({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: { name: secretName(job), labels: { 'factory.job': job.id } },
    stringData: env,
});

/**
 * The checkout claim: one ConfigMap per JOB id, the one job-scoped name this runner ever writes,
 * and the atom that makes the re-claim fence a mutex instead of a GET-then-POST race. The
 * apiserver's name uniqueness arbitrates — POST it and a `409` means somebody else holds the
 * checkout — while `data.attempt` (the board's monotonic per-job attempt counter, never a clock)
 * orders the contenders: a claim whose attempt is ahead of ours is our replacement's, and we
 * stand down. A ConfigMap and not a Secret because the protocol needs `get`, and granting `get`
 * on secrets would expose every attempt's env values; this object carries a holder token and an
 * attempt number, both already known to the driver.
 *
 * Keyed by the JOB id and never the thread root, even though worktreeDir keys the TREE by root:
 * the board serializes claims per thread root server-side (a separate fix), so cross-row
 * exclusion happens there — and a root-scoped claim NAME would break the attempt-ordered
 * stale-holder takeover across follow-up rows, where a leaked row-1 claim carrying attempt 3
 * would stand down row 2's attempt 1 forever.
 *
 * Everything else stays attempt-scoped: names carrying the lease token are what keep a
 * superseded attempt's cleanup from ever reaching the winner's objects.
 */
export const claimName = (job: BoardJob): string => {
    if (!JOB_ID.test(job.id)) {
        throw new Error(`refusing to address a job id that is not a uuid: ${job.id}`);
    }
    return `factory-job-${job.id}-claim`;
};

export const configmapsPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/configmaps`;

export const claimPath = (namespace: string, job: BoardJob): string =>
    `${configmapsPath(namespace)}/${claimName(job)}`;

/** The claim object this attempt POSTs. `data` values are strings — the apiserver rejects numbers. */
const claimBody = (job: BoardJob) => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
        name: claimName(job),
        labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
    },
    data: { holder: job.leaseToken, attempt: String(job.attempts) },
});

interface K8sClaim {
    metadata?: { uid?: string };
    data?: { holder?: string; attempt?: string };
}

/**
 * Bounded rounds for the acquire loop: POST 409 → read the holder → the holder vanished or was
 * an older attempt we released → POST again. Takeover is strictly forward-only (a claim whose
 * attempt is ahead makes us stand down, never wait), so more than a couple of rounds is an
 * apiserver flapping; the bound turns that into a thrown error and the job goes back to its
 * lease instead of two writers racing one checkout.
 */
const CLAIM_ROUNDS = 15;

/**
 * One call against the API server. The body is the raw response text rather than a parsed object:
 * the log endpoint answers plain text, and parsing is the caller's problem — which keeps the
 * injected fake a router over (method, path) and nothing more.
 */
export interface K8sResponse {
    status: number;
    body: string;
}

export type K8sMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type K8sRequest = (method: K8sMethod, path: string, body?: unknown) => Promise<K8sResponse>;

/** The ServiceAccount volume every pod gets, holding the token and the cluster CA. */
const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/**
 * The real transport: the API server the pod's own environment points at. Built only for a driver
 * running IN a cluster; everything that can fail is made to fail at construction rather than on the
 * first claim — `KUBERNETES_SERVICE_HOST` missing, or a ServiceAccount volume not mounted, are
 * startup errors, not mid-run surprises.
 */
export function inClusterRequest(): K8sRequest {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
    if (!host) {
        throw new Error(
            'KUBERNETES_SERVICE_HOST is not set: this driver is not running in a cluster. ' +
                'EXECUTOR=kubernetes needs an in-cluster driver — run it in the cluster it serves.',
        );
    }
    // Read once: the CA does not rotate, and reading it here is what makes a pod without its
    // projected ServiceAccount volume fail at startup instead of on every claim.
    const ca = readFileSync(`${SERVICE_ACCOUNT_DIR}/ca.crt`, 'utf8');

    return (method, path, body) =>
        new Promise<K8sResponse>((resolve, reject) => {
            const req = httpsRequest(
                {
                    host,
                    port: Number(port),
                    method,
                    path,
                    ca,
                    timeout: REQUEST_TIMEOUT_MS,
                    headers: {
                        // Read per call: a rotated ServiceAccount token must not be remembered.
                        authorization: `Bearer ${readFileSync(`${SERVICE_ACCOUNT_DIR}/token`, 'utf8').trim()}`,
                        'content-type': 'application/json',
                    },
                },
                (res) => {
                    let text = '';
                    res.setEncoding('utf8');
                    res.on('data', (chunk: string) => {
                        text += chunk;
                        // Only the tail survives OUTPUT_LIMIT downstream, so buffering a
                        // multi-megabyte single log line whole would be exactly the unbounded
                        // string the docker runner's cap exists to avoid. Keep a sliding tail.
                        if (text.length > 4 * OUTPUT_LIMIT) text = text.slice(-2 * OUTPUT_LIMIT);
                    });
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
                },
            );
            // A half-open connection would otherwise hold the run forever — and the loop would
            // renew the lease around a runner nobody can observe or finish.
            req.on('timeout', () => {
                req.destroy(new Error(`the API server did not answer within ${REQUEST_TIMEOUT_MS}ms`));
            });
            req.on('error', reject);
            if (body !== undefined) req.write(JSON.stringify(body));
            req.end();
        });
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A uuid, and nothing else — asserted before `job.id` is interpolated into an API path or a pod
 * name. Copied from docker.ts's own UUID, which re-asserts the same ids for the same reason.
 */
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface K8sJobStatus {
    succeeded?: number;
    failed?: number;
    conditions?: { type: string; reason?: string }[];
}

interface K8sPodList {
    items?: {
        metadata?: { name?: string; deletionTimestamp?: string };
        status?: {
            containerStatuses?: {
                state?: {
                    terminated?: { exitCode?: number };
                    waiting?: { reason?: string; message?: string };
                };
            }[];
        };
    }[];
}

/** Parses what the API server answers; a body that is not JSON reads as an empty object. */
function parse<T>(body: string): T {
    try {
        return JSON.parse(body) as T;
    } catch {
        return {} as T;
    }
}

/*
 * The runner vitals under kubernetes. `docker stats` has no direct twin here; the metrics API
 * (`metrics.k8s.io`, served by the metrics-server a cluster may not run) is the closest one, and
 * its absence is not an error: the interface blesses null as "no fresh sample", so a cluster
 * without a metrics-server renders no vitals rather than a wrong number — the same answer any
 * failed docker read gets.
 */

/** CPU quantities as the metrics API prints them: nanos, micros, millis, or whole cores. */
const CPU_QUANTITY = /^([0-9]*\.?[0-9]+)(n|u|m)?$/;

/** Millicores — the unit `cpuPercent` is a tenth of (1000m = one core = 100%). */
const cpuMillicores = (value: string): number | null => {
    const match = CPU_QUANTITY.exec(value.trim());
    if (!match) return null;
    const n = Number.parseFloat(match[1]!);
    if (!Number.isFinite(n)) return null;
    if (match[2] === 'n') return n / 1e6;
    if (match[2] === 'u') return n / 1e3;
    if (match[2] === 'm') return n;
    return n * 1000;
};

/** Memory quantities to MiB: the binary suffixes metrics-server emits, plus plain bytes. */
const MEM_TO_MIB: Record<string, number> = {
    '': 1 / 1048576,
    ki: 1 / 1024,
    mi: 1,
    gi: 1024,
    ti: 1024 ** 2,
    pi: 1024 ** 3,
    ei: 1024 ** 4,
    k: 1e3 / 1048576,
    m: 1e6 / 1048576,
    g: 1e9 / 1048576,
    t: 1e12 / 1048576,
    p: 1e15 / 1048576,
    e: 1e18 / 1048576,
};

const memMbOfQuantity = (value: string): number | null => {
    const match = /^([0-9]*\.?[0-9]+)\s*([A-Za-z]*)$/.exec(value.trim());
    if (!match) return null;
    const factor = MEM_TO_MIB[match[2]!.toLowerCase()];
    if (factor === undefined) return null;
    return Number.parseFloat(match[1]!) * factor;
};

/**
 * Pulls the vitals out of one PodMetrics object — the first container is the runner, the only
 * container the pod has. Pure and exported for the pinning, like `parseDockerStats`: null for
 * anything it cannot read, because a missed sample costs freshness, never the run.
 * `memPercent` is null by construction — the runner pod declares no memory limit, so there is
 * no denominator to divide by, and a percentage against the node's whole memory would not be
 * the number the docker dashboard renders either.
 */
export function parsePodMetrics(body: string): Omit<RuntimeSample, 'sampledAt'> | null {
    let metrics: { containers?: { usage?: { cpu?: unknown; memory?: unknown } }[] };
    try {
        metrics = JSON.parse(body) as { containers?: { usage?: { cpu?: unknown; memory?: unknown } }[] };
    } catch {
        return null;
    }
    const usage = metrics.containers?.[0]?.usage;
    const millicores = typeof usage?.cpu === 'string' ? cpuMillicores(usage.cpu) : null;
    const memUsedMb = typeof usage?.memory === 'string' ? memMbOfQuantity(usage.memory) : null;
    if (millicores === null || memUsedMb === null) return null;
    return { cpuPercent: millicores / 10, memUsedMb, memPercent: null };
}

/**
 * Per-run cleanup state, created fresh inside run() for every run and threaded through run0 into
 * create — deliberately NOT a closure cell on the runner object: the runner object is reused
 * across runs and nothing structurally prevents runs from overlapping, so shared closure state
 * would let one run's stand-down suppress another run's release.
 */
interface RunCleanup {
    /**
     * True once a post-create stand-down could not prove its own Job deleted: the Job's fate now
     * belongs to the kubelet's deadline, and the runner may still be on this attempt's checkout
     * when the next claimant arrives — so the claim is left held rather than released. A checkout
     * is never handed over voluntarily while this attempt's runner may still be on it. Leaving it
     * held is safe by construction: acquireClaim's stale-holder takeover (attempt-ordered,
     * uid-preconditioned release) is the documented self-healing route for a claim whose holder
     * died, and that claimant sweeps every `factory.job=<id>` Job before starting its own runner.
     */
    holdClaim: boolean;
}

/**
 * The kubernetes Runner. `request` is injected — the `createBoard(computeFetch)` pattern — and so is
 * `sleep`, which is what lets the poll loop be tested without two seconds per poll.
 */
export function createKubernetesRunner(
    config: DriverConfig,
    request: K8sRequest,
    sleep: (ms: number) => Promise<void> = wait,
): Runner {
    const name = (job: BoardJob): string => {
        // The board is not something this process trusts with a fragment of a path — and job.id
        // lands in API paths here the way workspacePath lands in a command line. Copied from
        // docker.ts, which asserts the same thing before a `docker run`.
        if (!JOB_ID.test(job.id)) {
            throw new Error(`refusing to address a job id that is not a uuid: ${job.id}`);
        }
        return containerName(job);
    };

    const secretsPath = `/api/v1/namespaces/${config.k8sNamespace}/secrets`;

    /** Best-effort: a 404 is the ordinary end of a reaped Secret, and any other failure is the fence's business. */
    const forgetSecret = (job: BoardJob): Promise<void> =>
        request('DELETE', `${secretsPath}/${secretName(job)}`).then(() => undefined, () => undefined);

    /**
     * The Secret's contents: the claim env, the loop's minted gate credentials, and the
     * reporter's ingest token. The reserved-name rule means the first two sets are disjoint, and
     * the gate names must reach the runner for the same reason they ride docker's env file —
     * the agent's ad-hoc gate calls land mid-run, against an endpoint this driver advertises.
     */
    const runnerEnv = (job: BoardJob): Record<string, string> => ({
        ...claimEnv(job),
        ...(job.gateEnv ?? {}),
        ...(config.ingestToken ? { INGEST_TOKEN: config.ingestToken } : {}),
    });

    /** Only a job whose Secret was ever created touches it — not even to delete one. */
    const forgetSecretIfAny = (job: BoardJob): Promise<void> =>
        Object.keys(runnerEnv(job)).length ? forgetSecret(job) : Promise.resolve();

    /**
     * This attempt's service fleet — every pod and headless Service carrying this attempt's
     * lease label AND the service label — deleted by name. The service label is the twin of
     * docker's `label=factory.service` filter, and it is load-bearing here too: the runner pod
     * and every ad-hoc gate pod carry the same lease label, and a teardown keyed on the lease
     * alone would delete a gate run still in flight when the runner's verdict lands early. The
     * set-based `,factory.service` requirement (key exists) narrows both lists to the fleet.
     * Every delete is
     * best-effort: a 404 is the ordinary end of an already-reaped object, a 409 a concurrent
     * fence's, and anything else is the next attempt's fence's business.
     */
    const teardownServices = async (job: BoardJob): Promise<void> => {
        for (const [listPath, basePath] of [
            [podsByLeasePath(config.k8sNamespace, job), podsPath(config.k8sNamespace)],
            [servicesByLeasePath(config.k8sNamespace, job), servicesPath(config.k8sNamespace)],
        ] as const) {
            let response: K8sResponse;
            try {
                response = await request('GET', listPath);
            } catch {
                continue;
            }
            if (response.status >= 300) continue;
            const items = parse<{ items?: { metadata?: { name?: string } }[] }>(response.body).items ?? [];
            for (const item of items) {
                if (!item.metadata?.name) continue;
                await request('DELETE', `${basePath}/${item.metadata.name}`).catch(() => undefined);
            }
        }
    };

    /**
     * The `.bellows.yaml` readout, as a Job: the same script docker runs in a throwaway
     * container, over a read-only PVC mount. Runs to terminal status, its log IS the output the
     * section splitter consumes, and the Job goes as soon as it is read. A readout that cannot
     * run is infrastructure — the same classification the docker read's failure gets — so every
     * failure here throws and the job goes back to its lease.
     */
    const readBellows = async (job: BoardJob): Promise<string> => {
        const spec = bellowsJobSpec(config, job);
        const jobName = spec.metadata.name;
        try {
            const created = await request('POST', jobsPath(config.k8sNamespace), spec);
            if (created.status >= 300) {
                throw new Error(`creating the .bellows.yaml readout answered ${created.status}: ${created.body.slice(0, 200)}`);
            }
            let failures = 0;
            for (;;) {
                let response: K8sResponse;
                try {
                    response = await request('GET', jobPath(config.k8sNamespace, jobName));
                } catch (e) {
                    if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) throw e;
                    await sleep(POLL_MS);
                    continue;
                }
                if (response.status === 404) {
                    throw new Error(`the .bellows.yaml readout ${jobName} no longer exists`);
                }
                if (response.status === 429 || response.status >= 500) {
                    if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
                        throw new Error(
                            `reading the .bellows.yaml readout answered ${response.status} ` +
                                `${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`,
                        );
                    }
                    await sleep(POLL_MS);
                    continue;
                }
                if (response.status >= 300) {
                    throw new Error(`reading the .bellows.yaml readout answered ${response.status}`);
                }
                failures = 0;
                const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
                if ((status.succeeded ?? 0) >= 1 || (status.failed ?? 0) >= 1) {
                    if ((status.failed ?? 0) >= 1) {
                        throw new Error('the .bellows.yaml readout failed — its own deadline is its bound');
                    }
                    break;
                }
                await sleep(POLL_MS);
            }
            const podsResponse = await readVerdict(
                `${podsPath(config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
                'listing the readout pods',
            );
            const pod = parse<K8sPodList>(podsResponse.body).items?.find(
                (item) => !item.metadata?.deletionTimestamp,
            );
            if (!pod?.metadata?.name) {
                throw new Error('the .bellows.yaml readout left no pod to read its output from');
            }
            const log = await readVerdict(
                `${podsPath(config.k8sNamespace)}/${pod.metadata.name}/log`,
                'reading the readout log',
            );
            if (log.status >= 300) {
                throw new Error(`reading the .bellows.yaml readout's log answered ${log.status}`);
            }
            return log.body;
        } finally {
            void request('DELETE', `${jobPath(config.k8sNamespace, jobName)}?propagationPolicy=Background`).then(
                () => undefined,
                () => undefined,
            );
        }
    };

    /**
     * The close-time opencode session scrape, as a Job: the same read the docker runner performs
     * with a throwaway container after the run's close, against the database the run persisted on
     * the PVC. NEVER throws — the scrape is the run's follow-up-ability, finish reason and
     * context vitals, and a failed read is not a failed run: the docker runner answers the same
     * failures with an `error` line and its verdict intact. Like docker, the caller retries —
     * the CLI exited a moment ago and the database may still be mid-checkpoint, so an empty or
     * failed answer reads as "not yet", whatever the reason.
     */
    const scrapeOpencodeSession = async (job: BoardJob): Promise<OpencodeRunOutcome> => {
        const fail = (error: string): OpencodeRunOutcome => ({
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            error,
        });
        let spec: AuxJobSpec;
        try {
            spec = opencodeReadoutJobSpec(config, job);
        } catch (e) {
            return fail((e as Error).message);
        }
        const jobName = spec.metadata.name;
        try {
            const created = await request('POST', jobsPath(config.k8sNamespace), spec);
            if (created.status >= 300) {
                return fail(`creating the session readout answered ${created.status}: ${created.body.slice(0, 200)}`);
            }
            let failures = 0;
            for (;;) {
                let response: K8sResponse;
                try {
                    response = await request('GET', jobPath(config.k8sNamespace, jobName));
                } catch (e) {
                    if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) return fail((e as Error).message);
                    await sleep(POLL_MS);
                    continue;
                }
                if (response.status === 404) return fail(`the session readout ${jobName} no longer exists`);
                if (response.status === 429 || response.status >= 500) {
                    if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
                        return fail(
                            `reading the session readout answered ${response.status} ` +
                                `${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`,
                        );
                    }
                    await sleep(POLL_MS);
                    continue;
                }
                if (response.status >= 300) return fail(`reading the session readout answered ${response.status}`);
                failures = 0;
                const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
                if ((status.succeeded ?? 0) >= 1 || (status.failed ?? 0) >= 1) {
                    if ((status.failed ?? 0) >= 1) {
                        return fail('the session readout job failed — its own deadline is its bound');
                    }
                    break;
                }
                await sleep(POLL_MS);
            }
            let pods: K8sResponse;
            let log: K8sResponse;
            try {
                pods = await readVerdict(
                    `${podsPath(config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
                    'listing the session readout pods',
                );
                if (pods.status >= 300) {
                    return fail(`listing the session readout pods answered ${pods.status}`);
                }
                const pod = parse<K8sPodList>(pods.body).items?.find(
                    (item) => !item.metadata?.deletionTimestamp,
                );
                if (!pod?.metadata?.name) return fail('the session readout left no pod to read its output from');
                log = await readVerdict(
                    `${podsPath(config.k8sNamespace)}/${pod.metadata.name}/log`,
                    'reading the session readout log',
                );
                if (log.status >= 300) return fail(`reading the session readout's log answered ${log.status}`);
            } catch (e) {
                return fail((e as Error).message);
            }
            return parseOpencodeRunOutcome(log.body);
        } finally {
            void request('DELETE', `${jobPath(config.k8sNamespace, jobName)}?propagationPolicy=Background`).then(
                () => undefined,
                () => undefined,
            );
        }
    };

    /**
     * Best-effort delete of THIS attempt's own Job — by its own attempt-scoped name, which is
     * what keeps it from ever reaching another attempt's objects. Used by the claim verifies
     * around the Job POST: a run that cannot prove the checkout is still its own must not leave a
     * runner on it. The ANSWER is the delete's verdict, and callers act on it: true when the Job
     * is provably going away (2xx) or provably already gone (404 — nothing of ours is left on
     * the checkout either way); false for any other non-2xx status or a transport rejection,
     * where the Job may survive to the kubelet's deadline. On false the caller HOLDS the
     * checkout claim instead of releasing it — the one thing worse than a held claim is handing
     * the checkout to a replacement while this attempt's runner may still be on it — and the
     * next claimant's stale-holder takeover is the documented route that reclaims both.
     */
    const deleteOwnJob = (job: BoardJob): Promise<boolean> =>
        request('DELETE', `${jobPath(config.k8sNamespace, name(job))}?propagationPolicy=Foreground`).then(
            (response) => response.status < 300 || response.status === 404,
            () => false,
        );

    /**
     * Take the checkout claim, atomically. The POST is the whole mutex: the apiserver grants the
     * name to exactly one creator, so there is no window in which two attempts both hold the
     * checkout — the GET-then-POST race the label fence had is closed by construction. A `409`
     * reads the holder: an attempt number at or ahead of ours is our own replacement, and we
     * stand down (this is what keeps a superseded attempt from ever touching its winner);
     * behind ours is a leftover from a driver that died holding the claim, released
     * conditionally on the exact incarnation we read — the uid precondition is what keeps a
     * stale attempt's release from ever reaching a newer claim. No clock is read anywhere: the
     * board's attempt counter orders the contenders, and a claim we cannot classify is released
     * the same way, because an unclassifiable object is never proof of a newer writer.
     */
    const acquireClaim = async (job: BoardJob): Promise<void> => {
        const path = claimPath(config.k8sNamespace, job);
        for (let round = 1; ; round += 1) {
            if (round > CLAIM_ROUNDS) {
                throw new Error(`the checkout claim of job ${job.id} was never acquired after ${CLAIM_ROUNDS} rounds`);
            }
            const post = await request('POST', configmapsPath(config.k8sNamespace), claimBody(job));
            if (post.status < 300) return;
            if (post.status !== 409) {
                throw new Error(`claiming the checkout answered ${post.status}: ${post.body.slice(0, 200)}`);
            }
            const get = await request('GET', path);
            // Gone between our 409 and the read — the holder released it; race for it again.
            if (get.status === 404) continue;
            if (get.status >= 300) {
                throw new Error(`reading the checkout claim answered ${get.status}: ${get.body.slice(0, 200)}`);
            }
            const claim = parse<K8sClaim>(get.body);
            if (claim.data?.holder === job.leaseToken) return;
            const attempt = Number(claim.data?.attempt);
            if (Number.isFinite(attempt) && attempt >= job.attempts) {
                throw new Error(
                    `job ${job.id} stands down: the checkout claim is held by a newer attempt ` +
                        `(${claim.data?.attempt} >= ${job.attempts})`,
                );
            }
            const uid = claim.metadata?.uid;
            if (!uid) {
                // A read that cannot name the incarnation it read is a bad read, and garbage is
                // never proof of an older holder: an UNCONDITIONED delete here could reach a
                // newer claim and reopen both races through this one branch. Fail loud; the job
                // goes back to its lease. Every apiserver-created object carries a uid.
                throw new Error(`the checkout claim of job ${job.id} could not be identified: no uid on the object`);
            }
            const release = await request('DELETE', path, {
                apiVersion: 'v1',
                kind: 'DeleteOptions',
                preconditions: { uid },
            });
            // 404: the holder released it first. 409: the claim we read was replaced in the
            // meantime — the next round's GET reads the new holder and orders us against it.
            if (release.status >= 300 && release.status !== 404 && release.status !== 409) {
                throw new Error(`releasing the checkout claim answered ${release.status}: ${release.body.slice(0, 200)}`);
            }
        }
    };

    /**
     * Give the checkout claim back — conditionally, because the only claim this attempt may ever
     * release is the exact incarnation it still holds. A claim that answers gone or held by
     * another attempt is left entirely alone: the first shape means nobody holds the checkout,
     * the second means a newer attempt took it over, and both leave nothing for this attempt to
     * undo. A driver that dies holding the claim leaks it — labeled `factory.job` for a cleanup
     * job, the same accepted-leak posture as the env Secret — and the next claimant releases it
     * by takeover, because its attempt number is strictly ahead.
     */
    const releaseClaim = async (job: BoardJob): Promise<void> => {
        const path = claimPath(config.k8sNamespace, job);
        let get: K8sResponse;
        try {
            get = await request('GET', path);
        } catch {
            return; // Nothing provable; a leaked claim is taken over by the next claimant.
        }
        if (get.status === 404 || get.status >= 300) return;
        const claim = parse<K8sClaim>(get.body);
        const uid = claim.metadata?.uid;
        if (claim.data?.holder !== job.leaseToken || !uid) return;
        try {
            await request('DELETE', path, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } });
        } catch {
            // Best effort: the leak's cost is one takeover by the next claimant, nothing worse.
        }
    };

    /**
     * The runner's arrival, split so the loop's auxiliary services can start BETWEEN the fence
     * and the runner: `prepare` takes the checkout claim, sweeps the label's leftovers, creates
     * the env Secret and runs the pre-create claim verify; `launch` POSTs the Job and runs the
     * post-create verify. Services and every author-facing refusal they can produce (a parse
     * refusal, a DNS-name collision) resolve BETWEEN the two — after the fence, so a stood-down
     * attempt starts no fleet, and before the Job, so a refused job never has a runner to
     * orphan and docker's fleet-before-runner order holds for free.
     */
    const prepare = async (job: BoardJob, cleanup: RunCleanup): Promise<void> => {
        const env = runnerEnv(job);

        /*
         * The re-claim fence, step one: TAKE THE CHECKOUT. One POST per round, arbitrated by the
         * apiserver's name uniqueness — the atomic mutex the old GET-then-POST label fence could
         * only approximate. Two attempts can no longer both observe a free checkout and both
         * create: the second POST answers 409 and reads who won.
         */
        await acquireClaim(job);

        /*
         * Step two: the sweep — the janitor that enforces the takeover. Every object the
         * `factory.job=<id>` selector answers is a leftover of the attempts this claim was taken
         * FROM: deleted BY NAME, per object, with Foreground propagation, until the selector
         * answers nothing and this attempt's Job is the only possible writer on the checkout. No
         * timestamps, no cutoffs, no clocks: an age filter was unsound in both directions, so the
         * sweep classifies nothing. It is safe to sweep "everything" exactly because the claim is
         * held: whoever the objects belonged to, the board has superseded them — and this attempt's
         * own Job cannot exist yet, its name carrying this attempt's lease token and nothing
         * having posted it.
         *
         * The claim is re-read before every deleting round: a stale attempt whose claim was taken
         * over mid-sweep STANDS DOWN having deleted nothing — never the winner's Job, which the
         * old fence deleted on sight (issue #32, race 2). A blink on the claim read deletes
         * nothing either: the round is skipped and the loop looks again within the same bound.
         */
        let waits = 0;
        for (;;) {
            /*
             * Every object the `factory.job=<id>` label answers, across the three kinds a job
             * can leave behind: runner and gate Jobs, a dead attempt's service pods, and its
             * service DNS Services (whose names are namespace-global, so a leftover `db` must
             * be swept before a replacement can create its own). Gates under this executor run
             * as Jobs carrying the same label, which is what puts them inside this sweep.
             */
            const fleets: { kind: string; basePath: string; names: string[] }[] = [];
            // A kind that could not answer — transport failure, 429, 5xx — makes the round
            // INCONCLUSIVE: "no answer" is not "nothing there", and the create must wait for a
            // round where every kind answered and named nothing.
            let conclusive = true;
            for (const [kind, selectorPath, basePath] of [
                ['job', jobsSelectorPath(config.k8sNamespace, job), jobsPath(config.k8sNamespace)],
                ['pod', podsSelectorPath(config.k8sNamespace, job), podsPath(config.k8sNamespace)],
                ['service', servicesSelectorPath(config.k8sNamespace, job), servicesPath(config.k8sNamespace)],
            ] as const) {
                let probe: K8sResponse;
                try {
                    probe = await request('GET', selectorPath);
                } catch {
                    // A transport failure says nothing about whether the objects are gone.
                    probe = { status: 0, body: '' };
                }
                // A kind answering nothing at all has nothing of this job in it.
                if (probe.status === 404) continue;
                if (probe.status >= 200 && probe.status < 300) {
                    const items = parse<{ items?: { metadata?: { name?: string } }[] }>(probe.body).items ?? [];
                    const names: string[] = [];
                    for (const item of items) {
                        if (item.metadata?.name) names.push(item.metadata.name);
                    }
                    if (names.length > 0) fleets.push({ kind, basePath, names });
                    continue;
                }
                // 429/5xx/transport: inconclusive — the round cannot free the checkout.
                conclusive = false;
            }
            // Every kind answered and none has anything of this job's — the checkout is free.
            if (fleets.length === 0) {
                if (conclusive) break;
                // Inconclusive: keep polling within the same bound instead of creating
                // alongside what may still be there.
                if (++waits > REPLACE_MAX_POLLS) {
                    throw new Error(
                        `the fence of job ${job.id} could not confirm the checkout empty (${REPLACE_MAX_POLLS} polls)`,
                    );
                }
                await sleep(POLL_MS);
                continue;
            }
            let verified: 'ours' | 'lost' | 'unknown' = 'unknown';
            try {
                const held = await request('GET', claimPath(config.k8sNamespace, job));
                if (held.status === 404) {
                    verified = 'lost';
                } else if (held.status >= 200 && held.status < 300) {
                    // A 2xx that cannot name its holder also reads as lost, deliberately
                    // asymmetric with step six: standing down deletes nothing, so garbage
                    // is safe to act on HERE — while step six deletes the Job, so there
                    // the same evidence fails loud without acting.
                    verified = parse<K8sClaim>(held.body).data?.holder === job.leaseToken ? 'ours' : 'lost';
                }
                // 429/5xx: unconfirmed — neither delete nor stand down on a maybe.
            } catch {
                verified = 'unknown';
            }
            if (verified === 'lost') {
                throw new Error(
                    `job ${job.id} stands down: the checkout claim was taken over while the job label still answered`,
                );
            }
            if (verified === 'unknown') {
                if (++waits > REPLACE_MAX_POLLS) {
                    throw new Error(
                        `the checkout claim of job ${job.id} could not be confirmed before fencing ` +
                            `(${REPLACE_MAX_POLLS} polls)`,
                    );
                }
                await sleep(POLL_MS);
                continue;
            }
            let deleted = 0;
            for (const fleet of fleets) {
                for (const leftover of fleet.names) {
                    const response = await request(
                        'DELETE',
                        `${fleet.basePath}/${leftover}?propagationPolicy=Foreground`,
                    );
                    // A 404 is the ordinary end of an object another fence got to first; a 409
                    // is a concurrent replacement's fence deleting the same object. Both mean
                    // the object is being removed. Anything else fails loud, as ever.
                    if (response.status >= 300 && response.status !== 404 && response.status !== 409) {
                        throw new Error(
                            `deleting the leftover ${fleet.kind}s answered ${response.status}: ` +
                                `${response.body.slice(0, 200)}`,
                        );
                    }
                    if (response.status < 300) deleted += 1;
                }
            }
            // Every delete came back 404/409 — another fence removed them already.
            if (deleted === 0) break;
            if (++waits > REPLACE_MAX_POLLS) {
                throw new Error(
                    `the leftover objects of job ${job.id} never disappeared after their delete ` +
                        `(${REPLACE_MAX_POLLS} polls)`,
                );
            }
            await sleep(POLL_MS);
        }

        // Step three: the env Secret, AFTER the claim and the sweep. Before the Job, as ever: a
        // pod that references a Secret that is not there yet is a CreateContainerConfigError and
        // a burned attempt. The name carries this attempt's lease token, so there is no previous
        // attempt's Secret at this name to sweep — and deliberately no pre-create delete, which
        // under a shared name was what let a superseded worker's cleanup destroy a replacement's
        // Secret. A stood-down attempt creates nothing here — and where the pre-create verify
        // below stands this attempt down after this Secret exists, the run's finally is what
        // reaps it; this step owns no cleanup of its own.
        if (Object.keys(env).length) {
            const secretResponse = await request('POST', secretsPath, secretBody(job, env));
            if (secretResponse.status >= 300) {
                throw new Error(
                    `creating the runner secret answered ${secretResponse.status}: ${secretResponse.body.slice(0, 200)}`,
                );
            }
        }

        /*
         * Step four: the claim must STILL be ours immediately before the Job POST — the first
         * half of the bracket that fences the POST from both sides. A takeover already visible
         * here creates nothing at all: the stand-down throws with nothing of this attempt's to
         * delete (the Secret above, if any, is the run's finally to reap). The read runs with
         * the same bounded patience as every verdict-carrying read, and its exhaustion
         * propagates unwrapped — nothing was created yet, so there is nothing to clean up. Only
         * a definitive answer acts: a gone claim, or one held by another attempt, stands the
         * attempt down; anything else fails loud without deleting, for the same reason.
         */
        const pre = await readVerdict(claimPath(config.k8sNamespace, job), 'reading the checkout claim');
        const preClaim = parse<K8sClaim>(pre.body);
        const preReadOurs = pre.status >= 200 && pre.status < 300;
        if (
            pre.status === 404 ||
            (preReadOurs && preClaim.data?.holder !== undefined && preClaim.data.holder !== job.leaseToken)
        ) {
            throw new Error(
                `job ${job.id} stands down: the checkout claim was taken over before the runner job was created`,
            );
        }
        if (!preReadOurs || preClaim.data?.holder !== job.leaseToken) {
            throw new Error(
                `the checkout claim of job ${job.id} could not be confirmed before creating the runner job ` +
                    `(answered ${pre.status})`,
            );
        }
    };

    // Step five: this attempt's Job, under its own attempt-scoped name.
    const launch = async (job: BoardJob, spec: RunnerJobSpec, cleanup: RunCleanup): Promise<void> => {
        const response = await request('POST', jobsPath(config.k8sNamespace), spec);
        if (response.status >= 300) {
            throw new Error(
                `creating the runner job answered ${response.status}: ${response.body.slice(0, 200)}`,
            );
        }

        /*
         * Step six: the claim must STILL be ours once the Job exists — the second half of the
         * bracket the pre-create verify opened. A takeover already visible before the POST
         * created nothing; a takeover landing in the one API round trip between the two is
         * caught here, and the attempt that loses the claim between its Job POST and this read
         * deletes its own Job — BY NAME, its own attempt-scoped name, so its cleanup can never
         * reach the winner's objects — and stands down. That single round trip is the residual:
         * a brief, bounded overlap of two schedulable Jobs, never an unbounded one, never a
         * teardown of the winner. The read runs with the same bounded patience the status poll
         * has: a blink or a 503 is not proof the claim moved, and standing down on a maybe
         * would burn runs on apiserver flakiness. But once the full patience is spent the
         * checkout cannot be proven ours, and no runner stays on a checkout its driver cannot
         * verify — burning the attempt is the alternative to two writers on one checkout, the
         * fence's own rule — so even the unverifiable answer takes the Job down, best-effort:
         * an apiserver that is truly gone still leaves it to the kubelet's
         * activeDeadlineSeconds, exactly as before. The heartbeat-409 kill (docs/jobs.md)
         * stays the backstop.
         */
        let held: K8sResponse;
        try {
            held = await readVerdict(claimPath(config.k8sNamespace, job), 'reading the checkout claim');
        } catch (e) {
            const deleted = await deleteOwnJob(job);
            // A failed delete leaves the Job to the kubelet's deadline: hold the claim — the
            // checkout is never handed over while this attempt's runner may still be on it.
            if (!deleted) cleanup.holdClaim = true;
            throw e;
        }
        const claim = parse<K8sClaim>(held.body);
        const readOurs = held.status >= 200 && held.status < 300;
        if (
            held.status === 404 ||
            (readOurs && claim.data?.holder !== undefined && claim.data.holder !== job.leaseToken)
        ) {
            const deleted = await deleteOwnJob(job);
            // A failed delete leaves the Job to the kubelet's deadline: hold the claim — the
            // checkout is never handed over while this attempt's runner may still be on it.
            if (!deleted) cleanup.holdClaim = true;
            throw new Error(
                `job ${job.id} stands down: the checkout claim was taken over before the runner could start`,
            );
        }
        if (!readOurs || claim.data?.holder !== job.leaseToken) {
            // Neither provably ours nor provably gone — and after the full patience, no runner
            // stays on a checkout its driver cannot verify. Burning the attempt is the
            // alternative to two writers on one checkout, the fence's own rule; the delete is
            // best-effort, so an apiserver that is truly gone still leaves the Job to the
            // kubelet's activeDeadlineSeconds, exactly as before.
            const deleted = await deleteOwnJob(job);
            // A failed delete leaves the Job to the kubelet's deadline: hold the claim — the
            // checkout is never handed over while this attempt's runner may still be on it.
            if (!deleted) cleanup.holdClaim = true;
            throw new Error(
                `the checkout claim of job ${job.id} could not be confirmed after creating the runner job ` +
                    `(answered ${held.status})`,
            );
        }
    };

    /**
     * One GET with the same bounded patience the status poll has. Used for the reads that carry
     * the run's verdict once it has finished: the pod list (exit code) and the log (output).
     * An apiserver answering 503 for a moment is not this run's verdict — reporting a failure
     * here would blame the command for the API server's problem and re-run finished work.
     */
    const readVerdict = async (path: string, what: string): Promise<K8sResponse> => {
        let failures = 0;
        for (;;) {
            let response: K8sResponse;
            try {
                response = await request('GET', path);
            } catch (e) {
                if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) throw e;
                await sleep(POLL_MS);
                continue;
            }
            if (response.status !== 429 && response.status < 500) return response;
            if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
                throw new Error(
                    `${what} answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`,
                );
            }
            await sleep(POLL_MS);
        }
    };

    /**
     * Runs one aux Job to its verdict: poll the Job to a terminal status with the same bounded
     * patience every verdict-carrying read has, then read the exit code off its pod and the
     * output off the pod's log — the same discovery (job-name label, terminating pods skipped)
     * and the same succeeded-with-no-pod convention (one pod, never retried, so a success can
     * only have counted an exit-0 termination) the runner's own verdict read applies. Used by
     * the publish steps, whose every container is exactly this shape.
     */
    const auxVerdict = async (jobName: string): Promise<{ exitCode: number | null; output: string }> => {
        let failures = 0;
        for (;;) {
            let response: K8sResponse;
            try {
                response = await request('GET', jobPath(config.k8sNamespace, jobName));
            } catch (e) {
                if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) throw e;
                await sleep(POLL_MS);
                continue;
            }
            if (response.status === 404) {
                throw new Error(`the job ${jobName} no longer exists`);
            }
            if (response.status === 429 || response.status >= 500) {
                if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
                    throw new Error(
                        `reading the job ${jobName} answered ${response.status} ` +
                            `${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`,
                    );
                }
                await sleep(POLL_MS);
                continue;
            }
            if (response.status >= 300) {
                throw new Error(`reading the job ${jobName} answered ${response.status}: ${response.body.slice(0, 200)}`);
            }
            failures = 0;
            const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
            if ((status.succeeded ?? 0) >= 1 || (status.failed ?? 0) >= 1) {
                const succeeded = (status.succeeded ?? 0) >= 1;
                const pods = await readVerdict(
                    `${podsPath(config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
                    `listing the pods of ${jobName}`,
                );
                if (pods.status >= 300) {
                    throw new Error(`listing the pods of ${jobName} answered ${pods.status}`);
                }
                const pod = parse<K8sPodList>(pods.body).items?.find(
                    (item) => !item.metadata?.deletionTimestamp,
                );
                const exitCode =
                    pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode ?? (succeeded ? 0 : null);
                let output = '';
                if (pod?.metadata?.name) {
                    const log = await request(
                        'GET',
                        `${podsPath(config.k8sNamespace)}/${pod.metadata.name}/log?tailLines=${LOG_TAIL_LINES}`,
                    ).catch(() => ({ status: 0, body: '' }));
                    if (log.status < 300) output = log.body;
                }
                return { exitCode, output };
            }
            await sleep(POLL_MS);
        }
    };

    const runner = {
        // Remote Control is refused at config under this executor, and the loop polls the remote id
        // only under Remote Control — so null is never even asked for. The interface blesses it.
        async remoteSessionId() {
            return null;
        },

        // The docker runner samples `docker stats`; the twin here is the metrics API, read from
        // the runner's own pod — discovered by the same job-name label the log read uses,
        // terminating pods skipped for the same reason. Every failure (no pod yet, no
        // metrics-server in the cluster, a blink) answers null: "no fresh sample", never an
        // error, exactly what a failed docker read answers.
        async sampleRuntime(job: BoardJob) {
            let pods: K8sResponse;
            try {
                pods = await request(
                    'GET',
                    `${podsPath(config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${name(job)}`)}`,
                );
            } catch {
                return null;
            }
            if (pods.status >= 300) return null;
            const runnerPod = parse<K8sPodList>(pods.body).items?.find(
                (item) => !item.metadata?.deletionTimestamp,
            )?.metadata?.name;
            if (!runnerPod) return null;
            let metrics: K8sResponse;
            try {
                metrics = await request(
                    'GET',
                    `/apis/metrics.k8s.io/v1beta1/namespaces/${config.k8sNamespace}/pods/${runnerPod}`,
                );
            } catch {
                return null;
            }
            if (metrics.status >= 300) return null;
            return parsePodMetrics(metrics.body);
        },

        // The same contract as `docker kill ... .catch(() => undefined)`: a kill that finds nothing
        // is the ordinary end of a finished run, and one that fails is the kubelet's deadline doing
        // this function's work. No Secret delete here: the run() wrapper below owns the Secret's
        // whole lifetime — it reaps on the verdict, on a throw, and on the kill-induced "Job no
        // longer exists" 404 — so every Secret that exists was created inside a run0 that is
        // either in flight (the wrapper will reap it) or done (the wrapper reaped it), and this
        // function's own delete would be redundant cleanup. It would also be harmful: a kill can
        // interleave the same attempt's create() between its Secret POST and its Job POST (a
        // lease-lost heartbeat), deleting the Secret the Job it is about to create references and
        // stranding its pod in CreateContainerConfigError. The cost of leaving the Secret alone is
        // stated, not hidden: a stale attempt whose Job was deleted before it existed runs to its
        // natural end with its env intact and its report refused by the board — the same semantics
        // the runner had before env injection.
        async kill(job: BoardJob) {
            await request(
                'DELETE',
                `${jobPath(config.k8sNamespace, name(job))}?propagationPolicy=Background`,
            ).catch(() => undefined);
            // The declared services go with the runner — docker.ts's kill tears its fleet down
            // the same way. A killed job's database has no reason to outlive the runner that
            // talked to it.
            await teardownServices(job);
        },

        // Both CLIs carry: claude-code with a minted session, opencode headless with none (the
        // session the run uses is scraped at close — see run0). The claude-code null-session
        // refusal lives in runnerJobSpec and in run0's pre-fence check below.
        async run(job: BoardJob, session: RunSession, onOutput?: (tail: string) => void) {
            /*
             * Every throw after create() succeeded — poll exhaustion, a vanished Job, a failed
             * verdict read — must still reap the env Secret AND release the checkout claim: the
             * loop's catch never calls kill(), and when the job retires dead there is no next
             * attempt to do either. The cleanup is the OUTSIDE of the run, not a step in it. The
             * claim is released first, conditionally on this attempt still holding its exact
             * incarnation (releaseClaim never touches a claim that moved on); the Secret is
             * reaped last. With the lease token in the name, both this and kill() can only ever
             * remove their own attempt's Secret.
             *
             * The one exception: a post-create stand-down whose own-Job DELETE did not answer
             * success or already-gone records that in `cleanup.holdClaim`, and the claim is left
             * held — the Job's fate then belongs to the kubelet's deadline, and this attempt's
             * runner may still be on the checkout when a replacement claimant arrives. Releasing
             * would hand the checkout over with a live writer on it. The held claim needs no other
             * cleanup: acquireClaim's stale-holder takeover is the documented self-healing route
             * (the next claimant releases it, uid-preconditioned, and sweeps every `factory.job`
             * Job before posting its own). `forgetSecretIfAny` stays unconditional — the Secret is
             * attempt-scoped and a running pod read its env at container start, which
             * `restartPolicy: Never` + `backoffLimit: 0` mean no restart can need again. The state
             * is a fresh cell per run, never a closure field: the runner object is reused across
             * runs and nothing prevents runs from overlapping, so shared closure state could let
             * one run's stand-down suppress another run's release.
             */
            const cleanup: RunCleanup = { holdClaim: false };
            try {
                return await runner.run0(job, session, onOutput, cleanup);
            } finally {
                if (!cleanup.holdClaim) await releaseClaim(job);
                // The service fleet's whole purpose is the run — it goes when the run does,
                // whatever the run came back with. Same close-time teardown docker.ts runs.
                await teardownServices(job);
                await forgetSecretIfAny(job);
            }
        },

        // The body of run() above, split out only so its cleanup can wrap the throw paths too.
        async run0(
            job: BoardJob,
            session: RunSession,
            onOutput: ((tail: string) => void) | undefined,
            cleanup: RunCleanup,
        ): Promise<RunOutcome> {
            // A null session is an opencode job under this executor — a fresh headless run, the
            // same shape the docker runner carries (dockerArgs). Under claude-code every job is
            // a session, and one arriving without is refused here, BEFORE the fence takes the
            // checkout — the same early refusal the docker loop makes.
            if (!session && config.cli !== 'opencode') {
                throw new Error(`refusing to run job ${job.id}: the kubernetes runner runs every job as a session`);
            }
            await prepare(job, cleanup);

            /*
             * Auxiliary services, the k8s form of docker.ts's setup: read the checkouts'
             * `.bellows.yaml` through a throwaway readout Job, then start each declared service
             * as a Pod with a headless Service as its DNS name — `redis://cache:6379` resolves
             * inside this namespace for exactly as long as this attempt runs. This sits between
             * the fence and the runner's own launch: after the fence, so a stood-down attempt
             * starts no fleet; before the Job, so every refusal below is answered while nothing
             * of this attempt's runs — a parse refusal or a name collision must never leave a
             * live runner to orphan on the checkout.
             *
             * The classification is docker.ts's own. A refused read or a refused start is
             * INFRASTRUCTURE — the API server said no to an object this process spawned — so it
             * throws, and the loop leaves the job to its lease instead of blaming the command.
             * A parse refusal is the AUTHOR's: deterministic, fully said by the message, so it
             * is returned as a failed run rather than thrown. The one addition this platform
             * forces: a Service name is NAMESPACE-global, so a 409 on the DNS object means
             * another concurrent job already holds that name — also deterministic, also the
             * author's to fix, and refused the same terminal way rather than resolved by an
             * ordering rule that would only read as "the wrong database came up".
             */
            if (config.servicesEnabled) {
                let specs: ServiceSpec[] = [];
                let refusal: string | null = null;
                let raw: string;
                try {
                    raw = await readBellows(job);
                } catch (e) {
                    throw new Error(`could not read .bellows.yaml: ${(e as Error).message}`);
                }
                try {
                    specs = collectServices(splitBellowsSections(raw));
                } catch (e) {
                    refusal = (e as Error).message;
                }
                if (!refusal) {
                    for (const spec of specs) {
                        try {
                            const pod = await request('POST', podsPath(config.k8sNamespace), servicePodSpec(config, job, spec));
                            if (pod.status >= 300) {
                                throw new Error(`creating the service pod answered ${pod.status}: ${pod.body.slice(0, 200)}`);
                            }
                            const dns = await request('POST', servicesPath(config.k8sNamespace), serviceDnsSpec(job, spec));
                            if (dns.status === 409) {
                                refusal =
                                    `.bellows.yaml: service "${spec.name}" is already running for another job in ` +
                                    'this namespace — a service name is shared across the namespace, and no ' +
                                    'first-wins or last-wins rule reads as anything but "the wrong database came up". ' +
                                    'Re-queue this job when the other one is done, or rename one of the services.';
                                break;
                            }
                            if (dns.status >= 300) {
                                throw new Error(`creating the service DNS name answered ${dns.status}: ${dns.body.slice(0, 200)}`);
                            }
                        } catch (e) {
                            // A partial fleet is torn down on the way out, exactly as docker's is.
                            await teardownServices(job);
                            throw new Error(`could not start service "${spec.name}": ${(e as Error).message}`);
                        }
                    }
                }
                if (refusal !== null) {
                    await teardownServices(job);
                    return { exitCode: null, output: refusal, timedOut: false, idled: false, started: true };
                }
            }

            // The runner — the last resource this attempt creates, only after every refusal the
            // services could produce has been answered.
            await launch(job, runnerJobSpec(config, job, session), cleanup);

            /*
             * Poll until the Job reports a terminal status. The kubelet-enforced
             * activeDeadlineSeconds is what guarantees the JOB eventually reaches one — the same
             * bound that kills the docker runner's container guarantees this loop an exit. It does
             * not guarantee this driver can keep READING it, so 429s, 5xx and transport failures
             * are retried a bounded number of times rather than treated as the run's verdict: the
             * house rule for the board applies here too — a server that is briefly unreachable is
             * not a lost run, and reporting one would blame the command for the API server's
             * problem and burn an attempt.
             */
            let timedOut = false;
            let jobSucceeded = false;
            let failures = 0;
            /*
             * Live output, best effort: the same log tail the finished run reports, read mid-run
             * and handed to the caller on every poll that found something. The pod is discovered
             * by label and remembered; every failure here — a pod not scheduled yet, a 503, a
             * dropped connection — costs freshness, never the run, because the status poll below
             * still owns the verdict and the final log read still owns the report.
             */
            let podName: string | null = null;
            for (;;) {
                let response: K8sResponse;
                try {
                    response = await request('GET', jobPath(config.k8sNamespace, name(job)));
                } catch (e) {
                    if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) throw e;
                    await sleep(POLL_MS);
                    continue;
                }
                if (response.status === 404) {
                    // Gone without this driver deleting it — fenced away or removed by hand. Its
                    // verdict can never arrive, so waiting longer is holding a slot for nothing.
                    throw new Error(`the runner job ${name(job)} no longer exists`);
                }
                if (response.status === 429 || response.status >= 500) {
                    if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
                        throw new Error(
                            `reading the runner job answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`,
                        );
                    }
                    await sleep(POLL_MS);
                    continue;
                }
                if (response.status >= 300) {
                    throw new Error(`reading the runner job answered ${response.status}: ${response.body.slice(0, 200)}`);
                }
                failures = 0;
                const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
                if ((status.succeeded ?? 0) >= 1 || (status.failed ?? 0) >= 1) {
                    jobSucceeded = (status.succeeded ?? 0) >= 1;
                    timedOut = (status.conditions ?? []).some(
                        (condition) => condition.type === 'Failed' && condition.reason === 'DeadlineExceeded',
                    );
                    break;
                }
                if (onOutput) {
                    if (podName === null) {
                        try {
                            const pods = await request(
                                'GET',
                                `/api/v1/namespaces/${config.k8sNamespace}/pods?labelSelector=${encodeURIComponent(
                                    `job-name=${name(job)}`,
                                )}`,
                            );
                            // Skipping terminating pods for the same reason the final read does:
                            // a replaced attempt's pod carries the same label, and its log is not
                            // this run's output.
                            podName =
                                parse<K8sPodList>(pods.body).items?.find(
                                    (item) => !item.metadata?.deletionTimestamp,
                                )?.metadata?.name ?? null;
                        } catch {
                            // Not scheduled yet, or the API server blinked. The next poll looks again.
                        }
                    }
                    if (podName !== null) {
                        try {
                            const log = await request(
                                'GET',
                                `/api/v1/namespaces/${config.k8sNamespace}/pods/${podName}/log?tailLines=${LOG_TAIL_LINES}`,
                            );
                            if (log.status < 300) onOutput(reportTail(log.body));
                        } catch {
                            // The log endpoint hiccups on a pod that is only starting. Freshness
                            // waits a poll; the run does not care.
                        }
                    }
                }
                await sleep(POLL_MS);
            }

            // The pod carries the exit code; the Job object does not. Found by the label the Job
            // controller stamps on every pod it owns, not by guessing the generated name.
            const podsResponse = await readVerdict(
                `/api/v1/namespaces/${config.k8sNamespace}/pods?labelSelector=${encodeURIComponent(
                    `job-name=${name(job)}`,
                )}`,
                'listing the runner pods',
            );
            if (podsResponse.status >= 300) {
                throw new Error(
                    `listing the runner pods answered ${podsResponse.status}: ${podsResponse.body.slice(0, 200)}`,
                );
            }
            // A re-claim replaced the previous attempt's Job, and its pod can still be listed
            // while it terminates — carrying the same job-name label. Skip terminating pods, so
            // the exit code and the log are always this run's.
            const pod = parse<K8sPodList>(podsResponse.body).items?.find(
                (item) => !item.metadata?.deletionTimestamp,
            );
            /*
             * When the Job succeeded but its pod is already gone — garbage-collected before the
             * list above — the Job status IS the exit code: this Job runs one pod
             * (completions: 1) and never retries it (backoffLimit: 0), so the controller can only
             * have counted success on an exit-0 termination. Reporting null here would map to
             * `failed` in the loop and record finished work as failed.
             */
            const exitCode =
                pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode ??
                (jobSucceeded ? 0 : null);

            let output = '';
            if (pod?.metadata?.name) {
                // The tail, not the transcript: a run that fails says why at the end, and the head
                // is banner — bounded in lines by tailLines and in bytes by reportTail, because
                // the board refuses a complete POST that does not fit. A log read that fails —
                // status or transport — does not change the verdict: the exit code already carries
                // it, and reporting empty output beats re-running finished work over one missing
                // log. No retries here at all: the pod may be gone for good, and the answer is
                // already known to be "whatever we can get".
                let log: K8sResponse;
                try {
                    log = await request(
                        'GET',
                        `/api/v1/namespaces/${config.k8sNamespace}/pods/${pod.metadata.name}/log?tailLines=${LOG_TAIL_LINES}`,
                    );
                } catch {
                    log = { status: 0, body: '' };
                }
                if (log.status < 300) output = reportTail(log.body);
            }

            // A resolved outcome here always means the pod was created, ran and exited: Job and
            // pod creation failures throw on their way to the loop's catch, so this is a verdict,
            // whatever the code — started is true even at 125, which is a perfectly ordinary exit
            // status for a shell or an agent CLI. The env Secret went with the run above — the
            // pod read it by now, and the wrapper's finally has removed it.
            const outcome: RunOutcome = { exitCode, output, timedOut, idled: false, started: true };

            /*
             * opencode mints its own session id, so the loop had none to report at spawn — this
             * is where it comes from instead: one throwaway Job over the PVC, one read-only query
             * against the database the run just closed. The same read answers HOW the run's last
             * message ended — a zero exit code with a finish reason that is not `stop` is the
             * model's context limit (or an abort) cutting a task short, which only the session
             * database knows. A failed read is not a failed run: it costs the task its follow-ups
             * and this verdict-check, not its verdict. Three tries, half a second apart, exactly
             * as the docker runner scrapes — the CLI exited a moment ago, and the database may
             * still be mid-checkpoint, which an answer of "no session yet" says without naming.
             */
            if (config.cli === 'opencode') {
                let scraped: OpencodeRunOutcome = {
                    sessionId: null,
                    finishReason: null,
                    contextTokens: null,
                    costUsd: null,
                    error: null,
                };
                let reason: string | null = null;
                for (let attempt = 0; attempt < 3 && !scraped.sessionId; attempt += 1) {
                    if (attempt > 0) await sleep(500);
                    scraped = await scrapeOpencodeSession(job);
                    reason = scraped.error ?? reason;
                }
                if (scraped.sessionId) {
                    outcome.sessionId = scraped.sessionId;
                    if (scraped.finishReason) outcome.finishReason = scraped.finishReason;
                    if (scraped.contextTokens !== null) outcome.contextTokens = scraped.contextTokens;
                    if (scraped.costUsd !== null) outcome.costUsd = scraped.costUsd;
                    // With a session scraped, the line's error is the RUN's last provider error,
                    // not the read's failure — carried as its own field so the verdict can name
                    // the cause of a premature stop, exactly as the docker runner does.
                    if (scraped.error) outcome.providerError = scraped.error;
                } else {
                    outcome.readoutError =
                        reason ?? 'the readout answered nothing (no session in the database)';
                }
            }
            return outcome;
        },

        // The publish, ported: the same publishCheckout workflow the docker runner runs
        // (publish.ts — one place for every decision the two executors must not drift on), with
        // this executor's transport underneath: one aux Job per step over the workspaces PVC,
        // the claim env by a per-attempt Secret read through envFrom — the same discipline the
        // sync, the gates and the runner obey — and the verdict off the pod's exit code and
        // log. The step Jobs carry the attempt's factory.job/factory.lease labels, so the
        // re-claim fence sweeps a dead driver's publish Jobs before a replacement touches the
        // tree; the claim is NOT re-taken here, exactly as docker takes nothing for its
        // publish: the publish runs in the loop's post-run position where the heartbeat is
        // still live, so the lease — not the ConfigMap — is what excludes a replacement.
        async publishGit(job: BoardJob): Promise<PublishResult> {
            const repo = worktreeDir(config, job);
            if (!repo) return publishFailed('the job names no checkout this driver can publish');
            const env = envBodyToData(envFileBody(job));
            const secret = Object.keys(env).length ? publishEnvSecretName(job) : null;
            if (secret) {
                const response = await request('POST', secretsPath, {
                    apiVersion: 'v1',
                    kind: 'Secret',
                    type: 'Opaque',
                    metadata: {
                        name: secret,
                        labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
                    },
                    stringData: env,
                });
                if (response.status >= 300) {
                    return publishFailed(
                        `creating the publish secret answered ${response.status}: ${response.body.slice(0, 200)}`,
                    );
                }
            }
            let stepNumber = 0;
            try {
                return await publishCheckout(config, job, async (publish) => {
                    stepNumber += 1;
                    const jobName = publishStepJobName(job, stepNumber);
                    try {
                        const created = await request(
                            'POST',
                            jobsPath(config.k8sNamespace),
                            publishStepJobSpec(config, job, stepNumber, publish, secret, repo),
                        );
                        if (created.status >= 300) {
                            throw new Error(
                                `creating the publish job answered ${created.status}: ${created.body.slice(0, 200)}`,
                            );
                        }
                        const verdict = await auxVerdict(jobName);
                        // A nonzero exit is the step's failure and the tool's own words are the
                        // reason — the log tail is what the workflow's step wrapper puts under
                        // the step's name, the exact role git's stderr plays on docker.
                        if (verdict.exitCode !== 0) {
                            throw new Error(
                                verdict.output.trim() ||
                                    `the step exited ${verdict.exitCode ?? 'without a readable code'}`,
                            );
                        }
                        return { stdout: verdict.output };
                    } finally {
                        // The step Job goes on every path, fire-and-forget: its name carries
                        // this attempt's lease token, and a delete that misses is swept by the
                        // next attempt's fence anyway.
                        void request(
                            'DELETE',
                            `${jobPath(config.k8sNamespace, jobName)}?propagationPolicy=Background`,
                        ).then(() => undefined, () => undefined);
                    }
                });
            } finally {
                if (secret) {
                    void request('DELETE', `${secretsPath}/${secret}`).then(() => undefined, () => undefined);
                }
            }
        },

        // The startup sync, as ever (see syncJobSpec): the loop calls it on every claim, the
        // task worktree does not exist until something creates it, and a refusal would fail
        // every claimed job.
        async syncCheckout(job: BoardJob): Promise<SyncResult> {
            const clone = repoPath(config, job);
            const worktree = worktreeDir(config, job);
            if (!clone || !worktree) return { ok: true, reason: null }; // nothing synced, nothing to fail either

            /*
             * The fence BEFORE the sync: the loop calls syncCheckout before run(), whose own
             * claim-and-sweep in prepare() would come too late — the sync is the first writer
             * on the task worktree. Taking the checkout claim here is the same acquireClaim
             * protocol prepare() runs, and the claim is then HELD through the run: prepare()'s
             * acquire recognizes its own holder (data.holder === leaseToken) and proceeds, so
             * the attempt never stands down against itself. A 409 against a live newer attempt
             * throws here exactly as it does there — the stand-down leaves the job to its lease
             * and creates nothing.
             *
             * The claim name stays PER-JOB-ID, never per-thread-root, even though worktreeDir
             * keys the tree by root: the board serializes claims per thread root server-side
             * (a separate fix), so cross-row exclusion happens at the board — and a root-scoped
             * claim NAME would break the attempt-ordered stale-holder takeover across follow-up
             * rows, where a leaked row-1 claim carrying attempt 3 would stand down row 2's
             * attempt 1 forever.
             */
            await acquireClaim(job);

            /*
             * The deletion the FAILURE arms use, awaited, with Foreground propagation: the
             * delete returns only after the Job's dependents — the pod — are gone, so the
             * releaseClaim that follows can never hand the checkout to a replacement while the
             * sync's pod is still writing the worktree. The success path deliberately keeps the
             * fire-and-forget Background delete in the finally below: there the Job is already
             * terminal AND the claim stays held through the run, so no handover window exists.
             * Failure hands the checkout over; success keeps ownership.
             */
            const takeSyncJobDown = async (): Promise<void> => {
                await request(
                    'DELETE',
                    `${jobPath(config.k8sNamespace, syncJobName(job))}?propagationPolicy=Foreground`,
                ).then(
                    () => undefined,
                    () => undefined,
                );
            };

            let secret: string | null = null;
            try {
                const result = await (async (): Promise<SyncResult> => {
                    /*
                     * The fetch credential: the claim env, by reference — the same Secret discipline the
                     * runner and every gate obey. Created before the Job; reaped in the finally, on the
                     * verdict or on a throw. The name carries the lease token, so a superseded attempt
                     * can never delete a replacement's Secret.
                     */
                    const env = envBodyToData(envFileBody(job));
                    if (Object.keys(env).length) {
                        const response = await request('POST', secretsPath, {
                            apiVersion: 'v1',
                            kind: 'Secret',
                            type: 'Opaque',
                            metadata: { name: syncEnvSecretName(job), labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken } },
                            stringData: env,
                        });
                        if (response.status >= 300) {
                            return {
                                ok: false,
                                reason: `creating the sync secret answered ${response.status}: ${response.body.slice(0, 200)}`,
                            };
                        }
                        secret = syncEnvSecretName(job);
                    }
                    const create = await request('POST', jobsPath(config.k8sNamespace), syncJobSpec(config, job, secret));
                    if (create.status >= 300) {
                        return {
                            ok: false,
                            reason: `creating the worktree sync job answered ${create.status}: ${create.body.slice(0, 200)}`,
                        };
                    }

                    /*
                     * Poll the sync Job to a terminal state, bounded like the runner's own status
                     * poll: a blink or a 503 is not the sync's verdict, but an apiserver that will
                     * not answer is not a tree to run on either — the bound expires into a failed
                     * sync and the loop fails the attempt with the reason. The kubelet's deadline
                     * (SYNC_DEADLINE_SECONDS) is what guarantees the JOB itself terminates, even if
                     * this driver dies first.
                     */
                    let failures = 0;
                    for (;;) {
                        let response: K8sResponse;
                        try {
                            response = await request('GET', jobPath(config.k8sNamespace, syncJobName(job)));
                        } catch (e) {
                            if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
                                return { ok: false, reason: `the worktree sync job could not be read: ${(e as Error).message}` };
                            }
                            await sleep(POLL_MS);
                            continue;
                        }
                        if (response.status === 429 || response.status >= 500) {
                            if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
                                return {
                                    ok: false,
                                    reason: `reading the worktree sync job answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`,
                                };
                            }
                            await sleep(POLL_MS);
                            continue;
                        }
                        if (response.status >= 300) {
                            return { ok: false, reason: `reading the worktree sync job answered ${response.status}: ${response.body.slice(0, 200)}` };
                        }
                        failures = 0;
                        const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
                        if ((status.succeeded ?? 0) >= 1 || (status.failed ?? 0) >= 1) break;
                        await sleep(POLL_MS);
                    }

                    // The verdict is the pod log — one JSON line, the same answer the docker sync
                    // container prints. A pod gone before its log could be read is a failed sync:
                    // running on a tree of unknown state would compound whatever went wrong.
                    let body = '';
                    try {
                        const pods = await request(
                            'GET',
                            `/api/v1/namespaces/${config.k8sNamespace}/pods?labelSelector=${encodeURIComponent(
                                `job-name=${syncJobName(job)}`,
                            )}`,
                        );
                        const pod = parse<K8sPodList>(pods.body).items?.find(
                            (item) => !item.metadata?.deletionTimestamp,
                        );
                        if (pod?.metadata?.name) {
                            const log = await request(
                                'GET',
                                `/api/v1/namespaces/${config.k8sNamespace}/pods/${pod.metadata.name}/log`,
                            );
                            if (log.status < 300) body = log.body;
                        }
                    } catch {
                        body = '';
                    }
                    const line = body.trim().split('\n').filter(Boolean).pop() ?? '';
                    try {
                        return JSON.parse(line) as SyncResult;
                    } catch {
                        return { ok: false, reason: 'the worktree sync answered nothing readable' };
                    }
                })();
                // A failed sync means no runner follows — nobody else would give the checkout
                // back, so the claim goes here, conditionally on this attempt still holding its
                // exact incarnation (releaseClaim never touches a claim that moved on). The sync
                // Job goes down Foreground FIRST, awaited: handing the checkout back is only
                // clean once nothing of this sync can still write the tree.
                if (!result.ok) {
                    await takeSyncJobDown();
                    await releaseClaim(job);
                }
                return result;
            } catch (e) {
                // A thrown sync — a transport failure, a malformed env line — releases the claim
                // the same way: holding it would only leave the next claimant to take it over.
                // The take-down precedes the release for the same handover reason as above; both
                // are best-effort, and the original error is the one that propagates.
                await takeSyncJobDown();
                await releaseClaim(job);
                throw e;
            } finally {
                /*
                 * The sync Job goes on EVERY exit path — success, a failed verdict, a poll that
                 * never answered, a throw — not just the Secret it was guarded by: a Job left to
                 * its own deadline could overlap a replacement's sync on the shared worktree. The
                 * name carries the lease token, so this delete can never reach a replacement's
                 * Job. The FAILURE arms above already deleted it Foreground and awaited the
                 * answer — this Background delete then answers 404 and is swallowed; on the
                 * SUCCESS path it is THE delete, and is fire-and-forget because the claim is
                 * still held: no handover, no window. Best-effort, fire-and-forget — the same
                 * posture as the Secret below and the readout's own finally: a delete that misses
                 * is swept by the next attempt's fence, which removes every `factory.job=<id>`
                 * object before its own creates.
                 */
                void request(
                    'DELETE',
                    `${jobPath(config.k8sNamespace, syncJobName(job))}?propagationPolicy=Background`,
                ).then(() => undefined, () => undefined);
                if (secret) {
                    void request('DELETE', `${secretsPath}/${secret}`).then(() => undefined, () => undefined);
                }
            }
        },

        /*
         * The terminal reclaim, the kubernetes shape: the remove script as a Job over the PVC,
         * UNDER the checkout claim — the same acquireClaim protocol the sync and the runner use,
         * so the removal and a follow-up's claim-taking sync are mutually exclusive ACROSS
         * drivers too, not just within this one (the loop's own barrier covers this driver; see
         * loop.ts). The claim is taken before the Job is created and released on every exit
         * path; an acquire that answers 409 means a LIVE attempt holds the checkout — a
         * follow-up mid-sync, most likely — and the reclaim SKIPS: costing the reclaim is fine
         * by contract (the tree stays, the branch survives), costing a live run is not. No
         * Secret, no env: removing needs nothing the claim held. The poll is bounded exactly
         * like the sync's: a blink or a 503 is not the script's verdict, but an apiserver that
         * will not answer is not a tree worth waiting on either, and the deadline
         * (RECLAIM_DEADLINE_SECONDS) is what guarantees the Job itself terminates if this driver
         * dies first. Best-effort by contract — the loop calls this only AFTER the verdict is
         * safely on the board, and a refusal must never turn a done task back into a failed one.
         */
        async reclaimWorktree(job: BoardJob): Promise<ReclaimResult> {
            const clone = repoPath(config, job);
            const worktree = worktreeDir(config, job);
            if (!clone || !worktree) return { ok: true, removed: false, reason: null };
            try {
                await acquireClaim(job);
            } catch (e) {
                // A 409 the acquire could not resolve by takeover is a live attempt on the
                // checkout (acquireClaim says which and why in its message). The skip names the
                // held tree so the log line says what was NOT reclaimed, and why.
                return {
                    ok: false,
                    removed: false,
                    reason: `the checkout is held (${worktree}): ${(e as Error).message}`,
                };
            }
            /*
             * The deletion the FAILURE arms use, awaited, with Foreground propagation — the same
             * handover discipline the sync's failure arm runs: the delete returns only after the
             * Job's dependents — the removal pod — are gone, so the releaseClaim that follows can
             * never hand the checkout to a follow-up's sync while something of this reclaim can
             * still write the tree. On the success path the Job is already terminal (its pod has
             * exited — that is what the poll waited for), so the Background fire-and-forget
             * delete in the finally is pure reaping and the release hands over nothing live.
             */
            const takeReclaimJobDown = async (): Promise<void> => {
                await request(
                    'DELETE',
                    `${jobPath(config.k8sNamespace, reclaimJobName(job))}?propagationPolicy=Foreground`,
                ).then(() => undefined, () => undefined);
            };
            try {
                const result = await (async (): Promise<ReclaimResult> => {
                    const create = await request('POST', jobsPath(config.k8sNamespace), reclaimJobSpec(config, job));
                    if (create.status >= 300) {
                        return { ok: false, removed: false, reason: `creating the worktree reclaim job answered ${create.status}: ${create.body.slice(0, 200)}` };
                    }
                    let failures = 0;
                    for (;;) {
                        let response: K8sResponse;
                        try {
                            response = await request('GET', jobPath(config.k8sNamespace, reclaimJobName(job)));
                        } catch (e) {
                            if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
                                return { ok: false, removed: false, reason: `the worktree reclaim job could not be read: ${(e as Error).message}` };
                            }
                            await sleep(POLL_MS);
                            continue;
                        }
                        if (response.status === 429 || response.status >= 500) {
                            if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
                                return {
                                    ok: false,
                                    removed: false,
                                    reason: `reading the worktree reclaim job answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`,
                                };
                            }
                            await sleep(POLL_MS);
                            continue;
                        }
                        if (response.status >= 300) {
                            return { ok: false, removed: false, reason: `reading the worktree reclaim job answered ${response.status}: ${response.body.slice(0, 200)}` };
                        }
                        failures = 0;
                        const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
                        if ((status.succeeded ?? 0) >= 1 || (status.failed ?? 0) >= 1) break;
                        await sleep(POLL_MS);
                    }
                    let body = '';
                    try {
                        const pods = await request(
                            'GET',
                            `/api/v1/namespaces/${config.k8sNamespace}/pods?labelSelector=${encodeURIComponent(
                                `job-name=${reclaimJobName(job)}`,
                            )}`,
                        );
                        const pod = parse<K8sPodList>(pods.body).items?.find((item) => !item.metadata?.deletionTimestamp);
                        if (pod?.metadata?.name) {
                            const log = await request(
                                'GET',
                                `/api/v1/namespaces/${config.k8sNamespace}/pods/${pod.metadata.name}/log`,
                            );
                            if (log.status < 300) body = log.body;
                        }
                    } catch {
                        body = '';
                    }
                    const line = body.trim().split('\n').filter(Boolean).pop() ?? '';
                    try {
                        return JSON.parse(line) as ReclaimResult;
                    } catch {
                        return { ok: false, removed: false, reason: 'the worktree reclaim answered nothing readable' };
                    }
                })();
                if (!result.ok) await takeReclaimJobDown();
                return result;
            } catch (e) {
                // A thrown read between create and verdict leaves the same live-pod risk as a
                // failed verdict: take the Job down before the finally hands the checkout back.
                // The error itself stays a throw — reclaimWorktree's callers catch, and a throw
                // here is transport-shaped, not a verdict to relay.
                await takeReclaimJobDown();
                throw e;
            } finally {
                // Every exit path, like the sync's own finally: a reclaim Job left running is a
                // pod still mounted on the volume. The failure arms' Foreground delete above has
                // already taken it down (this Background delete then answers 404 and is
                // swallowed); on the success path it IS the delete. THEN the claim goes — the
                // checkout is only handed over once nothing of this reclaim can still write it.
                void request(
                    'DELETE',
                    `${jobPath(config.k8sNamespace, reclaimJobName(job))}?propagationPolicy=Background`,
                ).then(() => undefined, () => undefined);
                await releaseClaim(job);
            }
        },

        /*
         * The loop's terminal pre-run refusals (a gates file that cannot be read, gates this
         * driver cannot run) complete the job failed WITHOUT runner.run, so run()'s finally —
         * the ordinary release path — never executes, and the claim the sync took would sit on
         * the checkout indefinitely. This hands it back: the same ownership-checked release
         * releaseClaim performs, so a claim that moved on is never touched. Docker implements
         * nothing here (its sweep leaves nothing behind), so the interface keeps the method
         * optional.
         */
        async releaseFence(job: BoardJob): Promise<void> {
            await releaseClaim(job);
        },
    };
    return runner;
}

/**
 * The kubernetes gate manager: the second `GateManager`, the way `createKubernetesRunner` is the
 * second `Runner`. The docker manager keeps a warm sleeper container per checkout and `docker
 * exec`s every gate into it; here a gate run IS a Job — the declared image over the workspaces
 * PVC, `workingDir` at the checkout — and the environment is a per-attempt Secret the pod reads
 * by reference. The docker cooldown has no twin and no need of one: docker pays container startup
 * once per cooldown window, kubernetes pays pod admission per run, and pod admission is seconds
 * against test suites that run minutes. The warm-start cost optimization is the one thing the
 * docker machinery has that this does not; every correctness property carries over.
 *
 * Like the runner, this manager is a client of the injected transport and of nothing else — no
 * board, no database, no docker — per the package's zero-dependency rule.
 */
interface GateEntry {
    job: BoardJob;
    image: string;
    envBody: string;
    /** The per-attempt env Secret's name, when the attempt carries env at all. */
    secretName: string | null;
    /** Per-key counter naming each run, so a gate run twice never reuses a Job name. */
    run: number;
}

export function createKubernetesGateManager({
    config,
    request,
    sleep = wait,
    gateTimeoutMs = config.gateTimeoutMs,
}: {
    config: DriverConfig;
    request: K8sRequest;
    sleep?: (ms: number) => Promise<void>;
    gateTimeoutMs?: number;
}): GateManager {
    const entries = new Map<string, GateEntry>();

    /** A harness failure, not a verdict: the same code docker exec's own failures carry. */
    const harness = (message: string): Error => Object.assign(new Error(message), { code: CONTAINER_GONE });

    /** The finished Job goes, on every path — its pod has read the env Secret by then. */
    const reap = (jobName: string): void => {
        void request('DELETE', `${jobPath(config.k8sNamespace, jobName)}?propagationPolicy=Background`).then(
            () => undefined,
            () => undefined,
        );
    };

    return {
        /**
         * Files the attempt context under the checkout key, validates the declared shapes — the
         * same checks docker's `gateEnvArgs` runs before its argv — and creates the attempt's
         * env Secret, so a malformed key, image or env line fails the job at claim, before the
         * agent runs. The Secret is per ATTEMPT (identical env for every run of one attempt),
         * created before any gate Job references it, and reaped at release. A 409 means a
         * previous acquire of this attempt already created it — same name, same values.
         * No container comes up here: the environment exists for exactly as long as each gate run.
         */
        async acquire(key, image, envBody = '', job) {
            if (!job) {
                throw harness('the kubernetes gate manager files gate runs under their job, and no job was given');
            }
            if (!GATE_KEY.test(key)) {
                throw harness(`refusing to run a gate in a checkout key that is not <org>/<uuid>/.worktrees/<uuid>: ${key}`);
            }
            if (!GATE_IMAGE.test(image)) {
                throw harness(`refusing to run a gate in an image that is not a plain image reference: "${image}"`);
            }
            const secretName = envBody ? gateEnvSecretName(job) : null;
            if (secretName) {
                const response = await request('POST', `/api/v1/namespaces/${config.k8sNamespace}/secrets`, {
                    apiVersion: 'v1',
                    kind: 'Secret',
                    type: 'Opaque',
                    metadata: {
                        name: secretName,
                        labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
                    },
                    stringData: envBodyToData(envBody),
                });
                if (response.status >= 300 && response.status !== 409) {
                    throw harness(
                        `creating the gate env secret answered ${response.status}: ${response.body.slice(0, 200)}`,
                    );
                }
            }
            entries.set(key, { job, image, envBody, secretName, run: 0 });
        },

        runGate(key, name, command) {
            const entry = entries.get(key);
            if (!entry) {
                return Promise.reject(harness(`no gate environment for ${key}`));
            }
            const run = (entry.run += 1);
            const { job, image, secretName } = entry;
            const jobName = gateJobName(job, name, run);
            return (async (): Promise<GateRun> => {
                try {
                    const created = await request(
                        'POST',
                        jobsPath(config.k8sNamespace),
                        gateJobSpec(config, job, key, image, name, command, run, secretName, gateTimeoutMs),
                    );
                    if (created.status >= 300) {
                        throw harness(
                            `creating the gate job answered ${created.status}: ${created.body.slice(0, 200)}`,
                        );
                    }

                    /*
                     * Poll to a terminal status. The kubelet's activeDeadlineSeconds guarantees
                     * the Job reaches one; the read of it gets the same bounded patience the
                     * runner's poll has, because an apiserver blink is not a gate verdict.
                     */
                    let succeeded = false;
                    let timedOut = false;
                    let failures = 0;
                    let imageCleared = false;
                    for (;;) {
                        let response: K8sResponse;
                        try {
                            response = await request('GET', jobPath(config.k8sNamespace, jobName));
                        } catch (e) {
                            if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) throw e;
                            await sleep(POLL_MS);
                            continue;
                        }
                        if (response.status === 404) {
                            throw harness(`the gate job ${jobName} no longer exists`);
                        }
                        if (response.status === 429 || response.status >= 500) {
                            if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
                                throw harness(
                                    `reading the gate job answered ${response.status} ` +
                                        `${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`,
                                );
                            }
                            await sleep(POLL_MS);
                            continue;
                        }
                        if (response.status >= 300) {
                            throw harness(
                                `reading the gate job answered ${response.status}: ${response.body.slice(0, 200)}`,
                            );
                        }
                        failures = 0;
                        const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
                        if ((status.succeeded ?? 0) >= 1 || (status.failed ?? 0) >= 1) {
                            succeeded = (status.succeeded ?? 0) >= 1;
                            timedOut = (status.conditions ?? []).some(
                                (condition) => condition.type === 'Failed' && condition.reason === 'DeadlineExceeded',
                            );
                            break;
                        }

                        /*
                         * The one k8s-shaped harness failure worth naming: a declared image the
                         * cluster cannot pull would otherwise burn the full deadline and report
                         * "timeout" over what is really "no such image". Named as soon as the
                         * pod says so; once a pod exists with no blocked container in it, the
                         * image has pulled and the check stops listing.
                         */
                        if (!imageCleared) {
                            const pods = await request(
                                'GET',
                                `${podsPath(config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
                            ).catch(() => ({ status: 0, body: '' }));
                            const pod = parse<K8sPodList>(pods.body).items?.find(
                                (item) => !item.metadata?.deletionTimestamp,
                            );
                            const container = pod?.status?.containerStatuses?.[0];
                            const waiting = container?.state?.waiting;
                            if (waiting?.reason === 'ImagePullBackOff' || waiting?.reason === 'ErrImagePull') {
                                throw harness(
                                    `the gate image "${image}" cannot be pulled: ${waiting.reason}` +
                                        (waiting.message ? ` — ${waiting.message.slice(0, 200)}` : ''),
                                );
                            }
                            // A pod with no container status yet has not reported anything — the
                            // image question is still open, and the check keeps watching.
                            imageCleared = container !== undefined;
                        }
                        await sleep(POLL_MS);
                    }

                    // The pod carries the exit code; succeeded-with-no-pod maps to 0 exactly as
                    // the runner's own verdict read does (one pod, never retried). A list that
                    // answered non-2xx is a harness failure, never a verdict: the runner throws
                    // on the same shape, and a silent "exit 1, empty output" would blame the
                    // command for the API server's answer.
                    const podsResponse = await readGateVerdict(
                        request,
                        sleep,
                        `${podsPath(config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
                        'listing the gate pods',
                    );
                    if (podsResponse.status >= 300) {
                        throw harness(
                            `listing the gate pods answered ${podsResponse.status}: ${podsResponse.body.slice(0, 200)}`,
                        );
                    }
                    const pod = parse<K8sPodList>(podsResponse.body).items?.find(
                        (item) => !item.metadata?.deletionTimestamp,
                    );
                    const exitCode =
                        pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode ?? (succeeded ? 0 : 1);

                    let output = '';
                    if (pod?.metadata?.name) {
                        const log = await request(
                            'GET',
                            `${podsPath(config.k8sNamespace)}/${pod.metadata.name}/log?tailLines=${LOG_TAIL_LINES}`,
                        ).catch(() => ({ status: 0, body: '' }));
                        // Trimmed like the docker manager's exec stdout: a trailing newline is
                        // the command's, not the gate's message.
                        if (log.status < 300) output = reportTail(log.body.trim());
                    }
                    // The docker manager's timeout shape: exit 124, and a named reason when the
                    // gate had nothing to say for itself.
                    return {
                        exitCode: timedOut ? 124 : exitCode,
                        output: timedOut && !output ? `[driver] gate killed after ${gateTimeoutMs}ms` : output,
                    };
                } finally {
                    reap(jobName);
                }
            })();
        },

        /** The attempt's env Secret goes here — every gate run of the attempt has read it by now. */
        release(key) {
            const entry = entries.get(key);
            if (!entry?.secretName) return;
            entries.delete(key);
            void request('DELETE', `/api/v1/namespaces/${config.k8sNamespace}/secrets/${entry.secretName}`).then(
                () => undefined,
                () => undefined,
            );
        },

        /** A drained driver has no more turns coming: whatever the cooldown would have kept is moot. */
        async stop() {
            for (const key of [...entries.keys()]) this.release(key);
        },
    };
}

/**
 * The gate poll's verdict-carrying read: the same bounded patience the runner uses for the reads
 * that decide a run, because reporting a failed gate over an apiserver blink would blame the
 * command for the API server's problem.
 */
async function readGateVerdict(
    request: K8sRequest,
    sleep: (ms: number) => Promise<void>,
    path: string,
    what: string,
): Promise<K8sResponse> {
    let failures = 0;
    for (;;) {
        let response: K8sResponse;
        try {
            response = await request('GET', path);
        } catch (e) {
            if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) throw e;
            await sleep(POLL_MS);
            continue;
        }
        if (response.status !== 429 && response.status < 500) return response;
        if (++failures > POLL_MAX_CONSECUTIVE_FAILURES) {
            throw new Error(`${what} answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`);
        }
        await sleep(POLL_MS);
    }
}
