import type { BoardJob } from './board.js';
import type { RunOutcome } from './runner.js';
import {
    deleteJob,
    jobPodsPath,
    podLogPath,
    podsByLeasePath,
    podsPath,
    servicesByLeasePath,
    servicesPath,
    servicePodSpec,
    serviceDnsSpec,
} from './k8s-auxspec.js';
import { bellowsJobSpec, jobsPath } from './k8s-podspec.js';
import { pollJobToTerminal, readVerdict } from './k8s-poll.js';
import { ERROR_PREVIEW_CHARS, HTTP_CONFLICT, HTTP_ERROR_STATUS, livePod, parse } from './k8s-transport.js';
import type { K8sDeps, K8sResponse } from './k8s-transport.js';
import { collectServices, splitBellowsSections } from './services.js';
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
        if (created.status >= HTTP_ERROR_STATUS) {
            throw new Error(
                `creating the .bellows.yaml readout answered ${created.status}: ${created.body.slice(0, ERROR_PREVIEW_CHARS)}`
            );
        }
        const pollFailure = await pollJobToTerminal(deps, jobName, {
            what: 'the .bellows.yaml readout',
            notFound: (n) => `the .bellows.yaml readout ${n} no longer exists`,
            errorStatus: (s) => `reading the .bellows.yaml readout answered ${s}`,
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
            throw new Error(`reading the .bellows.yaml readout's log answered ${log.status}`);
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

/** The declared services go with the runner: torn down whenever the run ends, whatever it came back with. */
export async function teardownServices(deps: K8sDeps, job: BoardJob): Promise<void> {
    for (const [listPath, basePath] of [
        [podsByLeasePath(deps.config.k8sNamespace, job), podsPath(deps.config.k8sNamespace)],
        [servicesByLeasePath(deps.config.k8sNamespace, job), servicesPath(deps.config.k8sNamespace)],
    ] as const) {
        await sweepFleetKind(deps, listPath, basePath);
    }
}

/**
 * Starts one declared service's Pod and DNS Service, answering the namespace-collision refusal
 * message on a 409 or `null` on success — every other failure throws, torn down on the way out
 * exactly as docker's partial fleet is.
 */
async function startOneService(deps: K8sDeps, job: BoardJob, spec: ServiceSpec): Promise<string | null> {
    try {
        const pod = await deps.request(
            'POST',
            podsPath(deps.config.k8sNamespace),
            servicePodSpec(deps.config, job, spec)
        );
        if (pod.status >= HTTP_ERROR_STATUS) {
            throw new Error(
                `creating the service pod answered ${pod.status}: ${pod.body.slice(0, ERROR_PREVIEW_CHARS)}`
            );
        }
        const dns = await deps.request('POST', servicesPath(deps.config.k8sNamespace), serviceDnsSpec(job, spec));
        if (dns.status === HTTP_CONFLICT) {
            return (
                `.bellows.yaml: service "${spec.name}" is already running for another job in ` +
                'this namespace — a service name is shared across the namespace, and no ' +
                'first-wins or last-wins rule reads as anything but "the wrong database came up". ' +
                'Re-queue this job when the other one is done, or rename one of the services.'
            );
        }
        if (dns.status >= HTTP_ERROR_STATUS) {
            throw new Error(
                `creating the service DNS name answered ${dns.status}: ${dns.body.slice(0, ERROR_PREVIEW_CHARS)}`
            );
        }
        return null;
    } catch (e) {
        // A partial fleet is torn down on the way out, exactly as docker's is.
        await teardownServices(deps, job);
        throw new Error(`could not start service "${spec.name}": ${(e as Error).message}`);
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
 * Answers a terminal `RunOutcome` for an author's refusal (a parse refusal, or a namespace-global
 * service-name collision), or `null` to continue toward the runner.
 */
export async function startServiceFleet(deps: K8sDeps, job: BoardJob): Promise<RunOutcome | null> {
    if (!deps.config.servicesEnabled) return null;
    const parsed = await readServiceSpecs(deps, job);
    let refusal = parsed.refusal;
    if (!refusal) {
        for (const spec of parsed.specs) {
            const conflict = await startOneService(deps, job, spec);
            if (conflict) {
                refusal = conflict;
                break;
            }
        }
    }
    if (refusal !== null) {
        await teardownServices(deps, job);
        return { exitCode: null, output: refusal, timedOut: false, idled: false, started: true };
    }
    return null;
}
