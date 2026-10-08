import type { BoardJob } from './board.js';
import {
    SERVICE_LOG_TAIL_LINES,
    SERVICE_READY_POLL_MS,
    SERVICE_RESTART_TIMEOUT_MS,
    SERVICE_RESTART_TIMEOUT_S,
} from './runner.js';
import type { DeadService, RunOutcome } from './runner.js';
import {
    deleteJob,
    eventsForPath,
    jobPodsPath,
    podLogPath,
    podsByLeasePath,
    podsPath,
    servicesByLeasePath,
    servicesPath,
    servicePodName,
    servicePodSpec,
    serviceDnsSpec,
} from './k8s-auxspec.js';
import { bellowsJobSpec, jobsPath } from './k8s-podspec.js';
import { pollJobToTerminal, readVerdict } from './k8s-poll.js';
import {
    answerPreview,
    expectOk,
    HTTP_ERROR_STATUS,
    livePod,
    parse,
    parseDeadServicePods,
    parseServicePods,
} from './k8s-transport.js';
import type { K8sDeps, K8sResponse } from './k8s-transport.js';
import {
    awaitServicesRunning,
    collectServices,
    declaredServiceSpecs,
    forgetDeclaredServices,
    missingDeclaredServices,
    recordDeclaredServices,
    splitBellowsSections,
} from './services.js';
import type { ServiceSpec } from './services.js';

/**
 * A declared service under kubernetes: read `.bellows.yaml` through a throwaway readout Job, then
 * start each declared service as a Pod with a headless Service as its DNS name — and the fleet's
 * teardown, by lease label, at the run's close. See docs/kubernetes.md's "A declared service is a
 * Pod with a headless Service as its DNS name".
 */

/**
 * The `.bellows.yaml` readout, as a Job: the same script docker runs in a throwaway container,
 * over a read-only PVC mount. Runs to terminal status, its log IS the output the section splitter
 * consumes, and the Job goes as soon as it is read. A readout that cannot run is infrastructure —
 * so every failure here throws and the job goes back to its lease.
 */
async function readBellows(deps: K8sDeps, job: BoardJob): Promise<string> {
    const spec = bellowsJobSpec(deps.config, job);
    const jobName = spec.metadata.name;
    try {
        const created = await deps.request('POST', jobsPath(deps.config.k8sNamespace), spec);
        expectOk(created, 'creating the .bellows.yaml readout');
        const pollFailure = await pollJobToTerminal(deps, jobName, {
            what: 'the .bellows.yaml readout',
            notFound: (n) => `the .bellows.yaml readout ${n} no longer exists`,
            errorStatus: (s, b) => `reading the .bellows.yaml readout ${answerPreview(s, b)}`,
            failed: 'the .bellows.yaml readout failed — its own deadline is its bound',
        });
        if (pollFailure !== null) throw new Error(pollFailure);
        const podsResponse = await readVerdict(
            deps,
            jobPodsPath(deps.config.k8sNamespace, jobName),
            'listing the readout pods'
        );
        const pod = livePod(podsResponse.body);
        if (!pod?.metadata?.name) {
            throw new Error('the .bellows.yaml readout left no pod to read its output from');
        }
        const log = await readVerdict(
            deps,
            podLogPath(deps.config.k8sNamespace, pod.metadata.name, null),
            'reading the readout log'
        );
        if (log.status >= HTTP_ERROR_STATUS) {
            throw new Error(`reading the .bellows.yaml readout's log ${answerPreview(log.status, log.body)}`);
        }
        return log.body;
    } finally {
        void deleteJob(deps, jobName);
    }
}

/**
 * This attempt's service fleet — every pod and headless Service carrying this attempt's lease
 * label AND the service label — deleted by name. Every delete is best-effort: a 404 is the
 * ordinary end of an already-reaped object, a 409 a concurrent fence's, and anything else is the
 * next attempt's fence's business.
 */
async function sweepFleetKind(deps: K8sDeps, listPath: string, basePath: string): Promise<void> {
    let response: K8sResponse;
    try {
        response = await deps.request('GET', listPath);
    } catch {
        return;
    }
    if (response.status >= HTTP_ERROR_STATUS) return;
    const items = parse<{ items?: { metadata?: { name?: string } }[] }>(response.body).items ?? [];
    for (const item of items) {
        if (!item.metadata?.name) continue;
        await deps.request('DELETE', `${basePath}/${item.metadata.name}`).catch(() => undefined);
    }
}

/**
 * The attempt's declared services, torn down by lease: on kill, on a refused start, and — through
 * the runner's releaseServices — once the loop's declared gates are done with them.
 */
export async function teardownServices(deps: K8sDeps, job: BoardJob): Promise<void> {
    forgetDeclaredServices(job);
    for (const [listPath, basePath] of [
        [podsByLeasePath(deps.config.k8sNamespace, job), podsPath(deps.config.k8sNamespace)],
        [servicesByLeasePath(deps.config.k8sNamespace, job), servicesPath(deps.config.k8sNamespace)],
    ] as const) {
        await sweepFleetKind(deps, listPath, basePath);
    }
}

/**
 * The attempt's dead services (issue #423), each with its last log lines — read before the
 * teardown deletes the pods, the only place the cause survives. The fleet list is the sample's
 * own lease selector; one that cannot be read throws. A log that cannot be read costs its tail,
 * never the finding.
 */
export async function deadServices(deps: K8sDeps, job: BoardJob): Promise<DeadService[]> {
    if (!deps.config.servicesEnabled) return [];
    const found = await deps.request('GET', podsByLeasePath(deps.config.k8sNamespace, job));
    expectOk(found, 'listing the service pods');
    const out: DeadService[] = [];
    // A declared service whose pod is not listed at all — deleted by hand, drained — is dead too.
    for (const gone of missingDeclaredServices(job, parseServicePods(found.body))) {
        const reason = await vanishedPodReason(deps, servicePodName(job, gone.name));
        out.push({ ...gone, exitCode: null, reason, logTail: '' });
    }
    for (const { pod, ...dead } of parseDeadServicePods(found.body)) {
        const log = await deps
            .request('GET', podLogPath(deps.config.k8sNamespace, pod, SERVICE_LOG_TAIL_LINES))
            .catch(() => null);
        out.push({ ...dead, logTail: log && log.status < HTTP_ERROR_STATUS ? log.body : '' });
    }
    return out;
}

/** What a pod gone without a word was told last, when nobody wrote its events: the usual takers. */
export const VANISHED_POD_REASON = 'pod deleted — evicted, drained or its node removed';

/**
 * Why a listed-no-more pod went (issue #560): its newest event, `reason: message`, while the
 * events outlive it — or VANISHED_POD_REASON when none can be read. Best-effort: a read that
 * fails costs the detail, never the finding.
 */
async function vanishedPodReason(deps: K8sDeps, pod: string): Promise<string> {
    const read = await deps.request('GET', eventsForPath(deps.config.k8sNamespace, pod)).catch(() => null);
    if (!read || read.status >= HTTP_ERROR_STATUS) return VANISHED_POD_REASON;
    type K8sEvent = { reason?: string; message?: string; lastTimestamp?: string; eventTime?: string };
    const events = parse<{ items?: K8sEvent[] }>(read.body).items ?? [];
    // `events.k8s.io` writes a MicroTime `eventTime` and no `lastTimestamp`: compared as instants.
    const at = (event: K8sEvent): number => Date.parse(event.lastTimestamp ?? event.eventTime ?? '') || 0;
    const last = [...events].sort((a, b) => at(a) - at(b)).pop();
    if (!last?.reason) return VANISHED_POD_REASON;
    return last.message ? `${last.reason}: ${last.message}` : last.reason;
}

/**
 * Starts the attempt's fleet: its one headless DNS Service, then each declared service's Pod
 * under it. Every name is attempt-scoped (serviceSubdomain), so nothing here can collide with a
 * concurrent job — any failure is infrastructure and throws, the partial fleet torn down on the
 * way out exactly as docker's is.
 */
async function startFleet(deps: K8sDeps, job: BoardJob, specs: ServiceSpec[]): Promise<void> {
    let current = 'the service DNS name';
    try {
        const dns = await deps.request(
            'POST',
            servicesPath(deps.config.k8sNamespace),
            serviceDnsSpec(deps.config, job)
        );
        expectOk(dns, 'creating the service DNS name');
        // The Service's uid is what makes every service pod an owned pod rather than a standalone
        // one (issue #363): an apiserver always stamps it, so an answer without one is a lying
        // proxy — and the pods it would leave behind are exactly the pods an enforcing CNI may
        // not confine. Fail loud instead of starting an owner-less fleet.
        const uid = parse<{ metadata?: { uid?: string } }>(dns.body).metadata?.uid;
        if (!uid) throw new Error('the service DNS name answered no uid — service pods would start standalone');
        for (const spec of specs) {
            current = `service "${spec.name}"`;
            const pod = await deps.request(
                'POST',
                podsPath(deps.config.k8sNamespace),
                servicePodSpec(deps.config, job, spec, uid)
            );
            expectOk(pod, 'creating the service pod');
        }
    } catch (e) {
        await teardownServices(deps, job);
        throw new Error(`could not start ${current}: ${(e as Error).message}`);
    }
}

/** Reads and parses `.bellows.yaml` into its declared services, or the parse refusal. */
async function readServiceSpecs(
    deps: K8sDeps,
    job: BoardJob
): Promise<{ specs: ServiceSpec[]; refusal: string | null }> {
    let raw: string;
    try {
        raw = await readBellows(deps, job);
    } catch (e) {
        throw new Error(`could not read .bellows.yaml: ${(e as Error).message}`);
    }
    try {
        return { specs: collectServices(splitBellowsSections(raw)), refusal: null };
    } catch (e) {
        return { specs: [], refusal: (e as Error).message };
    }
}

/**
 * The k8s form of docker.ts's setup: read the checkouts' `.bellows.yaml` through a throwaway
 * readout Job, then start each declared service as a Pod with a headless Service as its DNS name.
 * Answers a terminal `RunOutcome` for an author's parse refusal, or `null` to continue toward
 * the runner.
 */
export async function startServiceFleet(deps: K8sDeps, job: BoardJob): Promise<RunOutcome | null> {
    if (!deps.config.servicesEnabled) return null;
    const { specs, refusal } = await readServiceSpecs(deps, job);
    if (refusal !== null) {
        return { exitCode: null, output: refusal, timedOut: false, started: true, refused: true };
    }
    if (specs.length > 0) {
        await startFleet(deps, job, specs);
        recordDeclaredServices(job, specs);
    }
    return null;
}

/**
 * Polls until this attempt's fleet — pods and DNS Service — is out of the listing, or throws.
 * Returns the time waited, which the restart's readiness wait does not get again.
 */
async function awaitFleetGone(deps: K8sDeps, job: BoardJob): Promise<number> {
    const paths = [podsByLeasePath(deps.config.k8sNamespace, job), servicesByLeasePath(deps.config.k8sNamespace, job)];
    for (let waited = 0; ; waited += SERVICE_READY_POLL_MS) {
        let left = 0;
        for (const path of paths) {
            const listed = await deps.request('GET', path).catch(() => null);
            left +=
                listed && listed.status < HTTP_ERROR_STATUS
                    ? (parse<{ items?: unknown[] }>(listed.body).items ?? []).length
                    : 1;
        }
        if (left === 0) return waited;
        if (waited >= SERVICE_RESTART_TIMEOUT_MS) {
            throw new Error(`the old service fleet was still terminating ${SERVICE_RESTART_TIMEOUT_S}s on`);
        }
        await deps.sleep(SERVICE_READY_POLL_MS);
    }
}

/**
 * The pre-gate restart (issue #560): the recorded fleet torn down by lease, waited out of the
 * listing — a replacement pod takes its predecessor's name, and a terminating one answers 409 —
 * then started again and waited until every pod runs. Every failure throws.
 */
export async function restartServiceFleet(deps: K8sDeps, job: BoardJob): Promise<void> {
    const specs = declaredServiceSpecs(job);
    if (specs.length === 0) return;
    await teardownServices(deps, job);
    const fleetGoneWaited = await awaitFleetGone(deps, job);
    await startFleet(deps, job, specs);
    recordDeclaredServices(job, specs);
    await awaitServicesRunning(
        specs,
        async () => {
            const found = await deps.request('GET', podsByLeasePath(deps.config.k8sNamespace, job));
            expectOk(found, 'listing the service pods');
            // A pod Pending on an unpullable image never runs: listed as the dead one it is.
            const dead = new Set(parseDeadServicePods(found.body).map(({ name }) => name));
            return parseServicePods(found.body).map((pod) => (dead.has(pod.name) ? { ...pod, state: 'failed' } : pod));
        },
        deps.sleep,
        SERVICE_RESTART_TIMEOUT_MS - fleetGoneWaited
    );
}
