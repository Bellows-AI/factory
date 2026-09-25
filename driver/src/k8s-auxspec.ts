import { JOB_LABEL, LEASE_LABEL, SERVICE_LABEL } from './labels.js';
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import { claimCarriesGithubToken, claimContinuesSession } from './claim.js';
import { HELPER_TIMEOUT_MS, helperInputValue } from './helpers.js';
import type { HelperDescriptor, HelperPlan } from './helpers.js';
import {
    auxJobSpec,
    hash16,
    jobsPath,
    pullSecretsField,
    releaseLabel,
    workspaceMount,
    type AuxJobSpec,
    workspaceSubPathOf,
} from './k8s-podspec.js';
import { JOB_ID, LOG_TAIL_LINES, MS_PER_SECOND } from './k8s-transport.js';
import type { K8sDeps } from './k8s-transport.js';
import {
    CREDENTIAL_HELPER,
    gitWorktreeRemoveScript,
    gitWorktreeScript,
    repoPath,
    worktreeBranch,
    worktreeDir,
} from './publish.js';
import type { PublishStep } from './publish.js';
import type { ServiceSpec } from './services.js';

/**
 * The kubernetes executor's auxiliary Job/pod spec builders: the startup sync, the terminal
 * reclaim, the publish steps and the declared-service pods — plus the shared naming and path
 * helpers (the checkout claim's ConfigMap, the runner's per-attempt Secret) every `k8s-*.ts` file
 * addresses these objects by. See docs/kubernetes.md for the full module map.
 */

/**
 * The startup sync (issue #35), ported: the docker runner creates the task worktree by running
 * the worktree script in a throwaway container; this executor runs the SAME script as a Job —
 * the same aux shape the gates and the `.bellows.yaml` readout use, over the same PVC. The one
 * deliberate difference: the mount is READ-WRITE, because the whole point is creating the
 * worktree the run will edit. The executor image carries both node and git, as the docker
 * sync container does.
 */
const SYNC_DEADLINE_SECONDS = 600;

export const syncJobName = (job: BoardJob): string => `factory-sync-${hash16(`${job.id}|${job.leaseToken}`)}`;

/**
 * The per-attempt Secret carrying the claim env for the sync's fetch — the credential travels
 * by reference (`envFrom`), the way it does for the runner and every gate. Created before the
 * Job, reaped with the verdict (or on a throw), the same accepted-leak posture as the other
 * attempt-scoped Secrets. Null when the claim resolved to nothing — the spec then names no
 * Secret at all, because a pod that references a missing Secret sits in
 * `CreateContainerConfigError`, and an env-less claim is a supported board configuration.
 */
export const syncEnvSecretName = (job: BoardJob): string => `factory-sync-${hash16(`${job.id}|${job.leaseToken}`)}-env`;

export function syncJobSpec(config: DriverConfig, job: BoardJob, envSecret: string | null): AuxJobSpec {
    if (!JOB_ID.test(job.id) || !JOB_ID.test(job.leaseToken)) {
        throw new Error(`refusing to sync job ${job.id}: its ids are not the uuids the board claims`);
    }
    const clone = repoPath(config, job);
    const worktree = worktreeDir(config, job);
    if (!clone || !worktree) {
        throw new Error(
            `refusing to sync job ${job.id}: the board reported a repo label this driver cannot resolve a task worktree for (${job.repo ?? 'none'})`
        );
    }
    return auxJobSpec(config, job, {
        name: syncJobName(job),
        deadlineSeconds: SYNC_DEADLINE_SECONDS,
        container: {
            name: 'worktree-sync',
            image: executorImage(config, job.executorType),
            imagePullPolicy: config.imagePullPolicy,
            command: ['node', '-e', gitWorktreeScript],
            env: [
                { name: 'REPO', value: clone },
                { name: 'WORKTREE', value: worktree },
                { name: 'BRANCH', value: worktreeBranch(job) },
                // Restore mode, as a literal: a claim that continues a session (a follow-up)
                // keeps the tree exactly as the run before it left it — no
                // fetch, no rebase, nothing that touches the remote (issue #58).
                ...(claimContinuesSession(job) ? [{ name: 'RESTORE', value: '1' }] : []),
                // The fetch's credential helper CODE — a literal that is code, the same class as
                // the three path literals above (the pin on literal credentials stays intact).
                // Only when the claim env carries the token the helper reads; the token itself
                // travels the Secret below, which git's spawned helper reads from the pod's
                // environment. A restore fetches nothing, so it never carries one.
                ...(!claimContinuesSession(job) && claimCarriesGithubToken(job)
                    ? [{ name: 'CRED_HELPER', value: CREDENTIAL_HELPER }]
                    : []),
            ],
            ...(envSecret ? { envFrom: [{ secretRef: { name: envSecret } }] } : {}),
            volumeMounts: [workspaceMount(config, workspaceSubPathOf(job))],
        },
    });
}

/**
 * The terminal reclaim (issue #47), ported to the aux shape like every other one-off: the SAME
 * worktree-remove script the docker runner passes to its container, as a Job over the same
 * read-write PVC. Like the sync it undoes, it runs UNDER the checkout claim (see
 * reclaimWorktree) — a thread that looks terminal can gain a follow-up between the board's
 * answer and the removal, so the removal must not race that follow-up's sync on the shared
 * root-scoped tree. Still no Secret, no env: removing needs nothing the claim held. The juice is
 * the name carrying the lease token, so a superseded attempt can never remove anything of a
 * replacement's.
 */
const RECLAIM_DEADLINE_SECONDS = 600;

export const reclaimJobName = (job: BoardJob): string => `factory-reclaim-${hash16(`${job.id}|${job.leaseToken}`)}`;

export function reclaimJobSpec(config: DriverConfig, job: BoardJob): AuxJobSpec {
    if (!JOB_ID.test(job.id) || !JOB_ID.test(job.leaseToken)) {
        throw new Error(`refusing to reclaim job ${job.id}: its ids are not the uuids the board claims`);
    }
    const clone = repoPath(config, job);
    const worktree = worktreeDir(config, job);
    if (!clone || !worktree) {
        throw new Error(
            `refusing to reclaim job ${job.id}: the board reported a repo label this driver cannot resolve a task worktree for (${job.repo ?? 'none'})`
        );
    }
    return auxJobSpec(config, job, {
        name: reclaimJobName(job),
        deadlineSeconds: RECLAIM_DEADLINE_SECONDS,
        container: {
            name: 'worktree-reclaim',
            image: executorImage(config, job.executorType),
            imagePullPolicy: config.imagePullPolicy,
            command: ['node', '-e', gitWorktreeRemoveScript],
            env: [
                { name: 'REPO', value: clone },
                { name: 'WORKTREE', value: worktree },
            ],
            volumeMounts: [workspaceMount(config, workspaceSubPathOf(job))],
        },
    });
}

/**
 * One publish step, as a Job — the ported half of docker's sibling-container publish: the same
 * `publishCheckout` workflow (publish.ts) decides what runs; here it runs as one aux Job per
 * step, `workingDir` at the task worktree over the same workspaces PVC. The steps carry the
 * attempt's `factory.job`/`factory.lease` labels, which puts them inside the re-claim fence's
 * sweep: a driver that dies mid-publish leaves Jobs the next claimant deletes before its own
 * sync touches the tree — a cleaner handover than docker's, whose publish containers are
 * anonymous and bounded only by their own exit.
 *
 * The argv is the SAME argv the docker runner passes after the image name — including, on the
 * push, the credential-helper CODE as one `-c` argv element. A program, not a credential: the
 * same class as the sync's `CRED_HELPER` literal, and as readable in a pod spec as it already
 * is in a `docker run` argv. The token itself travels the per-attempt Secret, read through
 * `envFrom` by the helper git spawns.
 */
const PUBLISH_STEP_DEADLINE_SECONDS = 600;

/** The publish steps' per-attempt env Secret — same name discipline as the sync's. */
export const publishEnvSecretName = (job: BoardJob): string =>
    `factory-publish-${hash16(`${job.id}|${job.leaseToken}`)}-env`;

/** One step's Job name: attempt-scoped by the hash, sequential by the counter. */
export const publishStepJobName = (job: BoardJob, step: number): string =>
    `factory-pub-${hash16(`${job.id}|${job.leaseToken}`)}-${step}`;

interface PublishStepJobSpecInput {
    step: number;
    publish: PublishStep;
    envSecret: string | null;
    repo: string;
}

export function publishStepJobSpec(config: DriverConfig, job: BoardJob, input: PublishStepJobSpecInput): AuxJobSpec {
    const { step, publish, envSecret, repo } = input;
    if (!JOB_ID.test(job.id) || !JOB_ID.test(job.leaseToken)) {
        throw new Error(`refusing to publish job ${job.id}: its ids are not the uuids the board claims`);
    }
    return auxJobSpec(config, job, {
        name: publishStepJobName(job, step),
        deadlineSeconds: PUBLISH_STEP_DEADLINE_SECONDS,
        container: {
            name: `publish-${step}`,
            image: executorImage(config, job.executorType),
            imagePullPolicy: config.imagePullPolicy,
            // The workflow's argv verbatim — the executable the docker runner swaps in as
            // --entrypoint is this command's head.
            command: [publish.entrypoint, ...publish.args],
            ...(publish.inRepo ? { workingDir: repo } : {}),
            ...(publish.envLiterals
                ? { env: Object.entries(publish.envLiterals).map(([name, value]) => ({ name, value })) }
                : {}),
            ...(publish.env && envSecret ? { envFrom: [{ secretRef: { name: envSecret } }] } : {}),
            // Read-write: add/commit write the tree the run edited. Scoped to the job's own
            // subtree like every other mount — asserted before the spec.
            volumeMounts: [workspaceMount(config, workspaceSubPathOf(job))],
        },
    });
}

/**
 * One block-helper step (issue #207), as an aux Job — the kubernetes transport's twin of the
 * docker runner's `dockerRunHelper`: the same entrypoint/argv/script-content shape as the publish
 * steps above, over the same workspaces PVC, at the task worktree. `HELPER_TIMEOUT_MS` (shared
 * with the docker transport, via `k8s-runner.ts`'s deadline check) is what keeps a hung helper from
 * holding the worker slot past its bound on either platform.
 */
export const HELPER_JOB_DEADLINE_SECONDS = Math.max(1, Math.round(HELPER_TIMEOUT_MS / MS_PER_SECOND));

/**
 * One helper run's Job name, keyed by phase, helper id AND a caller-supplied nonce — a plain
 * `(job, plan)` hash would collide the instant a real producer ever declares two plans of the same
 * phase naming the same helper (called twice with different `input`, say): `gateJobName`'s sibling
 * pattern closes the identical hole with an explicit run counter, and this closes it the same way,
 * scoped to the one call that needs it rather than threading an index through the platform-neutral
 * `Runner.runHelper` seam. The caller (`k8s-helper-runner.ts`) mints a fresh nonce per invocation —
 * the same "never repeats" guarantee a lease token already carries — so no two calls, whatever
 * their plans, can ever address the same object.
 */
export const helperJobName = (job: BoardJob, plan: HelperPlan, nonce: string): string =>
    `factory-helper-${hash16(`${job.id}|${job.leaseToken}|${plan.phase}|${plan.helperId}|${nonce}`)}`;

/** The helper run's per-attempt env Secret — same name discipline as the sync's and publish's. */
export const helperEnvSecretName = (job: BoardJob, plan: HelperPlan, nonce: string): string =>
    `factory-helper-${hash16(`${job.id}|${job.leaseToken}|${plan.phase}|${plan.helperId}|${nonce}`)}-env`;

export interface HelperJobSpecInput {
    plan: HelperPlan;
    descriptor: HelperDescriptor;
    envSecret: string | null;
    nonce: string;
}

export function helperJobSpec(config: DriverConfig, job: BoardJob, input: HelperJobSpecInput): AuxJobSpec {
    const { plan, descriptor, envSecret, nonce } = input;
    if (!JOB_ID.test(job.id) || !JOB_ID.test(job.leaseToken)) {
        throw new Error(`refusing to run a helper for job ${job.id}: its ids are not the uuids the board claims`);
    }
    const worktree = worktreeDir(config, job);
    return auxJobSpec(config, job, {
        name: helperJobName(job, plan, nonce),
        deadlineSeconds: HELPER_JOB_DEADLINE_SECONDS,
        container: {
            name: 'helper',
            image: executorImage(config, job.executorType),
            imagePullPolicy: config.imagePullPolicy,
            command: ['node', '-e', descriptor.scriptBody],
            // The bounded input travels as a literal, never a credential — the same class as the
            // sync's REPO/WORKTREE/BRANCH literals.
            env: [{ name: 'HELPER_INPUT', value: helperInputValue(plan) }],
            ...(envSecret ? { envFrom: [{ secretRef: { name: envSecret } }] } : {}),
            ...(worktree ? { workingDir: worktree } : {}),
            volumeMounts: [workspaceMount(config, workspaceSubPathOf(job))],
        },
    });
}

/**
 * One declared service, as a Pod. A Pod and not a Job because a Job is a unit of WORK — a
 * service is a long-running neighbor the tests talk to, the k8s twin of docker's detached
 * container. `restartPolicy: Never` mirrors docker exactly: a detached container that crashes
 * stays crashed, and so does this pod.
 *
 * Environment values travel as literals, unlike every credential this driver forwards: they
 * were already world-readable in the author's `.bellows.yaml`, and no secret of this process's
 * own ever reaches them — the same reasoning docker's `-e KEY=value` argv states.
 */
const servicePodName = (job: BoardJob, name: string): string => `factory-job-${job.id}-${job.leaseToken}-svc-${name}`;

const SERVICE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function servicePodSpec(
    config: DriverConfig,
    job: BoardJob,
    spec: ServiceSpec
): {
    apiVersion: 'v1';
    kind: 'Pod';
    metadata: { name: string; labels: Record<string, string> };
    spec: {
        restartPolicy: 'Never';
        automountServiceAccountToken: false;
        containers: {
            name: string;
            image: string;
            imagePullPolicy: string;
            env: { name: string; value: string }[];
        }[];
    };
} {
    const labels = {
        [JOB_LABEL]: job.id,
        [LEASE_LABEL]: job.leaseToken,
        [SERVICE_LABEL]: spec.name,
        ...releaseLabel(config),
    };
    return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: servicePodName(job, spec.name), labels },
        spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            ...pullSecretsField(config),
            containers: [
                {
                    name: spec.name,
                    image: spec.image,
                    imagePullPolicy: config.imagePullPolicy,
                    env: spec.environment.map(({ key, value }) => {
                        if (!SERVICE_ENV_KEY.test(key)) {
                            throw new Error(
                                `refusing to run job ${job.id}: "${key}" is not a valid environment variable name`
                            );
                        }
                        return { name: key, value };
                    }),
                },
            ],
        },
    };
}

/**
 * The service's DNS name, as a headless Service. THIS is the whole feature under kubernetes:
 * `postgres://db:5432` resolves because an object named `db` exists, so the name is exactly the
 * declared service name and is therefore NAMESPACE-global — two concurrent jobs declaring `db`
 * collide at the apiserver, and the collision is refused, never resolved by an ordering rule.
 * The bellows parser already constrains names to lowercase DNS labels, so the declared name is
 * a legal Service name unchanged.
 *
 * Headless (`clusterIP: None`) because the gate endpoint aside, the runner must reach the
 * service's EPHEMERAL container ports, and no port list was declared — `ports:` is an unknown
 * key in `.bellows.yaml` by design. A headless Service publishes A records straight to the
 * matching pods, which is exactly the "any port, direct to the container" semantics docker's
 * network alias had.
 */
export function serviceDnsSpec(
    job: BoardJob,
    spec: ServiceSpec
): {
    apiVersion: 'v1';
    kind: 'Service';
    metadata: { name: string; labels: Record<string, string> };
    spec: { clusterIP: 'None'; selector: Record<string, string> };
} {
    return {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
            name: spec.name,
            labels: {
                [JOB_LABEL]: job.id,
                [LEASE_LABEL]: job.leaseToken,
                [SERVICE_LABEL]: spec.name,
            },
        },
        spec: {
            clusterIP: 'None',
            selector: { [JOB_LABEL]: job.id, [SERVICE_LABEL]: spec.name },
        },
    };
}

export const podsPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/pods`;

/** The pods of one Job, by the `job-name` label the Job controller stamps on every pod it owns. */
export const jobPodsPath = (namespace: string, jobName: string): string =>
    `${podsPath(namespace)}?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`;

/** One pod's log, tailed to `LOG_TAIL_LINES` by default — the full log when `tail` is null. */
export const podLogPath = (namespace: string, pod: string, tail: number | null = LOG_TAIL_LINES): string =>
    `${podsPath(namespace)}/${pod}/log${tail !== null ? `?tailLines=${tail}` : ''}`;

export const secretsPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/secrets`;

/**
 * Label-scoped collection paths: by JOB for the re-claim fence, by LEASE for this attempt's own
 * teardown. The teardown selectors additionally require the `factory.service` key to exist —
 * the set-based `,factory.service` at the end — because the runner pod and every gate pod carry
 * the same lease label, and only the service fleet may die at teardown.
 */
const byJob = (path: string, job: BoardJob): string =>
    `${path}?labelSelector=${encodeURIComponent(`${JOB_LABEL}=${job.id}`)}`;
const byLease = (path: string, job: BoardJob): string =>
    `${path}?labelSelector=${encodeURIComponent(`${LEASE_LABEL}=${job.leaseToken}`)},${SERVICE_LABEL}`;

export const podsSelectorPath = (namespace: string, job: BoardJob): string => byJob(podsPath(namespace), job);
export const servicesPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/services`;
export const servicesSelectorPath = (namespace: string, job: BoardJob): string => byJob(servicesPath(namespace), job);
export const podsByLeasePath = (namespace: string, job: BoardJob): string => byLease(podsPath(namespace), job);
export const servicesByLeasePath = (namespace: string, job: BoardJob): string => byLease(servicesPath(namespace), job);

export const jobPath = (namespace: string, name: string): string => `${jobsPath(namespace)}/${name}`;

/**
 * Delete one Job by name, swallowing the answer — the shape almost every aux/runner/gate Job's
 * teardown wants: reaped once its verdict has been read, and nobody downstream branches on
 * whether the delete actually landed. `Foreground` is what `takeSyncJobDown`/`takeReclaimJobDown`
 * await before handing the checkout back — the delete returns only once the Job's dependents are
 * gone, so a released claim can never overlap a pod still writing the tree.
 */
export function deleteJob(
    deps: K8sDeps,
    name: string,
    propagationPolicy: 'Background' | 'Foreground' = 'Background'
): Promise<void> {
    return deps
        .request('DELETE', `${jobPath(deps.config.k8sNamespace, name)}?propagationPolicy=${propagationPolicy}`)
        .then(
            () => undefined,
            () => undefined
        );
}

/** Delete one Secret by name, swallowing the answer — the same fire-and-forget shape as `deleteJob`. */
export function deleteSecret(deps: K8sDeps, name: string): Promise<void> {
    return deps.request('DELETE', `${secretsPath(deps.config.k8sNamespace)}/${name}`).then(
        () => undefined,
        () => undefined
    );
}

/**
 * The label-scoped collection path every attempt of a job shares. The lease token never repeats,
 * so attempt-scoped names cannot find a previous attempt's leftovers — the `factory.job` label is
 * the one identifier they all carry, and it is what the fence selects on.
 */
export const jobsSelectorPath = (namespace: string, job: BoardJob): string =>
    `${jobsPath(namespace)}?labelSelector=${encodeURIComponent(`${JOB_LABEL}=${job.id}`)}`;

/**
 * The checkout claim: one ConfigMap per JOB id, the one job-scoped name this runner ever writes,
 * and the atom that makes the re-claim fence a mutex instead of a GET-then-POST race. The
 * apiserver's name uniqueness arbitrates — POST it and a `409` means somebody else holds the
 * checkout — while `data.attempt` (the board's monotonic per-job attempt counter, never a clock)
 * orders the contenders: a claim whose attempt is ahead of ours is our replacement's, and we
 * stand down. A ConfigMap and not a Secret because the protocol needs `get`, and granting `get`
 * on secrets would expose every attempt's env values; this object carries a holder token and an
 * attempt number, both already known to the driver.
 *
 * Keyed by the JOB id and never the thread root, even though worktreeDir keys the TREE by root:
 * the board serializes claims per thread root server-side (a separate fix), so cross-row
 * exclusion happens there — and a root-scoped claim NAME would break the attempt-ordered
 * stale-holder takeover across follow-up rows, where a leaked row-1 claim carrying attempt 3
 * would stand down row 2's attempt 1 forever.
 *
 * Everything else stays attempt-scoped: names carrying the lease token are what keep a
 * superseded attempt's cleanup from ever reaching the winner's objects.
 */
export const claimName = (job: BoardJob): string => {
    if (!JOB_ID.test(job.id)) {
        throw new Error(`refusing to address a job id that is not a uuid: ${job.id}`);
    }
    return `factory-job-${job.id}-claim`;
};

export const configmapsPath = (namespace: string): string => `/api/v1/namespaces/${namespace}/configmaps`;

export const claimPath = (namespace: string, job: BoardJob): string => `${configmapsPath(namespace)}/${claimName(job)}`;

/** The claim object this attempt POSTs. `data` values are strings — the apiserver rejects numbers. */
export const claimBody = (job: BoardJob) => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
        name: claimName(job),
        labels: { [JOB_LABEL]: job.id, [LEASE_LABEL]: job.leaseToken },
    },
    data: { holder: job.leaseToken, attempt: String(job.attempts) },
});
