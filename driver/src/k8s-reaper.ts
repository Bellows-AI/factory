import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import {
    HTTP_CONFLICT,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_OK_STATUS,
    JOB_ID,
    parse,
    type K8sRequest,
    type K8sResponse,
} from './k8s-transport.js';
import {
    claimName,
    configmapsPath,
    podsPath,
    publishEnvSecretName,
    secretsPath,
    servicesPath,
    syncEnvSecretName,
} from './k8s-auxspec.js';
import { gateEnvSecretName, secretName } from './k8s-podspec.js';
import { JOB_LABEL, LEASE_LABEL, SERVICE_LABEL } from './labels.js';
import type { OrphanGroup, OrphanObject, ReaperArm, ReapVerdict } from './reaper.js';

/**
 * The kubernetes half of the orphan reaper (issue #301): enumerate the service fleet the driver's
 * crashed attempts left behind, and delete it when the board condemns the owning job. The
 * counterpart of the re-claim fence — the fence acts on the job label at CLAIM time, under the
 * checkout claim; this arm acts on it when the BOARD says no claim can ever be taken again.
 *
 * RBAC needs nothing new: `list` on pods and services is the fence's grant, `delete` on all four
 * kinds is already the chart's Role. `list secrets` stays deliberately ungranted — which is why
 * the attempt-scoped env Secrets are reaped by DERIVED NAME, never enumerated. The runner, sync,
 * gate and publish env Secrets' names all hash the same (job id, lease token) pair the labels
 * carry, so they are derivable; the HELPER env Secret's name carries a caller-minted nonce and is
 * not — it remains the stated residual, holding bytes rather than CPU, memory and disk
 * (docs/kubernetes.md).
 */

/** The two status codes a reaper delete can answer with that mean "already going away". */
const GONE_STATUSES: readonly number[] = [HTTP_NOT_FOUND, HTTP_CONFLICT];

/** Every kind the arm deletes, with its collection path — one table, not a branch per kind. */
const basePathOf = (config: DriverConfig): Record<OrphanObject['kind'], string> => ({
    pod: podsPath(config.k8sNamespace),
    service: servicesPath(config.k8sNamespace),
    // The docker-only kinds never reach this arm's table; the record must still be total.
    container: '',
    network: '',
});

/**
 * The (job id, lease token) pair, dressed as the BoardJob the shared naming helpers read — they
 * touch exactly these two fields and assert both are uuids, and this call site has already
 * tested both before reaching here.
 */
const attemptPair = (jobId: string, leaseToken: string): BoardJob => ({ id: jobId, leaseToken }) as BoardJob;

interface ListedItem {
    metadata?: {
        name?: string;
        labels?: Record<string, string>;
        creationTimestamp?: string;
    };
}

/** One label-selector collection GET, parsed into the fields the grouping needs. */
const listBySelector = async (request: K8sRequest, path: string): Promise<ListedItem[] | null> => {
    let response: K8sResponse;
    try {
        response = await request('GET', path);
    } catch {
        return null;
    }
    if (response.status < HTTP_OK_STATUS || response.status >= HTTP_ERROR_STATUS) return null;
    return parse<{ items?: ListedItem[] }>(response.body).items ?? [];
};

/** The selector: objects carrying BOTH labels (so runner/gate/sync pods never answer), scoped to
 * this chart release when one is configured — two releases sharing a namespace must never reap
 * each other's fleets as "unknown jobs". */
const selectorFor = (config: DriverConfig): string => {
    const terms = [JOB_LABEL, SERVICE_LABEL];
    if (config.k8sRelease) terms.push(`app.kubernetes.io/instance=${config.k8sRelease}`);
    return terms.join(',');
};

/** One listed item → its identity and age, or null when the row cannot be named or dated. */
const groupKeyOf = (
    item: ListedItem,
    kind: OrphanObject['kind']
): {
    jobId: string;
    leaseToken: string;
    name: string;
    object: OrphanObject;
    createdAtMs: number;
} | null => {
    const name = item.metadata?.name;
    const jobId = item.metadata?.labels?.[JOB_LABEL];
    const leaseToken = item.metadata?.labels?.[LEASE_LABEL];
    const created = item.metadata?.creationTimestamp;
    if (!name || !jobId || !leaseToken || created === undefined) return null;
    const createdAtMs = Date.parse(created);
    if (Number.isNaN(createdAtMs)) return null;
    const object: OrphanObject = { kind, name };
    return { jobId, leaseToken, name, object, createdAtMs };
};

const mergeIntoGroups = (
    groups: Map<string, OrphanGroup>,
    key: string,
    found: NonNullable<ReturnType<typeof groupKeyOf>>
): void => {
    const existing = groups.get(key);
    if (existing) {
        existing.objects.push(found.object);
        if (found.createdAtMs < existing.createdAtMs) existing.createdAtMs = found.createdAtMs;
    } else {
        groups.set(key, {
            jobId: found.jobId,
            leaseToken: found.leaseToken,
            createdAtMs: found.createdAtMs,
            objects: [found.object],
        });
    }
};

const scan = async (config: DriverConfig, request: K8sRequest): Promise<OrphanGroup[]> => {
    const selector = encodeURIComponent(selectorFor(config));
    const namespace = config.k8sNamespace;
    const pods = await listBySelector(request, `${podsPath(namespace)}?labelSelector=${selector}`);
    if (pods === null) return [];
    const services = await listBySelector(request, `${servicesPath(namespace)}?labelSelector=${selector}`);
    if (services === null) return [];

    const groups = new Map<string, OrphanGroup>();
    for (const { kind, items } of [
        { kind: 'pod' as const, items: pods },
        { kind: 'service' as const, items: services },
    ]) {
        for (const item of items) {
            const found = groupKeyOf(item, kind);
            if (found) mergeIntoGroups(groups, `${found.jobId}|${found.leaseToken}`, found);
        }
    }
    return [...groups.values()];
};

/** Deletes one named object, answering whether THIS call removed it (2xx) or it was already
 * going (404/409); a transport rejection or an unexpected status is the next round's problem. */
const deleteNamed = async (request: K8sRequest, path: string): Promise<boolean> => {
    try {
        const response = await request('DELETE', path);
        if (response.status >= HTTP_ERROR_STATUS && !GONE_STATUSES.includes(response.status)) return false;
        return response.status < HTTP_ERROR_STATUS;
    } catch {
        return false;
    }
};

/** The attempt-scoped env Secrets, re-derived through the builders that created them. */
const derivedSecretPaths = (config: DriverConfig, group: OrphanGroup): string[] => {
    const job = attemptPair(group.jobId, group.leaseToken!);
    const namespace = config.k8sNamespace;
    // Every one of these hashes the same (job id, lease token) pair the labels carry — see the
    // file header for why the helper env Secret is the one left out.
    return [secretName(job), syncEnvSecretName(job), gateEnvSecretName(job), publishEnvSecretName(job)].map(
        (name) => `${secretsPath(namespace)}/${name}`
    );
};

const uuidScoped = (group: OrphanGroup): group is OrphanGroup & { leaseToken: string } =>
    group.leaseToken !== null && JOB_ID.test(group.jobId) && JOB_ID.test(group.leaseToken);

const reap = async (
    config: DriverConfig,
    request: K8sRequest,
    group: OrphanGroup,
    verdict: ReapVerdict
): Promise<readonly string[]> => {
    const paths = basePathOf(config);
    const removed: string[] = [];
    for (const object of group.objects) {
        if (await deleteNamed(request, `${paths[object.kind]}/${object.name}?propagationPolicy=Foreground`)) {
            removed.push(`${object.kind} ${object.name}`);
        }
    }
    if (!uuidScoped(group)) return removed;
    // The attempt-scoped env Secrets and, on a provably dead job, the checkout claim: answered
    // in the log like the fleet's objects, so "is the reaper running?" stays answerable from a
    // round that only cleaned Secrets.
    for (const path of derivedSecretPaths(config, group)) {
        if (await deleteNamed(request, path)) removed.push(`secret ${path.split('/').pop()}`);
    }
    // The checkout claim is JOB-scoped — the one name a replacement attempt can hold — so only a
    // provably dead job's claim may be removed. A superseded attempt's group must never touch
    // it: the live attempt's fence is holding it right now.
    if (verdict === 'gone') {
        const claim = `${configmapsPath(config.k8sNamespace)}/${claimName(attemptPair(group.jobId, group.leaseToken))}?propagationPolicy=Foreground`;
        if (await deleteNamed(request, claim)) removed.push(`claim ${claim.split('/').pop()}`);
    }
    return removed;
};

/**
 * The arm. See the file header for the posture; `scan` is two collection GETs, `reap` is one
 * Foreground delete per named object plus the derived-name Secret deletes and — only on a
 * provably dead job — the checkout claim.
 */
export function createKubernetesReaper({ config, request }: { config: DriverConfig; request: K8sRequest }): ReaperArm {
    return {
        scan: () => scan(config, request),
        reap: (group, verdict) => reap(config, request, group, verdict),
    };
}
