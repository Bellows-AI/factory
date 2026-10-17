import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { jobsPath, runnerJobName, secretName } from '../src/k8s-podspec.js';
import { reclaimGroupName } from '../src/k8s-group.js';
import { createKubernetesRunner } from '../src/k8s-runner.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../src/k8s-transport.js';
import type { StepSink, SupervisorEndpoint } from '../src/step-control.js';
import {
    AGENT_CONTAINER,
    SUPERVISOR_ENV,
    type StepRequest,
    type StepResult,
    type SupervisorReport,
} from '../src/supervisor-contract.js';

/**
 * The kubernetes task group (issue #771): one Job per attempt, created by its first step and ended
 * by the loop's `finish`. What these pin is the acceptance of the change — the sync, the tree probe,
 * the review snapshot, the publish, the helpers and the reclaim create no Job or container of
 * their own — over a fake apiserver that records every object the driver creates.
 */
const NAMESPACE = 'factory';
const USER = '44444444-4444-4444-8444-444444444444';
const SESSION = { id: '33333333-3333-4333-8333-333333333333', resume: false };
const CONTROL_TOKEN = 'supervisor-control-token';
const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NAMESPACE, RUNNER_SERVICES: '0' });

const job = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    maxAttempts: 1,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt:
        'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    rootCommand: 'fix the failing build',
    repo: 'Bellows-AI/factory',
    env: { GITHUB_TOKEN: 'ghs_claim' },
    supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: CONTROL_TOKEN },
} as BoardJob;

const ok = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const json = (body: unknown, status = 200): K8sResponse => ({ status, body: JSON.stringify(body) });

interface Created {
    jobs: { name: string; containers: string[] }[];
    secrets: string[];
    deletedJobs: string[];
    deletedSecrets: string[];
}

/** A fake apiserver that keeps the checkout claim honest and records every Job and Secret the driver creates. */
function cluster(options: { ended?: boolean; imagePull?: string; agentExit?: number } = {}) {
    const created: Created = { jobs: [], secrets: [], deletedJobs: [], deletedSecrets: [] };
    const claims = new Map<string, { uid: string; holder: string; claimSeq: string }>();
    const gone = new Set<string>();
    const configmaps = `/api/v1/namespaces/${NAMESPACE}/configmaps`;
    const secrets = `/api/v1/namespaces/${NAMESPACE}/secrets`;
    const request: K8sRequest = async (method: K8sMethod, path: string, body?: unknown) => {
        if (path === configmaps && method === 'POST') {
            const claim = body as { metadata: { name: string }; data: { holder: string; claimSeq: string } };
            if (claims.has(claim.metadata.name)) return { status: 409, body: '{}' };
            claims.set(claim.metadata.name, { uid: `uid-${claims.size}`, ...claim.data });
            return json({}, 201);
        }
        if (path.startsWith(`${configmaps}/`)) {
            const name = path.slice(configmaps.length + 1);
            const claim = claims.get(name);
            if (method === 'DELETE') {
                claims.delete(name);
                return json({});
            }
            return claim ? json({ metadata: { uid: claim.uid }, data: claim }) : { status: 404, body: '{}' };
        }
        if (path === secrets && method === 'POST') {
            created.secrets.push((body as { metadata: { name: string } }).metadata.name);
            return json({}, 201);
        }
        if (path.startsWith(`${secrets}/`)) {
            created.deletedSecrets.push(path.slice(secrets.length + 1));
            return json({});
        }
        if (path === jobsPath(NAMESPACE) && method === 'POST') {
            const spec = body as {
                metadata: { name: string };
                spec: { template: { spec: { containers: { name: string }[] } } };
            };
            created.jobs.push({
                name: spec.metadata.name,
                containers: spec.spec.template.spec.containers.map((c) => c.name),
            });
            return json({}, 201);
        }
        if (path.startsWith(`${jobsPath(NAMESPACE)}/`)) {
            const name = path.slice(jobsPath(NAMESPACE).length + 1).split('?')[0]!;
            if (method === 'DELETE') {
                created.deletedJobs.push(name);
                gone.add(name);
                return json({});
            }
            if (gone.has(name)) return { status: 404, body: '{}' };
            // The attempt's group serves until finished; any other Job (a close-time readout) is long done.
            const isGroup = name === runnerJobName(job);
            return json({ status: !isGroup || options.ended ? { succeeded: 1 } : {} });
        }
        if (path.endsWith('/log')) return { status: 200, body: '' };
        // The sweep's selector lists, and the pod discovery by `job-name`.
        if (path.includes('labelSelector')) {
            if (!decodeURIComponent(path).includes('job-name=')) return json({ items: [] });
            if (options.imagePull) {
                return json({
                    items: [
                        {
                            metadata: { name: 'pod-1' },
                            status: {
                                containerStatuses: [
                                    { state: { waiting: { reason: 'ErrImagePull', message: options.imagePull } } },
                                ],
                            },
                        },
                    ],
                });
            }
            // A live pod: the agent has exited with its status, the supervisor beside it is still serving.
            return json({
                items: [
                    {
                        metadata: { name: 'pod-1' },
                        status: {
                            phase: 'Running',
                            containerStatuses: [
                                { name: AGENT_CONTAINER, state: { terminated: { exitCode: options.agentExit ?? 0 } } },
                                { name: 'supervisor', state: { running: {} } },
                            ],
                        },
                    },
                ],
            });
        }
        return { status: 404, body: '{}' };
    };
    return { request, created };
}

/** The supervised-step channel: records every step, answers each by kind, and reports on demand. */
function steps(answer: (step: StepRequest) => StepResult = () => ok(), contacted = true) {
    const submitted: StepRequest[] = [];
    const tokens = new Set<string>();
    let report!: (r: SupervisorReport) => void;
    const reported = new Promise<SupervisorReport>((resolve) => {
        report = resolve;
    });
    const sink: StepSink = {
        submit: async (token, step) => {
            tokens.add(token);
            submitted.push(step);
            return answer(step);
        },
        awaitReport: () => reported,
        contacted: () => contacted,
    };
    return { sink, submitted, tokens, report };
}

const FAST = async (): Promise<void> => undefined;
const runner = (request: K8sRequest, sink: StepSink, endpoint?: SupervisorEndpoint) =>
    createKubernetesRunner(config, request, FAST, { steps: sink, ...(endpoint ? { endpoint } : {}) });

const kinds = (s: { submitted: StepRequest[] }): string[] => s.submitted.map((step) => step.kind);

describe('the task group of one attempt', () => {
    it('creates one Job for the whole attempt: the sync, probe, snapshot, publish, helper and finish create none of their own', async () => {
        const api = cluster({ ended: true });
        const s = steps((step) => {
            if (step.kind === 'sync') return ok('{"ok":true,"reason":null,"fingerprint":"fp"}');
            if (step.kind === 'probe') return ok(`${JSON.stringify({ cloned: false })}\n`);
            if (step.kind === 'snapshot') return ok('{"ok":true}');
            if (step.kind === 'helper') return ok('{}');
            return ok();
        });
        const k8s = runner(api.request, s.sink);

        expect(await k8s.syncCheckout(job, undefined, SESSION)).toMatchObject({ ok: true });
        await k8s.probeTree!(job);
        await k8s.snapshotTree!(job, 'review-1');
        await k8s.runHelper!(job, { phase: 'pre', helperId: 'noop', input: {}, githubWriting: false } as never);
        await k8s.publishGit!(job, 'ghs_publish_fresh');
        await k8s.finish!(job);

        // One Job: the attempt's group — and every step went to its supervisor.
        expect(api.created.jobs).toEqual([
            { name: runnerJobName(job), containers: [AGENT_CONTAINER, 'supervisor', 'exporter'] },
        ]);
        expect(kinds(s)).toEqual(expect.arrayContaining(['sync', 'probe', 'snapshot', 'helper', 'finish']));
        expect(s.tokens).toEqual(new Set([CONTROL_TOKEN]));
        // One Secret — the runner's — under the name the admission policy admits; none for a step.
        expect(api.created.secrets).toEqual([secretName(job)]);
        // The group goes when the attempt does.
        expect(api.created.deletedSecrets).toContain(secretName(job));
    });

    it("gives the sync and the publish step the board's minted tokens, and none reaches a Secret", async () => {
        const api = cluster({ ended: true });
        const s = steps((step) => (step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : ok('{"cloned":false}')));
        const k8s = runner(api.request, s.sink);
        await k8s.syncCheckout(job, undefined, SESSION, 'ghs_sync_minted');
        await k8s.publishGit!(job, 'ghs_publish_minted');

        const sync = s.submitted.find((step) => step.kind === 'sync')!;
        expect(sync.env.GITHUB_TOKEN).toBe('ghs_sync_minted');
        // The claim's own value under the reserved name rides nothing.
        expect(JSON.stringify(s.submitted)).not.toContain('ghs_claim');
        expect(JSON.stringify(api.created)).not.toContain('ghs_sync_minted');
        expect(JSON.stringify(api.created)).not.toContain('ghs_publish_minted');
        expect(JSON.stringify(api.created)).not.toContain('ghs_claim');
    });

    it('releases the agent on `run`, waits for the supervisor’s report and leaves the group up for the steps after it', async () => {
        const api = cluster();
        const s = steps((step) => (step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : ok()));
        const k8s = runner(api.request, s.sink);
        await k8s.syncCheckout(job, undefined, SESSION);
        const running = k8s.run(job, SESSION);
        s.report({ outcome: 'completed', cause: null, agentExit: 0, agentEnd: 'exit', drained: true });

        const outcome = await running;

        expect(kinds(s)).toEqual(['sync', 'go']);
        expect(outcome).toMatchObject({ exitCode: 0, timedOut: false, started: true });
        // The Job is still the attempt's: nothing deleted it, and nothing else was created.
        // (The close-time turn readout is a Job of its own until its own issue retires it.)
        expect(api.created.deletedJobs.filter((name) => !name.startsWith('factory-cturns-'))).toEqual([]);
        expect(api.created.jobs.filter((created) => created.name === runnerJobName(job))).toHaveLength(1);
    });

    it('reads the budget’s end from the supervisor’s report as the run’s timeout', async () => {
        const api = cluster({ agentExit: 143 });
        const s = steps((step) => (step.kind === 'sync' ? ok('{"ok":true,"reason":null}') : ok()));
        const k8s = runner(api.request, s.sink);
        await k8s.syncCheckout(job, undefined, SESSION);
        const running = k8s.run(job, SESSION);
        s.report({ outcome: 'timed_out', cause: 'timeout', agentExit: 143, agentEnd: 'exit', drained: true });
        expect(await running).toMatchObject({ exitCode: 143, timedOut: true });
    });

    it('takes the group down and hands the checkout back when the sync fails', async () => {
        const api = cluster();
        const s = steps(() => ok('{"ok":false,"reason":"the rebase conflicts"}'));
        const k8s = runner(api.request, s.sink);

        expect(await k8s.syncCheckout(job, undefined, SESSION)).toMatchObject({
            ok: false,
            reason: 'the rebase conflicts',
        });

        expect(api.created.deletedJobs).toEqual([runnerJobName(job)]);
        expect(api.created.deletedSecrets).toContain(secretName(job));
        // The claim is free again: a replacement's sync takes it at once.
        const replacement = runner(api.request, steps(() => ok('{"ok":true,"reason":null}')).sink);
        expect(await replacement.syncCheckout(job, undefined, SESSION)).toMatchObject({ ok: true });
    });

    it('answers a group whose image cannot be pulled as a failed sync, naming the image problem', async () => {
        const api = cluster({ imagePull: 'manifest unknown' });
        const s = steps(() => ok('{"ok":true,"reason":null}'), false);
        const k8s = runner(api.request, s.sink);

        const synced = await k8s.syncCheckout(job, undefined, SESSION);

        expect(synced).toMatchObject({ ok: false, reason: expect.stringContaining('cannot be pulled') });
        // No step was submitted to a supervisor that never came up, and the group is gone.
        expect(s.submitted).toEqual([]);
        expect(api.created.deletedJobs).toEqual([runnerJobName(job)]);
    });

    it('creates a supervisor-only group for an adopted attempt, which has no agent to start', async () => {
        const api = cluster({ ended: true });
        const s = steps(() => ok('{"cloned":false}'));
        const k8s = runner(api.request, s.sink);

        await k8s.publishGit!(job);

        expect(api.created.jobs).toEqual([{ name: runnerJobName(job), containers: ['supervisor'] }]);
    });

    it('does not end a group it never created, and never throws for one', async () => {
        const api = cluster();
        const s = steps();
        await runner(api.request, s.sink).finish!(job);
        expect(s.submitted).toEqual([]);
        expect(api.created.deletedJobs).toEqual([]);
    });
});

describe('the reclaim of a thread with no attempt', () => {
    const endpoint: SupervisorEndpoint & { closed: string[] } = {
        closed: [],
        open: async () => ({ url: 'http://driver:8130', token: 'reclaim-token' }),
        close(token) {
            this.closed.push(token);
        },
    };

    it('runs in a supervisor-only group under a lease of its own, then deletes the group and its Secret', async () => {
        const api = cluster({ ended: true });
        const s = steps(() => ok('{"ok":true,"removed":true,"reason":null}'));
        const k8s = runner(api.request, s.sink, endpoint);

        expect(await k8s.reclaimWorktree(job)).toMatchObject({ ok: true, removed: true });

        const [group] = api.created.jobs;
        expect(api.created.jobs).toHaveLength(1);
        expect(group!.containers).toEqual(['supervisor']);
        expect(group!.name).not.toBe(runnerJobName(job));
        expect(group!.name).toMatch(/^factory-reclaim-/);
        expect(api.created.deletedJobs).toEqual([group!.name]);
        expect(kinds(s)).toEqual(['reclaim', 'finish']);
        expect(s.tokens).toEqual(new Set(['reclaim-token']));
        expect(endpoint.closed).toEqual(['reclaim-token']);
        // Its Secret is not the attempt's, and it is deleted with the group.
        expect(api.created.secrets).toHaveLength(1);
        expect(api.created.secrets[0]).not.toBe(secretName(job));
        expect(api.created.deletedSecrets).toEqual(api.created.secrets);
    });

    it('refuses without an endpoint to serve the group from, never by running the reclaim some other way', async () => {
        const api = cluster();
        const result = await runner(api.request, steps().sink).reclaimWorktree(job);
        expect(result).toMatchObject({
            ok: false,
            removed: false,
            reason: expect.stringContaining('no supervisor endpoint'),
        });
        expect(api.created.jobs).toEqual([]);
    });

    it('names its group apart from the attempt’s', () => {
        expect(reclaimGroupName(job)).not.toBe(runnerJobName(job));
    });
});
