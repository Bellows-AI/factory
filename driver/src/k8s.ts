import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { containerName, OUTPUT_LIMIT, reportTail, workspacePathOf } from './docker.js';
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
 * - The driver's zero-dependency rule holds: four API calls (create/get/delete a Job, read a pod's
 *   log) do not justify a client library with its transitive tree, and `node:https` is what carries
 *   the cluster CA without hoping an env var pointed Node at it.
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
 * How long create() will wait for a deleted leftover Job to actually vanish — about five minutes
 * at POLL_MS, the same patience the status poll has. The 404 that ends the wait is what frees the
 * Job's name for the replacement; exceeding the bound is a throw, which leaves the job to its
 * lease — burning an attempt is the alternative to two writers on one checkout.
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

    // The argv the docker runner puts after the image name, unchanged: the executor image's
    // ENTRYPOINT is the same claude wrapper, so the platform below the container is the only
    // difference. `--resume` keeps the original session id, and the command is NOT re-delivered —
    // it is already in the transcript.
    const args: string[] = [session.resume ? '--resume' : '--session-id', session.id];
    if (config.skipPermissions) args.push('--dangerously-skip-permissions');
    if (!session.resume) args.push('-p', job.command);

    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
            name: containerName(job),
            labels: { 'factory.job': job.id },
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
                metadata: { labels: { 'factory.job': job.id } },
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

    const create = async (job: BoardJob, spec: RunnerJobSpec): Promise<void> => {
        const post = async (): Promise<K8sResponse> => request('POST', jobsPath(config.k8sNamespace), spec);
        let response = await post();
        if (response.status === 409) {
            /*
             * A job id is only reused when a lease expired and the row was reclaimed — so a 409
             * means the previous attempt's Job object is still there. Replace it: this run is the
             * live one, and two writers on one checkout is the thing actually worth preventing
             * (docs/jobs.md).
             *
             * The fence is the 404, not the delete's response. A Foreground DELETE answers once
             * the deletion is marked; the name stays reserved until the garbage collector has torn
             * the old pods down — tens of seconds of termination grace. Re-POSTing at once would
             * 409 again, burn the attempt and leave the job one try from dead. So the delete is
             * awaited: GET until the object is really gone, bounded, then create — which is also
             * the property worth having, since the replacement then cannot schedule onto a
             * checkout somebody is still writing. The closest kubernetes gets to `docker kill`.
             */
            const removed = await request(
                'DELETE',
                `${jobPath(config.k8sNamespace, name(job))}?propagationPolicy=Foreground`,
            );
            if (removed.status >= 300 && removed.status !== 404) {
                throw new Error(`deleting the leftover runner answered ${removed.status}: ${removed.body.slice(0, 200)}`);
            }
            let waits = 0;
            for (;;) {
                let probe: K8sResponse;
                try {
                    probe = await request('GET', jobPath(config.k8sNamespace, name(job)));
                } catch {
                    // A transport failure says nothing about whether the object is gone; keep
                    // polling within the same bound.
                    probe = { status: 0, body: '' };
                }
                if (probe.status === 404) break;
                if (++waits > REPLACE_MAX_POLLS) {
                    throw new Error(
                        `the leftover runner job ${name(job)} never disappeared after its delete ` +
                            `(${REPLACE_MAX_POLLS} polls)`,
                    );
                }
                await sleep(POLL_MS);
            }
            response = await post();
        }
        if (response.status >= 300) {
            throw new Error(
                `creating the runner job answered ${response.status}: ${response.body.slice(0, 200)}`,
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

    return {
        // Remote Control is refused at config under this executor, and the loop polls the remote id
        // only under Remote Control — so null is never even asked for. The interface blesses it.
        async remoteSessionId() {
            return null;
        },

        // The same contract as `docker kill ... .catch(() => undefined)`: a kill that finds nothing
        // is the ordinary end of a finished run, and one that fails is the kubelet's deadline doing
        // this function's work.
        async kill(job) {
            await request(
                'DELETE',
                `${jobPath(config.k8sNamespace, name(job))}?propagationPolicy=Background`,
            ).catch(() => undefined);
        },

        async run(job, session): Promise<RunOutcome> {
            // The kubernetes runner speaks claude-code only, like its RunnerJobSpec: a null session
            // is an opencode job, which this executor does not carry. Mirrors the docker runner's
            // own refusal of a sessionless claude-code run.
            if (!session) {
                throw new Error(`refusing to run job ${job.id}: the kubernetes runner runs every job as a session`);
            }
            await create(job, runnerJobSpec(config, job, session));

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

            return { exitCode, output, timedOut, idled: false };
        },
    };
}
