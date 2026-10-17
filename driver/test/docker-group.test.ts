import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { claimEnv, RESERVED_ENV_NAMES } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { dockerArgs } from '../src/docker.js';
import {
    awaitSupervisor,
    createGroup,
    ctlVolumeArgs,
    exporterCreateArgs,
    exporterName,
    removeGroup,
    startGroup,
    supervisorCreateArgs,
    supervisorLossOf,
    supervisorName,
} from '../src/docker-group.js';
import { ctlVolumeName } from '../src/docker-mailbox.js';
import type { RunnerFiles } from '../src/docker-runner-support.js';
import { MAILBOXES, SUPERVISOR_CREDENTIAL_NAMES, SUPERVISOR_EXIT } from '../src/supervisor-contract.js';
import { orphanBoundMs } from '../src/supervisor-plan.js';

/*
 * The docker twin of the runner pod: the supervisor, the agent and the exporter as one container
 * group, the four mailboxes as named volumes. What is pinned is the shape the acceptance names —
 * the group holds all three, and the agent container reaches neither the supervisor's control nor
 * its credential. The pod's half is `k8s.test.ts`; the supervisor's own behavior is `supervisor.test.ts`.
 */
const USER = '44444444-4444-4444-8444-444444444444';
const SESSION = { id: '33333333-3333-4333-8333-333333333333', resume: false };
const config = loadDriverConfig({});
const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    rootCommand: 'fix the failing build',
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
    masterPrompt:
        'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    gateEnv: { BELLOWS_CONTROL_URL: 'http://driver:7000', BELLOWS_CONTROL_TOKEN: 'tok-agent', OTHER: 'x' },
    supervisorEnv: { SUPERVISOR_CONTROL_URL: 'http://driver:7000', SUPERVISOR_CONTROL_TOKEN: 'tok-supervisor' },
};
const START = '2026-09-01T00:00:00Z';

const mounts = (argv: string[]): string[] => argv.filter((_arg, i) => argv[i - 1] === '--mount');
const volumeOf = (box: keyof typeof MAILBOXES): string => `src=${ctlVolumeName(job, MAILBOXES[box])},`;

describe('the supervisor container', () => {
    const argv = supervisorCreateArgs(config, job, { exporting: true, agentless: false }, '/tmp/supervisor.env');

    // The supervisor runs the attempt's steps (sync, probe, publish, helpers, reclaim) as children
    // of its own container, so it mounts the member's workspace — only the member's own subtree.
    it('mounts all four mailboxes and the member’s own workspace subtree, nothing broader', () => {
        const mounted = mounts(argv);
        expect(mounted).toHaveLength(5);
        for (const box of ['in', 'out', 'export', 'supervisor'] as const) {
            expect(mounted.some((mount) => mount.includes(volumeOf(box)))).toBe(true);
        }
        const workspace = mounted.filter((mount) => mount.includes('workspaces'));
        expect(workspace).toHaveLength(1);
        expect(workspace[0]).toContain(`volume-subpath=bellows/${USER}`);
    });

    it('is told the orphan bound the lease allows, as the exporter is its drain give-up', () => {
        const bound = orphanBoundMs(config);
        expect(argv).toContain(`SUPERVISOR_ORPHAN_MS=${bound}`);
        const exporter = exporterCreateArgs(config, job, START, '/tmp/export.env');
        expect(exporter).toContain(`EXPORT_DRAIN_GIVEUP_MS=${bound}`);
    });

    it('takes its control pair by env file, never by argv', () => {
        expect(argv).toContain('--env-file');
        expect(argv.join(' ')).not.toMatch(/tok-supervisor|tok-agent/);
    });

    it('is hardened and labelled for the fence like every container of the run', () => {
        expect(argv).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']));
        expect(argv).toEqual(expect.arrayContaining(['--name', supervisorName(job)]));
        expect(argv).toEqual(expect.arrayContaining(['--label', `factory.lease=${job.leaseToken}`]));
    });
});

describe('the agent container', () => {
    const argv = dockerArgs(config, job, SESSION, { envFile: '/tmp/env-file' });

    it('mounts `in` read-only and `out`, and nothing of the supervisor’s own or the exporter’s', () => {
        const mounted = mounts(argv);
        expect(mounted.find((mount) => mount.includes(volumeOf('in')))).toMatch(/,readonly$/);
        const out = mounted.find((mount) => mount.includes(volumeOf('out')));
        expect(out).toBeDefined();
        expect(out).not.toMatch(/readonly/);
        expect(mounted.some((mount) => mount.includes(volumeOf('export')))).toBe(false);
        expect(mounted.some((mount) => mount.includes(volumeOf('supervisor')))).toBe(false);
    });

    it('is told two mailbox paths and no control credential', () => {
        expect(argv).toEqual(expect.arrayContaining(['FACTORY_CTL_IN=/factory/in', 'FACTORY_CTL_OUT=/factory/out']));
        for (const name of SUPERVISOR_CREDENTIAL_NAMES) expect(argv.join(' ')).not.toContain(name);
        expect(argv.join(' ')).not.toContain('tok-supervisor');
    });
});

// The kubernetes pod keeps the supervisor's pair in the attempt Secret beside the claim env: a
// member variable under the same name would reach the agent through the same Secret key.
describe('the claim env and the supervisor’s credential names', () => {
    it('drops a member variable named like the supervisor’s control pair', () => {
        const env = claimEnv({
            ...job,
            env: { SUPERVISOR_CONTROL_TOKEN: 'evil', SUPERVISOR_CONTROL_URL: 'x', KEEP: '1' },
        });
        expect({ ...env }).toEqual({ KEEP: '1' });
        for (const name of SUPERVISOR_CREDENTIAL_NAMES) expect(RESERVED_ENV_NAMES).toContain(name);
    });
});

describe('the exporter container', () => {
    it('mounts the member’s subtree and only the mailbox it shares with the supervisor', () => {
        const mounted = mounts(exporterCreateArgs(config, job, START, '/tmp/export.env'));
        expect(mounted).toHaveLength(2);
        expect(mounted.some((mount) => mount.includes('volume-subpath=bellows/'))).toBe(true);
        expect(mounted.some((mount) => mount.includes(volumeOf('export')))).toBe(true);
    });
});

describe('creating and starting the group', () => {
    const recorder = (refuse: (argv: string[]) => boolean = () => false) => {
        const calls: string[][] = [];
        const written: { file: string; body: string; mode: number }[] = [];
        const removed: string[] = [];
        const files: RunnerFiles = {
            writeFile: (async (file: string, body: string, options: { mode: number }) => {
                written.push({ file, body, mode: options.mode });
            }) as never,
            rm: (async (file: string) => {
                removed.push(file);
            }) as never,
        };
        const execDocker = async (argv: string[]) => {
            calls.push(argv);
            if (refuse(argv)) throw new Error('daemon said no');
            return { stdout: '' };
        };
        return { calls, written, removed, deps: { config, execDocker, files } };
    };

    it('creates the four labelled volumes, then the supervisor, then the exporter', async () => {
        const { calls, deps } = recorder();
        await createGroup(deps, job, SESSION, START);
        expect(calls.slice(0, 4)).toEqual(ctlVolumeArgs(job));
        const created = calls.filter((argv) => argv[0] === 'create').map((argv) => argv[argv.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(job), exporterName(job)]);
    });

    it('writes only the control pair to a 0600 env file per container and removes each', async () => {
        const { written, removed, deps } = recorder();
        await createGroup(deps, job, SESSION, START);
        expect(written.map((w) => w.body)).toEqual([
            'SUPERVISOR_CONTROL_URL=http://driver:7000\nSUPERVISOR_CONTROL_TOKEN=tok-supervisor\n',
            // The exporter's script reads the names it always read; the value is the supervisor's token.
            'BELLOWS_CONTROL_URL=http://driver:7000\nBELLOWS_CONTROL_TOKEN=tok-supervisor\n',
        ]);
        expect(written.every((w) => w.mode === 0o600)).toBe(true);
        expect(removed).toEqual(written.map((w) => w.file));
    });

    it('creates no exporter for a run without a transcript to export, and the supervisor still', async () => {
        const { calls, deps } = recorder();
        await createGroup(deps, { ...job, executorType: 'opencode' }, null, START);
        const created = calls.filter((argv) => argv[0] === 'create').map((argv) => argv[argv.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(job)]);
    });

    it('removes what it created and throws when the daemon refuses a container', async () => {
        const { calls, deps } = recorder((argv) => argv[0] === 'create' && argv.includes(exporterName(job)));
        await expect(createGroup(deps, job, SESSION, START)).rejects.toThrow('daemon said no');
        expect(calls).toContainEqual(['rm', '-f', supervisorName(job)]);
        for (const box of Object.values(MAILBOXES)) {
            expect(calls).toContainEqual(['volume', 'rm', '-f', ctlVolumeName(job, box)]);
        }
    });

    it('starts the supervisor and the exporter, leaving the agent to the caller', async () => {
        const { calls, deps } = recorder();
        await startGroup(deps.execDocker, job, SESSION);
        expect(calls).toEqual([
            ['start', supervisorName(job)],
            ['start', exporterName(job)],
        ]);
    });

    it('removeGroup tolerates anything already gone', async () => {
        const { deps } = recorder(() => true);
        await expect(removeGroup(deps.execDocker, job)).resolves.toBeUndefined();
    });
});

describe('waiting for the supervisor after the agent exits', () => {
    const answering = (stdout: string) => async () => ({ stdout });

    it('reads the supervisor’s exit status from `docker wait`', async () => {
        expect(await awaitSupervisor(answering('0\n'), job)).toBe(0);
        expect(await awaitSupervisor(answering('124\n'), job)).toBe(124);
    });

    it('answers null when the daemon cannot say, or the wind-down passed', async () => {
        const refusing = async () => {
            throw new Error('timed out');
        };
        expect(await awaitSupervisor(refusing, job)).toBeNull();
        expect(await awaitSupervisor(answering(''), job)).toBeNull();
    });

    it('calls a group lost unless its supervisor finalized — an exit 0, or its own deadline 124', () => {
        expect(supervisorLossOf(SUPERVISOR_EXIT.finalized, false)).toBeNull();
        expect(supervisorLossOf(SUPERVISOR_EXIT.deadline, false)).toBeNull();
        expect(supervisorLossOf(SUPERVISOR_EXIT.failed, false)).toMatch(/exit 70/);
        expect(supervisorLossOf(SUPERVISOR_EXIT.lost, false)).toBe(
            'the task supervisor lost its driver before the agent was released'
        );
        expect(supervisorLossOf(137, false)).toMatch(/before it finalized/);
        expect(supervisorLossOf(null, false)).toMatch(/did not finalize/);
        // The backstop's own timeout is a verdict, never a loss.
        expect(supervisorLossOf(null, true)).toBeNull();
    });
});
