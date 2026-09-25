import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import type { HelperPlan } from '../src/helpers.js';
import { helperEnvSecretName, publishEnvSecretName, syncEnvSecretName } from '../src/k8s-auxspec.js';
import { gateEnvSecretName, secretName, workspaceSubPathOf } from '../src/k8s-podspec.js';
import { WORKSPACE_PATH } from '../src/publish.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/*
 * The chart's admission policy (charts/factory/templates/driver-admission.yaml) admits a pod spec
 * only when every Secret it references matches one pattern, and admits a Secret create/delete only
 * under it. A new per-attempt Secret builder whose names miss the pattern would pass every offline
 * suite and then have every pod that references it refused by a real apiserver — so each builder is
 * pinned against the pattern read from the template itself, never a copy of it.
 */
const template = readFileSync(join(ROOT, 'charts/factory/templates/driver-admission.yaml'), 'utf8');
const pattern = new RegExp(/\$secretName := "([^"]+)"/.exec(template)![1]!);

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    masterPrompt: null,
    resumeSessionId: null,
    followUp: false,
    userId: '44444444-4444-4444-8444-444444444444',
    workspacePath: 'bellows/44444444-4444-4444-8444-444444444444',
} as BoardJob;

const plan: HelperPlan = { helperId: 'noop', phase: 'pre', input: {}, githubWriting: false };

describe('the admission policy Secret pattern', () => {
    it.each([
        ['runner claim env', secretName(job)],
        ['sync env', syncEnvSecretName(job)],
        ['publish env', publishEnvSecretName(job)],
        ['helper env', helperEnvSecretName(job, plan, 'nonce')],
        ['gate env', gateEnvSecretName(job)],
    ])('admits the %s Secret name', (_label, name) => {
        expect(name).toMatch(pattern);
    });

    it('refuses the chart-created Secrets the driver must never reach', () => {
        expect('dev-factory-dashboard').not.toMatch(pattern);
        expect('factory-dashboard').not.toMatch(pattern);
        expect('dev-factory-runner-credentials').not.toMatch(pattern);
    });
});

/*
 * Every mount of the workspaces claim must carry a subPath of the WORKSPACE_PATH shape, so a pod
 * the driver's identity submits cannot mount the claim root. The template's pattern is a copy of
 * WORKSPACE_PATH (CEL has no case-insensitive flag), so the two are held to the same verdicts.
 */
const subPathPattern = new RegExp(/\$workspaceSubPath := "([^"]+)"/.exec(template)?.[1] ?? '(?!)');

describe('the admission policy workspace subPath pattern', () => {
    it('admits the subPath every driver workspace mount uses', () => {
        expect(workspaceSubPathOf(job)).toMatch(subPathPattern);
    });

    it.each([
        'bellows/44444444-4444-4444-8444-444444444444',
        'Bellows_Org-1/ABCDEF01-2345-6789-ABCD-EF0123456789',
        `a${'b'.repeat(38)}/44444444-4444-4444-8444-444444444444`,
        `a${'b'.repeat(39)}/44444444-4444-4444-8444-444444444444`,
        '',
        'bellows',
        '/',
        '../bellows/44444444-4444-4444-8444-444444444444',
        'bellows/44444444-4444-4444-8444-444444444444/.worktrees/x',
        '-bellows/44444444-4444-4444-8444-444444444444',
        'bellows/not-a-uuid',
    ])('agrees with WORKSPACE_PATH on %j', (candidate) => {
        expect(subPathPattern.test(candidate)).toBe(WORKSPACE_PATH.test(candidate));
    });
});
