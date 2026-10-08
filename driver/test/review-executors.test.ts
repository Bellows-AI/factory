import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { syncCheckoutArgs } from '../src/docker-runner-support.js';
import { syncJobSpec } from '../src/k8s-auxspec.js';
import { runnerJobSpec } from '../src/k8s-podspec.js';

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
    attempts: 1,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    masterPrompt: 'Factory execution contract (factory-master-prompt/v1)',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    repo: 'Bellows-AI/factory',
    // A reviewer's claim carries no GITHUB_TOKEN, so no fetch credential ever exists for its sync.
    env: { JIRA_TOKEN: 'jira' },
};
const reviewer: BoardJob = { ...base, reviewRun: { profile: 'security', ref: REF, timeoutMinutes: 5 } };
const ordinary: BoardJob = { ...base, env: { GITHUB_TOKEN: 'ghp_x' } };

const dockerSync = (job: BoardJob, restore: boolean) =>
    syncCheckoutArgs(loadDriverConfig({}), job, {
        clone: '/w/clone',
        worktree: '/w/wt',
        restore,
        envFile: null,
    });
const k8sConfig = loadDriverConfig({ EXECUTOR: 'kubernetes' });
const k8sSyncEnv = (job: BoardJob) =>
    syncJobSpec(k8sConfig, job, null).spec.template.spec.containers[0]!.env as { name: string; value: string }[];
const names = (env: { name: string }[]) => env.map((entry) => entry.name);

describe('the startup sync of a reviewer’s claim', () => {
    it('on docker: restore mode and the snapshot ref, as literals, with no credential helper', () => {
        const argv = dockerSync(reviewer, true);
        expect(argv).toContain('RESTORE=1');
        expect(argv).toContain(`REVIEW_REF=${REF}`);
        expect(argv.some((arg) => arg.startsWith('CRED_HELPER='))).toBe(false);
        expect(argv.join(' ')).not.toContain('jira');
    });

    it('on kubernetes: the same two literals and no credential helper', () => {
        const env = k8sSyncEnv(reviewer);
        expect(env).toEqual(
            expect.arrayContaining([
                { name: 'RESTORE', value: '1' },
                { name: 'REVIEW_REF', value: REF },
            ])
        );
        expect(names(env)).not.toContain('CRED_HELPER');
    });

    it('is unchanged for an ordinary first claim: no restore, no snapshot ref, a helper when it holds a token', () => {
        expect(dockerSync(ordinary, false)).not.toContain('RESTORE=1');
        expect(dockerSync(ordinary, false).some((arg) => arg.startsWith('REVIEW_REF='))).toBe(false);
        expect(dockerSync(ordinary, false).some((arg) => arg.startsWith('CRED_HELPER='))).toBe(true);
        const env = k8sSyncEnv(ordinary);
        expect(names(env)).toEqual(expect.arrayContaining(['CRED_HELPER']));
        expect(names(env)).not.toContain('RESTORE');
        expect(names(env)).not.toContain('REVIEW_REF');
    });
});

describe('the wall-clock budget of a reviewer’s run', () => {
    const deadline = (job: BoardJob, env: NodeJS.ProcessEnv = {}) =>
        runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', ...env }), job, { id: SESSION, resume: false }).spec
            .activeDeadlineSeconds;

    it('on kubernetes is the profile’s, in the pod’s kubelet-enforced deadline', () => {
        expect(deadline(reviewer)).toBe(5 * 60);
    });

    it('is never past the operator’s ceiling', () => {
        expect(deadline(reviewer, { DRIVER_JOB_TIMEOUT_MS: String(2 * 60_000) })).toBe(2 * 60);
        expect(deadline({ ...reviewer, reviewRun: { profile: 'x', ref: REF, timeoutMinutes: 600 } })).toBe(
            deadline(base)
        );
    });

    it('leaves an ordinary task on the operator’s timeout', () => {
        expect(deadline(ordinary, { DRIVER_JOB_TIMEOUT_MS: String(90 * 60_000) })).toBe(90 * 60);
    });
});
