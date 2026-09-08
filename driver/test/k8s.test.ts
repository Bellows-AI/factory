import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { containerName } from '../src/docker.js';
import type { K8sRequest, K8sResponse } from '../src/k8s.js';
import {
    POLL_MAX_CONSECUTIVE_FAILURES,
    createKubernetesRunner,
    jobPath,
    jobsPath,
    runnerJobSpec,
    secretName,
} from '../src/k8s.js';

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
        // WORKDIR is the only literal value a runner env carries, and it is a path, not a secret.
        expect(container.env.filter((entry) => 'value' in entry)).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
        ]);
    });

    it('forwards no credentials when no secret is configured', () => {
        const container = spec().spec.template.spec.containers[0];
        expect(container.env).toEqual([{ name: 'WORKDIR', value: `/workspaces/bellows/${USER}` }]);
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
        expect(container.env.filter((entry) => 'value' in entry)).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
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
    const request: K8sRequest = (method, path, body) => {
        calls.push({ method, path, body });
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
        if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
            return Promise.resolve(answers.pods as K8sResponse);
        }
        if (path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`)) {
            return Promise.resolve(answers.log as K8sResponse);
        }
        return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
    };
    return { request, calls };
};

const runner = (request: K8sRequest) => createKubernetesRunner(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), request, async () => {});

describe('the kubernetes runner', () => {
    it('sweeps the job label, then creates the job in the configured namespace and reports success', async () => {
        const { request, calls } = fakeRequest();
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        // The fence is the first thing the run does: a label LIST of the job's previous
        // attempts — nothing deletable answers — before this one creates anything.
        expect(calls[0]).toEqual({ method: 'GET', path: expect.stringContaining(jobsPath(namespace)) });
        expect(calls[0].path).toContain(`labelSelector=${encodeURIComponent(`factory.job=${job.id}`)}`);
        expect(calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`)).toEqual([
            `GET ${jobsPath(namespace)}`,
            `POST ${jobsPath(namespace)}`,
            `GET ${jobPath(namespace, containerName(job))}`,
            'GET /api/v1/namespaces/factory/pods',
            `GET /api/v1/namespaces/factory/pods/${podName}/log`,
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
        const request: K8sRequest = (method, path) => {
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
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) {
                return gets === 1
                    ? Promise.resolve({ status: 200, body: 'partial output\n' })
                    : Promise.resolve(FAKE.log as K8sResponse);
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
        const request: K8sRequest = (method, path) => {
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
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve({ status: 500, body: 'unavailable' });
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
        const request: K8sRequest = (method, path) => {
            calls.push({ method, path });
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                lists += 1;
                // First read: the old Job is still listed. Second: gone. Everything after is
                // the NEW Job's own status poll.
                return Promise.resolve(
                    lists === 1
                        ? {
                              status: 200,
                              body: JSON.stringify({
                                  items: [
                                      {
                                          metadata: {
                                              name: leftover,
                                              creationTimestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
                                          },
                                      },
                                  ],
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
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
        // LIST finds the leftover by label, deletes it BY NAME with Foreground propagation,
        // LISTs again — nothing deletable answers — and only then the create. Foreground
        // propagation starts the teardown; the next list is what proves the old pods are off
        // the checkout — the delete's own response does not wait for them.
        expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'GET', 'POST', 'GET', 'GET', 'GET']);
        expect(calls[0].path).toContain(`labelSelector=${encodeURIComponent(`factory.job=${job.id}`)}`);
        expect(calls[1].path).toBe(`${jobPath(namespace, leftover)}?propagationPolicy=Foreground`);
    });

    // A re-claim whose sweep never lands — an apiserver losing deletes, say — must not loop
    // forever heartbeating a lease around a create that would run alongside leftovers. Bounded,
    // then thrown: the job goes back to the board rather than two writers racing one checkout.
    it('gives up when a deletable leftover job never disappears', async () => {
        const leftover = {
            metadata: {
                name: 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner',
                creationTimestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
            },
        };
        const request: K8sRequest = (method, path) => {
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
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /never disappeared/,
        );
    });

    // The env Secret this run creates precedes its first Job POST — and must SURVIVE the fence:
    // the Job references it by name, and a deleted one would start the pod silently without its
    // claim env. The fence sweeps JOBS by label and nothing else — and the Secret's name carries
    // this attempt's own lease token, so there is no previous attempt's Secret at this name.
    it('keeps the freshly created Secret across the label fence', async () => {
        const calls: Call[] = [];
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
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
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
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
     * The reported race: attempt A's fence DELETE is still in flight when A's lease expires and
     * the board reclaims the job; replacement attempt B creates its Job under the same
     * `factory.job` label. Kubernetes evaluates a selector at PROCESSING time, so A's delayed
     * collection DELETE would foreground-delete B's active Job, and B's runner would abort on
     * the vanished object. The fence therefore deletes BY NAME, and only objects whose
     * creationTimestamp proves they predate the fence: a Job created after the fence began —
     * the replacement's own — is never deleted and never waited on.
     */
    it("deletes only leftover jobs older than the fence, never a replacement's fresh Job", async () => {
        const now = Date.now();
        const oldName = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        const freshName = 'factory-job-11111111-1111-4111-8111-111111111111-newlease-runner';
        const oldJob = { metadata: { name: oldName, creationTimestamp: new Date(now - 10 * 60_000).toISOString() } };
        const freshJob = { metadata: { name: freshName, creationTimestamp: new Date(now).toISOString() } };
        let old = true;
        let fresh = true;
        const calls: Call[] = [];
        const request: K8sRequest = (method, path) => {
            calls.push({ method, path });
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({ items: [old ? oldJob : null, fresh ? freshJob : null].filter(Boolean) }),
                });
            }
            // The API server evaluates a selector at processing time: a collection DELETE would
            // take BOTH jobs — the genuine leftover and the replacement's fresh one. That is
            // the bug this fence must make unreachable.
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
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // No collection DELETE anywhere in the run: one whose selector would match the
        // replacement's fresh Job is exactly the delete this fence must never issue.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes('labelSelector='))).toBe(false);
        // The old leftover goes by NAME, Foreground.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, oldName)}?propagationPolicy=Foreground`,
        });
        // The fresh Job — created after this fence began, the replacement's own — is never
        // deleted at all.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(freshName))).toBe(false);
        // And the fence did not wait for it: the LIST after the deletes found only fresh
        // objects, which do not block — the create went straight ahead.
        expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'GET', 'POST', 'GET', 'GET', 'GET']);
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
        const request: K8sRequest = (method, path) => {
            calls.push({ method, path });
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
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
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
        const request: K8sRequest = (method, path) => {
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
        const request: K8sRequest = (method, path) => {
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
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
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
        const request: K8sRequest = (method, path) => {
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
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                lists += 1;
                // A 503 during an apiserver upgrade is not the run's verdict; the exit code is
                // still out there. The third read succeeds.
                return Promise.resolve(
                    lists <= 2 ? { status: 503, body: 'unavailable' } : (FAKE.pods as K8sResponse),
                );
            }
            if (path.includes('/log')) return Promise.resolve(FAKE.log as K8sResponse);
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(lists).toBe(3);
    });

    // A log read that fails outright — connection reset, pod gone — must not fail the report: the
    // exit code already carries the verdict, and re-running finished work is the worse outcome.
    it('keeps the verdict when the log read fails outright', async () => {
        const request: K8sRequest = (method, path) => {
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
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                return Promise.resolve(FAKE.pods as K8sResponse);
            }
            if (path.includes('/log')) return Promise.reject(new Error('connection reset'));
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
            return Promise.resolve({ status: calls.length === 1 ? 200 : 404, body: '{}' });
        };
        await runner(request).kill(job);
        await runner(request).kill(job);

        expect(calls.every((call) => call.method === 'DELETE')).toBe(true);
        expect(calls[0].path).toContain(`jobs/${containerName(job)}`);
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
