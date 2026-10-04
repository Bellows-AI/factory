import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { reportTail } from './runner.js';
import { CONTAINER_GONE } from './exec-codes.js';
import { keyQueue } from './gates.js';
import type { GateManager, GateRun } from './gates.js';
import { deleteJob, deleteSecret, secretsPath } from './k8s-auxspec.js';
import { readImagePullStatus, readJobPodVerdict, readJobStatus, timedOutOf, unpullableImage } from './k8s-poll.js';
import type { JobStatusResult } from './k8s-poll.js';
import { envBodyToData, gateEnvSecretName, gateJobName, gateJobSpec, jobsPath, secretBody } from './k8s-podspec.js';
import { GATE_IMAGE, GATE_KEY } from './publish.js';
import { HTTP_CONFLICT, POLL_MS, refusal, TIMEOUT_EXIT_CODE, wait } from './k8s-transport.js';
import type { K8sDeps, K8sRequest } from './k8s-transport.js';

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
    const response = await deps.request(
        'POST',
        secretsPath(deps.config.k8sNamespace),
        secretBody(job, secretName, envBodyToData(envBody))
    );
    // HTTP_CONFLICT is the tolerated one — `refusal`'s third argument is exactly this case.
    const refused = refusal(response, 'creating the gate env secret', HTTP_CONFLICT);
    if (refused) throw gateHarness(refused);
}

/** A cancelled gate's Job is already being deleted; there is no verdict left to wait for. */
function throwIfCancelled(signal: AbortSignal | undefined, jobName: string): void {
    if (signal?.aborted) throw gateHarness(`the gate job ${jobName} was cancelled`);
}

/**
 * Poll the gate Job to a terminal status. The kubelet's activeDeadlineSeconds guarantees the Job
 * reaches one; the read of it gets the same bounded patience every verdict-carrying read shares
 * (`readJobStatus`, the same core the runner and aux polls share), because an apiserver blink is
 * not a gate verdict — every give-up shape it can answer becomes a `gateHarness` failure here.
 * While the Job is pending, the poll also watches for a declared image the cluster cannot pull —
 * the one k8s-shaped harness failure worth naming, through the same `readImagePullStatus` the
 * runner and aux polls use (issue #302): naming it beats burning the full deadline and reporting
 * "timeout" over what is really "no such image".
 */
async function pollGateJobToTerminal(
    deps: K8sDeps,
    jobName: string,
    image: string,
    signal: AbortSignal | undefined
): Promise<{ succeeded: boolean; timedOut: boolean }> {
    let imageCleared = false;
    for (;;) {
        throwIfCancelled(signal, jobName);
        let result: JobStatusResult;
        try {
            result = await readJobStatus(deps, jobName, 'reading the gate job');
        } catch (e) {
            throw gateHarness((e as Error).message);
        }
        if (result.kind === 'notFound') throw gateHarness(`the gate job ${jobName} no longer exists`);
        if (result.kind === 'error') throw gateHarness(refusal(result, 'reading the gate job')!);
        if (result.kind === 'terminal') {
            return { succeeded: result.outcome === 'succeeded', timedOut: timedOutOf(result.status) };
        }
        if (!imageCleared) {
            const pull = await readImagePullStatus(deps, jobName);
            if (pull.blocked) throw gateHarness(unpullableImage('gate', image, pull.blocked));
            imageCleared = pull.containerSeen;
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
    let verdict: { exitCode: number | null; output: string };
    try {
        verdict = await readJobPodVerdict(deps, jobName, succeeded, 'listing the gate pods');
    } catch (e) {
        throw gateHarness((e as Error).message);
    }
    // The gate verdict needs a NUMBER, unlike the aux/runner null contract: no pod and no
    // success is exit 1, never "no verdict". Trimmed like the docker manager's exec stdout: a
    // trailing newline is the command's, not the gate's message.
    return { exitCode: verdict.exitCode ?? 1, output: reportTail(verdict.output.trim()) };
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
    /**
     * Every env Secret this manager created and has not deleted, by the lease that owns it. Apart
     * from `entries` because a reclaimed attempt's entry is overwritten by the next acquire of the
     * key while its Secret, credentials and all, still has to be deleted — by ITS release.
     */
    const secrets = new Map<string, string>();
    const serialize = keyQueue();

    /** The finished Job goes, on every path — its pod has read the env Secret by then. */
    const reap = (jobName: string): void => {
        void deleteJob(deps, jobName);
    };

    /**
     * One gate run: a Job over the checkout. The entry is read when the run's turn comes, not when
     * it was asked for — an attempt that took the key over while it waited is the one whose
     * environment it uses.
     */
    const runGateJob = async (
        key: string,
        name: string,
        command: string,
        signal: AbortSignal | undefined
    ): Promise<GateRun> => {
        const entry = entries.get(key);
        if (!entry) throw gateHarness(`no gate environment for ${key}`);
        // The run counter, bumped then read — one statement each, so the increment is not hidden
        // inside the expression that consumes it. It keeps a second ad-hoc call of the same gate
        // off the first's Job name.
        entry.run += 1;
        const run = entry.run;
        const { job, image, secretName } = entry;
        const jobName = gateJobName(job, name, run);
        // A cancelled gate: its Job goes now, Foreground, so the pod dies with it rather than
        // running its suite to the deadline; the poll stops at its next turn.
        const cancel = (): void => {
            void deleteJob(deps, jobName, 'Foreground');
        };
        if (signal?.aborted) throw gateHarness(`the gate ${name} was cancelled before it started`);
        signal?.addEventListener('abort', cancel, { once: true });
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
            const refused = refusal(created, 'creating the gate job');
            if (refused) throw gateHarness(refused);

            const { succeeded, timedOut } = await pollGateJobToTerminal(deps, jobName, image, signal);
            const { exitCode, output } = await readGateJobResult(deps, jobName, succeeded);

            // The docker manager's timeout shape: exit 124, and a named reason when the
            // gate had nothing to say for itself.
            return {
                exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
                output: timedOut && !output ? `[driver] gate killed after ${gateTimeoutMs}ms` : output,
            };
        } finally {
            signal?.removeEventListener('abort', cancel);
            reap(jobName);
        }
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
            if (secretName) {
                await createGateEnvSecret(deps, job, secretName, envBody);
                secrets.set(job.leaseToken, secretName);
            }
            // A re-acquire of the SAME attempt — the loop's per-gate re-acquire (issue #78) —
            // keeps the run counter, so a run never lands on a name a previous run of that gate
            // already used (the reaped Job can still exist when the create lands). A different
            // attempt starts at 0: names already differ across attempts through the lease token.
            const prev = entries.get(key);
            const run = prev && prev.job.id === job.id && prev.job.leaseToken === job.leaseToken ? prev.run : 0;
            entries.set(key, { job, image, envBody, secretName, run });
        },

        runGate(key, name, command, signal) {
            if (!entries.has(key)) {
                return Promise.reject(gateHarness(`no gate environment for ${key}`));
            }
            // One gate at a time per checkout, as docker's queue does: two suites in one worktree
            // give flaky verdicts.
            return serialize(key, () => runGateJob(key, name, command, signal));
        },

        /**
         * The releasing attempt's own env Secret goes here — every gate run of it has read it by
         * now — and the key's entry only if the attempt still owns it: a late release of a
         * reclaimed attempt must neither delete the Secret of the one that replaced it nor leave
         * its own, credentials and all, behind.
         */
        release(key, job) {
            const secretName = secrets.get(job.leaseToken);
            if (secretName) {
                secrets.delete(job.leaseToken);
                void deleteSecret(deps, secretName);
            }
            if (entries.get(key)?.job.leaseToken === job.leaseToken) entries.delete(key);
        },

        /** A drained driver has no more turns coming: whatever the cooldown would have kept is moot. */
        async stop() {
            for (const secretName of secrets.values()) void deleteSecret(deps, secretName);
            secrets.clear();
            entries.clear();
        },
    };
}
