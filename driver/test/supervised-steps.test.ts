import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { runTimeoutMs } from '../src/claim.js';
import { dockerArgs } from '../src/docker.js';
import { supervisorCreateArgs } from '../src/docker-group.js';
import { runnerJobSpec } from '../src/k8s-podspec.js';
import { reclaimGroupSpec } from '../src/k8s-group.js';
import { CREDENTIAL_HELPER, worktreeBranch, type PublishStep } from '../src/publish.js';
import { StepChannelClosed, StepTimedOut, type StepSink } from '../src/step-control.js';
import {
    orderFinish,
    orderGo,
    runHelperStep,
    runReclaimStep,
    runSyncStep,
    supervisedStepRunner,
} from '../src/supervised-steps.js';
import {
    AGENT_CONTAINER,
    SUPERVISOR_CONTAINER,
    SUPERVISOR_CREDENTIAL_NAMES,
    SUPERVISOR_ENV,
    type StepRequest,
    type StepResult,
} from '../src/supervisor-contract.js';
import { lookupHelper } from '../src/helpers.js';

/**
 * The supervised steps (issue #771): what the sync, the probe, the publish, the helpers and the
 * reclaim ask of an attempt's supervisor, and the one rule about credentials — they ride the step,
 * and the agent container's spec never names, mounts or carries one.
 */
const USER = '44444444-4444-4444-8444-444444444444';
const SESSION = '33333333-3333-4333-8333-333333333333';
/** The board's token minted for one step (docs/connections.md). */
const MINTED_TOKEN = 'ghs_minted-for-step-0123456789';
/** A GitHub token a board still put on the claim: a reserved name, which the steps never forward. */
const CLAIM_TOKEN = 'ghs_claim-time-abcdef';
const CONTROL_TOKEN = 'supervisor-control-token-xyz';
const config = loadDriverConfig({ EXECUTOR: 'kubernetes' });

const job: BoardJob = {
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
    env: { GITHUB_TOKEN: CLAIM_TOKEN, MEMBER_VAR: 'member' },
    supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: CONTROL_TOKEN },
} as BoardJob;
const WORKTREE = `${config.workspaceMount}/bellows/${USER}/.worktrees/${job.id}`;

const ok = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

/** A sink that records every submitted step and answers with `answer`. */
function sink(answer: (step: StepRequest, call: number) => StepResult | Error = () => ok()) {
    const submitted: StepRequest[] = [];
    const tokens: string[] = [];
    const impl: StepSink = {
        submit: async (token, step) => {
            tokens.push(token);
            submitted.push(step);
            const given = answer(step, submitted.length);
            if (given instanceof Error) throw given;
            return given;
        },
        awaitReport: () => Promise.reject(new Error('not used')),
        contacted: () => true,
    };
    return { host: { config, sink: impl }, submitted, tokens };
}

const publishStep = (over: Partial<PublishStep> = {}): PublishStep => ({
    label: 'git push',
    entrypoint: 'git',
    args: ['push'],
    env: true,
    inRepo: true,
    ...over,
});

describe('the publish steps over the supervisor', () => {
    it("hands the claim env and the board's minted token to the step that reads them, and to no other", async () => {
        const s = sink();
        const run = supervisedStepRunner(s.host, job, { kind: 'publish', githubToken: MINTED_TOKEN });

        await run(publishStep({ label: 'git push', env: true }));
        await run(publishStep({ label: 'git commit', env: false, args: ['commit'] }));

        const [push, commit] = s.submitted;
        // The minted token is the step's; a claim value under the reserved name never rides along.
        expect(push!.env).toMatchObject({ GITHUB_TOKEN: MINTED_TOKEN, MEMBER_VAR: 'member' });
        expect(JSON.stringify(s.submitted)).not.toContain(CLAIM_TOKEN);
        expect(commit!.env).toEqual({});
        // Addressed to this attempt's supervisor by its control token, run in the task worktree.
        expect(s.tokens).toEqual([CONTROL_TOKEN, CONTROL_TOKEN]);
        expect(push!.cwd).toBe(WORKTREE);
        expect(push!.argv).toEqual(['git', 'push']);
    });

    it('keeps the literal env a step names (paths and code, never credentials)', async () => {
        const s = sink();
        await supervisedStepRunner(s.host, job, { kind: 'probe' })(
            publishStep({ label: 'probe', env: false, inRepo: false, envLiterals: { REPO: WORKTREE } })
        );
        expect(s.submitted[0]).toMatchObject({ kind: 'probe', env: { REPO: WORKTREE } });
        expect(s.submitted[0]!.cwd).toBeUndefined();
    });

    it('derives a step with a remote effect from its operation, so a retried publish asks the same push', async () => {
        const first = sink();
        const second = sink();
        const op = 'fix/10@' + 'a'.repeat(40);
        await supervisedStepRunner(first.host, job, { kind: 'publish' })(publishStep({ op }));
        await supervisedStepRunner(second.host, job, { kind: 'publish' })(publishStep({ op }));
        expect(second.submitted[0]!.id).toBe(first.submitted[0]!.id);

        // A step without an operation reads the tree as it is now: it never replays an earlier answer.
        await supervisedStepRunner(first.host, job, { kind: 'probe' })(publishStep({ label: 'probe', env: false }));
        await supervisedStepRunner(second.host, job, { kind: 'probe' })(publishStep({ label: 'probe', env: false }));
        expect(second.submitted[1]!.id).not.toBe(first.submitted[1]!.id);
    });

    it('scopes a step identity to the attempt: another lease never names a live attempt’s step', async () => {
        const a = sink();
        const b = sink();
        const op = 'fix/10@' + 'b'.repeat(40);
        await supervisedStepRunner(a.host, job, { kind: 'publish' })(publishStep({ op }));
        await supervisedStepRunner(
            b.host,
            { ...job, leaseToken: '55555555-5555-4555-8555-555555555555' },
            { kind: 'publish' }
        )(publishStep({ op }));
        expect(b.submitted[0]!.id).not.toBe(a.submitted[0]!.id);
    });

    it('asks an unanswered step again under the same identity, and gives up after three asks', async () => {
        let calls = 0;
        const s = sink((_step, call) => {
            calls = call;
            return call < 3 ? new StepTimedOut('x') : ok('landed');
        });
        const result = await supervisedStepRunner(s.host, job, { kind: 'publish' })(publishStep({ op: 'fix/10@c' }));
        expect(result.stdout).toBe('landed');
        expect(calls).toBe(3);
        expect(new Set(s.submitted.map((step) => step.id)).size).toBe(1);

        const hopeless = sink(() => new StepTimedOut('x'));
        await expect(supervisedStepRunner(hopeless.host, job, { kind: 'publish' })(publishStep())).rejects.toThrow(
            /was not answered in time/
        );
        expect(hopeless.submitted).toHaveLength(3);
    });

    it('does not ask again once the attempt’s channel is closed', async () => {
        const s = sink(() => new StepChannelClosed('its step was answered'));
        await expect(supervisedStepRunner(s.host, job, { kind: 'publish' })(publishStep())).rejects.toThrow(
            /supervisor channel closed/
        );
        expect(s.submitted).toHaveLength(1);
    });

    it('fails a step in the tool’s own words, stderr first', async () => {
        const s = sink(() => ({
            exitCode: 1,
            stdout: 'out',
            stderr: 'remote: Permission to x denied\n',
            timedOut: false,
        }));
        await expect(supervisedStepRunner(s.host, job, { kind: 'publish' })(publishStep())).rejects.toThrow(
            /^remote: Permission to x denied\nout$/
        );
        const timedOut = sink(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        await expect(supervisedStepRunner(timedOut.host, job, { kind: 'publish' })(publishStep())).rejects.toThrow(
            /exceeded its 600000ms deadline/
        );
    });

    it('refuses to submit anything for an attempt with no supervisor control channel', async () => {
        const s = sink();
        const { supervisorEnv: _gone, ...bare } = job;
        await expect(
            supervisedStepRunner(s.host, bare as BoardJob, { kind: 'publish' })(publishStep())
        ).rejects.toThrow(/no supervisor control channel/);
        expect(s.submitted).toEqual([]);
    });
});

describe('the sync, the reclaim and the helpers over the supervisor', () => {
    it('syncs a starting claim with fetch credentials, the credential helper code and the paths', async () => {
        const s = sink(() => ok('{"ok":true,"reason":null,"fingerprint":"fp"}\n'));
        const result = await runSyncStep(s.host, job, MINTED_TOKEN);

        expect(result).toEqual({ ok: true, reason: null, fingerprint: 'fp' });
        const [sync] = s.submitted;
        expect(sync).toMatchObject({ kind: 'sync', timeoutMs: 600_000 });
        expect(sync!.env).toMatchObject({
            GITHUB_TOKEN: MINTED_TOKEN,
            REPO: `${config.workspaceMount}/bellows/${USER}/factory`,
            WORKTREE,
            BRANCH: worktreeBranch(job),
            CRED_HELPER: CREDENTIAL_HELPER,
        });
        expect(sync!.env.RESTORE).toBeUndefined();
    });

    it('fetches plain, with neither token nor helper, when the board issued no token', async () => {
        // A public repository's fetch must stay unauthenticated, which a helper answering an empty
        // password would break; the claim's own GitHub value is a reserved name and never forwarded.
        const s = sink(() => ok('{"ok":true,"reason":null}\n'));
        await runSyncStep(s.host, job);
        const env = s.submitted[0]!.env;
        expect(env.GITHUB_TOKEN).toBeUndefined();
        expect(env.CRED_HELPER).toBeUndefined();
        expect(env.MEMBER_VAR).toBe('member');
    });

    it('restores a continued session with no credential at all: nothing that touches the remote', async () => {
        const s = sink(() => ok('{"ok":true,"reason":null}\n'));
        await runSyncStep(s.host, { ...job, resumeSessionId: SESSION, followUp: true } as BoardJob);
        const env = s.submitted[0]!.env;
        expect(env.RESTORE).toBe('1');
        expect(env.GITHUB_TOKEN).toBeUndefined();
        expect(env.MEMBER_VAR).toBeUndefined();
        expect(env.CRED_HELPER).toBeUndefined();
    });

    it('reads a sync that printed no verdict, or timed out, as a failed sync saying why', async () => {
        const silent = sink(() => ok('npm warn\n'));
        expect(await runSyncStep(silent.host, job)).toMatchObject({
            ok: false,
            reason: expect.stringContaining('answered nothing readable'),
        });
        const slow = sink(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        expect(await runSyncStep(slow.host, job)).toMatchObject({
            ok: false,
            reason: expect.stringContaining('deadline'),
        });
    });

    it('has nothing to sync or reclaim for a job with no repository', async () => {
        const s = sink();
        const commandOnly = { ...job, repo: undefined } as unknown as BoardJob;
        expect(await runSyncStep(s.host, commandOnly)).toEqual({ ok: true, reason: null });
        expect(await runReclaimStep(s.host, commandOnly)).toEqual({ ok: true, removed: false, reason: null });
        expect(s.submitted).toEqual([]);
    });

    it('reclaims with the clone and the worktree and no credential', async () => {
        const s = sink(() => ok('{"ok":true,"removed":true,"reason":null}\n'));
        expect(await runReclaimStep(s.host, job)).toEqual({ ok: true, removed: true, reason: null });
        expect(s.submitted[0]).toMatchObject({ kind: 'reclaim', env: { WORKTREE } });
        expect(Object.keys(s.submitted[0]!.env).sort()).toEqual(['REPO', 'WORKTREE']);
    });

    it("gives a helper the claim env and the board's minted token only when it writes to GitHub", async () => {
        const descriptor = lookupHelper('merge-conflict-probe');
        expect(descriptor).toBeTruthy();
        const reading = sink(() => ok('{}'));
        await runHelperStep(reading.host, job, {
            phase: 'pre',
            helperId: 'merge-conflict-probe',
            input: {},
            githubWriting: false,
        } as never);
        expect(reading.submitted[0]!.env.GITHUB_TOKEN).toBeUndefined();
        expect(reading.submitted[0]!.env.HELPER_INPUT).toBeDefined();

        const writing = sink(() => ok('{}'));
        await runHelperStep(
            writing.host,
            job,
            { phase: 'pre', helperId: 'merge-conflict-probe', input: {}, githubWriting: true } as never,
            { token: MINTED_TOKEN }
        );
        expect(writing.submitted[0]!.env.GITHUB_TOKEN).toBe(MINTED_TOKEN);
        expect(writing.submitted[0]!.cwd).toBe(WORKTREE);
    });

    it('answers an unknown helper before anything is submitted', async () => {
        const s = sink();
        expect(await runHelperStep(s.host, job, { phase: 'pre', helperId: 'rm-rf', input: {} } as never)).toMatchObject(
            {
                ok: false,
                reason: 'unknown_helper',
            }
        );
        expect(s.submitted).toEqual([]);
    });

    it('releases the agent with what is left of the run budget, and ends the group by order', async () => {
        const s = sink();
        await orderGo(s.host, { ...job, setupMs: 120_000 } as BoardJob);
        await orderFinish(s.host, job);
        expect(s.submitted.map((step) => step.kind)).toEqual(['go', 'finish']);
        const budget = Number(s.submitted[0]!.env.BUDGET_MS);
        expect(budget).toBeGreaterThan(0);
        expect(budget).toBe(runTimeoutMs(config, job) - 120_000);
    });
});

/** Everything a container of the group is handed, as one string: its env, args and the Secret keys it names. */
const holds = (container: unknown): string => JSON.stringify(container);

describe('the agent environment holds no publish token', () => {
    const group = runnerJobSpec(config, job, { id: SESSION, resume: false });
    const containers = group.spec.template.spec.containers;
    const agent = containers.find((c) => c.name === AGENT_CONTAINER)!;
    const supervisor = containers.find((c) => c.name === SUPERVISOR_CONTAINER)!;

    it('names the publish token nowhere in the pod spec: the token exists only as a step env', async () => {
        // The token the board mints for a step never reaches a spec builder; the only way it leaves
        // the driver is the step it rides, addressed to the supervisor. A claim value under the
        // reserved name reaches neither.
        expect(JSON.stringify(group)).not.toContain(MINTED_TOKEN);
        expect(JSON.stringify(group)).not.toContain(CLAIM_TOKEN);
        const s = sink();
        await supervisedStepRunner(s.host, job, { kind: 'publish', githubToken: MINTED_TOKEN })(publishStep());
        expect(JSON.stringify(s.submitted)).toContain(MINTED_TOKEN);
        expect(holds(agent)).not.toContain(MINTED_TOKEN);
    });

    it('gives the agent container neither the supervisor’s credential nor a route to the step channel', () => {
        const env = JSON.stringify(agent.env);
        for (const name of SUPERVISOR_CREDENTIAL_NAMES) expect(env).not.toContain(name);
        expect(env).not.toContain(CONTROL_TOKEN);
        expect(env).not.toContain('http://driver:8130');
        // What the agent finds its supervisor through is three mailbox paths: no URL, no token.
        expect(
            agent.env
                .filter((e) => e.name.startsWith('FACTORY_CTL_'))
                .map((e) => e.name)
                .sort()
        ).toEqual(['FACTORY_CTL_GO', 'FACTORY_CTL_IN', 'FACTORY_CTL_OUT']);
    });

    it('delivers no claim env to the supervisor container: a step carries its own', () => {
        const names = supervisor.env.map((e) => e.name);
        expect(names).not.toContain('GITHUB_TOKEN');
        expect(names).not.toContain('MEMBER_VAR');
        expect(holds(supervisor)).not.toContain(CLAIM_TOKEN);
        // It mounts the member's workspace subtree — the steps work on the task worktree — and the mailboxes.
        expect(supervisor.volumeMounts.some((m) => m.name === 'workspaces' && m.subPath === `bellows/${USER}`)).toBe(
            true
        );
    });

    it('holds the same line on docker: the agent container’s argv names no step credential', () => {
        const args = dockerArgs(config, job, { id: SESSION, resume: false }, { envFile: '/tmp/agent.env' }).join(' ');
        expect(args).not.toContain(MINTED_TOKEN);
        expect(args).not.toContain(CONTROL_TOKEN);
        for (const name of SUPERVISOR_CREDENTIAL_NAMES) expect(args).not.toContain(name);
        expect(args).toContain('FACTORY_CTL_GO=');
        // The supervisor mounts the workspace there too, and carries the control pair by env file, never argv.
        const supervisorArgs = supervisorCreateArgs(
            config,
            job,
            { exporting: false, agentless: false },
            '/tmp/env'
        ).join(' ');
        expect(supervisorArgs).toContain(`bellows/${USER}`);
        expect(supervisorArgs).not.toContain(CONTROL_TOKEN);
        expect(supervisorArgs).not.toContain(CLAIM_TOKEN);
    });

    it('specs an agentless attempt’s group, and a reclaim’s, with no agent container at all', () => {
        const agentless = runnerJobSpec(config, { ...job, agent: false } as BoardJob, null);
        expect(agentless.spec.template.spec.containers.map((c) => c.name)).toEqual([SUPERVISOR_CONTAINER]);
        const reclaim = reclaimGroupSpec(config, job);
        expect(reclaim.spec.template.spec.containers.map((c) => c.name)).toEqual([SUPERVISOR_CONTAINER]);
        expect(reclaim.metadata.name).not.toBe(group.metadata.name);
        expect(holds(reclaim)).not.toContain(CLAIM_TOKEN);
    });
});
