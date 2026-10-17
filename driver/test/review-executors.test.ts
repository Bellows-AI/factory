import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { createDockerRunner } from '../src/docker-runner.js';
import type { StepSink } from '../src/step-control.js';
import { type StepRequest, SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import { runnerJobSpec } from '../src/k8s-podspec.js';
import { SUPERVISOR_STEPS_MS, SUPERVISOR_WINDDOWN_MS } from '../src/supervisor-contract.js';
import { k8sSyncStep } from './k8s-sync-step.js';

/**
 * A named reviewer's run on BOTH executors (issue #549): the same restore-at-the-snapshot start,
 * no credential on the sync, and the same wall-clock budget. Docker is development only and
 * Kubernetes primary, so every assertion here has its twin — a reviewer must never behave one way
 * on a laptop and another in the cluster.
 */

const USER = '44444444-4444-4444-8444-444444444444';
const ROOT = '55555555-5555-4555-8555-555555555555';
const SESSION = '33333333-3333-4333-8333-333333333333';
const REF = `refs/factory/review/${ROOT}/sec-1`;

const base: BoardJob = {
    id: ROOT,
    rootJobId: ROOT,
    command: 'review the work',
    rootCommand: 'review the work',
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
    // A reviewer's claim carries no GitHub credential, and its restore takes none (docs/connections.md).
    env: { JIRA_TOKEN: 'jira' },
};
const reviewer: BoardJob = { ...base, reviewRun: { profile: 'security', ref: REF, timeoutMinutes: 5 } };
const ordinary: BoardJob = { ...base };
/** A token the board minted for a sync; a restore ignores one even when handed it. */
const MINTED = 'ghs_minted';

/** The sync step the docker runner submits to the attempt's supervisor for `job`: its env, never its argv. */
const dockerSync = async (job: BoardJob, githubToken?: string): Promise<Record<string, string>> => {
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
    await createDockerRunner(loadDriverConfig({}), undefined, exec, { steps: sink }).syncCheckout(
        supervised,
        undefined,
        null,
        githubToken
    );
    return steps[0]!.env;
};
/** The sync step the kubernetes runner submits to the attempt's supervisor for `job`: its env, never its argv. */
const k8sSyncEnv = async (job: BoardJob, githubToken?: string): Promise<Record<string, string>> =>
    (await k8sSyncStep(job, githubToken)).env;

describe('the startup sync of a reviewer’s claim', () => {
    it('on docker: restore mode and the snapshot ref, as literals, with no credential helper', async () => {
        const env = await dockerSync(reviewer, MINTED);
        expect(env).toMatchObject({ RESTORE: '1', REVIEW_REF: REF });
        expect(env).not.toHaveProperty('CRED_HELPER');
        // A restore carries no claim env at all: nothing of the claim reaches the sync.
        expect(JSON.stringify(env)).not.toContain('jira');
    });

    it('on kubernetes: the same two literals and no credential helper', async () => {
        const env = await k8sSyncEnv(reviewer, MINTED);
        expect(env).toMatchObject({ RESTORE: '1', REVIEW_REF: REF });
        expect(env).not.toHaveProperty('CRED_HELPER');
        // A restore carries no claim env at all: nothing of the claim reaches the sync.
        expect(JSON.stringify(env)).not.toContain('jira');
    });

    it('is unchanged for an ordinary first claim: no restore, no snapshot ref, a helper when it holds a token', async () => {
        const dockerEnv = await dockerSync(ordinary, MINTED);
        expect(dockerEnv).not.toHaveProperty('RESTORE');
        expect(dockerEnv).not.toHaveProperty('REVIEW_REF');
        expect(dockerEnv).toHaveProperty('CRED_HELPER');
        const env = await k8sSyncEnv(ordinary, MINTED);
        expect(env).toHaveProperty('CRED_HELPER');
        expect(env).not.toHaveProperty('RESTORE');
        expect(env).not.toHaveProperty('REVIEW_REF');
    });
});

describe('the wall-clock budget of a reviewer’s run', () => {
    const deadline = (job: BoardJob, env: NodeJS.ProcessEnv = {}) =>
        runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', ...env }), job, { id: SESSION, resume: false }).spec
            .activeDeadlineSeconds;

    // The supervisor ends the agent at the budget; the kubelet's backstop adds its wind-down and
    // the hours the group serves the attempt's steps after the agent.
    const WINDDOWN_S = (SUPERVISOR_WINDDOWN_MS + SUPERVISOR_STEPS_MS) / 1000;

    it('on kubernetes is the profile’s, in the pod’s kubelet-enforced deadline', () => {
        expect(deadline(reviewer)).toBe(5 * 60 + WINDDOWN_S);
    });

    it('is never past the operator’s ceiling', () => {
        expect(deadline(reviewer, { DRIVER_JOB_TIMEOUT_MS: String(2 * 60_000) })).toBe(2 * 60 + WINDDOWN_S);
        expect(deadline({ ...reviewer, reviewRun: { profile: 'x', ref: REF, timeoutMinutes: 600 } })).toBe(
            deadline(base)
        );
    });

    it('leaves an ordinary task on the operator’s timeout', () => {
        expect(deadline(ordinary, { DRIVER_JOB_TIMEOUT_MS: String(90 * 60_000) })).toBe(90 * 60 + WINDDOWN_S);
    });
});
