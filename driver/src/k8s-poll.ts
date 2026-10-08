import type { BoardJob } from './board.js';
import { claimRestoresTree, envFileBody } from './claim.js';
import { executorImage } from './config.js';
import { ARTIFACT_LIMIT, reportTail, tailKept } from './runner.js';
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
import { vanishedRunner } from './k8s-kill.js';
import { envBodyToData, jobsPath, runnerName, secretBody } from './k8s-podspec.js';
import {
    answerPreview,
    containerFailure,
    ERROR_PREVIEW_CHARS,
    expectOk,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_SERVER_ERROR_STATUS,
    HTTP_TOO_MANY_REQUESTS,
    isMalformedRequest400,
    livePod,
    livePodOfItems,
    parse,
    POLL_MAX_CONSECUTIVE_FAILURES,
    POLL_MS,
    postRefusal,
    refusal,
} from './k8s-transport.js';
import type { K8sDeps, K8sJobStatus, K8sPod, K8sPodList, K8sResponse } from './k8s-transport.js';
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
 * command for the API server's problem and re-run finished work. The same patience covers the
 * API server's own pre-handler `400 Bad Request` (issue #308): a malformed-request answer from
 * Go's `net/http`, transient by nature, retried like a 5xx — a genuine JSON `Status` 400 is an
 * API refusal and returns immediately.
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
    if (
        response.status !== HTTP_TOO_MANY_REQUESTS &&
        response.status < HTTP_SERVER_ERROR_STATUS &&
        !isMalformedRequest400(response.status, response.body)
    ) {
        return response;
    }
    if (failures + 1 > POLL_MAX_CONSECUTIVE_FAILURES) {
        throw new Error(
            `${what} answered ${response.status} ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row: ` +
                `${response.body.slice(0, ERROR_PREVIEW_CHARS)}`
        );
    }
    await deps.sleep(POLL_MS);
    return readVerdict(deps, path, what, failures + 1);
}

/**
 * Whether a terminal Job's own conditions show the kubelet's `activeDeadlineSeconds` fired. A
 * current cluster (observed on v1.37) first marks it `FailureTarget` — already counting the pod
 * failed, the pod still terminating — and adds `Failed` only once the pod is gone. The poll reads
 * the first terminal status it sees, so both spellings are the deadline; knowing only `Failed`
 * reported a gate that ran long as "exit 1, empty output".
 */
export function timedOutOf(status: K8sJobStatus): boolean {
    return (status.conditions ?? []).some(
        (condition) =>
            (condition.type === 'Failed' || condition.type === 'FailureTarget') &&
            condition.reason === 'DeadlineExceeded'
    );
}

/**
 * The one unpullable-image message shape every poll shares; the role word is the only variation —
 * the gate names its own declared image ("gate"), the runner and aux Jobs name the executor's.
 */
export function unpullableImage(role: 'gate' | 'executor', image: string, blocked: string): string {
    return `the ${role} image "${image}" cannot be pulled: ${blocked}`;
}

/**
 * The one reading of "can this Job's image be pulled at all?", shared by every Job poll (issue
 * #302; the gate's `checkGateImagePullable`, generalized): a container blocked on its image names
 * the kubelet's reason and message, so the poll can fail right away instead of burning the
 * deadline and reporting a timeout or an unreadable verdict over what is really "no such image".
 * A container that is running or terminated has answered the image question. One that is still
 * waiting — `ContainerCreating` covers the whole first pull — has not: the pull can still fail
 * after this tick, so the watch keeps reading the pod list. A pod-list blink or a pod with no
 * container status yet answers "nothing seen" — the caller keeps polling.
 */
export async function readImagePullStatus(
    deps: K8sDeps,
    jobName: string
): Promise<{ blocked: string | null; containerSeen: boolean }> {
    const pods = await deps
        .request('GET', jobPodsPath(deps.config.k8sNamespace, jobName))
        .catch(() => ({ status: 0, body: '' }));
    const container = livePod(pods.body)?.status?.containerStatuses?.[0];
    const waiting = container?.state?.waiting;
    if (waiting?.reason === 'ImagePullBackOff' || waiting?.reason === 'ErrImagePull') {
        return {
            blocked: waiting.reason + (waiting.message ? ` — ${waiting.message.slice(0, ERROR_PREVIEW_CHARS)}` : ''),
            containerSeen: true,
        };
    }
    const containerSeen = container?.state?.terminated !== undefined || container?.state?.running !== undefined;
    return { blocked: null, containerSeen };
}

/**
 * One verdict-carrying read of a Job's status, translated to the four shapes every caller below
 * branches on: gone, an unexpected status, still running, or a terminal outcome. `readVerdict`
 * owns the transport/429/5xx/malformed-400 retry bound and THROWS once it is exhausted — every
 * caller propagates that (`pollJobToTerminal` re-throws it, `auxVerdict`,
 * `pollRunnerJobUntilTerminal`, the gate poll), wrapping it in its own shape when it needs to.
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
    errorStatus: (status: number, body: string) => string;
    failed: string | null;
}

/**
 * The pending arm's image watch for the polls whose Job runs the executor image (issue #302):
 * asks the pod whether the image is blocked — `readImagePullStatus` — and answers the failure
 * message when it is. Flips `seen.container` once any container status exists, so the pod list
 * is not re-read on later rounds after the image has pulled. Pulled out of the polls purely to
 * keep their complexity readable, the same move the gate poll makes.
 */
async function executorImageWatch(
    deps: K8sDeps,
    jobName: string,
    image: string,
    seen: { container: boolean }
): Promise<string | null> {
    const pull = await readImagePullStatus(deps, jobName);
    if (pull.blocked) return unpullableImage('executor', image, pull.blocked);
    seen.container = pull.containerSeen;
    return null;
}

/**
 * Poll one Job to a terminal status, the shape every aux Job readout shares: `readVerdict` owns
 * the transport/429/5xx/malformed-400 retry bound, a 404 means the Job is gone, any other non-2xx
 * is unexpected, and a terminal status answers `failed` on the Job's own failure (when the caller
 * names one) or null once there is a verdict to read — a Job failure with no `failed` message is
 * itself such a verdict, exactly like success. A read whose patience ran out — transport failures,
 * 429s, 5xx or the malformed-request 400 (issue #308), all infrastructure — RE-THROWS: it is not
 * this Job's verdict, and a caller that must never see a throw wraps the poll itself (the
 * opencode scrape does; the sync and reclaim callers let it propagate so the loop leaves the job
 * to its lease). Callers whose Job runs the executor image pass its name as `image`:
 * while the pod is still pending, the poll then watches for an image the node cannot pull and
 * answers `unpullableImage` the moment the pod says so (issue #302), instead of letting the Job
 * sit in ImagePullBackOff until its deadline makes the verdict unreadable.
 */
export async function pollJobToTerminal(
    deps: K8sDeps,
    jobName: string,
    messages: PollToTerminalMessages,
    image: string | null = null
): Promise<string | null> {
    const seen = { container: false };
    const pollPending = async (): Promise<string | null> => {
        if (!seen.container && image !== null) {
            const failure = await executorImageWatch(deps, jobName, image, seen);
            if (failure) return failure;
        }
        await deps.sleep(POLL_MS);
        return poll();
    };
    const poll = async (): Promise<string | null> => {
        const result = await readJobStatus(deps, jobName, messages.what);
        if (result.kind === 'notFound') return messages.notFound(jobName);
        if (result.kind === 'error') return messages.errorStatus(result.status, result.body);
        if (result.kind === 'pending') return pollPending();
        if (result.outcome === 'failed') return messages.failed;
        return null;
    };
    return poll();
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
): Promise<{ exitCode: number | null; output: string; pods: K8sPod[] }> {
    const podsResponse = await readVerdict(deps, jobPodsPath(deps.config.k8sNamespace, jobName), what);
    expectOk(podsResponse, what);
    const pods = parse<K8sPodList>(podsResponse.body).items ?? [];
    const pod = livePodOfItems(pods);
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
    return { exitCode, output, pods };
}

/**
 * Why a runner Job that failed inside its deadline was taken away rather than ended by its agent
 * (issue #560), or null when its pod says the agent ended it: no live pod left (deleted, drained,
 * its node removed), or one the kubelet evicted or the control plane marked a disruption target.
 */
export function runnerLossOf(pods: readonly K8sPod[]): string | null {
    const live = livePodOfItems([...pods]);
    const pod = live ?? pods[0];
    const disruption = pod?.status?.conditions?.find((c) => c.type === 'DisruptionTarget' && c.status === 'True');
    const evicted = pod?.status?.reason === 'Evicted';
    const said = disruption
        ? [disruption.reason, disruption.message]
        : evicted
          ? [pod?.status?.reason, pod?.status?.message]
          : [];
    const detail = said.filter(Boolean).join(': ');
    if (live && !disruption && !evicted) return null;
    const what = live
        ? 'the runner pod was taken away before it exited'
        : 'the runner pod was deleted before it exited';
    return `${what} (${detail || 'evicted, drained or its node removed'})`;
}

/**
 * Runs one aux Job to its verdict: poll the Job to a terminal status with the same bounded
 * patience every verdict-carrying read has, then read the exit code off its pod and the output
 * off the pod's log — the same discovery (job-name label, terminating pods skipped) and the same
 * succeeded-with-no-pod convention the runner's own verdict read applies. Used by the publish
 * steps and the claude-turns close read, whose every container is exactly this shape.
 */
export async function auxVerdict(
    deps: K8sDeps,
    jobName: string,
    signal?: AbortSignal
): Promise<{ exitCode: number | null; output: string }> {
    if (signal?.aborted) throw new Error(`the job ${jobName} was cancelled`);
    const result = await readJobStatus(deps, jobName, `reading the job ${jobName}`);
    if (result.kind === 'notFound') {
        throw new Error(`the job ${jobName} no longer exists`);
    }
    if (result.kind === 'error') throw new Error(refusal(result, `reading the job ${jobName}`)!);
    if (result.kind === 'pending') {
        await deps.sleep(POLL_MS);
        return auxVerdict(deps, jobName, signal);
    }
    return readJobPodVerdict(deps, jobName, result.outcome === 'succeeded', `listing the pods of ${jobName}`);
}

/**
 * A block-helper aux Job's verdict (issue #207) — `auxVerdict`'s shape, plus whether the
 * kubelet's own `activeDeadlineSeconds` is what ended it, the same `DeadlineExceeded` condition
 * check `pollRunnerJobUntilTerminal` makes for the runner Job. A helper that outlives its bound is
 * reported as a named `timeout` failure by its caller, never an ordinary exit. An aborted `signal`
 * ends the poll by throwing, like `auxVerdict`.
 */
export async function helperVerdict(
    deps: K8sDeps,
    jobName: string,
    signal?: AbortSignal
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
    if (signal?.aborted) throw new Error(`the helper job ${jobName} was cancelled`);
    const result = await readJobStatus(deps, jobName, `reading the helper job ${jobName}`);
    if (result.kind === 'notFound') {
        throw new Error(`the helper job ${jobName} no longer exists`);
    }
    if (result.kind === 'error') throw new Error(refusal(result, 'reading the helper job')!);
    if (result.kind === 'pending') {
        await deps.sleep(POLL_MS);
        return helperVerdict(deps, jobName, signal);
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
 * treated as the run's verdict. While the Job is still pending, the poll also watches for an
 * executor image the node cannot pull (issue #302) and fails the run naming it, instead of
 * burning the deadline and reporting a timeout over what is really "no such image".
 */
export async function pollRunnerJobUntilTerminal(
    deps: K8sDeps,
    job: BoardJob,
    onOutput: ((tail: string) => void) | undefined,
    podName: string | null = null
): Promise<{ timedOut: boolean; jobSucceeded: boolean }> {
    const image = executorImage(deps.config, job.executorType);
    const seen = { container: false };
    const poll = async (pod: string | null): Promise<{ timedOut: boolean; jobSucceeded: boolean }> => {
        const result = await readJobStatus(deps, runnerName(job), 'reading the runner job');
        if (result.kind === 'notFound') {
            // Gone without this driver deleting it — fenced away or removed by hand. Its verdict can
            // never arrive, so waiting longer is holding a slot for nothing.
            throw vanishedRunner(runnerName(job));
        }
        if (result.kind === 'error') throw new Error(refusal(result, 'reading the runner job')!);
        if (result.kind === 'terminal') {
            return { timedOut: timedOutOf(result.status), jobSucceeded: result.outcome === 'succeeded' };
        }
        if (!seen.container) {
            const failure = await executorImageWatch(deps, runnerName(job), image, seen);
            if (failure) throw new Error(failure);
        }
        const nextPodName = onOutput ? await tailRunnerOutput(deps, job, pod, onOutput) : pod;
        await deps.sleep(POLL_MS);
        return poll(nextPodName);
    };
    return poll(podName);
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
): Promise<{
    exitCode: number | null;
    output: string;
    fullLog: string;
    logTruncated: boolean;
    infraLoss: string | null;
}> {
    const verdict = await readJobPodVerdict(deps, runnerName(job), jobSucceeded, 'listing the runner pods');
    // The tail for the verdict's output field, and the full log (issue #325) tail-kept at the
    // artifact cap for the loop's upload — both cut from the one pod log this read exists for.
    const full = tailKept(verdict.output, ARTIFACT_LIMIT);
    return {
        exitCode: verdict.exitCode,
        output: reportTail(verdict.output),
        fullLog: full.content,
        logTruncated: full.truncated,
        infraLoss: jobSucceeded ? null : runnerLossOf(verdict.pods),
    };
}

/**
 * The verdict is the pod log — one JSON line, the same answer the docker sync/reclaim containers
 * print. A pod gone before its log could be read is a failed run: running on a tree of unknown
 * state would compound whatever went wrong. Empty for anything unreadable. `failure` is the
 * container's own status when it ended badly — a container that never started (an image with no
 * `node`) has no log at all, and its status is the only place the cause survives.
 *
 * `why` is issue #344's answer to the bare unreadable verdict: WHEN the log is empty, it names the
 * exact cause — no live pod (with the count), a refused or throwing read, or a container that
 * really printed nothing — so the caller can fold it into the failure reason it reports. By the
 * time anyone reads a failed sync, the Job has been reaped by its TTL and its pod events have
 * expired; this string is the only place the cause survives. Null whenever the log was read.
 */
async function readJobLog(
    deps: K8sDeps,
    jobName: string
): Promise<{ log: string; failure: string | null; why: string | null }> {
    let failure: string | null = null;
    let pods: K8sResponse;
    try {
        pods = await deps.request('GET', jobPodsPath(deps.config.k8sNamespace, jobName));
    } catch (e) {
        return {
            log: '',
            failure: null,
            why: `the pod list of ${jobName} could not be read: ${(e as Error).message}`,
        };
    }
    if (pods.status >= HTTP_ERROR_STATUS) {
        return { log: '', failure: null, why: `the pod list of ${jobName} ${answerPreview(pods.status, pods.body)}` };
    }
    const items = parse<K8sPodList>(pods.body).items ?? [];
    const pod = livePodOfItems(items);
    failure = containerFailure(pod);
    if (!pod) {
        const why =
            items.length === 0
                ? `no live pod for ${jobName} (none listed)`
                : `no live pod for ${jobName} (${items.length} listed, all terminating)`;
        return { log: '', failure, why };
    }
    const name = pod.metadata?.name;
    if (!name) {
        return { log: '', failure, why: `the live pod of ${jobName} has no name` };
    }
    let log: K8sResponse;
    try {
        log = await deps.request('GET', podLogPath(deps.config.k8sNamespace, name, null));
    } catch (e) {
        return { log: '', failure, why: `the log of ${name} could not be read: ${(e as Error).message}` };
    }
    if (log.status >= HTTP_ERROR_STATUS) {
        return { log: '', failure, why: `the log of ${name} ${answerPreview(log.status, log.body)}` };
    }
    if (log.body.trim() === '') {
        return {
            log: '',
            failure,
            why: `the container printed nothing (pod ${name}, phase ${pod.status?.phase ?? 'unknown'})`,
        };
    }
    return { log: log.body, failure, why: null };
}

/**
 * The unreadable-verdict detail the sync/reclaim callers fold into their reason: WHY the verdict
 * line could not be read — `readJobLog`'s empty-log cause when it has one, else the last log line
 * itself, preview-bounded like every other error preview (issue #344).
 */
function unreadableDetail(log: string, why: string | null): string {
    if (why) return why;
    const line = log.trim().split('\n').filter(Boolean).pop() ?? '';
    return `last log line ${JSON.stringify(line.slice(0, ERROR_PREVIEW_CHARS))}`;
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
    const restore = claimRestoresTree(job);
    const env = restore ? {} : envBodyToData(envFileBody(job));
    if (Object.keys(env).length) {
        const response = await deps.request(
            'POST',
            secretsPath(deps.config.k8sNamespace),
            secretBody(job, syncEnvSecretName(job), env)
        );
        const refused = postRefusal(response, 'creating the sync secret');
        if (refused) return { ok: false, reason: refused };
        secretRef.current = syncEnvSecretName(job);
    }
    const create = await deps.request(
        'POST',
        jobsPath(deps.config.k8sNamespace),
        syncJobSpec(deps.config, job, secretRef.current)
    );
    const refusedCreate = postRefusal(create, 'creating the worktree sync job');
    if (refusedCreate) return { ok: false, reason: refusedCreate };
    const jobName = syncJobName(job);
    const pollFailure = await pollJobToTerminal(
        deps,
        jobName,
        {
            what: 'reading the worktree sync job',
            notFound: (n) => `the worktree sync job ${n} no longer exists`,
            errorStatus: (s, b) => `reading the worktree sync job ${answerPreview(s, b)}`,
            failed: null,
        },
        executorImage(deps.config, job.executorType)
    );
    if (pollFailure) return { ok: false, reason: pollFailure };
    const { log, failure, why } = await readJobLog(deps, jobName);
    return parseLastJsonLine<SyncResult>(log, () =>
        failure
            ? { ok: false, reason: `the worktree sync container failed: ${failure}` }
            : { ok: false, reason: `${syncUnreadable.reason}: ${unreadableDetail(log, why)}` }
    );
}

/**
 * The reclaim Job itself: create, poll to terminal, read the verdict line. No Secret, no env:
 * removing needs nothing the claim held. Pulled out of `reclaimWorktree` purely to keep that
 * method's complexity readable — the same duplication `runSyncJob` closes for the sync.
 */
export async function runReclaimJob(deps: K8sDeps, job: BoardJob): Promise<ReclaimResult> {
    const create = await deps.request('POST', jobsPath(deps.config.k8sNamespace), reclaimJobSpec(deps.config, job));
    const refused = postRefusal(create, 'creating the worktree reclaim job');
    if (refused) return { ok: false, removed: false, reason: refused };
    const jobName = reclaimJobName(job);
    const pollFailure = await pollJobToTerminal(
        deps,
        jobName,
        {
            what: 'reading the worktree reclaim job',
            notFound: (n) => `the worktree reclaim job ${n} no longer exists`,
            errorStatus: (s, b) => `reading the worktree reclaim job ${answerPreview(s, b)}`,
            failed: null,
        },
        executorImage(deps.config, job.executorType)
    );
    if (pollFailure) return { ok: false, removed: false, reason: pollFailure };
    const { log, failure, why } = await readJobLog(deps, jobName);
    return parseLastJsonLine<ReclaimResult>(log, () =>
        failure
            ? { ok: false, removed: false, reason: `the worktree reclaim container failed: ${failure}` }
            : { ok: false, removed: false, reason: `${reclaimUnreadable.reason}: ${unreadableDetail(log, why)}` }
    );
}
