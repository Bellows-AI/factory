/**
 * The kubernetes executor: the second Runner, talking to the API server the way the docker one
 * talks to the daemon. This file is the thin entry point that composes the sibling `k8s-*.ts`
 * files into the public surface `driver/src/index.ts` and the test suite import:
 *
 * - `k8s-transport.ts` — the wire types (`K8sRequest`/`K8sResponse`), the real transport
 *   (`inClusterRequest`), and the protocol constants and status thresholds every other file reads.
 * - `k8s-podspec.ts` — the runner's own pure Job spec (`runnerJobSpec`, the `dockerArgs`
 *   analogue) plus the gate/bellows/claude-turns/opencode-readout spec builders and naming.
 * - `k8s-auxspec.ts` — the sync/reclaim/publish/service spec builders, and the shared checkout
 *   claim / per-attempt Secret naming and path helpers.
 * - `k8s-fence.ts` — the re-claim fence: claim acquire/release, the leftover sweep, and the
 *   pre/post-create claim verifies around the runner Job POST.
 * - `k8s-poll.ts` — Job-status polling to a terminal state, the live-output tail, and the
 *   sync/reclaim aux Job runners built on it.
 * - `k8s-services.ts` — the declared-service fleet: the `.bellows.yaml` readout, starting each
 *   service as a Pod + headless Service, and the lease-scoped teardown.
 * - `k8s-runner.ts` — `createKubernetesRunner` itself, composing the above into the `Runner`.
 * - `k8s-gates.ts` — `createKubernetesGateManager`, the second `GateManager`.
 *
 * Remote Control has no counterpart here — a tty held open, an auth volume, idle parking — so
 * `loadDriverConfig` refuses the combination outright rather than running a half-mode.
 */

export type { AuxJobSpec, GateJobSpecInput, RunnerJobSpec } from './k8s-podspec.js';
export {
    bellowsJobName,
    bellowsJobSpec,
    claudeTurnsJobName,
    claudeTurnsJobSpec,
    envBodyToData,
    gateEnvSecretName,
    gateJobName,
    gateJobSpec,
    jobsPath,
    opencodeReadoutJobName,
    opencodeReadoutJobSpec,
    runnerJobName,
    runnerJobSpec,
    secretName,
} from './k8s-podspec.js';

export type { PublishStepJobSpecInput } from './k8s-auxspec.js';
export {
    claimName,
    claimPath,
    configmapsPath,
    jobPath,
    podsByLeasePath,
    podsPath,
    podsSelectorPath,
    publishEnvSecretName,
    publishStepJobName,
    publishStepJobSpec,
    reclaimJobName,
    reclaimJobSpec,
    secretsPath,
    servicesByLeasePath,
    servicesPath,
    servicesSelectorPath,
    serviceDnsSpec,
    servicePodName,
    servicePodSpec,
    syncEnvSecretName,
    syncJobName,
    syncJobSpec,
} from './k8s-auxspec.js';

export type {
    InClusterRequestDeps,
    K8sClaim,
    K8sJobStatus,
    K8sMethod,
    K8sPodList,
    K8sRequest,
    K8sResponse,
} from './k8s-transport.js';
export { inClusterRequest, parsePodMetrics, parseServicePods, POLL_MAX_CONSECUTIVE_FAILURES } from './k8s-transport.js';

export { createKubernetesRunner } from './k8s-runner.js';
export { createKubernetesGateManager } from './k8s-gates.js';
