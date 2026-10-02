import type { DriverConfig } from './config.js';

/**
 * The pod-spec field builders the driver renders from its own configuration — the resource
 * requests/limits (issue #360), the runner group's scheduling knobs (issue #361) and the
 * voluntary-disruption opt-out (issue #362). One file because each is "config in, one optional
 * pod-spec field out", every one absent when unconfigured so an untouched cluster sees the spec
 * it always saw, and both spec files (`k8s-podspec.ts`, `k8s-auxspec.ts`) spread them. See
 * docs/kubernetes.md for the module map.
 */

/** One side of the `resources` block: cpu and/or memory, kubernetes quantity strings verbatim. */
export interface ResourceList {
    cpu?: string;
    memory?: string;
}

/** The `resources` block itself: requests and/or limits, each side present only when configured. */
export interface PodResources {
    requests?: ResourceList;
    limits?: ResourceList;
}

/**
 * The configured resource requests and limits (RUNNER_CPU_REQUEST / RUNNER_MEMORY_REQUEST /
 * RUNNER_CPU_LIMIT / RUNNER_MEMORY_LIMIT) on a pod spec. Absent entirely when none are
 * configured, so the BestEffort pod a cluster saw before this existed is unchanged. Requests and
 * limits are independent slots: requests make the pod Burstable and are what Karpenter and the
 * Cluster Autoscaler size for; limits render only when set, because a memory limit on an agent
 * run turns a big build into an OOM kill mid-work — the requests-only posture the dashboard pod
 * keeps deliberately. The values travel verbatim; the config validated their shape at boot.
 */
export function resourcesField(config: DriverConfig): { resources?: PodResources } {
    const { cpuRequest, cpuLimit, memoryRequest, memoryLimit } = config.runnerResources;
    const requests: ResourceList = {
        ...(cpuRequest ? { cpu: cpuRequest } : {}),
        ...(memoryRequest ? { memory: memoryRequest } : {}),
    };
    const limits: ResourceList = {
        ...(cpuLimit ? { cpu: cpuLimit } : {}),
        ...(memoryLimit ? { memory: memoryLimit } : {}),
    };
    const resources: PodResources = {
        ...(Object.keys(requests).length > 0 ? { requests } : {}),
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
    };
    return Object.keys(resources).length > 0 ? { resources } : {};
}

/**
 * The runner group's scheduling knobs (RUNNER_NODE_SELECTOR / RUNNER_TOLERATIONS / RUNNER_AFFINITY,
 * issue #361) on a pod spec: the tainted node group agent-written code lands on and nothing else
 * schedules onto. Absent field by field when unset, so the spec an untainted cluster sees is
 * unchanged. Docker has no twin — the daemon decides placement, there is nothing to forward.
 */
export interface SchedulingField {
    nodeSelector?: Record<string, string>;
    tolerations?: Record<string, unknown>[];
    affinity?: Record<string, unknown>;
}

export function schedulingField(config: DriverConfig): SchedulingField {
    const field: SchedulingField = {};
    if (config.runnerNodeSelector) field.nodeSelector = config.runnerNodeSelector;
    if (config.runnerTolerations) field.tolerations = config.runnerTolerations;
    if (config.runnerAffinity) field.affinity = config.runnerAffinity;
    return field;
}

/**
 * The voluntary-disruption opt-out (issue #362), as pod metadata: both keys, because Karpenter
 * consolidation reads `karpenter.sh/do-not-disrupt` while the cluster-autoscaler's scale-down
 * reads `cluster-autoscaler.kubernetes.io/safe-to-evict`, and to an operator they are one switch,
 * not a vendor choice. Neither survives an explicit `kubectl drain` — a drain evicts through the
 * disruption API, which consults only PodDisruptionBudgets — and this annotation is not offered
 * for the chart's own pods, whose answer is pdb.yaml. Absent entirely when RUNNER_DO_NOT_DISRUPT
 * is off, so the spec an operator who has not opted in sees is unchanged — an undisruptable pod
 * pins its node for as long as the run lasts, which is the operator's decision to make, not the
 * driver's.
 */
export const DO_NOT_DISRUPT_ANNOTATIONS: Record<string, string> = {
    'karpenter.sh/do-not-disrupt': 'true',
    'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false',
};

export function doNotDisruptField(config: DriverConfig): { annotations?: Record<string, string> } {
    return config.runnerDoNotDisrupt ? { annotations: { ...DO_NOT_DISRUPT_ANNOTATIONS } } : {};
}

/**
 * The pod-level half of the executor hardening (issue #382): the runtime's own seccomp profile.
 * Pod level and not container level on purpose — seccomp applies to every container the pod ever
 * grows, so naming it once is what keeps a future sidecar from being born unfiltered.
 * `RuntimeDefault` is the container runtime's profile, which blocks the syscalls a container has
 * no business making (keyctl, the kernel module calls, the older namespace escapes) without the
 * per-image tuning a `Localhost` profile would need from every executor image.
 *
 * Unlike every other builder in this file this one takes no config and is never absent. The pods
 * it lands on run code the driver did not write — the agent's commands, the repository's scripts,
 * a gate, a declared service's image — and a hardening an operator can switch off is a hardening
 * that is off when it matters. Callers SPREAD it into `securityContext`, never assign over one:
 * the gate's `runAsUser`/`runAsGroup` lives in the same field, and an assignment drops whichever
 * of the two was written first.
 */
export interface PodSecurityContext {
    runAsUser?: number;
    runAsGroup?: number;
    seccompProfile?: { type: 'RuntimeDefault' };
}

export function podHardeningField(): { seccompProfile: { type: 'RuntimeDefault' } } {
    return { seccompProfile: { type: 'RuntimeDefault' } };
}

/**
 * The container-level half (issue #382), and the half with teeth:
 *
 *   - `capabilities.drop: [ALL]` — a capability is a slice of root the kernel hands a process
 *     without asking anyone, and an agent run needs none of them: it reads, writes and compiles
 *     inside its own worktree. Dropping them all is what makes `CAP_NET_RAW` (ARP-spoofing a
 *     neighbour pod, which no NetworkPolicy sees) and `CAP_DAC_OVERRIDE` (reading past the file
 *     modes on the shared workspaces claim) unavailable rather than merely unused.
 *   - `allowPrivilegeEscalation: false` — without it a setuid binary inside the image re-acquires
 *     what the drop removed, and the drop is decoration. The two are one control.
 *
 * `readOnlyRootFilesystem` is deliberately NOT here. An agent run writes its caches, its HOME and
 * its git worktree; a read-only root fails it on the first `npm install`. The workspace is the
 * writable surface by design — docs/security.md states it as a limit rather than leaving it to be
 * discovered.
 *
 * `drop` is rebuilt per call rather than shared: a single frozen array would be reachable from
 * every spec this process ever builds, and one caller mutating it would disarm all of them.
 */
export interface ContainerSecurityContext {
    allowPrivilegeEscalation: false;
    capabilities: { drop: string[] };
}

export function containerHardeningField(): { securityContext: ContainerSecurityContext } {
    return { securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } } };
}
