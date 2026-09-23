import type { BoardJob } from './board.js';
import { claimContinuesSession, envFileBody, reportTail } from './docker.js';
import {
    jobPath,
    podsPath,
    reclaimJobName,
    reclaimJobSpec,
    secretsPath,
    syncEnvSecretName,
    syncJobName,
    syncJobSpec,
} from './k8s-auxspec.js';
import { envBodyToData, jobsPath, runnerName } from './k8s-podspec.js';
import {
    ERROR_PREVIEW_CHARS,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_SERVER_ERROR_STATUS,
    HTTP_TOO_MANY_REQUESTS,
    LOG_TAIL_LINES,
    parse,
    POLL_MAX_CONSECUTIVE_FAILURES,
    POLL_MS,
} from './k8s-transport.js';
import type { K8sDeps, K8sJobStatus, K8sPodList, K8sResponse } from './k8s-transport.js';
import type { ReclaimResult, SyncResult } from './publish.js';

/**
 * The kubernetes executor's job-status polling: reading one Job to a terminal state (bounded by
 * the same retry patience every verdict-carrying read shares), the live-output tail, and the
 * three concrete pollers built on it — the runner's own status poll, and the sync/reclaim aux
 * Jobs'. See docs/kubernetes.md's "Live output here is the pod log" and "The startup sync is
 * ported the same way" for the design this file implements.
 */

/** A Job's status object, read as one of its three states — never both `succeeded` and `failed`. */
function jobOutcome(status: K8sJobStatus): 'succeeded' | 'failed' | 'pending' {
    if ((status.succeeded ?? 0) >= 1) return 'succeeded';
    if ((status.failed ?? 0) >= 1) return 'failed';
    return 'pending';
}

/**
 * One GET with the same bounded patience the status poll has. Used for the reads that carry the
 * run's verdict once it has finished: the pod list (exit code) and the log (output). An apiserver
 * answering 503 for a moment is not this run's verdict — reporting a failure here would blame the
 * command for the API server's problem and re-run finished work.
 */
export async function readVerdict(deps: K8sDeps, path: string, what: string, failures = 0): Promise<K8sResponse> {
    let response: K8sResponse;
    try {
        response = await deps.request('GET', path);
    } catch (e) {
        if (failures + 1 > POLL_MAX_CONSECUTIVE_FAILURES) throw e;
        await deps.sleep(POLL_MS);
        return readVerdict(deps, path, what, failures + 1);
    }
    if (response.status !== HTTP_TOO_MANY_REQUESTS && response.status < HTTP_SERVER_ERROR_STATUS) {
        return response;
    }
    if (failures + 1 > POLL_MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`${what} answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`);
    }
    await deps.sleep(POLL_MS);
    return readVerdict(deps, path, what, failures + 1);
}

/** `readVerdict`'s own answer, or the message its bounded retries gave up with. */
async function readJobOrGiveUp(
    deps: K8sDeps,
    jobName: string,
    what: string
): Promise<K8sResponse | { giveUp: string }> {
    try {
        return await readVerdict(deps, jobPath(deps.config.k8sNamespace, jobName), what);
    } catch (e) {
        return { giveUp: (e as Error).message };
    }
}

/** The messages one `pollJobToTerminal` caller answers its own give-up shapes with. */
export interface PollToTerminalMessages {
    what: string;
    notFound: (jobName: string) => string;
    errorStatus: (status: number) => string;
    failed: string;
}

/**
 * Poll one Job to a terminal status, the shape every aux Job readout shares: `readVerdict` owns
 * the transport/429/5xx retry bound, a 404 means the Job is gone, any other non-2xx is
 * unexpected, and a terminal status answers `failed` on the Job's own failure or null on success.
 * NEVER throws — a caller that must throw wraps the non-null answer itself.
 */
export async function pollJobToTerminal(
    deps: K8sDeps,
    jobName: string,
    messages: PollToTerminalMessages
): Promise<string | null> {
    const result = await readJobOrGiveUp(deps, jobName, messages.what);
    if ('giveUp' in result) return result.giveUp;
    if (result.status === HTTP_NOT_FOUND) return messages.notFound(jobName);
    if (result.status >= HTTP_ERROR_STATUS) return messages.errorStatus(result.status);
    const outcome = jobOutcome(parse<{ status?: K8sJobStatus }>(result.body).status ?? {});
    if (outcome === 'failed') return messages.failed;
    if (outcome === 'succeeded') return null;
    await deps.sleep(POLL_MS);
    return pollJobToTerminal(deps, jobName, messages);
}

/** The exit code and log tail off an aux Job's own pod, once its status has gone terminal. */
async function readAuxVerdictOutput(
    deps: K8sDeps,
    jobName: string,
    succeeded: boolean
): Promise<{ exitCode: number | null; output: string }> {
    const pods = await deps.request(
        'GET',
        `${podsPath(deps.config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`
    );
    if (pods.status >= HTTP_ERROR_STATUS) {
        throw new Error(`listing the pods of ${jobName} answered ${pods.status}`);
    }
    const pod = parse<K8sPodList>(pods.body).items?.find((item) => !item.metadata?.deletionTimestamp);
    const exitCode = pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode ?? (succeeded ? 0 : null);
    let output = '';
    if (pod?.metadata?.name) {
        const log = await deps
            .request(
                'GET',
                `${podsPath(deps.config.k8sNamespace)}/${pod.metadata.name}/log?tailLines=${LOG_TAIL_LINES}`
            )
            .catch(() => ({ status: 0, body: '' }));
        if (log.status < HTTP_ERROR_STATUS) output = log.body;
    }
    return { exitCode, output };
}

/**
 * Runs one aux Job to its verdict: poll the Job to a terminal status with the same bounded
 * patience every verdict-carrying read has, then read the exit code off its pod and the output
 * off the pod's log — the same discovery (job-name label, terminating pods skipped) and the same
 * succeeded-with-no-pod convention the runner's own verdict read applies. Used by the publish
 * steps and the claude-turns close read, whose every container is exactly this shape.
 */
export async function auxVerdict(deps: K8sDeps, jobName: string): Promise<{ exitCode: number | null; output: string }> {
    const response = await readVerdict(deps, jobPath(deps.config.k8sNamespace, jobName), `reading the job ${jobName}`);
    if (response.status === HTTP_NOT_FOUND) {
        throw new Error(`the job ${jobName} no longer exists`);
    }
    if (response.status >= HTTP_ERROR_STATUS) {
        throw new Error(
            `reading the job ${jobName} answered ${response.status}: ${response.body.slice(0, ERROR_PREVIEW_CHARS)}`
        );
    }
    const outcome = jobOutcome(parse<{ status?: K8sJobStatus }>(response.body).status ?? {});
    if (outcome === 'pending') {
        await deps.sleep(POLL_MS);
        return auxVerdict(deps, jobName);
    }
    return readAuxVerdictOutput(deps, jobName, outcome === 'succeeded');
}

/**
 * The mid-run live output tail, best effort: discovers the runner's pod once and remembers it,
 * then reads its log tail on every poll that has one — every failure here (not scheduled yet, a
 * 503, a dropped connection) costs freshness, never the run.
 */
async function tailRunnerOutput(
    deps: K8sDeps,
    job: BoardJob,
    podName: string | null,
    onOutput: (tail: string) => void
): Promise<string | null> {
    let resolvedPodName = podName;
    if (resolvedPodName === null) {
        try {
            const pods = await deps.request(
                'GET',
                `${podsPath(deps.config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${runnerName(job)}`)}`
            );
            // Skipping terminating pods for the same reason the final read does: a replaced
            // attempt's pod carries the same label, and its log is not this run's output.
            resolvedPodName =
                parse<K8sPodList>(pods.body).items?.find((item) => !item.metadata?.deletionTimestamp)?.metadata?.name ??
                null;
        } catch {
            // Not scheduled yet, or the API server blinked. The next poll looks again.
        }
    }
    if (resolvedPodName !== null) {
        try {
            const log = await deps.request(
                'GET',
                `${podsPath(deps.config.k8sNamespace)}/${resolvedPodName}/log?tailLines=${LOG_TAIL_LINES}`
            );
            if (log.status < HTTP_ERROR_STATUS) onOutput(reportTail(log.body));
        } catch {
            // The log endpoint hiccups on a pod that is only starting. Freshness waits a poll.
        }
    }
    return resolvedPodName;
}

/**
 * Poll until the runner Job reports a terminal status. The kubelet-enforced activeDeadlineSeconds
 * is what guarantees the JOB eventually reaches one — the same bound that kills the docker
 * runner's container guarantees this an exit. It does not guarantee this driver can keep READING
 * it, so 429s, 5xx and transport failures are retried a bounded number of times rather than
 * treated as the run's verdict.
 */
export async function pollRunnerJobUntilTerminal(
    deps: K8sDeps,
    job: BoardJob,
    onOutput: ((tail: string) => void) | undefined,
    podName: string | null = null
): Promise<{ timedOut: boolean; jobSucceeded: boolean }> {
    const response = await readVerdict(
        deps,
        jobPath(deps.config.k8sNamespace, runnerName(job)),
        'reading the runner job'
    );
    if (response.status === HTTP_NOT_FOUND) {
        // Gone without this driver deleting it — fenced away or removed by hand. Its verdict can
        // never arrive, so waiting longer is holding a slot for nothing.
        throw new Error(`the runner job ${runnerName(job)} no longer exists`);
    }
    if (response.status >= HTTP_ERROR_STATUS) {
        throw new Error(
            `reading the runner job answered ${response.status}: ${response.body.slice(0, ERROR_PREVIEW_CHARS)}`
        );
    }
    const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
    const outcome = jobOutcome(status);
    if (outcome !== 'pending') {
        const timedOut = (status.conditions ?? []).some(
            (condition) => condition.type === 'Failed' && condition.reason === 'DeadlineExceeded'
        );
        return { timedOut, jobSucceeded: outcome === 'succeeded' };
    }
    const nextPodName = onOutput ? await tailRunnerOutput(deps, job, podName, onOutput) : podName;
    await deps.sleep(POLL_MS);
    return pollRunnerJobUntilTerminal(deps, job, onOutput, nextPodName);
}

/**
 * The pod carries the exit code; the Job object does not. Found by the label the Job controller
 * stamps on every pod it owns, not by guessing the generated name. When the Job succeeded but its
 * pod is already gone — garbage-collected before the list — the Job status IS the exit code: this
 * Job runs one pod and never retries it, so a success can only have counted an exit-0 termination.
 */
export async function readRunnerVerdict(
    deps: K8sDeps,
    job: BoardJob,
    jobSucceeded: boolean
): Promise<{ exitCode: number | null; output: string }> {
    const podsResponse = await readVerdict(
        deps,
        `${podsPath(deps.config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${runnerName(job)}`)}`,
        'listing the runner pods'
    );
    if (podsResponse.status >= HTTP_ERROR_STATUS) {
        throw new Error(
            `listing the runner pods answered ${podsResponse.status}: ${podsResponse.body.slice(0, ERROR_PREVIEW_CHARS)}`
        );
    }
    // A re-claim replaced the previous attempt's Job, and its pod can still be listed while it
    // terminates — carrying the same job-name label. Skip terminating pods, so the exit code and
    // the log are always this run's.
    const pod = parse<K8sPodList>(podsResponse.body).items?.find((item) => !item.metadata?.deletionTimestamp);
    const exitCode = pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode ?? (jobSucceeded ? 0 : null);
    let output = '';
    if (pod?.metadata?.name) {
        // The tail, not the transcript. No retries here at all: the pod may be gone for good, and
        // the answer is already known to be "whatever we can get".
        let log: K8sResponse;
        try {
            log = await deps.request(
                'GET',
                `${podsPath(deps.config.k8sNamespace)}/${pod.metadata.name}/log?tailLines=${LOG_TAIL_LINES}`
            );
        } catch {
            log = { status: 0, body: '' };
        }
        if (log.status < HTTP_ERROR_STATUS) output = reportTail(log.body);
    }
    return { exitCode, output };
}

/**
 * A bounded consecutive-failure retry, shared by the sync and reclaim pollers below: on a
 * transport failure or a 429/5xx, either give up with `reason` once the bound is spent, or sleep
 * and try again. Pulled out purely to keep each poller's own complexity readable — the two
 * pollers are otherwise the same shape as `readVerdict`, but NEVER throw (a failed sync or
 * reclaim is data, not an exception).
 */
async function pollAgainOrGiveUp(
    sleep: (ms: number) => Promise<void>,
    failures: number,
    reason: string,
    retry: (failures: number) => Promise<string | null>
): Promise<string | null> {
    if (failures + 1 > POLL_MAX_CONSECUTIVE_FAILURES) {
        return reason;
    }
    await sleep(POLL_MS);
    return retry(failures + 1);
}

/**
 * Poll the worktree sync Job to a terminal state, bounded like the runner's own status poll: a
 * blink or a 503 is not the sync's verdict, but an apiserver that will not answer is not a tree to
 * run on either — the bound expires into a failed sync. `null` is success; a string is the failure
 * reason. NEVER throws — `syncCheckout` answers a failed sync as data, the same shape any other
 * sync failure takes.
 */
export async function pollSyncJobToTerminal(deps: K8sDeps, job: BoardJob, failures = 0): Promise<string | null> {
    let response: K8sResponse;
    try {
        response = await deps.request('GET', jobPath(deps.config.k8sNamespace, syncJobName(job)));
    } catch (e) {
        return pollAgainOrGiveUp(
            deps.sleep,
            failures,
            `the worktree sync job could not be read: ${(e as Error).message}`,
            (f) => pollSyncJobToTerminal(deps, job, f)
        );
    }
    if (response.status === HTTP_TOO_MANY_REQUESTS || response.status >= HTTP_SERVER_ERROR_STATUS) {
        return pollAgainOrGiveUp(
            deps.sleep,
            failures,
            `reading the worktree sync job answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`,
            (f) => pollSyncJobToTerminal(deps, job, f)
        );
    }
    if (response.status >= HTTP_ERROR_STATUS) {
        return `reading the worktree sync job answered ${response.status}: ${response.body.slice(0, ERROR_PREVIEW_CHARS)}`;
    }
    const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
    if ((status.succeeded ?? 0) >= 1 || (status.failed ?? 0) >= 1) return null;
    await deps.sleep(POLL_MS);
    return pollSyncJobToTerminal(deps, job, 0);
}

/**
 * The verdict is the pod log — one JSON line, the same answer the docker sync container prints. A
 * pod gone before its log could be read is a failed sync: running on a tree of unknown state would
 * compound whatever went wrong. Empty for anything unreadable.
 */
async function readSyncJobLog(deps: K8sDeps, job: BoardJob): Promise<string> {
    try {
        const pods = await deps.request(
            'GET',
            `${podsPath(deps.config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${syncJobName(job)}`)}`
        );
        const pod = parse<K8sPodList>(pods.body).items?.find((item) => !item.metadata?.deletionTimestamp);
        if (pod?.metadata?.name) {
            const log = await deps.request('GET', `${podsPath(deps.config.k8sNamespace)}/${pod.metadata.name}/log`);
            if (log.status < HTTP_ERROR_STATUS) return log.body;
        }
    } catch {
        // Unreadable is empty, same as a pod that never carried a log.
    }
    return '';
}

/**
 * The sync Job itself: the fetch credential (by reference, same discipline as every other Secret
 * this driver mints), the Job, its poll, and its verdict line. The secret name is written into
 * `secretRef` the instant it is created — BEFORE the Job POST that can itself throw — so the
 * caller's `finally` can reap it whether this function returns or throws; a return value alone
 * would lose the name on a thrown transport failure between the two POSTs. A claim that continues
 * a session creates none at all: its restore fetches nothing, so there is no credential to hold.
 */
export async function runSyncJob(
    deps: K8sDeps,
    job: BoardJob,
    secretRef: { current: string | null }
): Promise<SyncResult> {
    const restore = claimContinuesSession(job);
    const env = restore ? {} : envBodyToData(envFileBody(job));
    if (Object.keys(env).length) {
        const response = await deps.request('POST', secretsPath(deps.config.k8sNamespace), {
            apiVersion: 'v1',
            kind: 'Secret',
            type: 'Opaque',
            metadata: {
                name: syncEnvSecretName(job),
                labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
            },
            stringData: env,
        });
        if (response.status >= HTTP_ERROR_STATUS) {
            return {
                ok: false,
                reason: `creating the sync secret answered ${response.status}: ${response.body.slice(0, ERROR_PREVIEW_CHARS)}`,
            };
        }
        secretRef.current = syncEnvSecretName(job);
    }
    const create = await deps.request(
        'POST',
        jobsPath(deps.config.k8sNamespace),
        syncJobSpec(deps.config, job, secretRef.current)
    );
    if (create.status >= HTTP_ERROR_STATUS) {
        return {
            ok: false,
            reason: `creating the worktree sync job answered ${create.status}: ${create.body.slice(0, ERROR_PREVIEW_CHARS)}`,
        };
    }
    const pollFailure = await pollSyncJobToTerminal(deps, job);
    if (pollFailure) return { ok: false, reason: pollFailure };
    const body = await readSyncJobLog(deps, job);
    const line = body.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
        return JSON.parse(line) as SyncResult;
    } catch {
        return { ok: false, reason: 'the worktree sync answered nothing readable' };
    }
}

/**
 * Poll the worktree reclaim Job to a terminal state — the sync poller's twin, bounded the same
 * way and NEVER throwing: `reclaimWorktree` is best-effort by contract, and a poll that cannot
 * answer is a skipped reclaim, never a failed task.
 */
export async function pollReclaimJobToTerminal(deps: K8sDeps, job: BoardJob, failures = 0): Promise<string | null> {
    let response: K8sResponse;
    try {
        response = await deps.request('GET', jobPath(deps.config.k8sNamespace, reclaimJobName(job)));
    } catch (e) {
        return pollAgainOrGiveUp(
            deps.sleep,
            failures,
            `the worktree reclaim job could not be read: ${(e as Error).message}`,
            (f) => pollReclaimJobToTerminal(deps, job, f)
        );
    }
    if (response.status === HTTP_TOO_MANY_REQUESTS || response.status >= HTTP_SERVER_ERROR_STATUS) {
        return pollAgainOrGiveUp(
            deps.sleep,
            failures,
            `reading the worktree reclaim job answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row`,
            (f) => pollReclaimJobToTerminal(deps, job, f)
        );
    }
    if (response.status >= HTTP_ERROR_STATUS) {
        return `reading the worktree reclaim job answered ${response.status}: ${response.body.slice(0, ERROR_PREVIEW_CHARS)}`;
    }
    const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
    if ((status.succeeded ?? 0) >= 1 || (status.failed ?? 0) >= 1) return null;
    await deps.sleep(POLL_MS);
    return pollReclaimJobToTerminal(deps, job, 0);
}

/** The reclaim Job's verdict line, off its pod's log — the sync log read's twin. */
async function readReclaimJobLog(deps: K8sDeps, job: BoardJob): Promise<string> {
    try {
        const pods = await deps.request(
            'GET',
            `${podsPath(deps.config.k8sNamespace)}?labelSelector=${encodeURIComponent(`job-name=${reclaimJobName(job)}`)}`
        );
        const pod = parse<K8sPodList>(pods.body).items?.find((item) => !item.metadata?.deletionTimestamp);
        if (pod?.metadata?.name) {
            const log = await deps.request('GET', `${podsPath(deps.config.k8sNamespace)}/${pod.metadata.name}/log`);
            if (log.status < HTTP_ERROR_STATUS) return log.body;
        }
    } catch {
        // Unreadable is empty, same as a pod that never carried a log.
    }
    return '';
}

/**
 * The reclaim Job itself: create, poll to terminal, read the verdict line. No Secret, no env:
 * removing needs nothing the claim held. Pulled out of `reclaimWorktree` purely to keep that
 * method's complexity readable — the same duplication `runSyncJob` closes for the sync.
 */
export async function runReclaimJob(deps: K8sDeps, job: BoardJob): Promise<ReclaimResult> {
    const create = await deps.request('POST', jobsPath(deps.config.k8sNamespace), reclaimJobSpec(deps.config, job));
    if (create.status >= HTTP_ERROR_STATUS) {
        return {
            ok: false,
            removed: false,
            reason: `creating the worktree reclaim job answered ${create.status}: ${create.body.slice(0, ERROR_PREVIEW_CHARS)}`,
        };
    }
    const pollFailure = await pollReclaimJobToTerminal(deps, job);
    if (pollFailure) return { ok: false, removed: false, reason: pollFailure };
    const body = await readReclaimJobLog(deps, job);
    const line = body.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
        return JSON.parse(line) as ReclaimResult;
    } catch {
        return { ok: false, removed: false, reason: 'the worktree reclaim answered nothing readable' };
    }
}
