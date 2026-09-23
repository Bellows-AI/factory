import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { envFileBody } from './claim.js';
import { composeRuntimeSample } from './runner.js';
import {
    mergeOpencodeOutcome,
    opencodeReadFailed,
    parseClaudeCloseRead,
    parseOpencodeRunOutcome,
    readOpencodeWithRetries,
} from './close-read.js';
import type { RunOutcome, RunSession, Runner } from './runner.js';
import type { OpencodeRunOutcome } from './close-read.js';
import type { HelperPlan } from './helpers.js';
import { runHelper } from './k8s-helper-runner.js';
import {
    deleteJob,
    deleteSecret,
    jobPodsPath,
    podLogPath,
    podsByLeasePath,
    publishEnvSecretName,
    publishStepJobName,
    publishStepJobSpec,
    reclaimJobName,
    secretsPath,
    syncJobName,
} from './k8s-auxspec.js';
import { acquireClaim, prepare, launch, releaseClaim, type RunCleanup } from './k8s-fence.js';
import {
    claudeTurnsJobSpec,
    envBodyToData,
    jobsPath,
    opencodeReadoutJobSpec,
    runnerJobSpec,
    runnerName,
    secretName,
} from './k8s-podspec.js';
import {
    auxVerdict,
    pollJobToTerminal,
    pollRunnerJobUntilTerminal,
    readRunnerVerdict,
    readVerdict,
    runReclaimJob,
    runSyncJob,
} from './k8s-poll.js';
import { startServiceFleet, teardownServices } from './k8s-services.js';
import {
    ERROR_PREVIEW_CHARS,
    HTTP_ERROR_STATUS,
    livePod,
    parsePodMetrics,
    parseServicePods,
    wait,
} from './k8s-transport.js';
import type { K8sDeps, K8sRequest, K8sResponse } from './k8s-transport.js';
import { publishCheckout, publishFailed, repoPath, withPublishToken, worktreeDir } from './publish.js';
import type { PublishResult, ReclaimResult, SyncResult } from './publish.js';
import { CLAUDE_CODE, OPENCODE } from './executors.js';

/**
 * The kubernetes `Runner`: assembles the fence (`k8s-fence.ts`), the pollers (`k8s-poll.ts`) and
 * the service fleet (`k8s-services.ts`) into the same `run`/`kill`/`syncCheckout`/`publishGit`/
 * `reclaimWorktree` surface the docker runner exposes. See docs/kubernetes.md for the protocol
 * each method implements; every function here is a thin composition over the sibling files, kept
 * here because it is the runner's own close-time bookkeeping (the opencode/claude-turns scrapes,
 * the publish steps) rather than a reusable poll/fence primitive.
 */

/** Best-effort: a 404 is the ordinary end of a reaped Secret, and any other failure is the fence's business. */
function forgetSecret(deps: K8sDeps, job: BoardJob): Promise<void> {
    return deleteSecret(deps, secretName(job));
}

/**
 * The close-time opencode session scrape, as a Job: the same read the docker runner performs with
 * a throwaway container after the run's close, against the database the run persisted on the
 * PVC. NEVER throws — the scrape is the run's follow-up-ability, finish reason and context vitals,
 * and a failed read is not a failed run.
 */
async function scrapeOpencodeSession(deps: K8sDeps, job: BoardJob, startedAt: string): Promise<OpencodeRunOutcome> {
    const fail = opencodeReadFailed;
    let spec: ReturnType<typeof opencodeReadoutJobSpec>;
    try {
        spec = opencodeReadoutJobSpec(deps.config, job, startedAt);
    } catch (e) {
        return fail((e as Error).message);
    }
    const jobName = spec.metadata.name;
    try {
        const created = await deps.request('POST', jobsPath(deps.config.k8sNamespace), spec);
        if (created.status >= HTTP_ERROR_STATUS) {
            return fail(
                `creating the session readout answered ${created.status}: ${created.body.slice(0, ERROR_PREVIEW_CHARS)}`
            );
        }
        const pollFailure = await pollJobToTerminal(deps, jobName, {
            what: 'the session readout',
            notFound: (n) => `the session readout ${n} no longer exists`,
            errorStatus: (s) => `reading the session readout answered ${s}`,
            failed: 'the session readout job failed — its own deadline is its bound',
        });
        if (pollFailure !== null) return fail(pollFailure);
        let pods: K8sResponse;
        let log: K8sResponse;
        try {
            pods = await readVerdict(
                deps,
                jobPodsPath(deps.config.k8sNamespace, jobName),
                'listing the session readout pods'
            );
            if (pods.status >= HTTP_ERROR_STATUS)
                return fail(`listing the session readout pods answered ${pods.status}`);
            const pod = livePod(pods.body);
            if (!pod?.metadata?.name) return fail('the session readout left no pod to read its output from');
            log = await readVerdict(
                deps,
                podLogPath(deps.config.k8sNamespace, pod.metadata.name, null),
                'reading the session readout log'
            );
            if (log.status >= HTTP_ERROR_STATUS)
                return fail(`reading the session readout's log answered ${log.status}`);
        } catch (e) {
            return fail((e as Error).message);
        }
        return parseOpencodeRunOutcome(log.body);
    } finally {
        void deleteJob(deps, jobName);
    }
}

/**
 * The close-time claude-code read: one aux Job over the PVC, its one answer parsed to the turn
 * count and the run's last words, or nulls. Every failure on the way answers nulls: unmeasured,
 * never zero, exactly the contract the docker twin's failed exec keeps.
 */
async function scrapeClaudeCloseRead(
    deps: K8sDeps,
    job: BoardJob,
    sessionId: string,
    startedAt: string
): Promise<{ turns: number | null; summary: string | null }> {
    let spec: ReturnType<typeof claudeTurnsJobSpec>;
    try {
        spec = claudeTurnsJobSpec(deps.config, job, sessionId, startedAt);
    } catch {
        return { turns: null, summary: null };
    }
    const jobName = spec.metadata.name;
    try {
        const created = await deps.request('POST', jobsPath(deps.config.k8sNamespace), spec);
        if (created.status >= HTTP_ERROR_STATUS) return { turns: null, summary: null };
        const verdict = await auxVerdict(deps, jobName);
        return parseClaudeCloseRead(verdict.output);
    } catch {
        return { turns: null, summary: null };
    } finally {
        void deleteJob(deps, jobName);
    }
}

async function attachOpencodeOutcome(
    deps: K8sDeps,
    job: BoardJob,
    startedAt: string,
    outcome: RunOutcome
): Promise<void> {
    const { scraped, reason } = await readOpencodeWithRetries(
        () => scrapeOpencodeSession(deps, job, startedAt),
        deps.sleep
    );
    mergeOpencodeOutcome(outcome, scraped, reason);
}

// The docker runner samples `docker stats`; the twin here is the metrics API, read from the
// runner's own pod. Every failure (no pod yet, no metrics-server, a blink) answers null for the
// NUMBERS: "no fresh sample", never an error. The service fleet is read FIRST and independently
// of the metrics API, so a cluster with no metrics-server still reports its services.
async function sampleRuntime(deps: K8sDeps, job: BoardJob) {
    const services = deps.config.servicesEnabled
        ? await deps
              .request('GET', podsByLeasePath(deps.config.k8sNamespace, job))
              .then((found) => (found.status >= HTTP_ERROR_STATUS ? null : parseServicePods(found.body)))
              .catch(() => null)
        : undefined;
    let pods: K8sResponse;
    try {
        pods = await deps.request('GET', jobPodsPath(deps.config.k8sNamespace, runnerName(job)));
    } catch {
        return composeRuntimeSample(null, services);
    }
    if (pods.status >= HTTP_ERROR_STATUS) return composeRuntimeSample(null, services);
    const runnerPod = livePod(pods.body)?.metadata?.name;
    if (!runnerPod) return composeRuntimeSample(null, services);
    let metrics: K8sResponse;
    try {
        metrics = await deps.request(
            'GET',
            `/apis/metrics.k8s.io/v1beta1/namespaces/${deps.config.k8sNamespace}/pods/${runnerPod}`
        );
    } catch {
        return composeRuntimeSample(null, services);
    }
    if (metrics.status >= HTTP_ERROR_STATUS) return composeRuntimeSample(null, services);
    return composeRuntimeSample(parsePodMetrics(metrics.body), services);
}

// The same contract as `docker kill ... .catch(() => undefined)`: a kill that finds nothing is the
// ordinary end of a finished run, and one that fails is the kubelet's deadline doing this
// function's work. No Secret delete here: run()'s finally owns the Secret's whole lifetime.
async function killRunner(deps: K8sDeps, job: BoardJob): Promise<void> {
    await deleteJob(deps, runnerName(job));
    await teardownServices(deps, job);
}

/** The per-run inputs `run0` needs beyond the job itself — bundled to stay under the 4-param cap. */
interface RunRequest {
    session: RunSession | null;
    onOutput: ((tail: string) => void) | undefined;
    cleanup: RunCleanup;
}

// The body of run() below, split out only so its cleanup can wrap the throw paths too.
async function run0(deps: K8sDeps, job: BoardJob, req: RunRequest): Promise<RunOutcome> {
    const { session, onOutput, cleanup } = req;
    // A null session is an opencode job under this executor; under claude-code every job is a
    // session, and one arriving without is refused here, BEFORE the fence takes the checkout.
    if (!session && job.executorType !== OPENCODE) {
        throw new Error(`refusing to run job ${job.id}: the kubernetes runner runs every job as a session`);
    }
    await prepare(deps, job, cleanup);

    // Services sit between the fence and the runner's own launch: after the fence, so a
    // stood-down attempt starts no fleet; before the Job, so every refusal they can produce is
    // answered while nothing of this attempt's runs.
    const refused = await startServiceFleet(deps, job);
    if (refused) return refused;

    const startedAt = new Date().toISOString();
    await launch(deps, job, runnerJobSpec(deps.config, job, session), cleanup);

    const { timedOut, jobSucceeded } = await pollRunnerJobUntilTerminal(deps, job, onOutput);
    const { exitCode, output } = await readRunnerVerdict(deps, job, jobSucceeded);

    const outcome: RunOutcome = { exitCode, output, timedOut, idled: false, started: true };

    if (job.executorType === OPENCODE) {
        await attachOpencodeOutcome(deps, job, startedAt, outcome);
    }

    if (job.executorType === CLAUDE_CODE && session) {
        const read = await scrapeClaudeCloseRead(deps, job, session.id, startedAt);
        outcome.agentTurns = read.turns;
        if (read.summary) outcome.summary = read.summary;
    }
    return outcome;
}

// Every throw after create() succeeded — poll exhaustion, a vanished Job, a failed verdict read —
// must still reap the env Secret AND release the checkout claim: the loop's catch never calls
// kill(), and when the job retires dead there is no next attempt to do either.
async function run(
    deps: K8sDeps,
    job: BoardJob,
    session: RunSession | null,
    onOutput?: (tail: string) => void
): Promise<RunOutcome> {
    const cleanup: RunCleanup = { holdClaim: false };
    try {
        return await run0(deps, job, { session, onOutput, cleanup });
    } finally {
        if (!cleanup.holdClaim) await releaseClaim(deps, job);
        await teardownServices(deps, job);
        await forgetSecret(deps, job);
    }
}

// The publish, ported: the same publishCheckout workflow the docker runner runs (publish.ts), with
// this executor's transport underneath: one aux Job per step over the workspaces PVC, the claim
// env by a per-attempt Secret read through envFrom, and the verdict off the pod's exit code and
// log.
async function publishGit(deps: K8sDeps, job: BoardJob, publishToken?: string): Promise<PublishResult> {
    const repo = worktreeDir(deps.config, job);
    const env = envBodyToData(envFileBody(withPublishToken(job, publishToken)));
    const secret = Object.keys(env).length ? publishEnvSecretName(job) : null;
    if (secret) {
        const response = await deps.request('POST', secretsPath(deps.config.k8sNamespace), {
            apiVersion: 'v1',
            kind: 'Secret',
            type: 'Opaque',
            metadata: { name: secret, labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken } },
            stringData: env,
        });
        if (response.status >= HTTP_ERROR_STATUS) {
            return publishFailed(
                `creating the publish secret answered ${response.status}: ${response.body.slice(0, ERROR_PREVIEW_CHARS)}`
            );
        }
    }
    let stepNumber = 0;
    try {
        return await publishCheckout(deps.config, job, async (publish) => {
            stepNumber += 1;
            const jobName = publishStepJobName(job, stepNumber);
            // Unreachable: the workflow answers a null-repo job with publishNothing before any
            // step runs. The assertion keeps the transport honest if the workflow's contract
            // ever changes under it.
            if (!repo) throw new Error('the publish workflow ran a step for a job with no checkout');
            try {
                const created = await deps.request(
                    'POST',
                    jobsPath(deps.config.k8sNamespace),
                    publishStepJobSpec(deps.config, job, { step: stepNumber, publish, envSecret: secret, repo })
                );
                if (created.status >= HTTP_ERROR_STATUS) {
                    throw new Error(
                        `creating the publish job answered ${created.status}: ${created.body.slice(0, ERROR_PREVIEW_CHARS)}`
                    );
                }
                const verdict = await auxVerdict(deps, jobName);
                if (verdict.exitCode !== 0) {
                    throw new Error(
                        verdict.output.trim() || `the step exited ${verdict.exitCode ?? 'without a readable code'}`
                    );
                }
                return { stdout: verdict.output };
            } finally {
                void deleteJob(deps, jobName);
            }
        });
    } finally {
        if (secret) void deleteSecret(deps, secret);
    }
}

/**
 * The startup sync, as ever (see `syncJobSpec`): the loop calls it on every claim, the task
 * worktree does not exist until something creates it, and a refusal would fail every claimed job.
 * The fence BEFORE the sync: the sync is the first writer on the task worktree, so the checkout
 * claim is taken here rather than waiting for `prepare`'s own acquire, which recognizes its own
 * holder and proceeds.
 */
async function syncCheckout(deps: K8sDeps, job: BoardJob): Promise<SyncResult> {
    const clone = repoPath(deps.config, job);
    const worktree = worktreeDir(deps.config, job);
    if (!clone || !worktree) return { ok: true, reason: null }; // nothing synced, nothing to fail either

    await acquireClaim(deps, job);

    // The deletion the FAILURE arms use, awaited, with Foreground propagation: the delete returns
    // only after the Job's dependents are gone, so the releaseClaim that follows can never hand
    // the checkout to a replacement while the sync's pod is still writing the worktree.
    const takeSyncJobDown = (): Promise<void> => deleteJob(deps, syncJobName(job), 'Foreground');

    const secretRef: { current: string | null } = { current: null };
    try {
        const result = await runSyncJob(deps, job, secretRef);
        // A failed sync means no runner follows — nobody else would give the checkout back, so
        // the claim goes here. The sync Job goes down Foreground FIRST, awaited: handing the
        // checkout back is only clean once nothing of this sync can still write the tree.
        if (!result.ok) {
            await takeSyncJobDown();
            await releaseClaim(deps, job);
        }
        return result;
    } catch (e) {
        // A thrown sync — a transport failure, a malformed env line — releases the claim the same
        // way: holding it would only leave the next claimant to take it over.
        await takeSyncJobDown();
        await releaseClaim(deps, job);
        throw e;
    } finally {
        // The sync Job goes on EVERY exit path, fire-and-forget: the name carries the lease
        // token, so this delete can never reach a replacement's Job.
        void deleteJob(deps, syncJobName(job));
        if (secretRef.current) void deleteSecret(deps, secretRef.current);
    }
}

/**
 * The terminal reclaim (issue #47), the kubernetes shape: the remove script as a Job over the
 * PVC, UNDER the checkout claim — the same `acquireClaim` protocol the sync and the runner use.
 * An acquire that answers 409 means a LIVE attempt holds the checkout, and the reclaim SKIPS:
 * costing the reclaim is fine by contract, costing a live run is not.
 */
async function reclaimWorktree(deps: K8sDeps, job: BoardJob): Promise<ReclaimResult> {
    const clone = repoPath(deps.config, job);
    const worktree = worktreeDir(deps.config, job);
    if (!clone || !worktree) return { ok: true, removed: false, reason: null };
    try {
        await acquireClaim(deps, job);
    } catch (e) {
        // A 409 the acquire could not resolve by takeover is a live attempt on the checkout
        // (acquireClaim says which and why in its message).
        return { ok: false, removed: false, reason: `the checkout is held (${worktree}): ${(e as Error).message}` };
    }
    const takeReclaimJobDown = (): Promise<void> => deleteJob(deps, reclaimJobName(job), 'Foreground');
    try {
        const result = await runReclaimJob(deps, job);
        if (!result.ok) await takeReclaimJobDown();
        return result;
    } catch (e) {
        // A thrown read between create and verdict leaves the same live-pod risk as a failed
        // verdict: take the Job down before the finally hands the checkout back.
        await takeReclaimJobDown();
        throw e;
    } finally {
        // The failure arms' Foreground delete above has already taken it down; on the success
        // path this Background delete IS the delete. THEN the claim goes.
        void deleteJob(deps, reclaimJobName(job));
        await releaseClaim(deps, job);
    }
}

/**
 * The kubernetes Runner. `request` is injected — the `createBoard(computeFetch)` pattern — and so
 * is `sleep`, which is what lets the poll loop be tested without two seconds per poll.
 */
export function createKubernetesRunner(
    config: DriverConfig,
    request: K8sRequest,
    sleep: (ms: number) => Promise<void> = wait
): Runner {
    const deps: K8sDeps = { config, request, sleep };
    return {
        // Remote Control is refused at config under this executor, and the loop polls the remote
        // id only under Remote Control — so null is never even asked for. The interface blesses it.
        async remoteSessionId() {
            return null;
        },
        sampleRuntime: (job: BoardJob) => sampleRuntime(deps, job),
        kill: (job: BoardJob) => killRunner(deps, job),
        run: (job: BoardJob, session: RunSession | null, onOutput?: (tail: string) => void) =>
            run(deps, job, session, onOutput),
        publishGit: (job: BoardJob, publishToken?: string) => publishGit(deps, job, publishToken),
        runHelper: (job: BoardJob, plan: HelperPlan, token?: string) => runHelper(deps, job, plan, token),
        syncCheckout: (job: BoardJob) => syncCheckout(deps, job),
        reclaimWorktree: (job: BoardJob) => reclaimWorktree(deps, job),
        // The loop's terminal pre-run refusals complete the job failed WITHOUT runner.run, so
        // run()'s finally never executes, and the claim the sync took would sit on the checkout
        // indefinitely. This hands it back the same ownership-checked way releaseClaim always does.
        releaseFence: (job: BoardJob) => releaseClaim(deps, job),
    };
}
