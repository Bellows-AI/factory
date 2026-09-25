import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import type { HelperPlan } from '../src/helpers.js';
import { helperEnvSecretName, publishEnvSecretName, syncEnvSecretName } from '../src/k8s-auxspec.js';
import { gateEnvSecretName, secretName } from '../src/k8s-podspec.js';

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
