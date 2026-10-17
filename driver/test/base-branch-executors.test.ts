import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { RESERVED_ENV_NAMES } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { dockerArgs } from '../src/docker.js';
import { createDockerRunner } from '../src/docker-runner.js';
import type { StepSink } from '../src/step-control.js';
import { type StepRequest, SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import { runnerJobSpec } from '../src/k8s-podspec.js';
import { k8sSyncStep } from './k8s-sync-step.js';

/**
 * A claim that names its base branch (a batch task's target) on BOTH executors: the startup sync
 * carries BASE_BRANCH as a literal on docker and kubernetes alike, and a claim without one, or
 * with a value no branch can have, carries none.
 */

const USER = '44444444-4444-4444-8444-444444444444';
const ROOT = '55555555-5555-4555-8555-555555555555';

const base: BoardJob = {
    id: ROOT,
    rootJobId: ROOT,
    command: 'do the work',
    rootCommand: 'do the work',
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt: 'Factory execution contract (factory-master-prompt/v1)',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    repo: 'Bellows-AI/factory',
    env: {},
};
const onSandbox: BoardJob = { ...base, baseBranch: 'batch-sandbox' };
const malformed: BoardJob = { ...base, baseBranch: '-x;rm' };

/** The env of the sync step the docker runner submits to the attempt's supervisor for `job`. */
const dockerSync = async (job: BoardJob): Promise<Record<string, string>> => {
    const steps: StepRequest[] = [];
    const sink: StepSink = {
        submit: async (_token, step) => {
            steps.push(step);
            return { exitCode: 0, stdout: '{"ok":true,"reason":null}', stderr: '', timedOut: false };
        },
        awaitReport: () => new Promise(() => undefined),
        contacted: () => true,
    };
    const supervised: BoardJob = {
        ...job,
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: 'tok' },
    };
    const exec = async () => ({ stdout: '' });
    await createDockerRunner(loadDriverConfig({}), undefined, exec, { steps: sink }).syncCheckout(supervised);
    return steps[0]!.env;
};
/** The env of the sync step the kubernetes runner submits to the attempt's supervisor for `job`. */
const k8sSyncEnv = async (job: BoardJob): Promise<Record<string, string>> => (await k8sSyncStep(job)).env;

describe('the startup sync of a claim with a base branch', () => {
    it('on docker: BASE_BRANCH in the sync step’s env', async () => {
        expect(await dockerSync(onSandbox)).toMatchObject({ BASE_BRANCH: 'batch-sandbox' });
    });

    it('on kubernetes: the same literal, in the sync step’s env', async () => {
        expect(await k8sSyncEnv(onSandbox)).toMatchObject({ BASE_BRANCH: 'batch-sandbox' });
    });

    it.each([
        ['no base branch', base],
        ['a value no branch can have', malformed],
    ])('carries none for %s, on either executor', async (_case, job) => {
        expect(await dockerSync(job)).not.toHaveProperty('BASE_BRANCH');
        expect(await k8sSyncEnv(job)).not.toHaveProperty('BASE_BRANCH');
    });
});

describe('the run of a claim with a base branch', () => {
    const SESSION = { id: '33333333-3333-4333-8333-333333333333', resume: false };
    const dockerRun = (job: BoardJob) => dockerArgs(loadDriverConfig({}), job, SESSION, { envFile: '/tmp/env-file' });
    const k8sRunEnv = (job: BoardJob) =>
        runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), job, SESSION).spec.template.spec.containers[0]!
            .env as { name: string; value?: string }[];

    it('hands the agent BASE_BRANCH on both executors, so its merges and PRs name the base', () => {
        expect(dockerRun(onSandbox)).toContain('BASE_BRANCH=batch-sandbox');
        expect(k8sRunEnv(onSandbox)).toEqual(expect.arrayContaining([{ name: 'BASE_BRANCH', value: 'batch-sandbox' }]));
    });

    it('hands it to an opencode run too', () => {
        const opencode = { ...onSandbox, executorType: 'opencode' } as BoardJob;
        const argv = dockerArgs(loadDriverConfig({}), opencode, null, { envFile: '/tmp/env-file' });
        expect(argv).toContain('BASE_BRANCH=batch-sandbox');
    });

    it('hands none without one', () => {
        expect(dockerRun(base).some((arg) => arg.startsWith('BASE_BRANCH='))).toBe(false);
        expect(k8sRunEnv(base).map((entry) => entry.name)).not.toContain('BASE_BRANCH');
    });
});

it('reserves BASE_BRANCH from member env, so no member value can move a task’s base', () => {
    expect(RESERVED_ENV_NAMES).toContain('BASE_BRANCH');
});
