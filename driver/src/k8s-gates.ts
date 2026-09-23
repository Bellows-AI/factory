import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { reportTail } from './runner.js';
import { CONTAINER_GONE } from './exec-codes.js';
import type { GateManager, GateRun } from './gates.js';
import { deleteJob, deleteSecret, jobPath, jobPodsPath, podLogPath } from './k8s-auxspec.js';
import { readVerdict } from './k8s-poll.js';
import { envBodyToData, gateEnvSecretName, gateJobName, gateJobSpec, jobsPath } from './k8s-podspec.js';
import { GATE_IMAGE, GATE_KEY } from './publish.js';
import {
    ERROR_PREVIEW_CHARS,
    HTTP_CONFLICT,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_SERVER_ERROR_STATUS,
    HTTP_TOO_MANY_REQUESTS,
    livePod,
    parse,
    POLL_MAX_CONSECUTIVE_FAILURES,
    POLL_MS,
    TIMEOUT_EXIT_CODE,
    wait,
} from './k8s-transport.js';
import type { K8sDeps, K8sJobStatus, K8sRequest, K8sResponse } from './k8s-transport.js';

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

/** A harness failure, not a verdict: the same code docker exec's own failures carry. */
const gateHarness = (message: string): Error => Object.assign(new Error(message), { code: CONTAINER_GONE });

/**
 * The attempt's env Secret, created before any gate Job references it. A 409 means a previous
 * acquire of this same attempt already created it — same name, same values — so only any OTHER
 * failure status is worth failing the acquire over. Pulled out of `acquire` purely to keep that
 * method's complexity readable.
 */
async function createGateEnvSecret(deps: K8sDeps, job: BoardJob, secretName: string, envBody: string): Promise<void> {
    const response = await deps.request('POST', `/api/v1/namespaces/${deps.config.k8sNamespace}/secrets`, {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'Opaque',
        metadata: {
            name: secretName,
            labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
        },
        stringData: envBodyToData(envBody),
    });
    if (response.status >= HTTP_ERROR_STATUS && response.status !== HTTP_CONFLICT) {
        throw gateHarness(
            `creating the gate env secret answered ${response.status}: ${response.body.slice(0, ERROR_PREVIEW_CHARS)}`
        );
    }
}

/**
 * The one k8s-shaped harness failure worth naming: a declared image the cluster cannot pull would
 * otherwise burn the full deadline and report "timeout" over what is really "no such image".
 * Named as soon as the pod says so; once a pod exists with no blocked container in it, the image
 * has pulled and the caller stops calling this. Pulled out of the poll below purely to keep that
 * function's complexity readable.
 */
async function checkGateImagePullable(deps: K8sDeps, jobName: string, image: string): Promise<boolean> {
    const pods = await deps
        .request('GET', jobPodsPath(deps.config.k8sNamespace, jobName))
        .catch(() => ({ status: 0, body: '' }));
    const pod = livePod(pods.body);
    const container = pod?.status?.containerStatuses?.[0];
    const waiting = container?.state?.waiting;
    if (waiting?.reason === 'ImagePullBackOff' || waiting?.reason === 'ErrImagePull') {
        throw gateHarness(
            `the gate image "${image}" cannot be pulled: ${waiting.reason}` +
                (waiting.message ? ` — ${waiting.message.slice(0, ERROR_PREVIEW_CHARS)}` : '')
        );
    }
    // A pod with no container status yet has not reported anything — the image question is
    // still open, and the caller keeps watching.
    return container !== undefined;
}

/** One gate Job status read's answer: retry (transport hiccup or 429/5xx within budget), still running, or terminal. */
type GateJobPoll =
    | { kind: 'retry' }
    | { kind: 'pending' }
    | { kind: 'terminal'; succeeded: boolean; timedOut: boolean };

/** Bumps the shared failure counter and throws `buildError()` once the bound is spent — otherwise answers `'retry'`. */
function retryOrThrow(failures: { count: number }, buildError: () => Error): 'retry' {
    if (++failures.count > POLL_MAX_CONSECUTIVE_FAILURES) throw buildError();
    return 'retry';
}

/** The terminal `GateJobPoll` a status body carries, once its Job has succeeded or failed. */
function gateJobTerminal(status: K8sJobStatus): { kind: 'terminal'; succeeded: boolean; timedOut: boolean } {
    const succeeded = (status.succeeded ?? 0) >= 1;
    const timedOut = (status.conditions ?? []).some(
        (condition) => condition.type === 'Failed' && condition.reason === 'DeadlineExceeded'
    );
    return { kind: 'terminal', succeeded, timedOut };
}

/**
 * One read of the gate Job's status, translated to a `GateJobPoll` — pulled out of
 * `pollGateJobToTerminal` purely to keep that function's complexity readable: the loop it wraps
 * no longer nests every status branch inside its own `for(;;)`.
 */
async function readGateJobStatus(deps: K8sDeps, jobName: string, failures: { count: number }): Promise<GateJobPoll> {
    let response: K8sResponse;
    try {
        response = await deps.request('GET', jobPath(deps.config.k8sNamespace, jobName));
    } catch (e) {
        return { kind: retryOrThrow(failures, () => gateHarness((e as Error).message)) };
    }
    if (response.status === HTTP_NOT_FOUND) {
        throw gateHarness(`the gate job ${jobName} no longer exists`);
    }
    if (response.status === HTTP_TOO_MANY_REQUESTS || response.status >= HTTP_SERVER_ERROR_STATUS) {
        return {
            kind: retryOrThrow(failures, () =>
                gateHarness(
                    `reading the gate job answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`
                )
            ),
        };
    }
    if (response.status >= HTTP_ERROR_STATUS) {
        throw gateHarness(
            `reading the gate job answered ${response.status}: ${response.body.slice(0, ERROR_PREVIEW_CHARS)}`
        );
    }
    failures.count = 0;
    const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
    if ((status.succeeded ?? 0) >= 1 || (status.failed ?? 0) >= 1) return gateJobTerminal(status);
    return { kind: 'pending' };
}

/**
 * Poll the gate Job to a terminal status. The kubelet's activeDeadlineSeconds guarantees the Job
 * reaches one; the read of it gets the same bounded patience the runner's poll has, because an
 * apiserver blink is not a gate verdict. Pulled out of `runGate` purely to keep that method's
 * complexity readable.
 */
async function pollGateJobToTerminal(
    deps: K8sDeps,
    jobName: string,
    image: string
): Promise<{ succeeded: boolean; timedOut: boolean }> {
    const failures = { count: 0 };
    let imageCleared = false;
    for (;;) {
        const result = await readGateJobStatus(deps, jobName, failures);
        if (result.kind === 'terminal') return { succeeded: result.succeeded, timedOut: result.timedOut };
        if (result.kind === 'pending' && !imageCleared) {
            imageCleared = await checkGateImagePullable(deps, jobName, image);
        }
        await deps.sleep(POLL_MS);
    }
}

/**
 * The pod carries the exit code; succeeded-with-no-pod maps to 0 exactly as the runner's own
 * verdict read does (one pod, never retried). A list that answered non-2xx is a harness failure,
 * never a verdict: the runner throws on the same shape, and a silent "exit 1, empty output" would
 * blame the command for the API server's answer. Pulled out of `runGate` purely to keep that
 * method's complexity readable.
 */
async function readGateJobResult(
    deps: K8sDeps,
    jobName: string,
    succeeded: boolean
): Promise<{ exitCode: number; output: string }> {
    let podsResponse: K8sResponse;
    try {
        podsResponse = await readVerdict(deps, jobPodsPath(deps.config.k8sNamespace, jobName), 'listing the gate pods');
    } catch (e) {
        throw gateHarness((e as Error).message);
    }
    if (podsResponse.status >= HTTP_ERROR_STATUS) {
        throw gateHarness(
            `listing the gate pods answered ${podsResponse.status}: ${podsResponse.body.slice(0, ERROR_PREVIEW_CHARS)}`
        );
    }
    const pod = livePod(podsResponse.body);
    const exitCode = pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode ?? (succeeded ? 0 : 1);
    let output = '';
    if (pod?.metadata?.name) {
        const log = await deps
            .request('GET', podLogPath(deps.config.k8sNamespace, pod.metadata.name))
            .catch(() => ({ status: 0, body: '' }));
        // Trimmed like the docker manager's exec stdout: a trailing newline is the command's,
        // not the gate's message.
        if (log.status < HTTP_ERROR_STATUS) output = reportTail(log.body.trim());
    }
    return { exitCode, output };
}

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
    const deps: K8sDeps = { config, request, sleep };
    const entries = new Map<string, GateEntry>();

    /** The finished Job goes, on every path — its pod has read the env Secret by then. */
    const reap = (jobName: string): void => {
        void deleteJob(deps, jobName);
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
                throw gateHarness('the kubernetes gate manager files gate runs under their job, and no job was given');
            }
            if (!GATE_KEY.test(key)) {
                throw gateHarness(
                    `refusing to run a gate in a checkout key that is not <org>/<uuid>/.worktrees/<uuid>: ${key}`
                );
            }
            if (!GATE_IMAGE.test(image)) {
                throw gateHarness(`refusing to run a gate in an image that is not a plain image reference: "${image}"`);
            }
            const secretName = envBody ? gateEnvSecretName(job) : null;
            if (secretName) await createGateEnvSecret(deps, job, secretName, envBody);
            // A re-acquire of the SAME attempt — the loop's per-gate re-acquire (issue #78) —
            // keeps the run counter, so a run never lands on a name a previous run of that gate
            // already used (the reaped Job can still exist when the create lands). A different
            // attempt starts at 0: names already differ across attempts through the lease token.
            const prev = entries.get(key);
            const run = prev && prev.job.id === job.id && prev.job.leaseToken === job.leaseToken ? prev.run : 0;
            entries.set(key, { job, image, envBody, secretName, run });
        },

        runGate(key, name, command) {
            const entry = entries.get(key);
            if (!entry) {
                return Promise.reject(gateHarness(`no gate environment for ${key}`));
            }
            const run = (entry.run += 1);
            const { job, image, secretName } = entry;
            const jobName = gateJobName(job, name, run);
            return (async (): Promise<GateRun> => {
                try {
                    const created = await request(
                        'POST',
                        jobsPath(config.k8sNamespace),
                        gateJobSpec(config, job, {
                            key,
                            image,
                            gateName: name,
                            command,
                            run,
                            envSecretName: secretName,
                            gateTimeoutMs,
                        })
                    );
                    if (created.status >= HTTP_ERROR_STATUS) {
                        throw gateHarness(
                            `creating the gate job answered ${created.status}: ${created.body.slice(0, ERROR_PREVIEW_CHARS)}`
                        );
                    }

                    const { succeeded, timedOut } = await pollGateJobToTerminal(deps, jobName, image);
                    const { exitCode, output } = await readGateJobResult(deps, jobName, succeeded);

                    // The docker manager's timeout shape: exit 124, and a named reason when the
                    // gate had nothing to say for itself.
                    return {
                        exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
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
            void deleteSecret(deps, entry.secretName);
        },

        /** A drained driver has no more turns coming: whatever the cooldown would have kept is moot. */
        async stop() {
            for (const key of [...entries.keys()]) this.release(key);
        },
    };
}
