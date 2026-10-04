import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { gateEnvContainerName } from '../src/docker.js';
import { createGateManager, type GateManager } from '../src/gates.js';
import { newJobState } from '../src/loop-attempt.js';
import { runDeclaredGates, type GateSession } from '../src/loop-gates.js';
import type { LoopRuntime } from '../src/loop-types.js';

const KEY = 'bellows/44444444-4444-4444-8444-444444444444/.worktrees/55555555-5555-4555-8555-555555555555';
const NAME = gateEnvContainerName(KEY);
const config = loadDriverConfig({});
const JOB = {
    id: '55555555-5555-4555-8555-555555555555',
    leaseToken: '22222222-2222-4222-8222-222222222222',
} as BoardJob;

type ExecResult = { stdout: string; stderr: string };
const OK: ExecResult = { stdout: '', stderr: '' };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settledWithin = (work: Promise<unknown>, ms: number) =>
    Promise.race([work.then(() => 'settled'), delay(ms).then(() => 'hung')]);

describe('gate output size', () => {
    it('reports a passing gate that prints more than 1 MiB as passed, not as a harness failure', async () => {
        const run = promisify(execFile);
        const execDocker = (args: string[], options?: { timeout?: number; maxBuffer?: number }) =>
            args[0] === 'exec'
                ? (run('sh', ['-c', 'head -c 2000000 /dev/zero | tr "\\000" a'], options) as Promise<ExecResult>)
                : Promise.resolve(OK);
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker });
        await manager.acquire(KEY, 'node:24', '');

        const outcome = await manager.runGate(KEY, 'test', 'npm test --verbose');

        expect(outcome.exitCode).toBe(0);
        await manager.stop();
    });

    it('answers a gate whose output outgrows the buffer as a failed verdict, never a gone container', async () => {
        const execDocker = async (args: string[]): Promise<ExecResult> => {
            if (args[0] !== 'exec') return OK;
            throw Object.assign(new Error('stdout maxBuffer length exceeded'), {
                code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            });
        };
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker });
        await manager.acquire(KEY, 'node:24', '');

        await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 1 });
        await manager.stop();
    });
});

describe('a timed-out gate', () => {
    it('tears the environment down so the hung process does not outlive the gate', async () => {
        const ops: string[] = [];
        const execDocker = async (args: string[]): Promise<ExecResult> => {
            ops.push(args.slice(0, 3).join(' '));
            if (args[0] === 'exec') throw Object.assign(new Error('killed'), { killed: true, stderr: '' });
            return OK;
        };
        const manager = createGateManager({ config, cooldownMs: 60_000, gateTimeoutMs: 10, execDocker });
        await manager.acquire(KEY, 'node:24', '');

        expect((await manager.runGate(KEY, 'test', 'npm run dev')).exitCode).toBe(124);

        expect(ops.slice(ops.findIndex((op) => op.startsWith(`exec ${NAME}`)) + 1)).toContain(`rm -f ${NAME}`);
        await manager.stop();
    });
});

describe('Stop during the declared gates', () => {
    const rtWith = (manager: GateManager): LoopRuntime =>
        ({
            gates: { manager, server: {} as never, advertiseUrl: () => '' },
            log: () => {},
            board: { gates: async () => 'held' },
        }) as unknown as LoopRuntime;
    const session: GateSession = {
        key: KEY,
        token: 't',
        image: 'node:24',
        envBody: '',
        declared: [{ name: 'test', command: 'npm test' }],
    };

    it('honours a Stop while the per-gate re-acquire hangs', async () => {
        const manager: GateManager = {
            acquire: () => new Promise(() => {}),
            runGate: async () => ({ exitCode: 0, output: '' }),
            release: () => {},
            stop: async () => {},
        };
        const state = newJobState();
        const gates = runDeclaredGates(rtWith(manager), JOB, session, state);
        await delay(5);
        state.stopped = true;
        state.abortNow();

        expect(await settledWithin(gates, 200)).toBe('settled');
    });

    it('honours a Stop while the declared gate is queued behind another run on the same env', async () => {
        let execs = 0;
        const execDocker = async (args: string[]): Promise<ExecResult> => {
            if (args[0] === 'exec' && execs++ === 0) return new Promise<ExecResult>(() => {});
            return OK;
        };
        const manager = createGateManager({ config, cooldownMs: 60_000, gateTimeoutMs: 600_000, execDocker });
        await manager.acquire(KEY, 'node:24', '');
        void manager.runGate(KEY, 'test', 'npm test'); // a previous attempt's orphaned ad-hoc run
        const state = newJobState();
        const gates = runDeclaredGates(rtWith(manager), JOB, session, state);
        await delay(5);
        state.stopped = true;
        state.abortNow();

        expect(await settledWithin(gates, 200)).toBe('settled');
        await manager.stop();
    });
});
