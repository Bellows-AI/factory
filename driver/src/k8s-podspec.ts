import { JOB_LABEL, LEASE_LABEL } from './labels.js';
import { createHash } from 'node:crypto';
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import {
    GATE_GID,
    GATE_HOME,
    GATE_UID,
    opencodeDbPath,
    runnerClaimEnv,
    runWorkingDir,
    SESSION_ID,
    transcriptDir,
    workspacePathOf,
} from './claim.js';
import { claudeTurnsScript, opencodeReadoutScript } from './container-scripts.js';
import type { RunSession } from './runner.js';
import { JOB_ID, MS_PER_SECOND, TTL_SECONDS } from './k8s-transport.js';
import { GATE_IMAGE, GATE_KEY, worktreeDir } from './publish.js';
import { bellowsReadEnv, bellowsReadScript } from './services.js';
import { OPENCODE } from './executors.js';
import { claudeSystemPromptArgs, opencodeAgentArgs } from './master-prompt.js';

/**
 * The kubernetes executor's pure Job/pod spec builders — the `dockerArgs` analogue for every
 * shape this driver POSTs to the API server: the runner itself, the gate runner, and the
 * `.bellows.yaml` / opencode-session / claude-turns aux readouts. Everything security-relevant
 * about a runner is decided here, and pinned by tests for that reason. The transport, polling,
 * fence and runner assembly live in the sibling `k8s-*.ts` files this one has no dependency on;
 * see docs/kubernetes.md for the full map.
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
                    volumeMounts: { name: string; mountPath: string; subPath: string }[];
                }[];
                volumes: { name: string; persistentVolumeClaim: { claimName: string } }[];
            };
        };
    };
}

/**
 * The volumeMount's `subPath`: the claim's `<orgId>/<userId>` subtree, asserted before it
 * becomes part of any pod spec — the same refusal the docker runner makes before the same value
 * joins its `volume-subpath` (D4 of the mount-scoping design: a malformed `workspacePath` is
 * refused before any container exists, never mounted somewhere unintended). Every workspaces
 * mount this file emits carries it, which is what makes "mounted broader" a shape the spec
 * cannot express: the kubelet fails a pod whose subPath is missing, loudly, rather than falling
 * back to the whole volume.
 */
export const workspaceSubPathOf = (job: BoardJob): string => {
    const path = workspacePathOf(job);
    if (!path) {
        throw new Error(
            `refusing to run job ${job.id}: the board reported no usable workspace path (${job.workspacePath ?? 'null'})`
        );
    }
    return path;
};

/**
 * The board's stacked environment plus every credential the pod carries by reference: the
 * bring-your-own credentials Secret, the claim env + minted gate credentials (the per-attempt
 * Secret `runnerJobSpec`'s caller creates), the telemetry/board URLs, and the runner's own
 * branch-ingest attempt pair. Pulled out of `runnerJobSpec` purely to keep that function's
 * complexity readable — every value here is a NAME or a literal path/URL, never a credential
 * value, the same rule the whole file is pinned on.
 */
function runnerCredentialEnv(config: DriverConfig, job: BoardJob): EnvVar[] {
    const env: EnvVar[] = [];
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
    const secretEnv = { ...runnerClaimEnv(job), ...(job.gateEnv ?? {}) };
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

    // The runner's branch-ingest credential — the attempt it runs for, as a job id + lease
    // token pair. Both are CREDENTIALS (the lease token most of all: it is what makes the pair
    // attempt-scoped), so the names travel in the pod spec and the values ride the per-attempt
    // Secret by reference — never a value here, which anyone who can `get pods` can read.
    env.push(
        { name: 'RUNNER_JOB_ID', valueFrom: { secretKeyRef: { name: secretName(job), key: 'RUNNER_JOB_ID' } } },
        {
            name: 'RUNNER_LEASE_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'RUNNER_LEASE_TOKEN' } },
        }
    );
    return env;
}

/**
 * opencode's own env and argv: headless only, and opencode mints its own session ids — a fresh
 * run is `run <command>` with no session at all, and a follow-up is `run --session <id> <command>`
 * with the session opencode ITSELF created on the earlier run, persisted via XDG_DATA_HOME (the
 * same tree the docker runner's env points at). Restoring a session for anything but a follow-up
 * would deliver nothing into the run and idle it to the deadline; the loop refuses that state
 * first, and this is the runner asserting it too, exactly as dockerArgs does. Pulled out of
 * `runnerJobSpec` purely to keep that function's complexity readable.
 */
function opencodeRunnerPlan(
    config: DriverConfig,
    job: BoardJob,
    session: RunSession | null,
    path: string
): { env: EnvVar[]; args: string[] } {
    if (session && !job.followUp) {
        throw new Error(`refusing to run job ${job.id}: the opencode runner restores a session only for a follow-up`);
    }
    const env: EnvVar[] = [{ name: 'XDG_DATA_HOME', value: `${config.workspaceMount}/${path}/.opencode` }];
    const args = ['run', ...opencodeAgentArgs()];
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
    return { env, args };
}

/**
 * The claude-code argv and env: `--resume` keeps the original session id, and the command is NOT
 * re-delivered — it is already in the transcript. A follow-up is the exception, on this platform
 * exactly as on docker: its command is the new adjustment, and it goes into the restored
 * transcript, last, so a command that looks like a flag is still read as a prompt. Pulled out of
 * `runnerJobSpec` purely to keep that function's complexity readable.
 */
function claudeRunnerPlan(
    config: DriverConfig,
    job: BoardJob,
    session: RunSession | null
): { env: EnvVar[]; args: string[] } {
    if (!session) {
        throw new Error(`refusing to run job ${job.id}: the kubernetes runner runs every job as a session`);
    }
    // The transcript store for claude-code (opencode persists through its own database). The
    // same name the docker argv carries for the same claim, so transcript persistence does not
    // depend on which executor ran the job — the entrypoint redirects CLAUDE_CONFIG_DIR onto the
    // workspaces PVC. A path literal like WORKDIR, never a credential.
    // The session id the reporter claims — asserted above as a safe token before it lands in
    // a spec, the same rule the argv below is held to.
    const env: EnvVar[] = [
        { name: 'FACTORY_TRANSCRIPT_DIR', value: transcriptDir(config, job) },
        { name: 'BELLOWS_SESSION_ID', value: session.id },
    ];
    const deliver = !session.resume || job.followUp;
    const args = [session.resume ? '--resume' : '--session-id', session.id];
    if (config.skipPermissions) args.push('--dangerously-skip-permissions');
    // The board-owned Factory execution context (issue #244) — the docker runner's identical
    // twin, so both platforms make the same provider-specific argv decision.
    args.push(...claudeSystemPromptArgs(job));
    if (deliver) args.push('-p', job.command);
    return { env, args };
}

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
            `refusing to run job ${job.id}: the board reported no usable workspace path (${job.workspacePath ?? 'null'})`
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
            `refusing to run job ${job.id}: the board reported a repo label this driver cannot resolve a task worktree for (${job.repo})`
        );
    }
    const env: EnvVar[] = [{ name: 'WORKDIR', value: runWorkingDir(config, job) }, ...runnerCredentialEnv(config, job)];

    // The argv each CLI speaks, and the executor-specific env beside it (opencode's session
    // database path, or claude-code's transcript store and session id). The docker runner
    // composes the same two shapes in dockerArgs — the ENTRYPOINT of either executor image
    // receives exactly these arguments after the image name, so the platform below the
    // container is the only difference.
    const plan =
        job.executorType === OPENCODE
            ? opencodeRunnerPlan(config, job, session, path)
            : claudeRunnerPlan(config, job, session);
    env.push(...plan.env);
    const args = plan.args;

    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
            // runnerJobName, not containerName(job): the Job's name lands on the pod template as
            // the `job-name` label, and a label value tops out at 63 bytes — the raw form is 85.
            // See runnerJobName for the full constraint.
            name: runnerJobName(job),
            // factory.job is shared by every attempt of the job: it is what `kubectl get jobs -l
            // factory.job=<id>` finds a runner that outlived its driver by, and what the re-claim
            // fence sweeps by. factory.lease is this attempt's alone — the label form of the
            // naming contract that scopes every per-attempt operation to its own objects.
            // app.kubernetes.io/instance scopes bulk cleanup to THIS release: `make stop` and a
            // shared-namespace neighbor must not delete each other's runners.
            labels: {
                [JOB_LABEL]: job.id,
                [LEASE_LABEL]: job.leaseToken,
                ...(config.k8sRelease ? { 'app.kubernetes.io/instance': config.k8sRelease } : {}),
            },
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
            activeDeadlineSeconds: Math.max(1, Math.round(config.jobTimeoutMs / MS_PER_SECOND)),
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: { labels: { [JOB_LABEL]: job.id, [LEASE_LABEL]: job.leaseToken } },
                spec: {
                    restartPolicy: 'Never',
                    // The runner gets no ServiceAccount token: automounting one would hand the
                    // Claude container the driver's own job-creating credentials — the docker
                    // socket riding along with the dashboard, refused here for the same reason.
                    automountServiceAccountToken: false,
                    containers: [
                        {
                            // A constant: a container name is a DNS LABEL (63 bytes), which rules
                            // out containerName(job) (85) the same way it rules the Job's own name
                            // out of the raw form. Nothing addresses the container by name — its
                            // log is read off the pod's labels, its lifecycle by the Job's.
                            name: 'runner',
                            image: executorImage(config, job.executorType),
                            // Stated, never defaulted: kubernetes reads a missing or :latest tag as
                            // `Always` and would reach for a registry, past the image the node
                            // already holds — which is how the docker runner finds it.
                            imagePullPolicy: config.imagePullPolicy,
                            env,
                            args,
                            volumeMounts: [
                                { name: 'workspaces', mountPath: `${config.workspaceMount}/${path}`, subPath: path },
                            ],
                        },
                    ],
                    volumes: [{ name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } }],
                },
            },
        },
    };
}

export const jobsPath = (namespace: string): string => `/apis/batch/v1/namespaces/${namespace}/jobs`;

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
export const secretBody = (job: BoardJob, env: Record<string, string>) => ({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: { name: secretName(job), labels: { [JOB_LABEL]: job.id } },
    stringData: env,
});

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
                /** The uid:gid the gate writes the shared worktree as — GATE_UID/GATE_GID. */
                securityContext?: { runAsUser: number; runAsGroup: number };
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
                    volumeMounts: { name: string; mountPath: string; subPath: string; readOnly?: boolean }[];
                }[];
                volumes: { name: string; persistentVolumeClaim: { claimName: string } }[];
            };
        };
    };
}

/** One aux Job's container — the part every builder below decides for itself. */
type AuxContainer = AuxJobSpec['spec']['template']['spec']['containers'][number];

/** What one aux Job builder supplies beyond the skeleton every one of them shares. */
interface AuxJobSpecInput {
    name: string;
    deadlineSeconds: number;
    container: AuxContainer;
    /** The uid:gid the gate writes the shared worktree as — GATE_UID/GATE_GID. Gate only. */
    securityContext?: { runAsUser: number; runAsGroup: number };
}

/**
 * The skeleton every aux Job builder shares: `factory.job`/`factory.lease` labels (twice — Job
 * and pod template), no ServiceAccount token, `backoffLimit: 0` (the board owns retries, never
 * the kubelet), the finished-Job TTL, and the workspaces PVC as the one named volume. Each
 * builder supplies its own name, deadline and container body — command, env, envFrom,
 * workingDir, volume mounts — which is the part that actually differs and that the spec tests
 * read. `runnerJobSpec` stays separate: its shape is pinned field by field, and sharing a type
 * with the aux Jobs would make "the runner has no envFrom" unreadable.
 */
export function auxJobSpec(config: DriverConfig, job: BoardJob, input: AuxJobSpecInput): AuxJobSpec {
    const labels = { [JOB_LABEL]: job.id, [LEASE_LABEL]: job.leaseToken };
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: input.name, labels },
        spec: {
            backoffLimit: 0,
            completions: 1,
            parallelism: 1,
            activeDeadlineSeconds: input.deadlineSeconds,
            ttlSecondsAfterFinished: TTL_SECONDS,
            template: {
                metadata: { labels },
                spec: {
                    restartPolicy: 'Never',
                    automountServiceAccountToken: false,
                    ...(input.securityContext ? { securityContext: input.securityContext } : {}),
                    containers: [input.container],
                    volumes: [{ name: 'workspaces', persistentVolumeClaim: { claimName: config.workspaceVolume } }],
                },
            },
        },
    };
}

/**
 * One `workspaces` volumeMount, scoped to `subPath` — the subtree every aux Job's container
 * mounts, read-write unless the caller marks it read-only (the `.bellows.yaml` readout's own).
 */
export function workspaceMount(
    config: DriverConfig,
    subPath: string,
    readOnly?: boolean
): { name: 'workspaces'; mountPath: string; subPath: string; readOnly?: boolean } {
    return {
        name: 'workspaces',
        mountPath: `${config.workspaceMount}/${subPath}`,
        subPath,
        ...(readOnly ? { readOnly } : {}),
    };
}

/** Sixteen hex characters naming one attempt-scoped run: readable in `kubectl get jobs`, and — at 64 bits — collision-proof at any real concurrency. Eight characters (32 bits) let two simultaneous attempts collide on one Job name, and the apiserver rejects the loser with AlreadyExists. */
const HASH_HEX_LENGTH = 16;
export const hash16 = (input: string): string =>
    createHash('sha256').update(input).digest('hex').slice(0, HASH_HEX_LENGTH);

/**
 * The raw gate name is repo content, so it never joins a k8s name directly: lowercased, every
 * character outside the DNS-subdomain alphabet folded to `-`, and anything leading rejected.
 * Uniqueness across runs of the same gate comes from the hash beside it, not from the
 * sanitization being invertible — it is not, and must not need to be.
 */
/** A k8s name part's own budget within the 253-byte object-name ceiling, once joined with the rest. */
const NAME_PART_MAX_LENGTH = 100;

const sanitizeNamePart = (value: string): string =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-')
        .replace(/^[^a-z0-9]+/, '')
        .slice(0, NAME_PART_MAX_LENGTH);

/** One gate run's Job name. The run counter keeps a second ad-hoc call of the same gate off the first's name. */
export const gateJobName = (job: BoardJob, gateName: string, run: number): string =>
    `factory-gate-${sanitizeNamePart(gateName)}-${hash16(`${job.id}|${job.leaseToken}|${gateName}|${run}`)}`;

/**
 * The gated attempt's Secret carrying the gate environment. Per ATTEMPT, not per run — the env
 * is the claim's stacked resolution and is identical for every gate run of the attempt, so one
 * Secret created at acquire serves them all, and a driver crash leaks at most one, the same
 * accepted-leak posture (and the same `factory.job` cleanup label) the runner's env Secret has.
 */
export const gateEnvSecretName = (job: BoardJob): string => `factory-gate-${hash16(`${job.id}|${job.leaseToken}`)}-env`;

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
interface GateJobSpecInput {
    key: string;
    image: string;
    gateName: string;
    command: string;
    run: number;
    envSecretName: string | null;
    gateTimeoutMs: number;
}

export function gateJobSpec(config: DriverConfig, job: BoardJob, gate: GateJobSpecInput): AuxJobSpec {
    const { key, image, gateName, command, run, envSecretName, gateTimeoutMs } = gate;
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
    // The mount is scoped to the checkout key's own `<orgId>/<userId>` half — the same subtree
    // the job's runner mounts. Both segments are asserted by GATE_KEY before the split.
    const subPath = key.split('/').slice(0, 2).join('/');
    return auxJobSpec(config, job, {
        name: jobName,
        deadlineSeconds: Math.max(1, Math.round(gateTimeoutMs / MS_PER_SECOND)),
        // The gate writes the shared task worktree, so it writes as the same uid:gid every
        // other writer on that tree uses — the executor images' `USER node` (uid 1000), which
        // the sync, reclaim and runner Jobs run as. The declared image's own default (root,
        // usually) would leave gate-written files the uid-1000 reclaim can never remove, and the
        // tree would stick for every later turn of the thread (observed 2026-09-13 on the docker
        // twin). HOME moves to /tmp with the uid: the image's own HOME (/root) is unwritable for
        // a non-root uid, and a gate that npm-installs needs a writable cache directory.
        securityContext: { runAsUser: GATE_UID, runAsGroup: GATE_GID },
        container: {
            // A container name is a 63-char DNS label — the Job name's roomy subdomain bound
            // does not apply to it, so the short hash stands in.
            name: `gate-${hash16(`${jobName}|${command}`)}`,
            image,
            imagePullPolicy: config.imagePullPolicy,
            command: ['sh', '-c', command],
            workingDir: `${config.workspaceMount}/${key}`,
            env: [{ name: 'HOME', value: GATE_HOME }],
            ...(envSecretName ? { envFrom: [{ secretRef: { name: envSecretName } }] } : {}),
            volumeMounts: [workspaceMount(config, subPath)],
        },
    });
}

/**
 * The env-file body becomes Secret stringData. Lines were written by `envFileBody` on this
 * side and are re-asserted here line by line, because this function is the one place the body
 * becomes cluster objects: a line without a `=`, or a name outside what a Secret key may hold,
 * is a bug or a forged claim, and both must fail loud rather than start a gate with half an env.
 */
/** How much of a rejected env line rides the refusal message — a preview, not the whole line. */
const ENV_LINE_PREVIEW_CHARS = 64;

export const envBodyToData = (body: string): Record<string, string> => {
    const data: Record<string, string> = Object.create(null);
    for (const line of body.split('\n')) {
        if (!line) continue;
        const eq = line.indexOf('=');
        const name = eq > 0 ? line.slice(0, eq) : '';
        if (!name || !/^[-._a-zA-Z0-9]+$/.test(name)) {
            throw new Error(
                `refusing to build a gate env Secret: "${line.slice(0, ENV_LINE_PREVIEW_CHARS)}" is not a NAME=value line`
            );
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

const bellowsJobName = (job: BoardJob): string => `factory-bellows-${hash16(`${job.id}|${job.leaseToken}`)}`;

/**
 * The runner Job's name, hashed like the readout's rather than `containerName(job)`'s raw
 * `<id>-<lease token>`: the apiserver carries the Job's name onto the pod template as the
 * `job-name` label, and a LABEL VALUE is capped at 63 bytes — the raw form is 85, and the
 * create answers 422. A DNS subdomain would take it; the label does not, and the label wins.
 * The hash keys on the same pair the raw form spelled out — job id and lease token — so the
 * name stays attempt-scoped: a reclaimed job's replacement attempt gets a different name, and
 * nothing a superseded attempt deletes by name can reach the winner's Job. Distinct prefix from
 * `bellowsJobName`, whose hash key is the same pair — one attempt's readout and runner must not
 * collide. Addressing is by label everywhere it can be (the fence's sweep, the pod log); the
 * name is only ever spoken by this process, which minted it.
 */
export const runnerJobName = (job: BoardJob): string => `factory-runner-${hash16(`${job.id}|${job.leaseToken}`)}`;

/**
 * The runner's own Job name, re-asserting `job.id` is a uuid before it lands in an API path — the
 * board is not something this process trusts with a fragment of a path, copied from docker.ts,
 * which asserts the same thing before a `docker run`.
 */
export const runnerName = (job: BoardJob): string => {
    if (!JOB_ID.test(job.id)) {
        throw new Error(`refusing to address a job id that is not a uuid: ${job.id}`);
    }
    return runnerJobName(job);
};

export function bellowsJobSpec(config: DriverConfig, job: BoardJob): AuxJobSpec {
    if (!job.workspacePath || !WORKSPACE_PATH.test(job.workspacePath)) {
        throw new Error(
            `refusing to read .bellows.yaml for job ${job.id}: ` +
                `the board reported no usable workspace path (${job.workspacePath ?? 'null'})`
        );
    }
    return auxJobSpec(config, job, {
        name: bellowsJobName(job),
        deadlineSeconds: BELLOWS_READ_DEADLINE_SECONDS,
        container: {
            name: 'bellows-read',
            image: executorImage(config, job.executorType),
            imagePullPolicy: config.imagePullPolicy,
            command: ['sh', '-c', bellowsReadScript],
            // The readout's parameters as literal env values — a path and two constants shared
            // with the splitter, never a credential (the same justification the sync's
            // REPO/WORKTREE/BRANCH literals give).
            env: Object.entries(bellowsReadEnv(config, job)).map(([name, value]) => ({ name, value })),
            volumeMounts: [workspaceMount(config, workspaceSubPathOf(job), true)],
        },
    });
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
    `factory-ocread-${hash16(`${job.id}|${job.leaseToken}`)}`;

/**
 * The close-time claude-code turn count under kubernetes: the same script docker runs
 * (claude-turns.cjs, passed by content), as one aux Job over the PVC — the twin of the
 * opencode readout above, reading the transcript the CLI wrote onto the volume under
 * FACTORY_TRANSCRIPT_DIR while the runner lived. The mount needs no WAL recovery, but it rides
 * the same read-write shape for one reason: there is exactly one close-time readout shape per
 * executor, and two variants of it would be two shapes to keep coherent. A Job that fails or
 * overspends its deadline answers through the caller's null contract — unmeasured, never zero.
 */
export const claudeTurnsJobName = (job: BoardJob): string => `factory-cturns-${hash16(`${job.id}|${job.leaseToken}`)}`;

export function claudeTurnsJobSpec(
    config: DriverConfig,
    job: BoardJob,
    sessionId: string,
    startedAt: string
): AuxJobSpec {
    if (!JOB_ID.test(sessionId)) {
        throw new Error(`refusing to count turns for job ${job.id}: not a session id: ${sessionId}`);
    }
    return auxJobSpec(config, job, {
        name: claudeTurnsJobName(job),
        deadlineSeconds: OPENCODE_READOUT_DEADLINE_SECONDS,
        container: {
            name: 'claude-turns',
            image: executorImage(config, job.executorType),
            imagePullPolicy: config.imagePullPolicy,
            command: ['node', '-e', claudeTurnsScript],
            // Both travel as env VALUES — the script is static, so nothing board-derived is
            // ever part of its text.
            env: [
                { name: 'CLAUDE_TRANSCRIPT_DIR', value: transcriptDir(config, job) },
                { name: 'CLAUDE_SESSION_ID', value: sessionId },
                // The per-run delta bound, exactly as docker passes it.
                { name: 'RUN_STARTED_AT', value: startedAt },
            ],
            volumeMounts: [workspaceMount(config, workspaceSubPathOf(job))],
        },
    });
}

export function opencodeReadoutJobSpec(config: DriverConfig, job: BoardJob, startedAt: string): AuxJobSpec {
    if (!job.workspacePath || !WORKSPACE_PATH.test(job.workspacePath)) {
        throw new Error(
            `refusing to read the opencode session database for job ${job.id}: ` +
                `the board reported no usable workspace path (${job.workspacePath ?? 'null'})`
        );
    }
    return auxJobSpec(config, job, {
        name: opencodeReadoutJobName(job),
        deadlineSeconds: OPENCODE_READOUT_DEADLINE_SECONDS,
        container: {
            name: 'opencode-readout',
            image: executorImage(config, job.executorType),
            imagePullPolicy: config.imagePullPolicy,
            command: ['node', '-e', opencodeReadoutScript],
            // Both travel as env VALUES — the script is static, so nothing board-derived is
            // ever part of its text. The directory scope is the run's own working directory
            // (the same string opencode records on the session), because the database is per
            // MEMBER: without it, two concurrent tasks of one member scrape each other's runs.
            env: [
                { name: 'OPENCODE_DB', value: opencodeDbPath(config, job) },
                { name: 'OPENCODE_DIR', value: runWorkingDir(config, job) },
                // The per-run delta bound, exactly as docker passes it: a follow-up resumes the
                // root conversation, and only the cycles this run wrote may count as its turns.
                { name: 'RUN_STARTED_MS', value: String(Date.parse(startedAt)) },
            ],
            volumeMounts: [workspaceMount(config, workspaceSubPathOf(job))],
        },
    });
}
