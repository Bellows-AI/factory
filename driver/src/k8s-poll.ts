import type { BoardJob } from './board.js';
import { claimContinuesSession, envFileBody } from './claim.js';
import { reportTail } from './runner.js';
import {
    jobPath,
    jobPodsPath,
    podLogPath,
    reclaimJobName,
    reclaimJobSpec,
    secretsPath,
    syncEnvSecretName,
    syncJobName,
    syncJobSpec,
} from './k8s-auxspec.js';
import { envBodyToData, jobsPath, runnerName, secretBody } from './k8s-podspec.js';
import {
    containerFailure,
    expectOk,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_SERVER_ERROR_STATUS,
    HTTP_TOO_MANY_REQUESTS,
    livePod,
    parse,
    POLL_MAX_CONSECUTIVE_FAILURES,
    POLL_MS,
    refusal,
} from './k8s-transport.js';
import type { K8sDeps, K8sJobStatus, K8sResponse } from './k8s-transport.js';
import { parseLastJsonLine, reclaimUnreadable, syncUnreadable } from './publish.js';
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

/** Whether a terminal Job's own conditions show the kubelet's `activeDeadlineSeconds` fired. */
export function timedOutOf(status: K8sJobStatus): boolean {
    return (status.conditions ?? []).some(
        (condition) => condition.type === 'Failed' && condition.reason === 'DeadlineExceeded'
    );
}

/**
 * One verdict-carrying read of a Job's status, translated to the four shapes every caller below
 * branches on: gone, an unexpected status, still running, or a terminal outcome. `readVerdict`
 * owns the transport/429/5xx retry bound and can still throw once it is exhausted — a caller that
 * must never throw (`pollJobToTerminal`) catches that itself; one that must (`auxVerdict`,
 * `pollRunnerJobUntilTerminal`, the gate poll) lets it propagate, wrapping it in its own shape
 * when it needs to.
 */
export type JobStatusResult =
    | { kind: 'notFound' }
    | { kind: 'error'; status: number; body: string }
    | { kind: 'pending' }
    | { kind: 'terminal'; outcome: 'succeeded' | 'failed'; status: K8sJobStatus };

export async function readJobStatus(deps: K8sDeps, jobName: string, what: string): Promise<JobStatusResult> {
    const response = await readVerdict(deps, jobPath(deps.config.k8sNamespace, jobName), what);
    if (response.status === HTTP_NOT_FOUND) return { kind: 'notFound' };
    if (response.status >= HTTP_ERROR_STATUS) return { kind: 'error', status: response.status, body: response.body };
    const status = parse<{ status?: K8sJobStatus }>(response.body).status ?? {};
    const outcome = jobOutcome(status);
    return outcome === 'pending' ? { kind: 'pending' } : { kind: 'terminal', outcome, status };
}

/**
 * The messages one `pollJobToTerminal` caller answers its own give-up shapes with. `failed` is
 * `null` for the sync/reclaim callers, whose script prints `{ok:false,reason}` on its OWN
 * failure — a failed Job is still a verdict to read there, never a give-up reason on its own.
 */
export interface PollToTerminalMessages {
    what: string;
    notFound: (jobName: string) => string;
    errorStatus: (status: number) => string;
    failed: string | null;
}

/**
 * Poll one Job to a terminal status, the shape every aux Job readout shares: `readVerdict` owns
 * the transport/429/5xx retry bound, a 404 means the Job is gone, any other non-2xx is
 * unexpected, and a terminal status answers `failed` on the Job's own failure (when the caller
 * names one) or null once there is a verdict to read — a Job failure with no `failed` message is
 * itself such a verdict, exactly like success. NEVER throws — a caller that must throw wraps the
 * non-null answer itself.
 */
export async function pollJobToTerminal(
    deps: K8sDeps,
    jobName: string,
    messages: PollToTerminalMessages
): Promise<string | null> {
    let result: JobStatusResult;
    try {
        result = await readJobStatus(deps, jobName, messages.what);
    } catch (e) {
        return (e as Error).message;
    }
    if (result.kind === 'notFound') return messages.notFound(jobName);
    if (result.kind === 'error') return messages.errorStatus(result.status);
    if (result.kind === 'pending') {
        await deps.sleep(POLL_MS);
        return pollJobToTerminal(deps, jobName, messages);
    }
    if (result.outcome === 'failed' && messages.failed !== null) return messages.failed;
    return null;
}

/**
 * The pod carries the exit code; the Job object does not. Found by the label the Job controller
 * stamps on every pod it owns, not by guessing the generated name — the same discovery every
 * verdict read below shares, with the same bounded patience `readVerdict` gives every other
 * verdict-carrying read. When the Job succeeded but its pod is already gone (garbage-collected
 * before the list), the Job status IS the exit code: this Job runs one pod and never retries it,
 * so a success can only have counted an exit-0 termination. A re-claim's replaced attempt's pod
 * can still be listed while it terminates, carrying the same job-name label — skipped, so the
 * exit code and the log are always this run's. The log read has no retry at all: the pod may be
 * gone for good, and the answer is already known to be "whatever we can get".
 */
export async function readJobPodVerdict(
    deps: K8sDeps,
    jobName: string,
    succeeded: boolean,
    what: string
): Promise<{ exitCode: number | null; output: string }> {
    const podsResponse = await readVerdict(deps, jobPodsPath(deps.config.k8sNamespace, jobName), what);
    expectOk(podsResponse, what);
    const pod = livePod(podsResponse.body);
    const exitCode = pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode ?? (succeeded ? 0 : null);
    let output = '';
    if (pod?.metadata?.name) {
        let log: K8sResponse;
        try {
            log = await deps.request('GET', podLogPath(deps.config.k8sNamespace, pod.metadata.name));
        } catch {
            log = { status: 0, body: '' };
        }
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
    const result = await readJobStatus(deps, jobName, `reading the job ${jobName}`);
    if (result.kind === 'notFound') {
        throw new Error(`the job ${jobName} no longer exists`);
    }
    if (result.kind === 'error') throw new Error(refusal(result, `reading the job ${jobName}`)!);
    if (result.kind === 'pending') {
        await deps.sleep(POLL_MS);
        return auxVerdict(deps, jobName);
    }
    return readJobPodVerdict(deps, jobName, result.outcome === 'succeeded', `listing the pods of ${jobName}`);
}

/**
 * A block-helper aux Job's verdict (issue #207) — `auxVerdict`'s shape, plus whether the
 * kubelet's own `activeDeadlineSeconds` is what ended it, the same `DeadlineExceeded` condition
 * check `pollRunnerJobUntilTerminal` makes for the runner Job. A helper that outlives its bound is
 * reported as a named `timeout` failure by its caller, never an ordinary exit.
 */
export async function helperVerdict(
    deps: K8sDeps,
    jobName: string
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
    const result = await readJobStatus(deps, jobName, `reading the helper job ${jobName}`);
    if (result.kind === 'notFound') {
        throw new Error(`the helper job ${jobName} no longer exists`);
    }
    if (result.kind === 'error') throw new Error(refusal(result, 'reading the helper job')!);
    if (result.kind === 'pending') {
        await deps.sleep(POLL_MS);
        return helperVerdict(deps, jobName);
    }
    const verdict = await readJobPodVerdict(
        deps,
        jobName,
        result.outcome === 'succeeded',
        `listing the pods of ${jobName}`
    );
    return { ...verdict, timedOut: timedOutOf(result.status) };
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
            const pods = await deps.request('GET', jobPodsPath(deps.config.k8sNamespace, runnerName(job)));
            // Skipping terminating pods for the same reason the final read does: a replaced
            // attempt's pod carries the same label, and its log is not this run's output.
            resolvedPodName = livePod(pods.body)?.metadata?.name ?? null;
        } catch {
            // Not scheduled yet, or the API server blinked. The next poll looks again.
        }
    }
    if (resolvedPodName !== null) {
        try {
            const log = await deps.request('GET', podLogPath(deps.config.k8sNamespace, resolvedPodName));
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
    const result = await readJobStatus(deps, runnerName(job), 'reading the runner job');
    if (result.kind === 'notFound') {
        // Gone without this driver deleting it — fenced away or removed by hand. Its verdict can
        // never arrive, so waiting longer is holding a slot for nothing.
        throw new Error(`the runner job ${runnerName(job)} no longer exists`);
    }
    if (result.kind === 'error') throw new Error(refusal(result, 'reading the runner job')!);
    if (result.kind === 'terminal') {
        return { timedOut: timedOutOf(result.status), jobSucceeded: result.outcome === 'succeeded' };
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
    const verdict = await readJobPodVerdict(deps, runnerName(job), jobSucceeded, 'listing the runner pods');
    // The tail, not the transcript — the one thing the runner's own read does beyond the shared
    // shape, since only its output ever reaches the board's live tail.
    return { exitCode: verdict.exitCode, output: reportTail(verdict.output) };
}

/**
 * The verdict is the pod log — one JSON line, the same answer the docker sync/reclaim containers
 * print. A pod gone before its log could be read is a failed run: running on a tree of unknown
 * state would compound whatever went wrong. Empty for anything unreadable. `failure` is the
 * container's own status when it ended badly — a container that never started (an image with no
 * `node`) has no log at all, and its status is the only place the cause survives.
 */
async function readJobLog(deps: K8sDeps, jobName: string): Promise<{ log: string; failure: string | null }> {
    let failure: string | null = null;
    try {
        const pods = await deps.request('GET', jobPodsPath(deps.config.k8sNamespace, jobName));
        const pod = livePod(pods.body);
        failure = containerFailure(pod);
        if (pod?.metadata?.name) {
            const log = await deps.request('GET', podLogPath(deps.config.k8sNamespace, pod.metadata.name, null));
            if (log.status < HTTP_ERROR_STATUS) return { log: log.body, failure };
        }
    } catch {
        // Unreadable is empty, same as a pod that never carried a log.
    }
    return { log: '', failure };
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
        const response = await deps.request(
            'POST',
            secretsPath(deps.config.k8sNamespace),
            secretBody(job, syncEnvSecretName(job), env)
        );
        const refused = refusal(response, 'creating the sync secret');
        if (refused) return { ok: false, reason: refused };
        secretRef.current = syncEnvSecretName(job);
    }
    const create = await deps.request(
        'POST',
        jobsPath(deps.config.k8sNamespace),
        syncJobSpec(deps.config, job, secretRef.current)
    );
    const refusedCreate = refusal(create, 'creating the worktree sync job');
    if (refusedCreate) return { ok: false, reason: refusedCreate };
    const jobName = syncJobName(job);
    const pollFailure = await pollJobToTerminal(deps, jobName, {
        what: 'reading the worktree sync job',
        notFound: (n) => `the worktree sync job ${n} no longer exists`,
        errorStatus: (s) => `reading the worktree sync job answered ${s}`,
        failed: null,
    });
    if (pollFailure) return { ok: false, reason: pollFailure };
    const { log, failure } = await readJobLog(deps, jobName);
    return parseLastJsonLine<SyncResult>(log, () =>
        failure ? { ok: false, reason: `the worktree sync container failed: ${failure}` } : syncUnreadable
    );
}

/**
 * The reclaim Job itself: create, poll to terminal, read the verdict line. No Secret, no env:
 * removing needs nothing the claim held. Pulled out of `reclaimWorktree` purely to keep that
 * method's complexity readable — the same duplication `runSyncJob` closes for the sync.
 */
export async function runReclaimJob(deps: K8sDeps, job: BoardJob): Promise<ReclaimResult> {
    const create = await deps.request('POST', jobsPath(deps.config.k8sNamespace), reclaimJobSpec(deps.config, job));
    const refused = refusal(create, 'creating the worktree reclaim job');
    if (refused) return { ok: false, removed: false, reason: refused };
    const jobName = reclaimJobName(job);
    const pollFailure = await pollJobToTerminal(deps, jobName, {
        what: 'reading the worktree reclaim job',
        notFound: (n) => `the worktree reclaim job ${n} no longer exists`,
        errorStatus: (s) => `reading the worktree reclaim job answered ${s}`,
        failed: null,
    });
    if (pollFailure) return { ok: false, removed: false, reason: pollFailure };
    const { log, failure } = await readJobLog(deps, jobName);
    return parseLastJsonLine<ReclaimResult>(log, () =>
        failure
            ? { ok: false, removed: false, reason: `the worktree reclaim container failed: ${failure}` }
            : reclaimUnreadable
    );
}
