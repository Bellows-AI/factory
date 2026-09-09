import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { claimEnv, containerName, OUTPUT_LIMIT, reportTail, workspacePathOf } from './docker.js';
import type { RunOutcome, RunSession, Runner } from './docker.js';

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
export function runnerJobSpec(config: DriverConfig, job: BoardJob, session: RunSession): RunnerJobSpec {
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
    const env: EnvVar[] = [{ name: 'WORKDIR', value: `${config.workspaceMount}/${path}` }];
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
    // The board's stacked environment, same discipline: names in the pod spec, values in the
    // per-attempt Secret (created before the Job — see create()). claimEnv has already dropped the
    // reserved names, so WORKDIR stays the one literal here. NOT optional: this driver created
    // this exact Secret moments earlier under this attempt's own lease token, so a missing key is
    // a bug and must fail loud (CreateContainerConfigError) rather than start the pod silently
    // without its env.
    for (const name of Object.keys(claimEnv(job))) {
        env.push({ name, valueFrom: { secretKeyRef: { name: secretName(job), key: name } } });
    }

    // The argv the docker runner puts after the image name, unchanged: the executor image's
    // ENTRYPOINT is the same claude wrapper, so the platform below the container is the only
    // difference. `--resume` keeps the original session id, and the command is NOT re-delivered —
    // it is already in the transcript. A follow-up is the exception, on this platform exactly as
    // on docker: its command is the new adjustment, and it goes into the restored transcript.
    const deliver = !session.resume || job.followUp;
    const args: string[] = [session.resume ? '--resume' : '--session-id', session.id];
    if (config.skipPermissions) args.push('--dangerously-skip-permissions');
    if (deliver) args.push('-p', job.command);

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
    items?: { metadata?: { name?: string; deletionTimestamp?: string }; status?: { containerStatuses?: { state?: { terminated?: { exitCode?: number } } }[] } }[];
}

/** Parses what the API server answers; a body that is not JSON reads as an empty object. */
function parse<T>(body: string): T {
    try {
        return JSON.parse(body) as T;
    } catch {
        return {} as T;
    }
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

    /** Only a job that carries env ever touches the per-job Secret — not even to delete one. */
    const forgetSecretIfAny = (job: BoardJob): Promise<void> =>
        Object.keys(claimEnv(job)).length ? forgetSecret(job) : Promise.resolve();

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

    const create = async (job: BoardJob, spec: RunnerJobSpec, cleanup: RunCleanup): Promise<void> => {
        const env = claimEnv(job);

        /*
         * The re-claim fence, step one: TAKE THE CHECKOUT. One POST per round, arbitrated by the
         * apiserver's name uniqueness — the atomic mutex the old GET-then-POST label fence could
         * only approximate. Two attempts can no longer both observe a free checkout and both
         * create: the second POST answers 409 and reads who won.
         */
        await acquireClaim(job);

        /*
         * Step two: the sweep — the janitor that enforces the takeover. Every Job the
         * `factory.job=<id>` selector answers is a leftover of the attempts this claim was taken
         * FROM: deleted BY NAME, per object, with Foreground propagation, until the selector
         * answers nothing and this attempt's Job is the only possible writer on the checkout. No
         * timestamps, no cutoffs, no clocks: an age filter was unsound in both directions, so the
         * sweep classifies nothing. It is safe to sweep "everything" exactly because the claim is
         * held: whoever the Jobs belonged to, the board has superseded them — and this attempt's
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
            let probe: K8sResponse;
            try {
                probe = await request('GET', jobsSelectorPath(config.k8sNamespace, job));
            } catch {
                // A transport failure says nothing about whether the objects are gone; keep
                // polling within the same bound.
                probe = { status: 0, body: '' };
            }
            // Nothing answers the selector at all — nothing to fence.
            if (probe.status === 404) break;
            if (probe.status >= 200 && probe.status < 300) {
                const items = parse<{ items?: { metadata?: { name?: string } }[] }>(probe.body).items ?? [];
                const names: string[] = [];
                for (const item of items) {
                    if (item.metadata?.name) names.push(item.metadata.name);
                }
                // The selector answers nothing — the checkout is free.
                if (names.length === 0) break;
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
                for (const leftover of names) {
                    const response = await request(
                        'DELETE',
                        `${jobPath(config.k8sNamespace, leftover)}?propagationPolicy=Foreground`,
                    );
                    // A 404 is the ordinary end of an object another fence got to first; a 409
                    // is a concurrent replacement's fence deleting the same object. Both mean
                    // the object is being removed. Anything else fails loud, as ever.
                    if (response.status >= 300 && response.status !== 404 && response.status !== 409) {
                        throw new Error(
                            `deleting the leftover runners answered ${response.status}: ${response.body.slice(0, 200)}`,
                        );
                    }
                    if (response.status < 300) deleted += 1;
                }
                // Every delete came back 404/409 — another fence removed them already.
                if (deleted === 0) break;
            }
            if (++waits > REPLACE_MAX_POLLS) {
                throw new Error(
                    `the leftover runner jobs of job ${job.id} never disappeared after their delete ` +
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

        // Step five: this attempt's Job, under its own attempt-scoped name.
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

    const runner = {
        // Remote Control is refused at config under this executor, and the loop polls the remote id
        // only under Remote Control — so null is never even asked for. The interface blesses it.
        async remoteSessionId() {
            return null;
        },

        // No vitals here: `docker stats` has no kubernetes twin, and a pod's metrics come from the
        // metrics-server the cluster may not run. The dashboard renders nothing rather than a
        // wrong number, the same way gates are refused here rather than skipped.
        async sampleRuntime() {
            return null;
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
        },

        // The kubernetes runner speaks claude-code only, like its RunnerJobSpec: a null session
        // is an opencode job, which this executor does not carry. Mirrors the docker runner's
        // own refusal of a sessionless claude-code run.
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
            // The kubernetes runner speaks claude-code only, like its RunnerJobSpec: a null session
            // is an opencode job, which this executor does not carry. Mirrors the docker runner's
            // own refusal of a sessionless claude-code run.
            if (!session) {
                throw new Error(`refusing to run job ${job.id}: the kubernetes runner runs every job as a session`);
            }
            await create(job, runnerJobSpec(config, job, session), cleanup);

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
            return { exitCode, output, timedOut, idled: false, started: true };
        },
    };
    return runner;
}
