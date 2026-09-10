import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { containerName } from '../src/docker.js';
import { CONTAINER_GONE } from '../src/gates.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../src/k8s.js';
import {
    POLL_MAX_CONSECUTIVE_FAILURES,
    bellowsJobSpec,
    claimName,
    createKubernetesGateManager,
    createKubernetesRunner,
    envBodyToData,
    gateEnvSecretName,
    gateJobName,
    gateJobSpec,
    jobPath,
    jobsPath,
    runnerJobSpec,
    secretName,
    serviceDnsSpec,
    servicePodSpec,
    syncEnvSecretName,
    syncJobName,
    syncJobSpec,
} from '../src/k8s.js';
import { CREDENTIAL_HELPER, gitWorktreeScript } from '../src/publish.js';
import type { ServiceSpec } from '../src/services.js';

const USER = '44444444-4444-4444-8444-444444444444';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
};

const SESSION = '33333333-3333-4333-8333-333333333333';

const spec = (env: NodeJS.ProcessEnv = {}) =>
    runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', ...env }), job, { id: SESSION, resume: false });

const resumedSpec = (env: NodeJS.ProcessEnv = {}) =>
    runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', ...env }), job, { id: SESSION, resume: true });

describe('the runner job spec', () => {
    it('is a batch/v1 Job named after the job id', () => {
        expect(spec().apiVersion).toBe('batch/v1');
        expect(spec().kind).toBe('Job');
        expect(spec().metadata.name).toBe(containerName(job));
    });

    // The executor image's ENTRYPOINT is the claude wrapper, so the container args are exactly what
    // the docker runner puts after the image name — same prompt, same flags, same platform.
    it('runs the command as a prompt, with the same argv the docker runner passes after the image', () => {
        expect(spec().spec.template.spec.containers[0].args).toEqual([
            '--session-id',
            SESSION,
            '-p',
            'fix the failing build',
        ]);
    });

    // The command is delivered once. On a resume it is already in the transcript, and sending it
    // again would re-run the work somebody has been driving by hand.
    it('restores a resumed session without re-sending the command', () => {
        expect(resumedSpec().spec.template.spec.containers[0].args).toEqual(['--resume', SESSION]);
    });

    // The docker runner's follow-up rule, unchanged on this platform: a follow-up restores the
    // parent conversation AND delivers the adjustment into it.
    it('delivers the command into the restored session on a follow-up', () => {
        const followUpSpec = runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes' }),
            { ...job, followUp: true },
            { id: SESSION, resume: true },
        );
        expect(followUpSpec.spec.template.spec.containers[0].args).toEqual([
            '--resume',
            SESSION,
            '-p',
            'fix the failing build',
        ]);
    });

    it("mounts the workspaces PVC and starts at the AUTHOR's workspace root", () => {
        const container = spec().spec.template.spec.containers[0];
        expect(container.env).toContainEqual({ name: 'WORKDIR', value: `/workspaces/bellows/${USER}` });
        expect(spec().spec.template.spec.volumes).toContainEqual({
            name: 'workspaces',
            persistentVolumeClaim: { claimName: 'factory-ai_workspaces' },
        });
        expect(container.volumeMounts).toContainEqual({ name: 'workspaces', mountPath: '/workspaces' });
    });

    // Executor parity for the task worktree (issue #35): a repo job starts in the thread's
    // worktree here exactly as the docker runner does — same WORKDIR rule, one code path on the
    // board side.
    it('starts a repo job in its task worktree', () => {
        const repoSpec = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), { ...job, repo: 'Bellows-AI/factory' }, {
            id: SESSION,
            resume: false,
        });
        expect(repoSpec.spec.template.spec.containers[0].env).toContainEqual({
            name: 'WORKDIR',
            value: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
        });
    });

    it('refuses to run a repo job whose worktree path cannot be asserted', () => {
        expect(() =>
            runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), { ...job, repo: 'Bellows-AI/factory', rootJobId: 'not-a-uuid' }, {
                id: SESSION,
                resume: false,
            }),
        ).toThrow(/worktree/);
    });

    it('refuses a workspace path that is not <org>/<uuid>', () => {
        /*
         * The board is not something this process trusts with a fragment of a command line — the
         * same rule remoteSessionArgs applies to a session id, and the stakes are higher here:
         * the value becomes the agent's working directory, and `..` in it points at the parent of
         * every member's tree.
         */
        for (const path of [
            '../../etc',
            'bellows/../../etc',
            'bellows/not-a-uuid',
            `/absolute/${USER}`,
            `bellows/${USER}/extra`,
            null,
        ]) {
            expect(
                () =>
                    runnerJobSpec(
                        loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                        { ...job, workspacePath: path },
                        { id: SESSION, resume: false },
                    ),
                String(path),
            ).toThrow(/no usable workspace path/);
        }
    });

    // The id becomes the Job object's name and lands in API paths — the same interpolation the
    // docker runner guards before a `docker run`, from the same kind of board.
    it('refuses a job id that is not a uuid, rather than interpolating it', () => {
        expect(() =>
            runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), { ...job, id: '../../etc/passwd' }, {
                id: SESSION,
                resume: false,
            }),
        ).toThrow(/must be a uuid/);
    });

    // The k8s form of `-e NAME`: the NAMES travel and the values live in a Secret the cluster
    // already holds. A literal `value:` would put the credential in the pod spec, which anyone who
    // can `get pods` can read — the same audience every `ps` on the host has.
    it('names credentials by secretKeyRef, never by value', () => {
        const container = spec({ RUNNER_CREDENTIALS_SECRET: 'claude-credentials' }).spec.template.spec.containers[0];
        expect(container.env).toContainEqual({
            name: 'CLAUDE_CODE_OAUTH_TOKEN',
            valueFrom: {
                secretKeyRef: { name: 'claude-credentials', key: 'CLAUDE_CODE_OAUTH_TOKEN', optional: true },
            },
        });
        expect(container.env).toContainEqual({
            name: 'ANTHROPIC_API_KEY',
            valueFrom: { secretKeyRef: { name: 'claude-credentials', key: 'ANTHROPIC_API_KEY', optional: true } },
        });
        // WORKDIR and the OTLP endpoint are the only literal values a runner env carries, and both
        // are paths/URLs, not secrets — the object of the pin above.
        expect(container.env.filter((entry) => 'value' in entry)).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
        ]);
    });

    // Where a runner's telemetry goes. A literal value like WORKDIR — an OTLP endpoint is a path,
    // not a credential — but unlike the compose world there is no network for a pod to join that
    // would make the image's baked `collector:4318` resolve, so this process has to name the
    // collector. RUNNER_OTEL_ENDPOINT overrides the compose-collector default; the pin is that it
    // lands as the runner's own `value`, readable in the pod spec like WORKDIR is.
    it('points the runner at a collector, overriding it when configured', () => {
        const def = spec().spec.template.spec.containers[0];
        expect(def.env).toContainEqual({ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' });
        const configured = spec({ RUNNER_OTEL_ENDPOINT: 'http://telemetry.internal:4318' }).spec.template.spec
            .containers[0];
        expect(configured.env).toContainEqual({
            name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
            value: 'http://telemetry.internal:4318',
        });
    });

    it('forwards no credentials when no secret is configured', () => {
        const container = spec().spec.template.spec.containers[0];
        expect(container.env).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
        ]);
    });

    // The claim env's VALUES never touch the pod spec — anyone who can `get pods` would read them.
    // They live in a per-attempt Secret the runner creates before the Job and reaps with it.
    it('references claim env by secretKeyRef into the per-job Secret, never by value', () => {
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const container = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), envJob, {
            id: SESSION,
            resume: false,
        }).spec.template.spec.containers[0];
        // NOT optional: the driver created this exact Secret moments before the Job, under this
        // attempt's own lease token — a missing key is a bug and must fail loud
        // (CreateContainerConfigError), not start the pod silently without its env.
        expect(container.env).toContainEqual({
            name: 'CORE_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(envJob), key: 'CORE_TOKEN' } },
        });
        expect(JSON.stringify(container.env)).not.toContain('shh');
    });

    it('carries no claim env entries, and names no Secret, for an env-less claim', () => {
        const container = spec().spec.template.spec.containers[0];
        expect(JSON.stringify(container.env)).not.toContain('factory-job-');
        // The OTEL endpoint is a literal, not a claim entry: the runner's telemetry is always
        // pointed somewhere, defaulting to the image's compose collector.
        expect(container.env.filter((entry) => 'value' in entry)).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
        ]);
    });

    // A failed runner pod must never be re-run by the cluster: a kubelet retry would re-send the
    // prompt and run the work twice. The board owns retries — the lease expires and the job is
    // offered again, which is visible in `attempts`.
    it('never restarts a failed runner', () => {
        expect(spec().spec.template.spec.restartPolicy).toBe('Never');
        expect(spec().spec.backoffLimit).toBe(0);
    });

    it('bounds the run with an active deadline', () => {
        // DRIVER_JOB_TIMEOUT_MS maps onto the kubelet-enforced deadline, so a runner that outlives
        // its driver still dies — the k8s form of `docker kill`.
        expect(spec({ DRIVER_JOB_TIMEOUT_MS: '45000' }).spec.activeDeadlineSeconds).toBe(45);
    });

    it('runs exactly one pod, and reaps the object when it is done', () => {
        expect(spec().spec.completions).toBe(1);
        expect(spec().spec.parallelism).toBe(1);
        expect(spec().spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    });

    // The same labels the docker runner passes as --label: factory.job is what lets `kubectl
    // get jobs -l factory.job=<id>` find a runner that outlived its driver — and what the
    // re-claim fence sweeps by; factory.lease scopes every per-attempt operation to its own
    // attempt's objects, the same split as the docker runner's two labels.
    it('labels the pod so an orphan can be found after the driver dies', () => {
        expect(spec().spec.template.metadata.labels).toMatchObject({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
        });
        expect(spec().metadata.labels).toMatchObject({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
        });
    });

    // Every runner pod would otherwise auto-mount the driver's own ServiceAccount token — the
    // credentials that may create Jobs — into the Claude container. That is the docker socket
    // riding along with the dashboard, and it is refused here for the same reason.
    it('leaves no service account token in the runner', () => {
        expect(spec().spec.template.spec.automountServiceAccountToken).toBe(false);
    });

    it('skips permissions only when told to', () => {
        expect(spec().spec.template.spec.containers[0].args).not.toContain('--dangerously-skip-permissions');
        expect(spec({ RUNNER_SKIP_PERMISSIONS: '1' }).spec.template.spec.containers[0].args).toContain(
            '--dangerously-skip-permissions',
        );
    });

    /**
     * Kubernetes defaults to `Always` for an untagged or `:latest` image, which would reach past
     * the node's own local images to a registry that has never heard of `claude-executor` — the
     * docker runner's "use what the daemon has" behavior has to be stated, not assumed.
     */
    it('states the pull policy instead of letting kubernetes default to Always', () => {
        expect(spec().spec.template.spec.containers[0].imagePullPolicy).toBe('IfNotPresent');
        expect(spec({ RUNNER_IMAGE_PULL_POLICY: 'Always' }).spec.template.spec.containers[0].imagePullPolicy).toBe(
            'Always',
        );
    });
});

/*
 * The runner is tested against an injected request function — the same discipline board.test.ts
 * applies to fetch, and the reason this suite spawns nothing and needs no cluster. The fake is a
 * router over (method, path): everything it is not told about throws, so a test that passes is one
 * whose every call was accounted for.
 */
interface Call {
    method: string;
    path: string;
    body?: unknown;
}

type Route = (path: string, body?: unknown) => K8sResponse | Promise<K8sResponse>;

const ANSWER: Record<string, Route> = {};

const namespace = 'factory';

const podName = `${containerName(job)}-xxxxx`;

const FAKE: Record<string, unknown> = {
    create: { status: 201, body: '{}' },
    // The fence: a label LIST that answers empty (nothing left to delete). fenceDelete stays
    // only so an unexpected collection DELETE still gets an answer instead of a route miss.
    fenceDelete: { status: 200, body: '{}' },
    fenceList: { status: 200, body: '{"items":[]}' },
    job: { status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) },
    failed: {
        status: 200,
        body: JSON.stringify({ status: { failed: 1, conditions: [{ type: 'Failed', reason: 'DeadlineExceeded' }] } }),
    },
    pods: {
        status: 200,
        body: JSON.stringify({
            items: [
                {
                    metadata: { name: podName },
                    status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
                },
            ],
        }),
    },
    log: { status: 200, body: 'did the work\n' },
    secretCreate: { status: 201, body: '{}' },
    secretDelete: { status: 200, body: '{}' },
};

/** A request function that answers from FAKE, or throws if the test did not script the call. */
const fakeRequest = (overrides: Record<string, unknown> = {}): { request: K8sRequest; calls: Call[] } => {
    const calls: Call[] = [];
    const answers = { ...FAKE, ...overrides };
    const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
    // The checkout claim, emulated the way the apiserver arbitrates it: name uniqueness on POST,
    // a readable GET, a uid-preconditioned DELETE (see claimServer).
    const serve = claimServer();
    const request: K8sRequest = (method, path, body) => {
        calls.push({ method, path, body });
        const claimAnswer = serve(method, path, body);
        if (claimAnswer) return Promise.resolve(claimAnswer);
        if (path === jobsPath(namespace) && method === 'POST') return Promise.resolve(answers.create as K8sResponse);
        if (path.startsWith(`${jobsPath(namespace)}?`)) {
            if (method === 'DELETE') return Promise.resolve(answers.fenceDelete as K8sResponse);
            return Promise.resolve(answers.fenceList as K8sResponse);
        }
        if (path === secretsPath) {
            if (method === 'DELETE') return Promise.resolve(answers.secretDelete as K8sResponse);
            return Promise.resolve(answers.secretCreate as K8sResponse);
        }
        if (path.startsWith(`${secretsPath}/`)) return Promise.resolve(answers.secretDelete as K8sResponse);
        // Any attempt's Job: names carry the lease token now, so a run's own status poll targets
        // a path built from ITS token, not the fixture job's.
        if (path.startsWith(`${jobsPath(namespace)}/`)) return Promise.resolve(answers.job as K8sResponse);
        // Service objects: lists answer empty (nothing to sweep, nothing to tear down), a POST
        // creates one, a delete succeeds. Overrides script the interesting cases.
        const servicesPath = `/api/v1/namespaces/${namespace}/services`;
        if (path === servicesPath) {
            if (method === 'DELETE') return Promise.resolve(answers.fenceDelete as K8sResponse);
            return Promise.resolve((answers.serviceCreate ?? { status: 201, body: '{}' }) as K8sResponse);
        }
        if (path.startsWith(`${servicesPath}?`)) return Promise.resolve(answers.fenceList as K8sResponse);
        if (path.startsWith(`${servicesPath}/`)) return Promise.resolve(answers.fenceDelete as K8sResponse);
        if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
            return Promise.resolve(answers.pods as K8sResponse);
        }
        if (
            path.startsWith(`/api/v1/namespaces/${namespace}/pods/`) &&
            !path.endsWith('/log') &&
            method === 'DELETE'
        ) {
            return Promise.resolve(answers.fenceDelete as K8sResponse);
        }
        if (path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`)) {
            return Promise.resolve(answers.log as K8sResponse);
        }
        {
            const aux = auxRoutes(method, path);
            if (aux) return Promise.resolve(aux);
        }
        return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
    };
    return { request, calls };
};

const runner = (request: K8sRequest) => createKubernetesRunner(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), request, async () => {});

/**
 * Default answers for the objects the runner touches beyond the runner Job itself: the fence
 * sweeps service pods and headless Services by the job label, the lease teardown lists them,
 * and aux Jobs (gates, the .bellows.yaml readout) ride the same Job routes the tests script.
 * Every inline router falls through to this before rejecting, so a test only scripts the
 * objects it is about. Lists answer empty — nothing to sweep, nothing to tear down.
 */
const AUX: Record<string, K8sResponse> = {
    list: { status: 200, body: '{"items":[]}' },
    delete: { status: 200, body: '{}' },
    create: { status: 201, body: '{}' },
};
function auxRoutes(method: string, path: string): K8sResponse | null {
    const ns = `/api/v1/namespaces/${namespace}`;
    if (path === `${ns}/services`) {
        if (method === 'DELETE') return AUX.delete;
        if (method === 'POST') return AUX.create;
        return AUX.list;
    }
    if (path.startsWith(`${ns}/services?`)) return AUX.list;
    if (path.startsWith(`${ns}/services/`)) return AUX.delete;
    // Every pod list EXCEPT the runner's job-name discovery (those are routed by the routers
    // above): the fence's sweep and the lease teardown answer empty — nothing of this job's.
    if (path.startsWith(`${ns}/pods?`)) return AUX.list;
    if (path.startsWith(`${ns}/pods/`) && !path.endsWith('/log') && method === 'DELETE') return AUX.delete;
    return null;
}

/** A lease token distinct from the fixture job's, for the attempt that reclaimed a job. */
const NEW_TOKEN = '99999999-9999-4999-8999-999999999999';

const configmapsPath = `/api/v1/namespaces/${namespace}/configmaps`;

/** The checkout claim's path: one ConfigMap per JOB id, shared by every attempt (issue #32). */
const claimPathFor = (id: string): string => `${configmapsPath}/factory-job-${id}-claim`;

/**
 * A minimal API server for the checkout claim: ConfigMap NAME uniqueness arbitrates (a POST of a
 * taken name answers 409), a GET reads the stored claim, and a DELETE honors uid preconditions —
 * exactly the three apiserver properties the acquire/takeover/release protocol rests on.
 */
const claimServer = () => {
    const claims = new Map<string, { uid: string; holder: string; attempt: string }>();
    let uids = 0;
    return (method: K8sMethod, path: string, body: unknown): K8sResponse | undefined => {
        if (method === 'POST' && path === configmapsPath) {
            const b = body as { metadata?: { name?: string }; data?: { holder?: string; attempt?: string } };
            const name = b.metadata?.name ?? '';
            if (claims.has(name)) return { status: 409, body: '{"reason":"AlreadyExists"}' };
            claims.set(name, {
                uid: `claim-uid-${++uids}`,
                holder: b.data?.holder ?? '',
                attempt: b.data?.attempt ?? '',
            });
            return { status: 201, body: '{}' };
        }
        if (path?.startsWith(`${configmapsPath}/`)) {
            const name = path.slice(configmapsPath.length + 1);
            const claim = claims.get(name);
            if (method === 'GET') {
                return claim
                    ? {
                          status: 200,
                          body: JSON.stringify({
                              metadata: { uid: claim.uid },
                              data: { holder: claim.holder, attempt: claim.attempt },
                          }),
                      }
                    : { status: 404, body: '{"kind":"Status"}' };
            }
            if (method === 'DELETE') {
                const want = (body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid;
                if (claim && (!want || want === claim.uid)) {
                    claims.delete(name);
                    return { status: 200, body: '{}' };
                }
                return { status: claim ? 409 : 404, body: '{"kind":"Status"}' };
            }
        }
        return undefined;
    };
};

/*
 * The startup sync (issue #35), ported: the docker runner creates the task worktree with a
 * `docker run` of the worktree script; here the same script is the same Job shape every other
 * aux Job uses — the declared image over the workspaces PVC, read-write this time, because the
 * whole point is creating the worktree the run will edit. Executor parity is why this exists:
 * without it, every claimed job fails at the loop's sync step.
 */
describe('the worktree sync', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const cfg = () => loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });

    it('runs the worktree script as an aux Job over a read-write PVC', () => {
        const envJob: BoardJob = { ...repoJob, env: { CORE_TOKEN: 'shh' } };
        const s = syncJobSpec(cfg(), envJob, syncEnvSecretName(envJob));
        expect(s.apiVersion).toBe('batch/v1');
        expect(s.kind).toBe('Job');
        expect(s.metadata.name).toBe(syncJobName(repoJob));
        expect(s.metadata.labels).toEqual({ 'factory.job': repoJob.id, 'factory.lease': repoJob.leaseToken });
        const container = s.spec.template.spec.containers[0];
        expect(container.command).toEqual(['node', '-e', gitWorktreeScript]);
        // The three paths the script needs, as literal values — paths, not credentials.
        expect(container.env).toContainEqual({ name: 'REPO', value: `/workspaces/bellows/${USER}/factory` });
        expect(container.env).toContainEqual({
            name: 'WORKTREE',
            value: `/workspaces/bellows/${USER}/.worktrees/${repoJob.id}`,
        });
        expect(container.env).toContainEqual({ name: 'BRANCH', value: `factory/${repoJob.id}` });
        // Read-write: the Job's whole purpose is creating the worktree.
        expect(container.volumeMounts).toEqual([{ name: 'workspaces', mountPath: '/workspaces' }]);
        expect(s.spec.template.spec.volumes).toContainEqual({
            name: 'workspaces',
            persistentVolumeClaim: { claimName: 'factory-ai_workspaces' },
        });
        expect(s.spec.template.spec.automountServiceAccountToken).toBe(false);
        expect(s.spec.backoffLimit).toBe(0);
        expect(s.spec.template.spec.restartPolicy).toBe('Never');
    });

    it('carries the claim env by reference, and a literal value only for the three paths', () => {
        const envJob: BoardJob = { ...repoJob, env: { CORE_TOKEN: 'shh' } };
        const container = syncJobSpec(cfg(), envJob, syncEnvSecretName(envJob)).spec.template.spec.containers[0];
        expect(container.envFrom).toEqual([{ secretRef: { name: syncEnvSecretName(envJob) } }]);
        for (const entry of container.env ?? []) {
            expect(entry.name === 'REPO' || entry.name === 'WORKTREE' || entry.name === 'BRANCH', entry.name).toBe(true);
            expect(entry.valueFrom, entry.name).toBeUndefined();
        }
    });

    // The sync's fetch needs a credential helper to read the token git never reads from the
    // environment — but only when there IS a token: a public repo must keep its plain
    // unauthenticated fetch. What travels as the literal is helper CODE (the same class as the
    // three path literals), never the credential value — that stays in the Secret.
    it('passes the sync the credential-helper code only when the claim env carries GITHUB_TOKEN', () => {
        const tokenJob: BoardJob = { ...repoJob, env: { GITHUB_TOKEN: 't0k-3n' } };
        const withToken = syncJobSpec(cfg(), tokenJob, syncEnvSecretName(tokenJob)).spec.template.spec.containers[0];
        expect(withToken.env).toContainEqual({ name: 'CRED_HELPER', value: CREDENTIAL_HELPER });
        // The pin that must survive: no credential VALUE travels as a literal, and the claim
        // env still rides the Secret by reference.
        expect(JSON.stringify(withToken.env)).not.toContain('t0k-3n');
        expect(withToken.envFrom).toEqual([{ secretRef: { name: syncEnvSecretName(tokenJob) } }]);

        const noToken = syncJobSpec(cfg(), { ...repoJob, env: { CORE_TOKEN: 'shh' } }, 'the-secret')
            .spec.template.spec.containers[0];
        expect(noToken.env.some((entry) => entry.name === 'CRED_HELPER')).toBe(false);
    });

    // An env-less claim is a supported board configuration (docs/jobs.md: AUTH_MODE=none, no
    // GITHUB_TOKEN in any scope). The sync pod must not reference a Secret that will never
    // exist — a pod that does sits in CreateContainerConfigError until the deadline kills the
    // Job, and every such repo job would stall ten minutes and fail.
    it('names no Secret at all when the claim resolved to no environment', () => {
        const container = syncJobSpec(cfg(), repoJob, null).spec.template.spec.containers[0];
        expect(container.envFrom).toBeUndefined();
    });

    it('refuses to build a sync for a worktree path it cannot assert', () => {
        expect(() => syncJobSpec(cfg(), { ...repoJob, rootJobId: 'not-a-uuid' }, 'the-secret')).toThrow(/worktree/);
    });

    it('syncs through a real Job: Secret before Job, verdict from the log, Secret reaped', async () => {
        const { request, calls } = fakeRequest({ log: { status: 200, body: '{"ok":true,"reason":null}\n' } });
        const envJob: BoardJob = { ...repoJob, env: { CORE_TOKEN: 'shh' } };
        const result = await runner(request).syncCheckout(envJob);

        expect(result).toEqual({ ok: true, reason: null });
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        const jobPost = calls.find((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(secretPost?.body).toMatchObject({
            metadata: { name: syncEnvSecretName(envJob), labels: { 'factory.job': envJob.id } },
            stringData: { CORE_TOKEN: 'shh' },
        });
        // The Job the sync POSTs is the sync's own, named after this attempt.
        expect((jobPost?.body as { metadata?: { name?: string } }).metadata?.name).toBe(syncJobName(envJob));
        const order = calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`);
        expect(order.indexOf(`POST ${secretsPath}`)).toBeLessThan(order.indexOf(`POST ${jobsPath(namespace)}`));
        // Reaped with the verdict, the same accepted-leak posture the runner env Secret has.
        expect(calls.some((call) => call.method === 'DELETE' && call.path === `${secretsPath}/${syncEnvSecretName(envJob)}`)).toBe(true);
    });

    it('creates no Secret for an env-less claim', async () => {
        const { request, calls } = fakeRequest({ log: { status: 200, body: '{"ok":true,"reason":null}\n' } });
        await runner(request).syncCheckout(repoJob);
        expect(calls.some((call) => call.path?.includes('/secrets'))).toBe(false);
    });

    it('answers ok:false with the script’s reason when the sync job fails', async () => {
        const { request } = fakeRequest({ log: { status: 200, body: '{"ok":false,"reason":"worktree sync failed: no space left"}\n' } });
        const result = await runner(request).syncCheckout(repoJob);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('no space left');
    });

    it('syncs nothing for a job that names no repository', async () => {
        const { request, calls } = fakeRequest();
        expect(await runner(request).syncCheckout(job)).toEqual({ ok: true, reason: null });
        expect(calls).toHaveLength(0);
    });

    it('answers ok:false when the sync Job never reaches a verdict it can read', async () => {
        const { request } = fakeRequest({ job: { status: 500, body: 'nope' } });
        const result = await runner(request).syncCheckout(repoJob);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('500');
    });

    it('answers ok:false when the log answers nothing parseable', async () => {
        const { request } = fakeRequest({ log: { status: 404, body: 'gone' } });
        const result = await runner(request).syncCheckout(repoJob);
        expect(result).toEqual({ ok: false, reason: 'the worktree sync answered nothing readable' });
    });

    /*
     * The fence before the sync (PR #46 review): the loop calls syncCheckout before run(), so
     * the sync is the FIRST writer on the task worktree — and the only mutual exclusion it can
     * get is the checkout claim, taken here under the same acquireClaim protocol prepare()
     * runs. The claim is then held through the run: prepare()'s acquire recognizes its own
     * holder and proceeds.
     */
    it('takes the checkout claim before creating anything for the sync, and holds it on success', async () => {
        const envJob: BoardJob = { ...repoJob, env: { CORE_TOKEN: 'shh' } };
        const { request, calls } = fakeRequest({ log: { status: 200, body: '{"ok":true,"reason":null}\n' } });
        const result = await runner(request).syncCheckout(envJob);

        expect(result).toEqual({ ok: true, reason: null });
        const order = calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`);
        const claimPost = order.indexOf(`POST ${configmapsPath}`);
        expect(claimPost).toBe(0);
        expect(claimPost).toBeLessThan(order.indexOf(`POST /api/v1/namespaces/${namespace}/secrets`));
        expect(claimPost).toBeLessThan(order.indexOf(`POST ${jobsPath(namespace)}`));
        // Success KEEPS the claim: the runner's own acquire follows within the same lease, and
        // releasing here would open a window another claimant could walk through.
        expect(order).not.toContain(`DELETE ${claimPathFor(envJob.id)}`);
    });

    // The replacement-with-an-active-runner shape of the review comment: a claim POST that
    // answers 409 against a LIVE newer attempt is the run path's stand-down, and the sync must
    // honor it before creating anything — no sync Secret, no sync Job, nothing to sweep later.
    it('stands down without creating anything when a live newer attempt holds the claim', async () => {
        const calls: Call[] = [];
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 409, body: '{"reason":"AlreadyExists"}' });
            }
            if (path === claimPathFor(job.id) && method === 'GET') {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'claim-uid-9' },
                        data: { holder: NEW_TOKEN, attempt: '2' },
                    }),
                });
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        await expect(runner(request).syncCheckout(repoJob)).rejects.toThrow(/stands down/);
        expect(calls.some((call) => call.method === 'POST' && call.path?.includes('/secrets'))).toBe(false);
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
    });

    /*
     * The sync Job used to survive every exit path until its own Kubernetes deadline — the
     * review's "overlap with a replacement" hazard. It is attempt-scoped by its lease token,
     * so deleting it on every exit can never reach a replacement's Job.
     */
    it('deletes its sync Job when the sync succeeds', async () => {
        const { request, calls } = fakeRequest({ log: { status: 200, body: '{"ok":true,"reason":null}\n' } });
        await runner(request).syncCheckout(repoJob);
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path === `${jobsPath(namespace)}/${syncJobName(repoJob)}?propagationPolicy=Background`,
            ),
        ).toBe(true);
    });

    it('deletes its sync Job when the poll gives up and the sync fails', async () => {
        const { request, calls } = fakeRequest({ job: { status: 500, body: 'nope' } });
        const result = await runner(request).syncCheckout(repoJob);
        expect(result.ok).toBe(false);
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path === `${jobsPath(namespace)}/${syncJobName(repoJob)}?propagationPolicy=Background`,
            ),
        ).toBe(true);
    });

    it('deletes its sync Job even when the sync throws mid-flight', async () => {
        const calls: Call[] = [];
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.reject(new Error('the apiserver closed the connection'));
            }
            if (method === 'DELETE' && path.startsWith('/api/v1/namespaces/')) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        await expect(runner(request).syncCheckout(repoJob)).rejects.toThrow(/closed the connection/);
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path === `${jobsPath(namespace)}/${syncJobName(repoJob)}?propagationPolicy=Background`,
            ),
        ).toBe(true);
    });

    // A failed sync means no runner follows, so nobody else would give the checkout back:
    // the claim goes, conditionally on this attempt still holding its exact incarnation.
    it('releases the claim when the sync fails after taking it', async () => {
        const { request, calls } = fakeRequest({
            log: { status: 200, body: '{"ok":false,"reason":"worktree sync failed: no space left"}\n' },
        });
        const result = await runner(request).syncCheckout(repoJob);
        expect(result.ok).toBe(false);
        const release = calls.find((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
        expect(release).toBeDefined();
        // The uid precondition is what keeps a stale release from reaching a newer claim.
        expect((release?.body as { preconditions?: { uid?: string } }).preconditions?.uid).toBeDefined();
    });

    /*
     * A failure hands the checkout over to a replacement — and a replacement's sync must not
     * overlap the leftover sync pod on the shared worktree. So the failure arms delete the sync
     * Job with Foreground propagation (the delete returns only after the pod is gone) and AWAIT
     * it BEFORE releaseClaim; the finally's Background delete alone returns immediately and
     * leaves the pod terminating while the next claimant acquires. Modeled with a delay on the
     * sync Job delete: a release issued before the await would complete (and be recorded) first.
     */
    it('takes the sync Job down Foreground, and only then releases the claim, when the sync fails', async () => {
        const base = fakeRequest({
            log: { status: 200, body: '{"ok":false,"reason":"worktree sync failed: no space left"}\n' },
        });
        const completions: string[] = [];
        const gated: K8sRequest = async (method, path, body) => {
            const response = await base.request(method, path, body);
            if (method === 'DELETE' && path === `${jobPath(namespace, syncJobName(repoJob))}?propagationPolicy=Foreground`) {
                // Foreground returns only once the dependents are gone — that takes time.
                await new Promise((resolve) => setTimeout(resolve, 20));
                completions.push('sync-job-gone');
            } else if (method === 'DELETE' && path === claimPathFor(repoJob.id)) {
                completions.push('claim-released');
            }
            return response;
        };
        const result = await runner(gated).syncCheckout(repoJob);

        expect(result.ok).toBe(false);
        expect(completions).toEqual(['sync-job-gone', 'claim-released']);
    });

    // The same handover discipline on the THROW arm: a poll that died mid-flight leaves a sync
    // pod that may still be running, and the rethrow follows the release — so the take-down
    // must be complete before the claim goes.
    it('takes the sync Job down Foreground, and only then releases the claim, when the sync throws mid-flight', async () => {
        const completions: string[] = [];
        const serve = claimServer();
        const request: K8sRequest = async (method, path, body) => {
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) {
                if (method === 'DELETE' && path === claimPathFor(repoJob.id)) completions.push('claim-released');
                return claimAnswer;
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.reject(new Error('the apiserver closed the connection'));
            }
            // Both API groups a delete can name: the claim (/api/v1) and the sync Job
            // (/apis/batch/v1).
            if (method === 'DELETE' && path?.startsWith('/api')) {
                if (path.includes(syncJobName(repoJob))) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    completions.push('sync-job-gone');
                }
                return { status: 200, body: '{}' };
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        await expect(runner(request).syncCheckout(repoJob)).rejects.toThrow(/closed the connection/);
        expect(completions).toEqual(['sync-job-gone', 'claim-released']);
    });

    // The mirror pin: success keeps ownership, so its delete stays fire-and-forget Background
    // and no Foreground delete is issued at all — the claim is held through the run.
    it('keeps the success-path sync Job delete Background and never deletes Foreground', async () => {
        const { request, calls } = fakeRequest({ log: { status: 200, body: '{"ok":true,"reason":null}\n' } });
        const result = await runner(request).syncCheckout(repoJob);

        expect(result).toEqual({ ok: true, reason: null });
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes('propagationPolicy=Foreground'))).toBe(false);
        expect(
            calls.some(
                (call) =>
                    call.method === 'DELETE' &&
                    call.path === `${jobsPath(namespace)}/${syncJobName(repoJob)}?propagationPolicy=Background`,
            ),
        ).toBe(true);
    });

    // The sync takes the claim, the run follows within the same lease: prepare()'s acquire must
    // read the claim it meets as ITS OWN (holder === lease token) and proceed, never stand down
    // against itself.
    it('hands the claim to the run that follows without standing down against itself', async () => {
        const { request } = fakeRequest({ log: { status: 200, body: '{"ok":true,"reason":null}\n' } });
        const r = runner(request);
        await r.syncCheckout(repoJob);
        const outcome = await r.run(repoJob, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
    });
});

describe('the kubernetes runner', () => {
    it('sweeps the job label, then creates the job in the configured namespace and reports success', async () => {
        const { request, calls } = fakeRequest();
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        // The claim is the first thing the run does: one POST whose name uniqueness arbitrates
        // the checkout. Then the fence: a label LIST of the job's previous attempts — nothing
        // answers — before this one creates anything.
        expect(calls[0]?.method).toBe('POST');
        expect(calls[0]?.path).toBe(configmapsPath);
        expect(calls[1]).toEqual({ method: 'GET', path: expect.stringContaining(jobsPath(namespace)) });
        expect(calls[1].path).toContain(`labelSelector=${encodeURIComponent(`factory.job=${job.id}`)}`);
        expect(calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`)).toEqual([
            `POST ${configmapsPath}`,
            // The sweep lists every kind the job label can answer — runner and gate Jobs, then
            // service pods, then service DNS Services — before this attempt creates anything.
            `GET ${jobsPath(namespace)}`,
            `GET /api/v1/namespaces/factory/pods`,
            `GET /api/v1/namespaces/factory/services`,
            `GET ${claimPathFor(job.id)}`,
            `POST ${jobsPath(namespace)}`,
            `GET ${claimPathFor(job.id)}`,
            `GET ${jobPath(namespace, containerName(job))}`,
            'GET /api/v1/namespaces/factory/pods',
            `GET /api/v1/namespaces/factory/pods/${podName}/log`,
            `GET ${claimPathFor(job.id)}`,
            `DELETE ${claimPathFor(job.id)}`,
            // The close-time teardown lists this attempt's service fleet by lease; the empty
            // answers mean nothing was ever started.
            'GET /api/v1/namespaces/factory/pods',
            'GET /api/v1/namespaces/factory/services',
        ]);
        expect(outcome).toEqual({ exitCode: 0, output: 'did the work\n', timedOut: false, idled: false, started: true });
    });

    it('creates the per-job Secret before the Job when the claim carries env, and reaps it with the verdict', async () => {
        const { request, calls } = fakeRequest();
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const r = createKubernetesRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
            request,
            async () => {},
        );
        await r.run(envJob, { id: SESSION, resume: false });

        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        expect(secretPost?.body).toMatchObject({
            apiVersion: 'v1',
            kind: 'Secret',
            type: 'Opaque',
            metadata: { name: secretName(envJob), labels: { 'factory.job': envJob.id } },
            stringData: { CORE_TOKEN: 'shh' },
        });
        // The Secret precedes the Job: a pod referencing a Secret that is not there yet is a
        // CreateContainerConfigError and a burned attempt.
        const secretIndex = calls.findIndex((call) => call.method === 'POST' && call.path === secretsPath);
        const jobIndex = calls.findIndex((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(secretIndex).toBeGreaterThanOrEqual(0);
        expect(secretIndex).toBeLessThan(jobIndex);
        // And creating it is the FIRST thing the run does to a Secret: the name carries this
        // attempt's lease token, so there is no previous attempt's Secret at this name to sweep.
        const firstSecretCall = calls.find((call) => call.path?.includes('/secrets'));
        expect(firstSecretCall?.method).toBe('POST');
        // Reaped once the verdict and the log have been read — not before, or the pod could not
        // have pulled the values at all.
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path === `${secretsPath}/${secretName(envJob)}`,
            ),
        ).toBe(true);
    });

    it('creates no Secret at all for an env-less claim', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(job, { id: SESSION, resume: false });
        expect(calls.some((call) => call.path?.includes('/secrets'))).toBe(false);
    });

    /*
     * kill() deletes the Job and nothing else. The env Secret is the run() wrapper's to reap —
     * on the verdict, on a throw, or on the kill-induced "Job no longer exists" 404 — because a
     * delete here can interleave the SAME attempt's create() between its Secret POST and its
     * Job POST (a lease-lost heartbeat): the Job would then be created referencing a Secret that
     * no longer exists, and its pod would sit in CreateContainerConfigError.
     */
    it('deletes only the runner Job when it kills, never the env Secret', async () => {
        const { request, calls } = fakeRequest();
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        await runner(request).kill(envJob);
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path?.startsWith(jobPath(namespace, containerName(envJob))),
            ),
        ).toBe(true);
        expect(calls.some((call) => call.path?.includes('/secrets'))).toBe(false);
    });

    /*
     * The reported race: a lease expires, the board reclaims the job, and a replacement attempt
     * creates its Secret. The superseded worker then processes its lost heartbeat and its kill()
     * deletes a Secret — under a job-id-only name, the replacement's. The lease token in the name
     * used to bound the damage to the old attempt's own Secret; kill() now deletes no Secret at
     * all — the run's own exit reaps it — so nothing a kill does can reach any attempt's Secret.
     */
    it("deletes only the superseded attempt's Secret when the job id has been reclaimed", async () => {
        const oldJob: BoardJob = {
            ...job,
            env: { CORE_TOKEN: 'shh' },
            leaseToken: '22222222-2222-4222-8222-222222222222',
        };
        const newJob: BoardJob = {
            ...job,
            env: { CORE_TOKEN: 'shh' },
            leaseToken: '99999999-9999-4999-8999-999999999999',
        };
        const { request, calls } = fakeRequest();

        // The replacement attempt runs to completion: it creates and reaps its OWN Secret.
        await runner(request).run(newJob, { id: SESSION, resume: false });
        const afterRun = calls.length;
        expect(
            calls.slice(0, afterRun).some(
                (call) =>
                    call.method === 'DELETE' &&
                    call.path === `/api/v1/namespaces/${namespace}/secrets/${secretName(newJob)}`,
            ),
        ).toBe(true);

        // The superseded worker's kill must not be able to touch the replacement's Secret — and
        // since kill() deletes no Secret at all (the run's own exit reaps it), neither the
        // replacement's nor the old attempt's is reachable from a kill.
        await runner(request).kill(oldJob);
        expect(calls.slice(afterRun).some((call) => call.path?.includes('/secrets'))).toBe(false);
    });

    it('reports a non-zero exit with the pod exit code and the tail of the log', async () => {
        const { request } = fakeRequest({
            job: { status: 200, body: JSON.stringify({ status: { failed: 1 } }) },
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: { containerStatuses: [{ state: { terminated: { exitCode: 3 } } }] },
                        },
                    ],
                }),
            },
            log: { status: 200, body: 'claude: permission denied' },
        });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(3);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.output).toBe('claude: permission denied');
    });

    /**
     * Live output on this platform is the log tail read mid-run: one poll sees the Job still
     * running, discovers the pod, and hands the caller what the log says so far; the next sees
     * the terminal status and the finished run reports exactly as it always did. The final log
     * read is unchanged — the preview never replaces the report.
     */
    it('streams the log tail while the pod runs, and reports the finished log at the end', async () => {
        const tails: string[] = [];
        let gets = 0;
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (path === jobPath(namespace, containerName(job))) {
                gets += 1;
                // First poll: still running, and worth a look at the log. Second: done.
                return Promise.resolve(
                    gets === 1
                        ? { status: 200, body: JSON.stringify({ status: {} }) }
                        : (FAKE.job as K8sResponse),
                );
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) {
                return gets === 1
                    ? Promise.resolve({ status: 200, body: 'partial output\n' })
                    : Promise.resolve(FAKE.log as K8sResponse);
            }
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false }, (tail) =>
            tails.push(tail),
        );

        expect(tails).toEqual(['partial output\n']);
        expect(outcome).toEqual({ exitCode: 0, output: 'did the work\n', timedOut: false, idled: false, started: true });
    });

    // A pod that has not been scheduled yet, or a log endpoint that hiccups, is a skipped preview —
    // never a failed run.
    it('streams nothing, and fails nothing, when the mid-run log read answers badly', async () => {
        const tails: string[] = [];
        let gets = 0;
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (path === jobPath(namespace, containerName(job))) {
                gets += 1;
                return Promise.resolve(
                    gets === 1
                        ? { status: 200, body: JSON.stringify({ status: {} }) }
                        : (FAKE.job as K8sResponse),
                );
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve({ status: 500, body: 'unavailable' });
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false }, (tail) =>
            tails.push(tail),
        );

        expect(tails).toEqual([]);
        expect(outcome.exitCode).toBe(0);
    });

    /*
     * A job id is only reused when a lease expired and the row was reclaimed — and the leftover
     * Job objects of the previous attempts may still exist. Sweeping them by label before
     * creating is the fencing mechanism: two writers on one checkout is the thing actually
     * worth preventing (docs/jobs.md). The sweep is by LABEL, not by name — attempt-scoped Job
     * names would make a name-targeted delete miss every previous attempt.
     */
    it('sweeps leftover jobs by label before creating, and waits for the sweep to land', async () => {
        const calls: Call[] = [];
        const leftover = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        let lists = 0;
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                lists += 1;
                // First read: the old Job is still listed. Second: gone. Everything after is
                // the NEW Job's own status poll. The fixture carries no creationTimestamp —
                // the fence classifies nothing, so it reads none.
                return Promise.resolve(
                    lists === 1
                        ? {
                              status: 200,
                              body: JSON.stringify({
                                  items: [{ metadata: { name: leftover } }],
                              }),
                          }
                        : { status: 200, body: JSON.stringify({ items: [] }) },
                );
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
        // Claim, then LIST finds the leftover by label, the claim is confirmed still ours,
        // the leftover is deleted BY NAME with Foreground propagation, LISTs again — nothing
        // deletable answers — and only then the create. Foreground propagation starts the
        // teardown; the next list is what proves the old pods are off the checkout — the
        // delete's own response does not wait for them.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            // Round one lists every kind — jobs names the leftover, pods and services answer
            // empty — then the claim is confirmed ours and the leftover is deleted by name.
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            // Round two: all three kinds answer empty.
            'GET',
            'GET',
            'GET',
            'GET',
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
        ]);
        expect(calls[1].path).toContain(`labelSelector=${encodeURIComponent(`factory.job=${job.id}`)}`);
        expect(calls[5].path).toBe(`${jobPath(namespace, leftover)}?propagationPolicy=Foreground`);
    });

    // A re-claim whose sweep never lands — an apiserver losing deletes, say — must not loop
    // forever heartbeating a lease around a create that would run alongside leftovers. Bounded,
    // then thrown: the job goes back to the board rather than two writers racing one checkout.
    // "Deletable" means ANY item the selector answers — the fence classifies nothing — so the
    // fixture carries no timestamp for it to read.
    it('gives up when a deletable leftover job never disappears', async () => {
        const leftover = {
            metadata: { name: 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner' },
        };
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: [leftover] }) });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                // Answered, and yet the object never leaves the list — the failure mode the
                // bound exists for.
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /never disappeared/,
        );
    });

    /*
     * Issue #32, race 2: the old fence deleted EVERY Job the `factory.job` selector answered, so
     * a stale attempt fencing after its replacement was posted would delete the legitimate lease
     * holder's Job — whose status poll then answers 404 and aborts an active run. Under the
     * claim protocol the stale attempt loses the acquisition step instead — the claim's attempt
     * number is ahead of its own — and stands down having created and deleted nothing at all.
     */
    it('stands down when a newer attempt holds the checkout claim, and touches nothing of its replacement', async () => {
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2 };
        const newerJobName = containerName(newerJob);
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let replacementAlive = true;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            // The claim is held by attempt 2; this run is attempt 1.
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 409, body: '{"reason":"AlreadyExists"}' });
            }
            if (path === claimPath && method === 'GET') {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'claim-uid-2' },
                        data: { holder: NEW_TOKEN, attempt: '2' },
                    }),
                });
            }
            // The replacement's runner Job is live and answers the label selector.
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({
                        items: replacementAlive ? [{ metadata: { name: newerJobName } }] : [],
                    }),
                });
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, newerJobName)}?`)) {
                replacementAlive = false;
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/stands down/);
        // The replacement's Job still exists — a superseded attempt never reaches the winner.
        expect(replacementAlive).toBe(true);
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(newerJobName))).toBe(false);
        // Nothing was created either: standing down leaves the job to its lease.
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
        // And the claim it does not hold is not deleted by the loser either.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    /*
     * The takeover pin: a leftover claim of an OLDER attempt (a driver that died holding it) is
     * released by the next claimant, conditionally on the exact incarnation it read — the uid
     * precondition is what keeps a stale attempt's delete from ever reaching a newer incarnation
     * of the claim. Attempt numbers order the attempts of one job; no clock is read anywhere.
     */
    it('takes over the leftover claim of an older attempt under a uid precondition, then creates', async () => {
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2 };
        const claimPath = claimPathFor(job.id);
        const serve = claimServer();
        const calls: Call[] = [];
        // A leftover from the older attempt: the first claim POST stores it under claim-uid-1.
        let seeded = false;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (!seeded) {
                seeded = true;
                serve('POST', configmapsPath, {
                    metadata: { name: `factory-job-${job.id}-claim` },
                    data: { holder: job.leaseToken, attempt: '1' },
                });
            }
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(newerJob))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await createKubernetesRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
            request,
            async () => {},
        ).run(newerJob, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // The takeover delete names the exact claim incarnation that was read.
        const takeover = calls.find((call) => call.method === 'DELETE' && call.path === claimPath);
        expect(
            (takeover?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid,
        ).toBe('claim-uid-1');
        expect(calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`)).toEqual([
            `POST ${configmapsPath}`,
            `GET ${claimPath}`,
            `DELETE ${claimPath}`,
            `POST ${configmapsPath}`,
            `GET ${jobsPath(namespace)}`,
            `GET /api/v1/namespaces/factory/pods`,
            `GET /api/v1/namespaces/factory/services`,
            `GET ${claimPath}`,
            `POST ${jobsPath(namespace)}`,
            `GET ${claimPath}`,
            `GET ${jobPath(namespace, containerName(newerJob))}`,
            'GET /api/v1/namespaces/factory/pods',
            `GET /api/v1/namespaces/factory/pods/${podName}/log`,
            `GET ${claimPath}`,
            `DELETE ${claimPath}`,
            'GET /api/v1/namespaces/factory/pods',
            'GET /api/v1/namespaces/factory/services',
        ]);
    });

    /*
     * Issue #32, race 1: both fences could observe an empty selector before either POST became
     * visible, and both attempts would create Jobs — two runners on one writable checkout, the
     * exact harm docs/jobs.md calls the single most important line in the board contract. Under
     * the claim protocol the second attempt's POST answers 409, it takes over only because its
     * attempt number is ahead, and the FIRST attempt — still inside its sweep, holding nothing
     * anymore — finds the claim no longer its own and stands down before creating anything.
     */
    it('admits one runner per checkout: the superseded attempt stands down mid-sweep', async () => {
        const olderJob: BoardJob = { ...job, attempts: 1 };
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2 };
        const newerJobName = containerName(newerJob);
        const serve = claimServer();
        const calls: Call[] = [];
        const liveJobs = new Set<string>();

        let signalOlderClaimed!: () => void;
        const olderClaimed = new Promise<void>((resolve) => {
            signalOlderClaimed = resolve;
        });
        let openOlderList!: () => void;
        const olderList = new Promise<void>((resolve) => {
            openOlderList = resolve;
        });

        const shared = (method: K8sMethod, path: string, body?: unknown): Promise<K8sResponse> => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({ items: [...liveJobs].map((name) => ({ metadata: { name } })) }),
                });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                liveJobs.add((body as { metadata?: { name?: string } })?.metadata?.name ?? '');
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                liveJobs.delete((path.slice(jobsPath(namespace).length + 1).split('?')[0]) ?? '');
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(olderJob)) || path === jobPath(namespace, newerJobName)) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        // The older attempt's fence: its first label list is held until the test has run the
        // newer attempt to completion, so the sweep sees the replacement's live Job.
        const olderRequest: K8sRequest = (method, path, body) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                // The claim is taken before the first list in the fixed code; signal then. Before
                // the fix there is no claim POST, so signal at the list instead — the test must
                // start the newer attempt either way.
                signalOlderClaimed();
                return olderClaimed.then(() => olderList).then(() => shared(method, path, body));
            }
            const result = shared(method, path, body);
            if (method === 'POST' && path === configmapsPath) {
                result.then(
                    () => signalOlderClaimed(),
                    () => signalOlderClaimed(),
                );
            }
            return result;
        };

        const makeRunner = (request: K8sRequest) =>
            createKubernetesRunner(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), request, async () => {});

        const olderRun = makeRunner(olderRequest).run(olderJob, { id: SESSION, resume: false });
        await olderClaimed;
        const newerOutcome = await makeRunner(shared).run(newerJob, { id: SESSION, resume: false });
        expect(newerOutcome.exitCode).toBe(0);
        openOlderList();
        await expect(olderRun).rejects.toThrow(/stands down/);

        // Exactly one runner Job was ever created, and it is the newer attempt's.
        const jobPosts = calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(jobPosts).toHaveLength(1);
        expect((jobPosts[0]?.body as { metadata?: { name?: string } } | undefined)?.metadata?.name).toBe(newerJobName);
        // The superseded attempt never reached the winner's objects.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(newerJobName))).toBe(false);
    });

    // The env Secret this run creates precedes its first Job POST — and must SURVIVE the fence:
    // the Job references it by name, and a deleted one would start the pod silently without its
    // claim env. The fence sweeps JOBS by label and nothing else — and the Secret's name carries
    // this attempt's own lease token, so there is no previous attempt's Secret at this name.
    it('keeps the freshly created Secret across the label fence', async () => {
        const calls: Call[] = [];
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === secretsPath) {
                if (method === 'DELETE') return Promise.resolve({ status: 200, body: '{}' });
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path.startsWith(`${secretsPath}/`)) return Promise.resolve({ status: 200, body: '{}' });
            if (method === 'DELETE') return Promise.resolve({ status: 200, body: '{}' });
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const outcome = await createKubernetesRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
            request,
            async () => {},
        ).run(envJob, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // Created once, before the Job POST.
        const secretPosts = calls.filter((c) => c.method === 'POST' && c.path === secretsPath);
        expect(secretPosts).toHaveLength(1);
        expect(
            calls.findIndex((c) => c.method === 'POST' && c.path === secretsPath),
        ).toBeLessThan(calls.findIndex((c) => c.method === 'POST' && c.path === jobsPath(namespace)));
        // And NOT deleted between the fence and the Job POST.
        const fenceList = calls.findIndex((c) => c.method === 'GET' && c.path?.includes('labelSelector='));
        const rePost = calls.findIndex(
            (c, i) => i > fenceList && c.method === 'POST' && c.path === jobsPath(namespace),
        );
        const secretDeletesInTheFence = calls
            .slice(fenceList, rePost)
            .filter((c) => c.method === 'DELETE' && c.path?.includes('/secrets'));
        expect(secretDeletesInTheFence).toHaveLength(0);
    });

    /*
     * The sweep classifies NOTHING, so every Job the `factory.job` selector answers is deleted —
     * which is safe exactly because the claim is held: whoever the Jobs belonged to, the board
     * has superseded them, and a successor that reclaims while this sweep is in flight makes the
     * claim check answer not-ours and stands this attempt down before a single delete lands. No
     * timestamp makes a predecessor distinguishable — one can be younger than any cutoff, because
     * its attempt's fencing waited on the kubelet's unbounded garbage collection. Each is deleted
     * BY NAME with Foreground propagation; a collection DELETE is still never issued, because
     * the API server evaluates a selector at processing time and one in flight could reach Jobs
     * posted after the fence began — this attempt's own, once created.
     */
    it('fences every Job the label answers — leftover and fresh successor alike — by name, never as a collection DELETE', async () => {
        const now = Date.now();
        const oldName = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        const freshName = 'factory-job-11111111-1111-4111-8111-111111111111-newlease-runner';
        const oldJob = { metadata: { name: oldName, creationTimestamp: new Date(now - 10 * 60_000).toISOString() } };
        const freshJob = { metadata: { name: freshName, creationTimestamp: new Date(now).toISOString() } };
        let old = true;
        let fresh = true;
        const calls: Call[] = [];
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({ items: [old ? oldJob : null, fresh ? freshJob : null].filter(Boolean) }),
                });
            }
            // The API server evaluates a selector at processing time: a collection DELETE would
            // take EVERY Job of the id — including this attempt's own once created. The fence
            // must never issue one.
            if (method === 'DELETE' && path.includes('labelSelector=')) {
                old = false;
                fresh = false;
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                if (path.startsWith(`${jobPath(namespace, oldName)}`)) old = false;
                if (path.startsWith(`${jobPath(namespace, freshName)}`)) fresh = false;
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // No collection DELETE anywhere in the run: one whose selector would match this
        // attempt's own Job once created is exactly the delete this fence must never issue.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes('labelSelector='))).toBe(false);
        // Both Jobs go BY NAME, Foreground — the fresh successor's leftover too: its run
        // released the claim before this attempt acquired it, so its Job is sweepable.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, oldName)}?propagationPolicy=Foreground`,
        });
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, freshName)}?propagationPolicy=Foreground`,
        });
        // Claim, LIST ×3 (finds both in jobs; pods and services empty), claim confirmed ours,
        // two deletes, LIST ×3 (clean), claim re-verified before the create, create, claim
        // verified again, then the status poll, the pod list, the log, the claim release and
        // the lease teardown.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'DELETE',
            'GET',
            'GET',
            'GET',
            'GET',
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
        ]);
    });

    /*
     * THE race the mutex closes: this attempt loses its lease while its own Secret creation and
     * fencing consume more than half of it. The predecessor's Job — a different lease token —
     * was created 7 seconds before the fence's deciding list under a 10s lease, so the
     * half-lease cutoff computed at fence entry classified it FRESH and spared it: two writers
     * on one checkout. No clock-derived predicate can classify that correctly — a Job stamped
     * fence-entry-fresh is exactly what the cutoff tested — so the fence no longer classifies
     * at all: any Job the label answers is deleted by name and awaited before the create. The
     * lease is pinned at the supported minimum to prove nothing timing-based remains
     * load-bearing.
     */
    it('deletes a live predecessor the age filter would have called fresh, and waits for it before creating', async () => {
        const predecessor = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        let predecessorAlive = true;
        const calls: Call[] = [];
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({
                        items: predecessorAlive
                            ? [{ metadata: { name: predecessor, creationTimestamp: new Date().toISOString() } }]
                            : [],
                    }),
                });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                if (path.startsWith(jobPath(namespace, predecessor))) predecessorAlive = false;
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        // A 10s lease puts the entry-time cutoff 5s back: the predecessor — younger than that
        // at the deciding list — is a live writer on this checkout, and it must not survive.
        const r = createKubernetesRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, DRIVER_LEASE_SECONDS: '10' }),
            request,
            async () => {},
        );
        const outcome = await r.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // Deleted BY NAME, Foreground...
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, predecessor)}?propagationPolicy=Foreground`,
        });
        // ...and only once the claim is confirmed ours and the selector answers nothing does
        // this attempt create its own Job: claim, LIST ×3 (finds the predecessor in jobs; the
        // others empty), claim confirmed, DELETE, LIST ×3 (clean), claim re-verified, POST,
        // claim verified, then the status poll and the close-time reads.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
            'GET',
            'GET',
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
        ]);
    });

    // A collection that answers 404 has nothing behind it to fence: straight to the create, no
    // second list, no deletes.
    it('treats a 404 from the label list as nothing left to fence', async () => {
        const calls: Call[] = [];
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 404, body: '{"kind":"Status"}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            // Jobs 404s; the sweep goes on to the pods and services lists, both empty — the
            // round is conclusive and the checkout is free.
            'GET',
            'GET',
            'GET',
            'GET',
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
        ]);
    });

    // A dropped connection says nothing about whether the objects are gone; the fence keeps
    // polling within the same bound instead of creating alongside what may still be there.
    it('keeps fencing through a transport failure on the list', async () => {
        const calls: Call[] = [];
        let lists = 0;
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                lists += 1;
                // First read: the connection drops. Second: the selector answers nothing.
                return lists === 1
                    ? Promise.reject(new Error('connection reset'))
                    : Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            // Round one: the jobs list drops — the round is inconclusive, and the pods and
            // services lists still run before the retry.
            'GET',
            'GET',
            'GET',
            // Round two: jobs, pods and services all answer empty — free to create.
            'GET',
            'GET',
            'GET',
            'GET',
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
        ]);
    });

    /*
     * Release is conditional: the only claim this attempt may ever delete is the exact
     * incarnation it still holds, proved by a GET before the DELETE. Case (a): a finished run
     * releases its own claim, uid-preconditioned. Case (b): a claim that has moved on — taken
     * over, or already gone — is left entirely alone.
     */
    it('releases the claim when the run ends, and never releases a claim it no longer holds', async () => {
        const claimPath = claimPathFor(job.id);
        // (a) A successful run ends with the claim read and released — then the service fleet's
        // lease lists (empty), and the env Secret's reap is the last call.
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const released = fakeRequest();
        await runner(released.request).run(envJob, { id: SESSION, resume: false });
        const tail = released.calls.slice(-5);
        expect(tail[0]).toEqual({ method: 'GET', path: claimPath });
        expect(tail[1]?.method).toBe('DELETE');
        expect(tail[1]?.path).toBe(claimPath);
        expect((tail[1]?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBe(
            'claim-uid-1',
        );
        expect(tail[2]).toEqual({
            method: 'GET',
            path: `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(`factory.lease=${envJob.leaseToken}`)},factory.service`,
        });
        expect(tail[3]).toEqual({
            method: 'GET',
            path: `/api/v1/namespaces/${namespace}/services?labelSelector=${encodeURIComponent(`factory.lease=${envJob.leaseToken}`)},factory.service`,
        });
        expect(tail[4]).toEqual({
            method: 'DELETE',
            path: `/api/v1/namespaces/${namespace}/secrets/${secretName(envJob)}`,
        });

        // (b) The claim answers gone at release time: no DELETE on the configmaps path at all.
        let reads = 0;
        const serve = claimServer();
        const calls: Call[] = [];
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) {
                // The verify reads (our claim, still held) succeed; every later read — the
                // release's — answers 404, as if another attempt took the claim over and
                // finished its whole run in between.
                reads += 1;
                if (reads > 3) return { status: 404, body: '{"kind":"Status"}' };
                return claimAnswer;
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // The acquire POST and the two verifies around the Job POST happened — reads 1 through
        // 3 — and the release read found the claim gone without deleting anything.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    // A claim with no attempt number — hand-made, or written by a driver from before the field
    // existed — is never proof of a newer writer, so it is released by takeover like any other
    // older holder's leftover. Standing down on garbage would let a dead claim hold the
    // checkout forever.
    it('takes over a claim object that carries no attempt number', async () => {
        const claimPath = claimPathFor(job.id);
        const serve = claimServer();
        const calls: Call[] = [];
        let seeded = false;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (!seeded) {
                seeded = true;
                // A hand-made claim: a holder, but no attempt field at all.
                serve('POST', configmapsPath, {
                    metadata: { name: `factory-job-${job.id}-claim` },
                    data: { holder: 'someone-else' },
                });
            }
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // Taken over, not stood down: the holder was not a newer attempt.
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(true);
        // And the takeover was conditioned on the incarnation the GET read.
        expect(
            (calls.find((call) => call.method === 'DELETE' && call.path === claimPath)?.body as {
                preconditions?: { uid?: string };
            } | undefined)?.preconditions?.uid,
        ).toBe('claim-uid-1');
    });

    // The claim name is the one job-scoped object name this runner ever writes — asserted before
    // it joins an API path, the same way the Job's and the Secret's are.
    it('names the checkout claim after the job id alone, and refuses a job id that is not a uuid', () => {
        expect(claimName(job)).toBe(`factory-job-${job.id}-claim`);
        expect(() => claimName({ ...job, id: '../../etc/passwd' })).toThrow(/not a uuid/);
    });

    /*
     * The post-create verify is the bracket that closes race 1's residual window: a takeover
     * landing between the Job POST and the claim read is answered by the loser deleting its OWN
     * attempt-scoped Job and standing down — never by touching anything of the winner's.
     */
    it('stands down and removes its own Job when the claim is taken over between the Job POST and the verify', async () => {
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2 };
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let jobPosted = false;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === jobsPath(namespace)) {
                jobPosted = true;
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    // The claim is ours until this attempt's Job exists; the takeover lands the
                    // moment it is — exactly the window this bracket closes.
                    return Promise.resolve(
                        jobPosted
                            ? {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-9' },
                                      data: { holder: NEW_TOKEN, attempt: '2' },
                                  }),
                              }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-8' },
                                      data: { holder: job.leaseToken, attempt: '1' },
                                  }),
                              },
                    );
                }
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /taken over before the runner could start/,
        );
        // Its OWN Job, by name, Foreground.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, containerName(job))}?propagationPolicy=Foreground`,
        });
        // And nothing of the winner's: no Job of the newer attempt is ever addressed.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(NEW_TOKEN))).toBe(false);
    });

    // A read that cannot name the incarnation it read is a bad read, and an UNCONDITIONED delete
    // of it could reach a newer claim — reopening both races through the takeover itself. The
    // runner refuses instead: fail loud, leave the job to its lease, delete nothing.
    it('refuses to release a claim it cannot identify, rather than deleting unconditioned', async () => {
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 409, body: '{"reason":"AlreadyExists"}' });
            }
            if (path === claimPath && method === 'GET') {
                // An older holder by attempt number, but a body with no uid on it.
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({ data: { holder: 'someone-else', attempt: '0' } }),
                });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not be identified/,
        );
        // No delete anywhere near the configmaps path, least of all an unconditioned one.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
        expect(calls.some((call) => call.method === 'DELETE' && call.body !== undefined)).toBe(false);
    });

    // A blink on the post-create verify is not proof the claim moved: the read runs with the
    // same bounded patience the status poll has, and only a definitive answer stands the run down.
    it('keeps the run through a transient failure on the post-create claim verify', async () => {
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let reads = 0;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    // First read: the apiserver blinks right after the Job POST. Second: ours.
                    return Promise.resolve(
                        reads === 1
                            ? { status: 503, body: 'unavailable' }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, attempt: '1' },
                                  }),
                              },
                    );
                }
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // The 503 was retried, not acted on; the run created its Job and released its claim.
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toHaveLength(1);
    });

    /*
     * The bracket's first half: a takeover already visible BEFORE the Job POST must meet a
     * create() that creates nothing — the older attempt never becomes a second writer on the
     * checkout, not even briefly. The claim read that answers the takeover is the one between
     * the sweep and the POST.
     */
    it('stands down before creating the runner job when the claim is taken over before the POST', async () => {
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath && method === 'GET') {
                // The takeover lands between the sweep and the Job POST.
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'claim-uid-7' },
                        data: { holder: NEW_TOKEN, attempt: '2' },
                    }),
                });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/stands down/);
        // The takeover was visible before the POST: no Job is ever created...
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
        // ...and nothing on the jobs path is deleted — this attempt has nothing there to delete.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(jobsPath(namespace)))).toBe(
            false,
        );
    });

    // The pre-create verify carries the same bounded patience as every verdict-carrying read: a
    // blink before the Job POST is waited out, not acted on — and the Job is posted exactly
    // once, only after the claim is confirmed.
    it('waits out a blink on the pre-create claim verify, and posts the Job only after it', async () => {
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let reads = 0;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    // The apiserver blinks on the FIRST claim read of the run — the pre-create
                    // verify's — and answers ours from then on.
                    return Promise.resolve(
                        reads === 1
                            ? { status: 503, body: 'unavailable' }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, attempt: '1' },
                                  }),
                              },
                    );
                }
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toHaveLength(1);
        const firstClaimRead = calls.findIndex((call) => call.method === 'GET' && call.path === claimPath);
        const jobPost = calls.findIndex((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(firstClaimRead).toBeGreaterThanOrEqual(0);
        expect(firstClaimRead).toBeLessThan(jobPost);
    });

    /*
     * No runner stays on a checkout its driver cannot verify: when the post-create verify spends
     * its whole patience without an answer, the loser best-effort deletes its OWN Job and burns
     * the attempt — the alternative to two writers on one checkout, the fence's own rule.
     */
    it('removes its own Job when the post-create claim verify exhausts its patience', async () => {
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let reads = 0;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    // The pre-create verify reads ours; every later read — the post-create
                    // verify's — answers 503 until the patience is spent.
                    return Promise.resolve(
                        reads === 1
                            ? {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, attempt: '1' },
                                  }),
                              }
                            : { status: 503, body: 'unavailable' },
                    );
                }
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /in a row|unavailable|checkout claim/i,
        );
        // The delete names only this attempt's own Job, Foreground — best-effort.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, containerName(job))}?propagationPolicy=Foreground`,
        });
    });

    // Same doctrine, other evidence: a post-create verify that DOES answer but cannot name a
    // holder is neither provably ours nor a definitive loss — and still no runner stays behind.
    it('removes its own Job when the post-create claim verify cannot name a holder', async () => {
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let reads = 0;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    // The pre-create verify reads ours; every later read answers 200 with a
                    // body that carries no holder at all.
                    return Promise.resolve(
                        reads === 1
                            ? {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, attempt: '1' },
                                  }),
                              }
                            : { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-x' } }) },
                    );
                }
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not be confirmed/,
        );
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, containerName(job))}?propagationPolicy=Foreground`,
        });
    });

    /*
     * The failed-delete rule: a post-create stand-down whose own-Job DELETE answers neither 2xx
     * nor 404 leaves the Job's fate to the kubelet's deadline — and this attempt's runner may
     * still be on the checkout when a replacement claimant arrives. So the claim is NOT released:
     * the checkout is never handed over voluntarily while this attempt's runner may still be on
     * it, and the next claimant's stale-holder takeover (uid-preconditioned release, then a sweep
     * of every `factory.job=<id>` Job) is the documented route that reclaims both.
     */
    it('holds the claim when the post-create verify exhausts its patience and the own-Job delete fails', async () => {
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let reads = 0;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    // Read 1 is the pre-create verify (ours); reads 2 through
                    // POLL_MAX_CONSECUTIVE_FAILURES + 2 are the post-create verify, answering 500
                    // until its patience is spent; anything after would be the release's read.
                    const spent = reads > 2 + POLL_MAX_CONSECUTIVE_FAILURES;
                    return Promise.resolve(
                        reads === 1 || spent
                            ? {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, attempt: '1' },
                                  }),
                              }
                            : { status: 500, body: 'unavailable' },
                    );
                }
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                // The delete fails: whether the Job is really going away is unknown.
                return Promise.resolve({ status: 500, body: 'refused' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/in a row/);
        // The delete failed, so the Job may still be on the checkout: the claim is left held.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    // A 404 from the own-Job DELETE is a SUCCESS here: the Job is already gone, so nothing of
    // this attempt's is left on the checkout and the claim may be released as usual.
    it('releases the claim when the own-Job delete answers 404 — already gone is a success', async () => {
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let reads = 0;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    const spent = reads > 2 + POLL_MAX_CONSECUTIVE_FAILURES;
                    return Promise.resolve(
                        reads === 1 || spent
                            ? {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, attempt: '1' },
                                  }),
                              }
                            : { status: 500, body: 'unavailable' },
                    );
                }
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return Promise.resolve({ status: 404, body: '{"kind":"Status"}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/in a row/);
        const release = calls.find((call) => call.method === 'DELETE' && call.path === claimPath);
        expect(release).toBeDefined();
        expect((release?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBe(
            'claim-uid-1',
        );
    });

    // A 2xx from the own-Job DELETE is the ordinary success: the Job is going away, so the
    // existing behavior is preserved and the claim is released, uid-preconditioned as ever.
    it('releases the claim when the own-Job delete succeeds after an exhausted post-create verify', async () => {
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let reads = 0;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    const spent = reads > 2 + POLL_MAX_CONSECUTIVE_FAILURES;
                    return Promise.resolve(
                        reads === 1 || spent
                            ? {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, attempt: '1' },
                                  }),
                              }
                            : { status: 500, body: 'unavailable' },
                    );
                }
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/in a row/);
        const release = calls.find((call) => call.method === 'DELETE' && call.path === claimPath);
        expect(release).toBeDefined();
        expect((release?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBe(
            'claim-uid-1',
        );
    });

    /*
     * The taken-over branch sets the hold flag the same way, but the claim itself was never this
     * attempt's to release once a newer attempt holds it — releaseClaim was a no-op there before
     * the flag existed, and this pin keeps the uniform flag from regressing that: a failed delete
     * must not turn a no-op release into a delete of a claim this attempt does not hold.
     */
    it('leaves a taken-over claim untouched when the stand-down deletes nothing', async () => {
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2 };
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let jobPosted = false;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === jobsPath(namespace)) {
                jobPosted = true;
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath && method === 'GET') {
                // The claim is ours until this attempt's Job exists; the takeover lands the
                // moment it is. Later reads — the release's — still answer the new holder.
                return Promise.resolve(
                    jobPosted
                        ? {
                              status: 200,
                              body: JSON.stringify({
                                  metadata: { uid: 'claim-uid-9' },
                                  data: { holder: NEW_TOKEN, attempt: '2' },
                              }),
                          }
                        : {
                              status: 200,
                              body: JSON.stringify({
                                  metadata: { uid: 'claim-uid-8' },
                                  data: { holder: job.leaseToken, attempt: '1' },
                              }),
                          },
                );
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return Promise.resolve({ status: 500, body: 'refused' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /taken over before the runner could start/,
        );
        // The stand-down did try its own Job delete — and only its own.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, containerName(job))}?propagationPolicy=Foreground`,
        });
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(NEW_TOKEN))).toBe(false);
        // And the claim that moved on is never deleted.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    // Uniformity: the unverifiable branch (a read that answers but names no holder) holds the
    // claim on a failed delete exactly like the exhausted-patience branch — and here the release
    // read WOULD answer ours, so the flag is the only thing standing between the claim and its
    // release while this attempt's runner may still be on the checkout.
    it('holds the claim when the verify cannot name a holder and the own-Job delete fails', async () => {
        const claimPath = claimPathFor(job.id);
        const calls: Call[] = [];
        let reads = 0;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    // Read 1: the pre-create verify, ours. Read 2: the post-create verify, a 200
                    // that names no holder — the unverifiable branch. Read 3+: the release read.
                    return Promise.resolve(
                        reads === 2
                            ? { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-x' } }) }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, attempt: '1' },
                                  }),
                              },
                    );
                }
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return Promise.resolve({ status: 500, body: 'refused' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not be confirmed/,
        );
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    // The sweep deletes only when the claim verify answers definitively: a blink on the claim
    // read is 'unknown' — nothing is deleted that round, and the fence looks again within its
    // bound, because deleting on a maybe is what would reach the winner's Job.
    it('deletes nothing on a round whose claim verify could not be confirmed, and looks again', async () => {
        const leftover = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        const calls: Call[] = [];
        let claimReads = 0;
        let lists = 0;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === claimPathFor(job.id)) {
                if (method === 'GET') {
                    claimReads += 1;
                    // The sweep's FIRST verify read: the apiserver blinks. The second (and every
                    // later read, including the post-create verify and the release) answers ours.
                    return Promise.resolve(
                        claimReads === 1
                            ? { status: 503, body: 'unavailable' }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, attempt: '1' },
                                  }),
                              },
                    );
                }
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                lists += 1;
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({ items: lists <= 2 ? [{ metadata: { name: leftover } }] : [] }),
                });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // LIST ×3 (leftover in jobs; pods/services empty), verify 503 → no delete, LIST ×3
        // (leftover again), verify ours → DELETE, LIST ×3 (clean), claim re-verified, create,
        // verify, poll, pods, log, release, release-delete, lease teardown ×2.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
            'GET',
            'GET',
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
        ]);
        expect(calls[9]?.path).toBe(`${jobPath(namespace, leftover)}?propagationPolicy=Foreground`);
    });

    // The board refuses a complete POST that does not fit its body limit — an oversized report
    // would fail to report, leave the job to its lease, and re-run finished work until the job
    // went dead. The cap has to hold for the WORST log, not the average one: a character cap
    // counts UTF-16 units, and 64 Ki of CJK text is 192 KiB of UTF-8, while control characters
    // expand six-fold under JSON escaping.
    it('keeps the report under the board body limit even fully escaped', async () => {
        // CJK: three bytes per character in UTF-8. Control characters: up to six bytes once
        // JSON.stringify escapes them. Together, the worst case the report can face.
        const oversized = 'あ'.repeat(100 * 1024) + '\u0001'.repeat(100 * 1024);
        const { request } = fakeRequest({ log: { status: 200, body: oversized } });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        const body = JSON.stringify({
            leaseToken: job.leaseToken,
            status: 'succeeded',
            exitCode: 0,
            output: outcome.output,
        });
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(128 * 1024);
        // The tail, not the head: a run that fails says why at the end.
        expect(outcome.output.endsWith('\u0001')).toBe(true);
    });

    // A 503 during an apiserver upgrade, or a dropped connection, is not the run's verdict — the
    // pod may already have succeeded. The poll retries a bounded number of times instead of
    // abandoning the job to its lease and re-running it.
    it('keeps polling through transient API failures', async () => {
        const calls: Call[] = [];
        let gets = 0;
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (path === jobsPath(namespace) && method === 'POST') {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (path === jobPath(namespace, containerName(job))) {
                gets += 1;
                if (gets <= 2) return Promise.resolve({ status: 503, body: 'unavailable' });
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(gets).toBe(3);
    });

    // The bound exists because the failure mode it guards is an apiserver down for MINUTES: one
    // more failed read than POLL_MAX_CONSECUTIVE_FAILURES abandons the run, whose deadline has
    // all but certainly fired by then — polling on would hold a worker slot forever.
    it('abandons the run after too many consecutive failed reads', async () => {
        let gets = 0;
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (path === jobsPath(namespace) && method === 'POST') {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (path === jobPath(namespace, containerName(job))) {
                gets += 1;
                return Promise.resolve({ status: 503, body: 'unavailable' });
            }
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/in a row/);
        expect(gets).toBe(POLL_MAX_CONSECUTIVE_FAILURES + 1);
    });

    // Any throw after the Job was created — poll exhaustion, a vanished object — skips the
    // verdict-path cleanup, and the loop's catch never calls kill(). Without a delete here the
    // claim env's plaintext values stay in a Secret nobody will reap when the job retires dead.
    // The run never touches a Secret before creating it (the name carries the lease token, so
    // there is no pre-create sweep), so the proof is the LAST call being a delete — one the throw
    // came after.
    it('deletes the per-job Secret even when the run throws after creating it', async () => {
        const { request, calls } = fakeRequest({
            job: { status: 503, body: 'unavailable' },
        });
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        await expect(
            createKubernetesRunner(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), request, async () => {}).run(
                envJob,
                { id: SESSION, resume: false },
            ),
        ).rejects.toThrow(/in a row/);

        const last = calls[calls.length - 1]!;
        expect(last.method).toBe('DELETE');
        expect(last.path).toBe(`/api/v1/namespaces/${namespace}/secrets/${secretName(envJob)}`);
        // And it was the post-create cleanup: the Job create, its failed status polls and the
        // delete all follow the Secret's creation.
        const secretCreate = calls.findIndex((c) => c.method === 'POST' && c.path?.endsWith('/secrets'));
        const lastDelete = calls.length - 1;
        expect(lastDelete).toBeGreaterThan(secretCreate);
    });

    // Two outages of 10 reads each would trip the bound if the count carried across them — it
    // must not. One good read in between proves the job is alive and observable again.
    it('recounts after a good read, so separate outages do not add up', async () => {
        const outage = (): K8sResponse => ({ status: 503, body: 'unavailable' });
        const script: K8sResponse[] = [
            ...Array.from({ length: 10 }, outage),
            { status: 200, body: JSON.stringify({ status: {} }) },
            ...Array.from({ length: 10 }, outage),
            FAKE.job as K8sResponse,
        ];
        let served = 0;
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (path === jobsPath(namespace) && method === 'POST') {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(script[served++] ?? outage());
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
        expect(served).toBe(22);
    });

    /*
     * A completed pod can be garbage-collected before the list that reads its exit code. The Job
     * status is then the verdict: this Job runs one pod and never retries it, so the controller
     * can only have counted success on an exit-0 termination — and a null exit code would map to
     * `failed` in the loop, recording finished work as failed.
     */
    it('treats the Job status as the verdict when its pod is already gone', async () => {
        const { request } = fakeRequest({ pods: { status: 200, body: JSON.stringify({ items: [] }) } });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
        expect(outcome.output).toBe('');
    });

    it('still reports a failed job when its pod is gone', async () => {
        const { request } = fakeRequest({
            job: { status: 200, body: JSON.stringify({ status: { failed: 1 } }) },
            pods: { status: 200, body: JSON.stringify({ items: [] }) },
        });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBeNull();
        expect(outcome.timedOut).toBe(false);
        expect(outcome.output).toBe('');
    });

    // After a re-claim, the replaced attempt's pod can still be listed while it terminates — same
    // job-name label, different run. Its exit code must never be reported as this run's verdict.
    it('skips a pod that is still terminating, rather than reporting its exit code', async () => {
        const { request } = fakeRequest({
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: `${podName}-old`, deletionTimestamp: '2026-08-29T12:06:00.000Z' },
                            status: { containerStatuses: [{ state: { terminated: { exitCode: 7 } } }] },
                        },
                        {
                            metadata: { name: podName },
                            status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
                        },
                    ],
                }),
            },
        });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
    });

    // A vanished Job object is not a transient failure: its verdict can never arrive, so polling
    // on would hold a worker slot forever.
    it('abandons the run when the job object is gone', async () => {
        const { request } = fakeRequest({ job: { status: 404, body: '{"kind":"Status"}' } });
        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /no longer exists/,
        );
    });

    // The deadline is enforced by the kubelet, so the Job reports failed with the reason attached;
    // the driver maps that onto the same verdict `docker kill` after DRIVER_JOB_TIMEOUT_MS gets.
    it('treats DeadlineExceeded as a timeout', async () => {
        const { request } = fakeRequest({ job: FAKE.failed });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.timedOut).toBe(true);
    });

    // The runner never started — creation was refused. Reporting `failed` would blame the command
    // for the driver's problem, so the error propagates and the loop leaves the job to its lease.
    it('leaves a job to its lease when the job cannot be created', async () => {
        const { request } = fakeRequest({ create: { status: 500, body: 'nope' } });
        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/500/);
    });

    it('keeps polling the pod list through transient API failures', async () => {
        let lists = 0;
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                lists += 1;
                // A 503 during an apiserver upgrade is not the run's verdict; the exit code is
                // still out there. The third read succeeds.
                return Promise.resolve(
                    lists <= 2 ? { status: 503, body: 'unavailable' } : (FAKE.pods as K8sResponse),
                );
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(lists).toBe(3);
    });

    // A log read that fails outright — connection reset, pod gone — must not fail the report: the
    // exit code already carries the verdict, and re-running finished work is the worse outcome.
    it('keeps the verdict when the log read fails outright', async () => {
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            if (method === 'POST' && path === jobsPath(namespace)) {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (path === jobPath(namespace, containerName(job))) {
                return Promise.resolve(FAKE.job as K8sResponse);
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=')) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.reject(new Error('connection reset'));
            {
                const aux = auxRoutes(method, path);
                if (aux) return Promise.resolve(aux);
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(outcome.output).toBe('');
    });

    it('kill deletes the job and tolerates it already being gone', async () => {
        const calls: Call[] = [];
        const request: K8sRequest = (method, path) => {
            calls.push({ method, path });
            // First call is the Job DELETE (200); everything after — the service fleet's lease
            // lists and their deletes — answers 404, the ordinary end of nothing being there.
            return Promise.resolve({ status: calls.length === 1 ? 200 : 404, body: '{}' });
        };
        await runner(request).kill(job);
        await runner(request).kill(job);

        expect(calls[0].method).toBe('DELETE');
        expect(calls[0].path).toContain(`jobs/${containerName(job)}`);
        // Every further call is the job's own fleet teardown: the lease-scoped pod and service
        // lists (and 404 deletes for whatever they ever named). No Secrets — kill() deletes none.
        expect(calls.some((call) => call.path?.includes('/secrets'))).toBe(false);
        expect(calls.every((call) => call.method === 'DELETE' || call.path?.includes('?labelSelector='))).toBe(true);
    });

    // The id lands in the DELETE path the same way it lands in the create — asserted before it is
    // interpolated, whatever the call.
    it('kill refuses a job id that is not a uuid', async () => {
        const { request } = fakeRequest();
        await expect(runner(request).kill({ ...job, id: 'not-a-uuid' })).rejects.toThrow(/not a uuid/);
    });

    // Remote Control is refused at config under this executor, and the loop only polls the remote
    // id under Remote Control — so the honest answer here is the interface's own null.
    it('answers null for the remote session id', async () => {
        const { request } = fakeRequest();
        expect(await runner(request).remoteSessionId(job, SESSION)).toBeNull();
    });
});

// ==============================================================================================
// Gates under kubernetes: a gate run IS a Job — the declared image over the workspaces PVC,
// workingDir at the checkout, env by reference. Everything security-relevant about a gate Job is
// decided in gateJobSpec and pinned here, exactly as the runner's is in runnerJobSpec.
// ==============================================================================================

const gatedConfig = loadDriverConfig({
    EXECUTOR: 'kubernetes',
    K8S_NAMESPACE: namespace,
    GATE_TIMEOUT_MS: '30000',
});

describe('the gate job spec', () => {
    const ROOT_KEY = '55555555-5555-4555-8555-555555555555';
    const gateSpec = (overrides: Parameters<typeof gateJobSpec>[6] = 1, envSecret: string | null = 'the-secret') =>
        gateJobSpec(gatedConfig, job, `bellows/${USER}/.worktrees/${ROOT_KEY}`, 'node:24', 'test', 'npm test', overrides, envSecret, 30_000);

    it('is a batch/v1 Job named after the job id, lease and gate, unique per run', () => {
        expect(gateSpec().apiVersion).toBe('batch/v1');
        expect(gateSpec().metadata.name).toMatch(/^factory-gate-test-[0-9a-f]{8}$/);
        // A second run of the same gate is a different object — ad-hoc calls land mid-run, and
        // two runs of one gate must never race for one name.
        expect(gateSpec(2).metadata.name).not.toBe(gateSpec(1).metadata.name);
    });

    // The command travels as ONE argv element into `sh -c` — the same single element docker
    // exec's gate runs receive. It is never interpolated into a larger shell line.
    it('runs the declared command via sh -c as one argv element', () => {
        expect(gateSpec().spec.template.spec.containers[0].command).toEqual(['sh', '-c', 'npm test']);
    });

    it("works at the checkout the coding agent edits — the same tree, via the same PVC", () => {
        const container = gateSpec().spec.template.spec.containers[0];
        expect(container.workingDir).toBe(`/workspaces/bellows/${USER}/.worktrees/${ROOT_KEY}`);
        expect(container.image).toBe('node:24');
        expect(gateSpec().spec.template.spec.volumes).toEqual([
            { name: 'workspaces', persistentVolumeClaim: { claimName: 'factory-ai_workspaces' } },
        ]);
    });

    it('carries the attempt labels and no ServiceAccount token', () => {
        const s = gateSpec();
        expect(s.metadata.labels).toEqual({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
        });
        expect(s.spec.template.metadata.labels).toEqual(s.metadata.labels);
        expect(s.spec.template.spec.automountServiceAccountToken).toBe(false);
    });

    // The kubelet's deadline is the gate's wall-clock cap; the driver reads DeadlineExceeded
    // off the finished Job and reports exit 124.
    it('bounds the run with activeDeadlineSeconds from GATE_TIMEOUT_MS', () => {
        expect(gateSpec().spec.activeDeadlineSeconds).toBe(30);
        expect(gateSpec().spec.backoffLimit).toBe(0);
        expect(gateSpec().spec.template.spec.restartPolicy).toBe('Never');
    });

    // The env travels by reference and never as literals — the same rule that keeps claim
    // values out of the runner pod spec keeps them out of a gate pod spec.
    it('reads the env from a Secret by reference, and skips envFrom entirely when there is none', () => {
        expect(gateSpec().spec.template.spec.containers[0].envFrom).toEqual([
            { secretRef: { name: 'the-secret' } },
        ]);
        expect(gateSpec(1, null).spec.template.spec.containers[0].envFrom).toBeUndefined();
        expect(JSON.stringify(gateSpec())).not.toContain('"value":');
    });

    it('sanitizes a hostile gate name into a legal k8s name without carrying it raw', () => {
        const s = gateJobSpec(gatedConfig, job, `bellows/${USER}/.worktrees/${ROOT_KEY}`, 'node:24', 'UPPER Case!!', 'npm test', 1, null, 30_000);
        expect(s.metadata.name).toMatch(/^factory-gate-[a-z0-9.-]+-[0-9a-f]{8}$/);
        expect(s.metadata.name).not.toContain('UPPER');
        expect(s.metadata.name).not.toContain('Case');
    });

    it('refuses a checkout key or image that is not the shape the board legally produces', () => {
        expect(() => gateSpec(1, null)).not.toThrow();
        expect(() =>
            gateJobSpec(gatedConfig, job, '../other-member/repo', 'node:24', 'test', 'npm test', 1, null, 30_000),
        ).toThrow(/checkout key/);
        expect(() =>
            gateJobSpec(gatedConfig, job, `bellows/${USER}/.worktrees/${ROOT_KEY}`, '-flag-image', 'test', 'npm test', 1, null, 30_000),
        ).toThrow(/image reference/);
    });
});

describe('the gate env body', () => {
    it('parses NAME=value lines and drops nothing but the newlines', () => {
        expect(envBodyToData('A=1\nB=hello world\n')).toEqual({ A: '1', B: 'hello world' });
    });

    it('refuses a line that is not NAME=value, before it becomes a Secret key', () => {
        expect(() => envBodyToData('A=1\nnot-a-pair\n')).toThrow(/NAME=value/);
        expect(() => envBodyToData('bad key!=1')).toThrow(/NAME=value/);
    });
});

describe('the kubernetes gate manager', () => {
    const KEY = `bellows/${USER}/.worktrees/55555555-5555-4555-8555-555555555555`;
    const GATE_JOB = /^factory-gate-test-[0-9a-f]{8}$/;

    /** A fake that routes the objects one gate run touches: env Secret, Job, its pod, its log. */
    const gateFake = (options: {
        job?: K8sResponse;
        pods?: K8sResponse;
        log?: K8sResponse;
        secretCreate?: K8sResponse;
        jobCreate?: K8sResponse;
    } = {}) => {
        const calls: Call[] = [];
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const respond = (r: K8sResponse) => Promise.resolve(r);
            if (path === `/api/v1/namespaces/${namespace}/secrets`) {
                if (method === 'DELETE') return respond({ status: 200, body: '{}' });
                return respond(options.secretCreate ?? { status: 201, body: '{}' });
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/secrets/`)) return respond({ status: 200, body: '{}' });
            if (path === jobsPath(namespace)) {
                if (method === 'DELETE') return respond({ status: 200, body: '{}' });
                return respond(options.jobCreate ?? { status: 201, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}/`)) {
                return respond(options.job ?? { status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) });
            }
            if (path.includes('pods?') && decodeURIComponent(path).includes('job-name=')) {
                return respond(
                    options.pods ?? {
                        status: 200,
                        body: JSON.stringify({
                            items: [
                                {
                                    metadata: { name: 'gate-pod' },
                                    status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
                                },
                            ],
                        }),
                    },
                );
            }
            if (path.includes('/log')) return respond(options.log ?? { status: 200, body: 'gate said hi\n' });
            return Promise.reject(new Error(`gate fake has no answer for ${method} ${path}`));
        };
        return { request, calls };
    };

    const manager = (request: K8sRequest) =>
        createKubernetesGateManager({ config: gatedConfig, request, sleep: async () => {} });

    it('creates the attempt env Secret before the Job, and reaps the Job with the verdict', async () => {
        const { request, calls } = gateFake();
        const m = manager(request);
        await m.acquire(KEY, 'node:24', 'CORE_TOKEN=shh\n', job);
        const outcome = await m.runGate(KEY, 'test', 'npm test');

        expect(outcome).toEqual({ exitCode: 0, output: 'gate said hi' });
        const secretPost = calls.findIndex((c) => c.method === 'POST' && c.path?.endsWith('/secrets'));
        const jobPost = calls.findIndex((c) => c.method === 'POST' && c.path === jobsPath(namespace));
        expect(secretPost).toBeGreaterThanOrEqual(0);
        expect(secretPost).toBeLessThan(jobPost);
        // The Secret carries the env values, labeled to this attempt — one per attempt, created
        // before any gate Job references it.
        expect(calls[secretPost]?.body).toMatchObject({
            kind: 'Secret',
            stringData: { CORE_TOKEN: 'shh' },
            metadata: { labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken } },
        });
        expect(calls[secretPost]?.body).toMatchObject({
            metadata: { name: gateEnvSecretName(job) },
        });
        // The Job goes once the verdict and log have been read; the Secret's life is the
        // attempt's, and release() is what ends it.
        expect(
            calls.some((c) => c.method === 'DELETE' && c.path?.startsWith(`${jobsPath(namespace)}/`)),
        ).toBe(true);
        expect(calls.some((c) => c.method === 'DELETE' && c.path?.includes('/secrets/'))).toBe(false);
        await m.release(KEY);
        expect(
            calls.some(
                (c) =>
                    c.method === 'DELETE' &&
                    c.path === `/api/v1/namespaces/${namespace}/secrets/${gateEnvSecretName(job)}`,
            ),
        ).toBe(true);
    });

    it('runs a gate with no env at all without touching a Secret', async () => {
        const { request, calls } = gateFake();
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', job);
        await m.runGate(KEY, 'test', 'npm test');
        expect(calls.some((c) => c.path?.includes('/secrets'))).toBe(false);
    });

    it('reports the kubelet deadline as exit 124, the docker timeout convention', async () => {
        const { request } = gateFake({
            job: {
                status: 200,
                body: JSON.stringify({ status: { failed: 1, conditions: [{ type: 'Failed', reason: 'DeadlineExceeded' }] } }),
            },
        });
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', job);
        const outcome = await m.runGate(KEY, 'test', 'npm test');
        expect(outcome.exitCode).toBe(124);
    });

    it('rejects with the harness code when the cluster refuses the run', async () => {
        const { request } = gateFake({ jobCreate: { status: 403, body: 'forbidden' } });
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', job);
        await expect(m.runGate(KEY, 'test', 'npm test')).rejects.toMatchObject({ code: 125 });
    });

    it('names an unpullable gate image instead of burning the deadline', async () => {
        const { request } = gateFake({
            job: { status: 200, body: '{"status":{}}' },
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: 'gate-pod' },
                            status: {
                                containerStatuses: [
                                    { state: { waiting: { reason: 'ImagePullBackOff', message: 'no such image' } } },
                                ],
                            },
                        },
                    ],
                }),
            },
        });
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', job);
        await expect(m.runGate(KEY, 'test', 'npm test')).rejects.toThrow(/ImagePullBackOff/);
    });

    it('refuses a run whose attempt context was never acquired, like docker refuses a missing container', async () => {
        const { request } = gateFake();
        await expect(manager(request).runGate(KEY, 'test', 'npm test')).rejects.toMatchObject({ code: 125 });
    });

    it('validates the checkout key and image shapes at acquire, before anything runs', async () => {
        const { request } = gateFake();
        const m = manager(request);
        await expect(m.acquire('../other/repo', 'node:24', '', job)).rejects.toThrow(/checkout key/);
        await expect(m.acquire(KEY, 'not an image!!', '', job)).rejects.toThrow(/image reference/);
        await expect(m.acquire(KEY, 'node:24', '', job)).resolves.toBeUndefined();
    });

    it('names the gate Job so two runs of one gate never collide', async () => {
        const { request, calls } = gateFake();
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', job);
        await m.runGate(KEY, 'test', 'npm test');
        await m.runGate(KEY, 'test', 'npm test');
        const names = calls
            .filter((c) => c.method === 'POST' && c.path === jobsPath(namespace))
            .map((c) => (c.body as { metadata?: { name?: string } })?.metadata?.name);
        expect(names[0]).toMatch(GATE_JOB);
        expect(names[0]).not.toBe(names[1]);
    });
});

// ==============================================================================================
// Auxiliary services under kubernetes: a pod per declared service, a headless Service as its DNS
// name, alive for exactly the attempt.
// ==============================================================================================

describe('the service pod and DNS specs', () => {
    const cache: ServiceSpec = {
        name: 'cache',
        image: 'redis',
        environment: [{ key: 'ALLOW_EMPTY_PASSWORD', value: 'yes' }],
    };

    it('runs the service as a never-restarted, token-less pod with the declared env as literals', () => {
        const pod = servicePodSpec(gatedConfig, job, cache);
        expect(pod.kind).toBe('Pod');
        expect(pod.metadata.name).toBe(`factory-job-${job.id}-${job.leaseToken}-svc-cache`);
        expect(pod.metadata.labels).toEqual({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
            'factory.service': 'cache',
        });
        expect(pod.spec.restartPolicy).toBe('Never');
        expect(pod.spec.automountServiceAccountToken).toBe(false);
        expect(pod.spec.containers[0].image).toBe('redis');
        expect(pod.spec.containers[0].env).toEqual([{ name: 'ALLOW_EMPTY_PASSWORD', value: 'yes' }]);
    });

    it('refuses an environment key that is not a variable name', () => {
        expect(() =>
            servicePodSpec(gatedConfig, job, { ...cache, environment: [{ key: 'not a key', value: 'x' }] }),
        ).toThrow(/not a valid environment variable name/);
    });

    it('names the DNS object exactly the service name, headless, selecting only this attempt', () => {
        const dns = serviceDnsSpec(job, cache);
        expect(dns.kind).toBe('Service');
        expect(dns.metadata.name).toBe('cache');
        expect(dns.spec.clusterIP).toBe('None');
        expect(dns.spec.selector).toEqual({ 'factory.job': job.id, 'factory.service': 'cache' });
    });
});

describe('the kubernetes services flow', () => {
    const KEY = `bellows/${USER}/.worktrees/55555555-5555-4555-8555-555555555555`;
    const BELLOWS_OUTPUT =
        '###__bellows:factory\nservices:\n  - name: cache\n    image: redis\n    environment:\n      ALLOW_EMPTY_PASSWORD: "yes"\n';

    /** A fake that routes one full run with services: readout Job, service objects, runner Job. */
    const servicesFake = (options: { bellowsLog?: string; dnsCreate?: K8sResponse } = {}) => {
        const calls: Call[] = [];
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            const respond = (r: K8sResponse) => Promise.resolve(r);
            const empty = { status: 200, body: '{"items":[]}' };
            if (path === jobsPath(namespace)) {
                // Every Job POST is accepted; nothing ever polls as failed.
                return respond({ status: 201, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                // The fence's job list: nothing of this job's left to sweep.
                return respond(empty);
            }
            if (path.startsWith(`${jobsPath(namespace)}/`)) {
                return respond({ status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) });
            }
            if (path === `/api/v1/namespaces/${namespace}/services`) {
                return respond(options.dnsCreate ?? { status: 201, body: '{}' });
            }
            // The readout's pod list: answer once with a pod so its log can be read.
            if (path.includes('pods?') && decodeURIComponent(path).includes('job-name=factory-bellows')) {
                return respond({
                    status: 200,
                    body: JSON.stringify({ items: [{ metadata: { name: 'bellows-pod' } }] }),
                });
            }
            if (path === `/api/v1/namespaces/${namespace}/pods/bellows-pod/log`) {
                return respond({ status: 200, body: options.bellowsLog ?? BELLOWS_OUTPUT });
            }
            if (path.includes('pods?') && decodeURIComponent(path).includes('job-name=')) {
                return respond({
                    status: 200,
                    body: JSON.stringify({
                        items: [
                            {
                                metadata: { name: 'runner-pod' },
                                status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
                            },
                        ],
                    }),
                });
            }
            if (path === `/api/v1/namespaces/${namespace}/pods/runner-pod/log`) {
                return respond({ status: 200, body: 'did the work\n' });
            }
            if (path.includes('pods?') || path.includes('services?')) return respond(empty);
            if (path === `/api/v1/namespaces/${namespace}/pods`) return respond({ status: 201, body: '{}' });
            if (path.includes('/secrets')) return respond({ status: 200, body: '{}' });
            if (path.startsWith('/api/v1/namespaces/factory/pods/')) return respond({ status: 200, body: '{}' });
            if (path.startsWith('/api/v1/namespaces/factory/services/')) return respond({ status: 200, body: '{}' });
            return Promise.reject(new Error(`services fake has no answer for ${method} ${path}`));
        };
        return { request, calls };
    };

    const servicesRunner = (request: K8sRequest) =>
        createKubernetesRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '1' }),
            request,
            async () => {},
        );

    it('starts the declared fleet before the runner and tears it down with the attempt', async () => {
        const { request, calls } = servicesFake();
        const outcome = await servicesRunner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // The readout Job ran first, then the service pod and its DNS name, and only then the
        // runner Job — docker's fleet-before-runner order.
        const bellowsPost = calls.findIndex((c) => c.body && (c.body as { metadata?: { name?: string } }).metadata?.name?.startsWith('factory-bellows-'));
        const podPost = calls.findIndex((c) => c.method === 'POST' && c.path?.endsWith('/pods'));
        const dnsPost = calls.findIndex((c) => c.method === 'POST' && c.path?.endsWith('/services'));
        const jobPost = calls.findIndex(
            (c) =>
                c.method === 'POST' &&
                c.path === jobsPath(namespace) &&
                (c.body as { metadata?: { name?: string } })?.metadata?.name === containerName(job),
        );
        expect(bellowsPost).toBeGreaterThanOrEqual(0);
        expect(podPost).toBeGreaterThan(bellowsPost);
        expect(dnsPost).toBeGreaterThan(podPost);
        expect(jobPost).toBeGreaterThan(dnsPost);

        // And the fleet goes with the attempt: the close-time teardown lists by lease. The
        // claim's release (GET, DELETE) precedes it; an env-less claim has no Secret to reap.
        const tail = calls.slice(-4);
        expect(tail.map((c) => c.method)).toEqual(['GET', 'DELETE', 'GET', 'GET']);
    });

    it('refuses a DNS-name collision terminally, naming the conflict instead of ordering the race', async () => {
        const { request, calls } = servicesFake({ dnsCreate: { status: 409, body: '{"reason":"AlreadyExists"}' } });
        const outcome = await servicesRunner(request).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: null, started: true });
        expect(outcome.output).toContain('already running for another job');
        // The runner Job was never created — a refused job has no runner to orphan.
        expect(
            calls.some((c) => c.method === 'POST' && c.path === jobsPath(namespace) && (c.body as { metadata?: { name?: string } })?.metadata?.name === containerName(job)),
        ).toBe(false);
        // And the partial fleet was torn down on the way out: the lease lists ran (their empty
        // answers mean the fake had nothing left to delete), plus the DNS 409'd object is
        // this attempt's own to name.
        expect(
            calls.some(
                (c) => c.method === 'GET' && c.path?.includes(`pods?labelSelector=${encodeURIComponent(`factory.lease=${job.leaseToken}`)}`),
            ),
        ).toBe(true);
        expect(
            calls.some(
                (c) => c.method === 'GET' && c.path?.includes(`services?labelSelector=${encodeURIComponent(`factory.lease=${job.leaseToken}`)}`),
            ),
        ).toBe(true);
    });

    it('fails the read as infrastructure when the readout object disappears', async () => {
        const { request } = servicesFake({ bellowsLog: 'cat: cannot open: boom' });
        // The readout Job answering 404 while its output is being read is INFRASTRUCTURE — the
        // object was removed under us — so the run throws and goes back to its lease, never
        // reporting a verdict over the API server's answer.
        const failing: K8sRequest = (method, path, body) => {
            if (path.startsWith(`${jobsPath(namespace)}/`) && decodeURIComponent(path).includes('factory-bellows')) {
                return Promise.resolve({ status: 404, body: '{}' });
            }
            return servicesFake().request(method, path, body);
        };
        await expect(servicesRunner(failing).run(job, { id: SESSION, resume: false })).rejects.toThrow();
    });
});
