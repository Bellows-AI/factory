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

/** How one named delete landed: removed it this call, it was already going (404/409), or it
 * failed — a transport rejection or an unexpected status is the next round's problem. */
type DeleteResult = 'removed' | 'gone' | 'failed';

const deleteNamed = async (request: K8sRequest, path: string): Promise<DeleteResult> => {
    try {
        const response = await request('DELETE', path);
        if (response.status >= HTTP_ERROR_STATUS) return GONE_STATUSES.includes(response.status) ? 'gone' : 'failed';
        return 'removed';
    } catch {
        return 'failed';
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

/**
 * The attempt-scoped env Secrets, deleted FIRST — before the Pod and Service, and one failed
 * delete stops the round (answers false): a Secret has no ownerReferences, so once the listed
 * objects are gone no next scan can rediscover the (job, lease) pair these names are hashed
 * from. Already-gone Secrets (404/409) never hold the teardown back. The names hash the OLD
 * lease token, so this ordering never reaches a replacement attempt's resources.
 */
const reapDerivedSecrets = async (
    config: DriverConfig,
    request: K8sRequest,
    group: OrphanGroup & { leaseToken: string },
    removed: string[]
): Promise<boolean> => {
    for (const path of derivedSecretPaths(config, group)) {
        const result = await deleteNamed(request, path);
        if (result === 'failed') return false;
        if (result === 'removed') removed.push(`secret ${path.split('/').pop()}`);
    }
    return true;
};

const reap = async (
    config: DriverConfig,
    request: K8sRequest,
    group: OrphanGroup,
    verdict: ReapVerdict
): Promise<readonly string[]> => {
    const paths = basePathOf(config);
    const removed: string[] = [];
    if (uuidScoped(group) && !(await reapDerivedSecrets(config, request, group, removed))) return removed;
    for (const object of group.objects) {
        const result = await deleteNamed(request, `${paths[object.kind]}/${object.name}?propagationPolicy=Foreground`);
        if (result === 'removed') removed.push(`${object.kind} ${object.name}`);
    }
    if (!uuidScoped(group)) return removed;
    // The checkout claim is JOB-scoped — the one name a replacement attempt can hold — so only a
    // provably dead job's claim may be removed. A superseded attempt's group must never touch
    // it: the live attempt's fence is holding it right now. Deleted the fence's own way — read
    // first, delete THAT incarnation by uid precondition — so the removal can only ever reach
    // the exact object this call read, never one created after it; an unreadable or
    // unidentifiable claim is deferred to the next round rather than deleted on a maybe. (A
    // `gone` job can hold no live attempt, so any claim here is a leftover — the precondition is
    // what makes that argument structural instead of argued.) Answered in the log like the
    // fleet's objects, so "is the reaper running?" stays answerable from a round that only
    // cleaned Secrets.
    if (verdict === 'gone') {
        const claimPath = `${configmapsPath(config.k8sNamespace)}/${claimName(attemptPair(group.jobId, group.leaseToken))}`;
        try {
            const read = await request('GET', claimPath);
            const uid =
                read.status < HTTP_ERROR_STATUS
                    ? parse<{ metadata?: { uid?: string } }>(read.body).metadata?.uid
                    : undefined;
            if (!uid) return removed;
            const claim = `${claimPath}?propagationPolicy=Foreground`;
            const result = await request('DELETE', claim, {
                apiVersion: 'v1',
                kind: 'DeleteOptions',
                preconditions: { uid },
            });
            if (result.status < HTTP_ERROR_STATUS) removed.push(`claim ${claimPath.split('/').pop()}`);
        } catch {
            // Best effort: a leaked claim is taken over by the next claimant anyway.
        }
    }
    return removed;
};

/**
 * The arm. See the file header for the posture; `scan` is two collection GETs, `reap` is the
 * derived-name Secret deletes FIRST — one failure stops the round, since nothing rediscoverable
 * would survive it — then one Foreground delete per named object and — only on a provably dead
 * job — the checkout claim.
 */
export function createKubernetesReaper({ config, request }: { config: DriverConfig; request: K8sRequest }): ReaperArm {
    return {
        scan: () => scan(config, request),
        reap: (group, verdict) => reap(config, request, group, verdict),
    };
}
