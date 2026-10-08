import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import type { HelperPlan } from '../src/helpers.js';
import {
    helperEnvSecretName,
    publishEnvSecretName,
    servicePodSpec,
    syncEnvSecretName,
    syncJobSpec,
} from '../src/k8s-auxspec.js';
import { workspacePath } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { UNHARDENED_LABEL } from '../src/labels.js';
import { gateEnvSecretName, runnerJobSpec, secretName } from '../src/k8s-podspec.js';
import { WORKSPACE_PATH } from '../src/publish.js';

const SESSION = '33333333-3333-4333-8333-333333333333';

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
    claimSeq: 1,
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
        expect(workspacePath(job)).toMatch(subPathPattern);
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

/*
 * Issue #361: the scheduling knobs the driver forwards onto every pod it specs
 * (RUNNER_NODE_SELECTOR / RUNNER_TOLERATIONS / RUNNER_AFFINITY) must be ADMISSION-NEUTRAL — the
 * policy pins placement to the scheduler by refusing `nodeName` and stays silent about everything
 * else scheduling-shaped, which is what makes a tainted runner node group addable in values alone.
 * A future policy edit that reaches for these fields would silently break that, so the absence is
 * pinned against the template itself, never a copy of it.
 */
describe('the admission policy stays silent on forwarded scheduling fields', () => {
    it('still pins placement to the scheduler by refusing nodeName', () => {
        expect(template).toContain('variables.spec.nodeName');
    });

    it.each(['nodeSelector', 'tolerations', 'affinity'])('never constrains %s', (field) => {
        expect(template).not.toContain(`variables.spec.${field}`);
    });
});

/*
 * Issue #382. The policy already FORBIDS the dangerous shapes — `privileged`, added capabilities —
 * which is a different thing from REQUIRING the safe ones: a driver that silently stopped setting
 * `capabilities.drop` would be admitted by every expression above it. These three validations close
 * that, and they are the half that can fail closed: `failurePolicy: Fail` means a CEL expression
 * that does not compile refuses every pod this driver creates, so the assertions below come in
 * pairs — the expression is in the template, AND the driver's own output satisfies the field it
 * names. The second half is what turns "the policy is stricter than the driver" into an offline
 * failure instead of a cluster-wide outage.
 */
describe('the admission policy requires the pod hardening (#382)', () => {
    it.each([
        ['the seccomp profile', 'seccompProfile'],
        // The full expression fragment, never the bare field name: that also appears in the
        // template's own header comment, so a bare needle passes with the validation deleted.
        ['the escalation bit', 'c.securityContext.allowPrivilegeEscalation == false'],
        ['the capability drop', "'ALL' in c.securityContext.capabilities.drop"],
        // A CONTAINER-level seccomp profile overrides the pod-level one, so pinning only the pod
        // leaves `Unconfined` on a container admitted — the policy would require the invariant and
        // permit its exact negation one field deeper. The needle names `variables.containers`
        // explicitly: `c.securityContext.seccompProfile` alone is a SUBSTRING of the pod-level
        // expression's `variables.spec.securityContext.seccompProfile`, so it passes against a
        // template that never looks at a container at all.
        ['the container-level seccomp override', 'has(c.securityContext.seccompProfile)'],
    ])('names %s', (_label, needle) => {
        expect(template).toContain(needle);
    });

    // The opt-out has to be visible to the policy, which sees the object and nothing else: a
    // declared `unhardened: true` service and a driver that quietly stopped hardening look
    // identical without the label.
    it('lets a declared opt-out through by its label, and only by its label', () => {
        expect(template).toContain(UNHARDENED_LABEL);
    });

    // The honest half. Every spec the driver builds must satisfy the fields the expressions name;
    // a template tightened past the driver fails here rather than at a real apiserver.
    it('is satisfied by every pod spec the driver builds', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory' });
        // The file's shared fixture carries no master prompt, which `runnerJobSpec` refuses; only
        // the pod's security fields matter here, so the cheapest legal one is enough.
        const promptedJob: BoardJob = { ...job, masterPrompt: 'Factory execution contract' };
        const pods = [
            runnerJobSpec(config, promptedJob, { id: SESSION, resume: false }).spec.template.spec,
            syncJobSpec(config, { ...job, repo: 'Bellows-AI/factory' }, null).spec.template.spec,
            servicePodSpec(config, job, { name: 'cache', image: 'redis', environment: [] }, 'uid').spec,
        ];
        for (const pod of pods) {
            expect(pod.securityContext?.seccompProfile?.type).toBe('RuntimeDefault');
            expect(pod.containers[0]!.securityContext?.allowPrivilegeEscalation).toBe(false);
            expect(pod.containers[0]!.securityContext?.capabilities?.drop).toContain('ALL');
        }
    });
});
