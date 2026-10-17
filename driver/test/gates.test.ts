import { readFileSync, rmSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
    createGateManager,
    declaredTimeoutMs,
    type GateAttempt,
    type GateClaim,
    type GateManager,
    type GateRunOptions,
} from '../src/gates.js';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { gateEnvContainerName } from '../src/docker.js';
import { gateEnvFile, refreshGateEnv } from '../src/gate-exec.js';
import { networkName } from '../src/services.js';

/**
 * The gate environment registry and its ad-hoc HTTP channel.
 *
 * The docker daemon is stood in by `execDocker`, the way the docker runner's suite does it: the
 * suite never shells out, and every assertion is on the argv this process would run or the
 * verdict it would report. The server tests use a real socket on loopback, because the contract
 * under test is HTTP.
 */

/**
 * A real socket cannot hand a test the `Server` handle — the gate server keeps it private — so
 * `createServer` is wrapped, not replaced: the real node:http still builds every server (the
 * suite's sockets stay real) and each instance is recorded for the one test that must reach it.
 */
const { createdServers } = vi.hoisted(() => ({
    createdServers: [] as import('node:http').Server[],
}));

vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    const realCreateServer = actual.createServer.bind(actual);
    const wrapped = ((handler?: import('node:http').RequestListener) => {
        const created = realCreateServer(handler);
        createdServers.push(created);
        return created;
    }) as typeof actual.createServer;
    return { ...actual, createServer: wrapped };
});

let createGateServer: typeof import('../src/gates.js')['createGateServer'];

beforeAll(async () => {
    // isolate:false shares the module cache across files in a worker: when another file (loop,
    // k8s) evaluated gates.ts first, its node:http import is bound to the real module and the
    // wrapper above never sees a server. Reset + re-import binds the source to THIS file's mock.
    vi.resetModules();
    ({ createGateServer } = await import('../src/gates.js'));
});

const KEY = `bellows/44444444-4444-4444-8444-444444444444/.worktrees/55555555-5555-4555-8555-555555555555`;
const NAME = gateEnvContainerName(KEY);
const config = loadDriverConfig({});

/** The attempt a gate runs under — its id and lease token name the services network. */
const JOB: BoardJob = {
    id: '55555555-5555-4555-8555-555555555555',
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
    masterPrompt: 'You are running inside Factory.',
    resumeSessionId: null,
    followUp: false,
    userId: '44444444-4444-4444-8444-444444444444',
    workspacePath: 'bellows/44444444-4444-4444-8444-444444444444',
};

/** The same attempt, whose checkout declares `setup: npm ci`. */
const WITH_SETUP: BoardJob = { ...JOB, gates: { image: 'node:24', setup: 'npm ci', gates: [] } };

/** The execFile-shaped seam: resolves on exit 0, rejects with `.code` otherwise. */
type ExecResult = { stdout: string; stderr: string };
type ExecError = Error & { code?: number | string; stdout?: string; stderr?: string };
type ExecArgs = string[] & { timeout?: number };
const exec =
    (script: (args: ExecArgs, options?: { timeout?: number }) => Promise<ExecResult> | ExecResult) =>
    (args: string[], options?: { timeout?: number }): Promise<ExecResult> =>
        Promise.resolve().then(() => script(args as ExecArgs, options));

const fails = (code: number, stderr: string) => {
    const error = new Error(`exit ${code}`) as ExecError;
    error.code = code;
    error.stderr = stderr;
    return Promise.reject(error);
};

const logs: string[][] = [];
const recording = exec((args) => {
    logs.push(args);
    return { stdout: '', stderr: '' };
});

/** docker's own "no such container" exit code — the harness state every rejection here reports. */
const CONTAINER_GONE_CODE = 125;
const OK_STATUS = 200;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const BAD_REQUEST_STATUS = 400;
const CONFLICT_STATUS = 409;
const PAYLOAD_TOO_LARGE_STATUS = 413;
const UNPROCESSABLE_STATUS = 422;

/** The margin past a 5ms cooldown that every "did the teardown fire" assertion waits out. */
const COOLDOWN_SETTLE_MS = 40;

describe('the gate environment manager: lifecycle', () => {
    it('creates the environment container on first acquire and reuses it after', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');
        await manager.acquire(KEY, 'node:24', '');

        expect(logs.filter((args) => args[0] === 'run')).toHaveLength(1);
        expect(logs.flat()).toEqual(expect.arrayContaining(['-d', '--name', NAME]));
        await manager.stop();
    });

    it('fences before creating, the way every spawn here is fenced', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');
        expect(logs[0]).toEqual(['rm', '-f', NAME]);
        await manager.stop();
    });

    it('takes the env body as a file, never as argv values', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: recording });
        await manager.acquire(KEY, 'node:24', 'MY_TOKEN=board-secret\n');
        const run = logs.find((args) => args[0] === 'run')!;
        expect(run).toEqual(expect.arrayContaining(['--env-file', expect.stringContaining('factory-gateenv')]));
        expect(run.some((arg) => arg.includes('board-secret'))).toBe(false);
        await manager.stop();
    });

    // The warm container keeps the env it was created with; a re-acquire's fresher token (asked at
    // each gate run's start, docs/connections.md) reaches the gate through exec's own env file.
    it('hands each gate the newest env body by exec env file, without recreating the container', async () => {
        const seen: { args: string[]; file: string }[] = [];
        const reading = exec((args) => {
            if (args[0] === 'exec') {
                const at = args.indexOf('--env-file');
                seen.push({ args, file: at > 0 ? readFileSync(args[at + 1]!, 'utf8') : '' });
            }
            return { stdout: '', stderr: '' };
        });
        logs.length = 0;
        const manager = createGateManager({
            config,
            cooldownMs: 1000,
            execDocker: exec((args) => {
                logs.push(args);
                return reading(args);
            }),
        });
        await manager.acquire(KEY, 'node:24', 'GITHUB_TOKEN=ghs_first\n');
        await manager.acquire(KEY, 'node:24', 'GITHUB_TOKEN=ghs_second\n');
        await manager.runGate(KEY, 'test', 'npm test');

        expect(logs.filter((args) => args[0] === 'run')).toHaveLength(1);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.file).toBe('GITHUB_TOKEN=ghs_second\n');
        expect(seen[0]!.args.some((arg) => arg.includes('ghs_'))).toBe(false);
        await manager.stop();
    });

    // Two ad-hoc runs re-acquire outside the key's queue: their env files must not share a temp name.
    it('refreshes the env file under concurrent re-acquires without either failing', async () => {
        const entry = { name: 'factory-gateenv-concurrent-refresh-test', envBody: 'GITHUB_TOKEN=ghs_0\n' };
        await Promise.all(
            Array.from({ length: 8 }, (_, i) => refreshGateEnv({ ...entry }, `GITHUB_TOKEN=ghs_${i + 1}\n`))
        );
        expect(readFileSync(gateEnvFile(entry.name), 'utf8')).toMatch(/^GITHUB_TOKEN=ghs_[1-8]\n$/);
        rmSync(gateEnvFile(entry.name), { force: true });
    });

    it('tears the container down after the cooldown, and only then', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 5, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');
        manager.release(KEY, JOB);
        // The acquire fence above is also an `rm -f`; only counts AFTER release are teardowns.
        const atRelease = logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME).length;
        await new Promise((resolve) => setTimeout(resolve, COOLDOWN_SETTLE_MS));
        const afterCooldown = logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME).length;
        expect(afterCooldown).toBe(atRelease + 1);
    });

    it('cancels the teardown when the same environment is acquired again', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 5, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');
        manager.release(KEY, JOB);
        const atRelease = logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME).length;
        await manager.acquire(KEY, 'node:24', '');
        await new Promise((resolve) => setTimeout(resolve, COOLDOWN_SETTLE_MS));
        const afterCooldown = logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME).length;
        expect(afterCooldown).toBe(atRelease);
        await manager.stop();
    });

    it('recreates a container whose teardown already ran', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 5, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');
        manager.release(KEY, JOB);
        await new Promise((resolve) => setTimeout(resolve, COOLDOWN_SETTLE_MS));
        await manager.acquire(KEY, 'node:24', '');
        expect(logs.filter((args) => args[0] === 'run')).toHaveLength(2);
        await manager.stop();
    });
});

describe('the gate environment manager: running gates', () => {
    it('runs a gate by exec and answers its exit code with a tailed output', async () => {
        const GATE_FAIL_EXIT_CODE = 3;
        const gateExec = exec((args) => {
            if (args[0] === 'exec') {
                if (args[4] === 'pass') return { stdout: 'all green\n', stderr: '' };
                return fails(GATE_FAIL_EXIT_CODE, '2 problems\n');
            }
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: gateExec });
        await manager.acquire(KEY, 'node:24', '');

        await expect(manager.runGate(KEY, 'test', 'pass')).resolves.toEqual({
            exitCode: 0,
            output: 'all green',
        });
        await expect(manager.runGate(KEY, 'test', 'fail')).resolves.toEqual({
            exitCode: GATE_FAIL_EXIT_CODE,
            output: '2 problems',
        });
        await manager.stop();
    });

    it('runs the declared setup once per environment, before the first gate, and not again', async () => {
        const scripts: string[] = [];
        const setupExec = exec((args) => {
            if (args[0] === 'exec') scripts.push(args[4] ?? '');
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: setupExec });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        await manager.runGate(KEY, 'test', 'npm test');
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
        await manager.runGate(KEY, 'lint', 'npm run lint');

        expect(scripts).toEqual(['npm ci', 'npm test', 'npm run lint']);
        await manager.stop();
    });

    it('answers a failed setup as a setup failure, skips the gate, and retries setup next time', async () => {
        const SETUP_EXIT_CODE = 7;
        const scripts: string[] = [];
        let setupFails = true;
        const setupExec = exec((args) => {
            if (args[0] !== 'exec') return { stdout: '', stderr: '' };
            scripts.push(args[4] ?? '');
            if (args[4] === 'npm ci' && setupFails) return fails(SETUP_EXIT_CODE, 'registry down\n');
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: setupExec });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });

        await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toEqual({
            exitCode: SETUP_EXIT_CODE,
            output: 'registry down',
            setupFailed: true,
        });
        setupFails = false;
        await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 0 });
        expect(scripts).toEqual(['npm ci', 'npm ci', 'npm test']);
        await manager.stop();
    });

    // Issue #733: the agent needs the install before its first turn, not before the first gate.
    describe('runSetup: setup before the agent starts', () => {
        const SETUP_EXIT_CODE = 7;
        /** Records every exec'd script; `npm ci` fails while `setupFails()` says so. */
        const scripted = (setupFails: () => boolean = () => false) => {
            const scripts: string[] = [];
            const timeouts: (number | undefined)[] = [];
            const execDocker = exec((args, options) => {
                if (args[0] !== 'exec') return { stdout: '', stderr: '' };
                scripts.push(args[4] ?? '');
                timeouts.push(options?.timeout);
                if (args[4] === 'npm ci' && setupFails()) return fails(SETUP_EXIT_CODE, 'registry down\n');
                return { stdout: 'installed\n', stderr: '' };
            });
            return { scripts, timeouts, execDocker };
        };

        it('runs setup now, and the first gate does not repeat it', async () => {
            const docker = scripted();
            const manager = createGateManager({ config, cooldownMs: 1000, execDocker: docker.execDocker });
            await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });

            await expect(manager.runSetup(KEY)).resolves.toEqual({ exitCode: 0, output: 'installed' });
            await manager.runGate(KEY, 'test', 'npm test');
            expect(docker.scripts).toEqual(['npm ci', 'npm test']);
            await manager.stop();
        });

        it('answers a failed setup and leaves it pending, so the first gate retries it', async () => {
            let setupFails = true;
            const docker = scripted(() => setupFails);
            const manager = createGateManager({ config, cooldownMs: 1000, execDocker: docker.execDocker });
            await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });

            await expect(manager.runSetup(KEY)).resolves.toEqual({
                exitCode: SETUP_EXIT_CODE,
                output: 'registry down',
            });
            setupFails = false;
            await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 0 });
            expect(docker.scripts).toEqual(['npm ci', 'npm ci', 'npm test']);
            await manager.stop();
        });

        it('re-runs setup for a new attempt on a warm environment', async () => {
            const docker = scripted();
            const manager = createGateManager({ config, cooldownMs: 1000, execDocker: docker.execDocker });
            await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
            await manager.runSetup(KEY);
            const followUp: BoardJob = { ...WITH_SETUP, leaseToken: '33333333-3333-4333-8333-333333333333' };
            await manager.acquire(KEY, 'node:24', '', { job: followUp });
            await manager.runSetup(KEY);
            await manager.runGate(KEY, 'test', 'npm test');

            expect(docker.scripts).toEqual(['npm ci', 'npm ci', 'npm test']);
            await manager.stop();
        });

        it('answers null and runs nothing when the checkout declares no setup', async () => {
            const docker = scripted();
            const manager = createGateManager({ config, cooldownMs: 1000, execDocker: docker.execDocker });
            await manager.acquire(KEY, 'node:24', '', { job: JOB });

            await expect(manager.runSetup(KEY)).resolves.toBeNull();
            expect(docker.scripts).toEqual([]);
            await manager.stop();
        });

        it('runs setup under the timeout it is given', async () => {
            const docker = scripted();
            const manager = createGateManager({
                config,
                cooldownMs: 1000,
                gateTimeoutMs: 30_000,
                execDocker: docker.execDocker,
            });
            await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });

            await manager.runSetup(KEY, { timeoutMs: 12_000 });
            expect(docker.timeouts).toEqual([12_000]);
            await manager.stop();
        });

        // Review round 1: the cooldown must not reap the environment out from under the attempt and
        // make the end-of-run gate pass install a second time.
        it('runs setup once per attempt, even when the environment is reaped and re-acquired', async () => {
            vi.useFakeTimers();
            try {
                const docker = scripted();
                const manager = createGateManager({ config, cooldownMs: 1000, execDocker: docker.execDocker });
                await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
                await manager.runSetup(KEY);
                await vi.advanceTimersByTimeAsync(5000);
                // An ad-hoc gate arms the cooldown too; its reap must not forget the install either.
                await manager.runGate(KEY, 'test', 'npm test');
                await vi.advanceTimersByTimeAsync(5000);
                await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
                await manager.runGate(KEY, 'test', 'npm test');

                expect(docker.scripts).toEqual(['npm ci', 'npm test', 'npm test']);
                await manager.stop();
            } finally {
                vi.useRealTimers();
            }
        });

        it('a new attempt handed a warm environment runs its own setup before its first gate', async () => {
            const docker = scripted();
            const manager = createGateManager({ config, cooldownMs: 1000, execDocker: docker.execDocker });
            await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
            await manager.runSetup(KEY);
            const followUp: BoardJob = { ...WITH_SETUP, leaseToken: '33333333-3333-4333-8333-333333333333' };
            await manager.acquire(KEY, 'node:24', '', { job: followUp });
            await manager.runGate(KEY, 'test', 'npm test');

            expect(docker.scripts).toEqual(['npm ci', 'npm ci', 'npm test']);
            await manager.stop();
        });

        // The kubernetes manager's rule: a setup queued for one attempt never clears another's.
        it("a setup that finishes after the environment passed to a newer attempt leaves that attempt's setup pending", async () => {
            const scripts: string[] = [];
            let releaseHang!: () => void;
            const hanging = exec((args) => {
                if (args[0] !== 'exec') return { stdout: '', stderr: '' };
                scripts.push(args[4] ?? '');
                if (args[4] === 'hang') {
                    return new Promise<ExecResult>((resolve) => {
                        releaseHang = () => resolve({ stdout: '', stderr: '' });
                    });
                }
                return { stdout: '', stderr: '' };
            });
            const manager = createGateManager({ config, cooldownMs: 1000, execDocker: hanging });
            await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
            const held = manager.runGate(KEY, 'hold', 'hang');
            const staleSetup = manager.runSetup(KEY);
            await new Promise((resolve) => setTimeout(resolve, 5));
            const followUp: BoardJob = { ...WITH_SETUP, leaseToken: '33333333-3333-4333-8333-333333333333' };
            await manager.acquire(KEY, 'node:24', '', { job: followUp });
            releaseHang();
            await held;
            await staleSetup;
            await manager.runGate(KEY, 'test', 'npm test');

            expect(scripts).toEqual(['npm ci', 'hang', 'npm ci', 'npm ci', 'npm test']);
            await manager.stop();
        });

        // Review round 2: the per-checkout record of a succeeded setup ends with its attempt's release.
        it("forgets the attempt's setup at its release", async () => {
            const docker = scripted();
            const manager = createGateManager({ config, cooldownMs: 0, execDocker: docker.execDocker });
            await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
            await manager.runSetup(KEY);
            manager.release(KEY, WITH_SETUP);
            await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
            await manager.runGate(KEY, 'test', 'npm test');

            expect(docker.scripts).toEqual(['npm ci', 'npm ci', 'npm test']);
            await manager.stop();
        });

        it('tears the environment down when the attempt aborts mid-setup', async () => {
            const removed: string[] = [];
            const hanging = exec((args) => {
                if (args[0] === 'rm') removed.push(args[2] ?? '');
                if (args[0] === 'exec') return new Promise<ExecResult>(() => {});
                return { stdout: '', stderr: '' };
            });
            const manager = createGateManager({ config, cooldownMs: 1000, execDocker: hanging });
            await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });
            removed.length = 0;
            const controller = new AbortController();

            const running = manager.runSetup(KEY, { signal: controller.signal });
            await new Promise((resolve) => setTimeout(resolve, 5));
            controller.abort();

            await expect(running).resolves.toMatchObject({ exitCode: 130 });
            expect(removed).toContain(NAME);
            await manager.stop();
        });
    });

    it('serializes gate runs per checkout, so two turns cannot interleave installs', async () => {
        let releaseFirst!: () => void;
        const gate = new Promise<ExecResult>((resolve) => {
            releaseFirst = () => resolve({ stdout: 'first done\n', stderr: '' });
        });
        let execCalls = 0;
        const slowExec = exec((args) => {
            if (args[0] === 'exec') {
                execCalls += 1;
                return execCalls === 1 ? gate : Promise.resolve({ stdout: 'second\n', stderr: '' });
            }
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: slowExec });
        await manager.acquire(KEY, 'node:24', '');

        const first = manager.runGate(KEY, 'test', 'npm test');
        const second = manager.runGate(KEY, 'test', 'npm run lint');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(execCalls).toBe(1); // the second run waits for the first

        releaseFirst();
        await expect(first).resolves.toMatchObject({ exitCode: 0 });
        await expect(second).resolves.toMatchObject({ exitCode: 0 });
        await manager.stop();
    });

    /*
     * The declared services live on the attempt's own network, and a gate is where the tests
     * that need them run — so the environment joins that network before the gate execs, once
     * per attempt. A job with no services has no network: the connect is refused, and the gate
     * runs anyway (nothing to reach is not a harness failure).
     */
    it('joins the attempt’s services network before running a gate, once per attempt', async () => {
        const seen: string[][] = [];
        const servicesExec = exec((args) => {
            seen.push(args);
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({
            config: loadDriverConfig({ RUNNER_SERVICES: '1' }),
            cooldownMs: 1000,
            execDocker: servicesExec,
        });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        await manager.runGate(KEY, 'test', 'npm test');
        await manager.runGate(KEY, 'lint', 'npm run lint');

        const connect = ['network', 'connect', networkName(JOB), NAME];
        expect(seen.filter((args) => args.join(' ') === connect.join(' '))).toHaveLength(1);
        const connectAt = seen.findIndex((args) => args.join(' ') === connect.join(' '));
        expect(seen.findIndex((args) => args[0] === 'exec')).toBeGreaterThan(connectAt);

        // A later attempt on the same warm environment joins ITS network.
        const next = { ...JOB, leaseToken: '33333333-3333-4333-8333-333333333333' };
        await manager.acquire(KEY, 'node:24', '', { job: next });
        await manager.runGate(KEY, 'test', 'npm test');
        expect(seen).toContainEqual(['network', 'connect', networkName(next), NAME]);
        await manager.stop();
    });

    it('runs the gate anyway when the attempt has no services network to join', async () => {
        const noNetwork = exec((args) => {
            if (args[0] === 'network') return fails(1, 'Error: No such network\n');
            if (args[0] === 'exec') return { stdout: 'green\n', stderr: '' };
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({
            config: loadDriverConfig({ RUNNER_SERVICES: '1' }),
            cooldownMs: 1000,
            execDocker: noNetwork,
        });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toEqual({ exitCode: 0, output: 'green' });
        await manager.stop();
    });

    it('joins no network when services are off', async () => {
        logs.length = 0;
        const manager = createGateManager({
            config: loadDriverConfig({ RUNNER_SERVICES: '0' }),
            cooldownMs: 1000,
            execDocker: recording,
        });
        await manager.acquire(KEY, 'node:24', '', { job: JOB });
        await manager.runGate(KEY, 'test', 'npm test');
        expect(logs.some((args) => args[0] === 'network')).toBe(false);
        await manager.stop();
    });

    it('keeps a different checkout in a different container', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: recording });
        const other = `bellows/44444444-4444-4444-8444-444444444444/.worktrees/66666666-6666-4666-8666-666666666666`;
        await manager.acquire(KEY, 'node:24', '');
        await manager.acquire(other, 'python:3', '');
        expect(logs.filter((args) => args[0] === 'run')).toHaveLength(2);
        const stoppedAt = logs.length;
        await manager.stop();
        // The drain removes exactly the containers the manager still tracks.
        expect(logs.slice(stoppedAt).filter((args) => args[0] === 'rm' && args[1] === '-f')).toHaveLength(2);
    });
});

describe('the gate environment manager: acquire serialization and timeouts', () => {
    // Two gated claims on one member+repo while neither container exists yet (the concurrency-2
    // default makes this ordinary): the cold acquires must line up, or they race two `docker run`s
    // on one name and the loser fails the job outright.
    it('serializes cold acquires of the same checkout', async () => {
        let releaseFirstRun!: () => void;
        const firstRun = new Promise<{ stdout: string; stderr: string }>((resolve) => {
            releaseFirstRun = () => resolve({ stdout: '', stderr: '' });
        });
        let runCalls = 0;
        const slowExec = exec((args) => {
            if (args[0] === 'run') {
                runCalls += 1;
                return runCalls === 1 ? firstRun : Promise.resolve({ stdout: '', stderr: '' });
            }
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: slowExec });

        const first = manager.acquire(KEY, 'node:24', '');
        const second = manager.acquire(KEY, 'node:24', '');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(runCalls).toBe(1); // the second acquire waits for the first

        releaseFirstRun();
        await Promise.all([first, second]);
        expect(runCalls).toBe(1); // and reuses, rather than creating a second container
        await manager.stop();
    });

    // A hung gate (a watch-mode test, a dev server) must fail the gate, not stall the verdict
    // forever. The kill arrives through the exec's own timeout; 124 is the convention `timeout`
    // itself uses, and the output says what happened.
    it('kills a gate that outlives its timeout, and reports it as a failed gate', async () => {
        const seenOptions: ({ timeout?: number } | undefined)[] = [];
        const timingOut = exec((args, options) => {
            if (args[0] !== 'exec') return { stdout: '', stderr: '' };
            seenOptions.push(options);
            const error = new Error('killed') as ExecError & { killed?: boolean };
            error.killed = true;
            error.stderr = '';
            return Promise.reject(error);
        });
        const manager = createGateManager({
            config,
            cooldownMs: 1000,
            gateTimeoutMs: 30_000,
            execDocker: timingOut,
        });
        await manager.acquire(KEY, 'node:24', '');

        await expect(manager.runGate(KEY, 'test', 'npm run dev')).resolves.toEqual({
            exitCode: 124,
            output: '[driver] gate killed after 30000ms',
        });
        // The cap travels as the exec's own timeout, the way `timeout` would wrap it.
        expect(seenOptions.at(-1)).toMatchObject({ timeout: 30_000 });
        await manager.stop();
    });

    /** An exec seam that kills every `docker exec` at its timeout, recording each one's options. */
    const killedAtTimeout = (seenOptions: ({ timeout?: number } | undefined)[]) =>
        exec((args, options) => {
            if (args[0] !== 'exec') return { stdout: '', stderr: '' };
            seenOptions.push(options);
            const error = new Error('killed') as Error & { killed?: boolean };
            error.killed = true;
            return Promise.reject(error);
        });

    // A gate's own `timeout:` (issue #576): the UI suite outlives GATE_TIMEOUT_MS by design, so
    // its declared budget, not the driver default, bounds it.
    it('kills a gate at its own timeout, not the driver default', async () => {
        const seenOptions: ({ timeout?: number } | undefined)[] = [];
        const manager = createGateManager({
            config,
            cooldownMs: 1000,
            gateTimeoutMs: 30_000,
            execDocker: killedAtTimeout(seenOptions),
        });
        await manager.acquire(KEY, 'node:24', '');

        await expect(manager.runGate(KEY, 'ui', 'npm run verify:ui', { timeoutMs: 2_700_000 })).resolves.toEqual({
            exitCode: 124,
            output: '[driver] gate killed after 2700000ms',
        });
        expect(seenOptions.at(-1)).toMatchObject({ timeout: 2_700_000 });
        await manager.stop();
    });

    // The board is trusted, but a claim carrying no positive number must not become a NaN deadline.
    it.each([Number.NaN, 0, -5, Number.POSITIVE_INFINITY])('reads a timeoutMinutes of %s as none', (timeoutMinutes) => {
        expect(declaredTimeoutMs({ name: 'ui', command: 'x', timeoutMinutes })).toBeUndefined();
    });

    it("caps a gate's own timeout at DRIVER_JOB_TIMEOUT_MS", async () => {
        const seenOptions: ({ timeout?: number } | undefined)[] = [];
        const manager = createGateManager({
            config: loadDriverConfig({ DRIVER_JOB_TIMEOUT_MS: '1800000' }),
            cooldownMs: 1000,
            gateTimeoutMs: 30_000,
            execDocker: killedAtTimeout(seenOptions),
        });
        await manager.acquire(KEY, 'node:24', '');

        await manager.runGate(KEY, 'ui', 'npm run verify:ui', { timeoutMs: 2_700_000 });
        expect(seenOptions.at(-1)).toMatchObject({ timeout: 1_800_000 });
        await manager.stop();
    });

    it('runs setup under the driver default when the gate declares its own timeout', async () => {
        const seenOptions: ({ timeout?: number } | undefined)[] = [];
        const passing = exec((args, options) => {
            if (args[0] === 'exec') seenOptions.push(options);
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, gateTimeoutMs: 30_000, execDocker: passing });
        await manager.acquire(KEY, 'node:24', '', { job: WITH_SETUP });

        await manager.runGate(KEY, 'ui', 'npm run verify:ui', { timeoutMs: 2_700_000 });
        expect(seenOptions.map((options) => options?.timeout)).toEqual([30_000, 2_700_000]);
        await manager.stop();
    });
});

describe('the gate environment manager: failure and edge cases', () => {
    // Docker failing to exec at all — the container was torn down under the caller — is a
    // HARNESS state, not a gate verdict: it rejects with the container-gone code, which is what
    // the ad-hoc endpoint's 409 and the loop's failed-gate path both key on.
    it('rejects a gate whose container the daemon cannot exec into', async () => {
        const gone = exec((args) => {
            if (args[0] === 'exec') {
                const error = new Error('Error response from daemon: No such container') as Error & {
                    code?: number;
                };
                error.code = CONTAINER_GONE_CODE;
                return Promise.reject(error);
            }
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: gone });
        await manager.acquire(KEY, 'node:24', '');

        await expect(manager.runGate(KEY, 'test', 'npm test')).rejects.toMatchObject({ code: 125 });
        await manager.stop();
    });

    it('rejects a gate for a checkout that has no environment at all', async () => {
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: recording });
        await expect(manager.runGate(KEY, 'test', 'npm test')).rejects.toMatchObject({ code: 125 });
    });

    // Cooldown 0 means "tear down when the run's exits are walked" — release-driven, never
    // between the gates of one run, or a checkout declaring two gates could never pass.
    it('keeps the environment up across gates at cooldown 0, and tears down on release', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 0, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');
        await manager.runGate(KEY, 'test', 'npm test');
        await manager.runGate(KEY, 'lint', 'npm run lint');
        // Between gates, no `rm` but the acquire fence above.
        expect(logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME)).toHaveLength(1);
        manager.release(KEY, JOB);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME)).toHaveLength(2);
    });

    // A gate whose exec outlives its environment's teardown (lost lease → release → cooldown
    // fired, or the drain) must not leave a stale timer behind: one armed on the dead entry
    // would delete the RE-CREATED environment when it fires, failing an innocent job, and hold
    // the event loop open past shutdown.
    it('does not arm a cooldown on an entry that was torn down while a gate ran', async () => {
        const COOLDOWN_FIRE_WAIT_MS = 20;
        const REARM_CHECK_WAIT_MS = 30;
        logs.length = 0;
        let releaseExec!: () => void;
        const pendingExec = new Promise<{ stdout: string; stderr: string }>((resolve) => {
            releaseExec = () => resolve({ stdout: 'late gate\n', stderr: '' });
        });
        const slowExec = exec((args) => {
            logs.push(args);
            if (args[0] === 'exec') return pendingExec;
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 5, execDocker: slowExec });
        await manager.acquire(KEY, 'node:24', '');

        const gate = manager.runGate(KEY, 'test', 'npm test');
        // The environment is torn down (and re-created by nobody in this test) while the exec runs.
        manager.release(KEY, JOB);
        await new Promise((resolve) => setTimeout(resolve, COOLDOWN_FIRE_WAIT_MS)); // the cooldown timer fires on the dead entry
        releaseExec();
        await expect(gate).resolves.toMatchObject({ exitCode: 0 });

        // The re-armed cooldown on the dead entry never fires: no rm beyond the fence+teardown.
        await new Promise((resolve) => setTimeout(resolve, REARM_CHECK_WAIT_MS));
        expect(logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME)).toHaveLength(2);
    });
});

/** A manager that acquires and passes every gate — for server tests about anything but the run. */
const idle = { acquire: async () => {}, runGate: async () => ({ exitCode: 0, output: '' }) };

/**
 * A loopback gate server with `token` registered for `gates` under JOB, already listening;
 * `run(gate)` is the agent's `POST /run` for one declared name under that token.
 */
async function serveGates(
    manager: Pick<GateManager, 'acquire' | 'runGate'>,
    {
        token = 'tok-1',
        gates = [{ name: 'test', command: 'npm test' }],
    }: { token?: string; gates?: GateClaim['gates'] } = {}
) {
    const server = createGateServer({ host: '127.0.0.1', manager });
    server.register(token, { key: KEY, image: 'node:24', job: JOB, gates });
    const port = await server.listen();
    const run = (gate = 'test') =>
        fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ gate }),
        });
    return { server, port, run };
}

describe('the gate server', () => {
    it('runs a declared gate for a bearer token and answers the verdict', async () => {
        const seen: { key: string; name: string; command: string }[] = [];
        const acquiredFor: (BoardJob | undefined)[] = [];
        const manager = {
            // The job is the attempt context: the kubernetes manager refuses an acquire without
            // one, and the docker manager joins the attempt's services network by it.
            acquire: async (_key: string, _image: string, _envBody?: string, attempt?: GateAttempt) => {
                acquiredFor.push(attempt?.job);
            },
            runGate: async (key: string, name: string, command: string) => {
                seen.push({ key, name, command });
                return { exitCode: 0, output: 'ok' };
            },
        };
        const { server, run } = await serveGates(manager);

        const response = await run('test');
        expect(response.status).toBe(OK_STATUS);
        await expect(response.json()).resolves.toEqual({ exitCode: 0, output: 'ok' });
        expect(seen).toEqual([{ key: KEY, name: 'test', command: 'npm test' }]);
        expect(acquiredFor).toEqual([JOB]);
        await server.close();
    });

    // An ad-hoc run an hour into the agent's turn must not start on the token minted at gate setup.
    it('acquires an ad-hoc run with the env its claim asks for now, not the one it registered', async () => {
        const bodies: (string | undefined)[] = [];
        const manager = {
            acquire: async (_key: string, _image: string, envBody?: string) => {
                bodies.push(envBody);
            },
            runGate: async () => ({ exitCode: 0, output: 'ok' }),
        };
        const server = createGateServer({ host: '127.0.0.1', manager });
        let asked = 0;
        server.register('tok-fresh', {
            key: KEY,
            image: 'node:24',
            job: JOB,
            gates: [{ name: 'test', command: 'npm test' }],
            envBody: 'GITHUB_TOKEN=ghs_setup\n',
            freshEnv: async () => {
                asked += 1;
                return `GITHUB_TOKEN=ghs_run${asked}\n`;
            },
        });
        const port = await server.listen();
        for (let i = 0; i < 2; i++) {
            const response = await fetch(`http://127.0.0.1:${port}/run`, {
                method: 'POST',
                headers: { authorization: 'Bearer tok-fresh' },
                body: JSON.stringify({ gate: 'test' }),
            });
            expect(response.status).toBe(OK_STATUS);
        }
        expect(bodies).toEqual(['GITHUB_TOKEN=ghs_run1\n', 'GITHUB_TOKEN=ghs_run2\n']);
        await server.close();
    });

    // An ad-hoc call is a client waiting on one HTTP answer (the agent's shell tool gives up at
    // 10 minutes), and a hangup kills the run: a longer gate would die every time, so it is
    // refused up front and left to the end-of-run pass (issue #576).
    it('refuses an ad-hoc run of a gate whose timeout outlasts the call, before acquiring', async () => {
        let acquired = 0;
        let ran = 0;
        const manager = {
            acquire: async () => {
                acquired += 1;
            },
            runGate: async () => {
                ran += 1;
                return { exitCode: 0, output: '' };
            },
        };
        const { server, run } = await serveGates(manager, {
            gates: [{ name: 'ui', command: 'npm run verify:ui', timeoutMinutes: 11 }],
        });
        const response = await run('ui');
        expect(response.status).toBe(UNPROCESSABLE_STATUS);
        await expect(response.json()).resolves.toEqual({
            error: 'gate "ui" declares timeout: 11, longer than an ad-hoc run can wait (10 minutes); it runs in the end-of-run gates pass',
        });
        expect([acquired, ran]).toEqual([0, 0]);
        await server.close();
    });

    it("passes a declared gate's timeout to the manager in ms", async () => {
        const seen: (number | undefined)[] = [];
        const manager = {
            acquire: async () => {},
            runGate: async (_key: string, _name: string, _command: string, options?: GateRunOptions) => {
                seen.push(options?.timeoutMs);
                return { exitCode: 0, output: 'ok' };
            },
        };
        const { server, run } = await serveGates(manager, {
            gates: [
                { name: 'test', command: 'npm test' },
                { name: 'ui', command: 'npm run verify:ui', timeoutMinutes: 10 },
            ],
        });
        for (const gate of ['test', 'ui']) {
            const response = await run(gate);
            expect(response.status).toBe(OK_STATUS);
        }
        expect(seen).toEqual([undefined, 600_000]);
        await server.close();
    });

    it('runs an on-demand gate ad hoc, and refuses a long one without promising the end-of-run pass', async () => {
        const ran: string[] = [];
        const manager = {
            acquire: async () => {},
            runGate: async (_key: string, name: string) => {
                ran.push(name);
                return { exitCode: 0, output: 'ok' };
            },
        };
        const { server, run } = await serveGates(manager, {
            gates: [
                { name: 'smoke', command: 'npm run smoke', onDemand: true },
                { name: 'ui', command: 'npm run verify:ui', timeoutMinutes: 45, onDemand: true },
            ],
        });
        expect((await run('smoke')).status).toBe(OK_STATUS);
        const refused = await run('ui');
        expect(refused.status).toBe(UNPROCESSABLE_STATUS);
        await expect(refused.json()).resolves.toEqual({
            error: 'gate "ui" declares timeout: 45, longer than an ad-hoc run can wait (10 minutes); it is on_demand, so the end-of-run gates pass skips it too',
        });
        expect(ran).toEqual(['smoke']);
        await server.close();
    });

    it('refuses an unknown token, an undeclared gate and a malformed body', async () => {
        const { server, port } = await serveGates(idle, { token: 'tok-2' });
        const url = `http://127.0.0.1:${port}/run`;
        const post = (headers: Record<string, string>, body: string) => fetch(url, { method: 'POST', headers, body });

        expect((await post({ authorization: 'Bearer nope' }, '{"gate":"test"}')).status).toBe(UNAUTHORIZED_STATUS);
        expect((await post({ authorization: 'Bearer tok-2' }, '{"gate":"deploy"}')).status).toBe(NOT_FOUND_STATUS);
        expect((await post({ authorization: 'Bearer tok-2' }, 'not json')).status).toBe(BAD_REQUEST_STATUS);
        expect((await post({ authorization: 'Bearer tok-2' }, '{}')).status).toBe(BAD_REQUEST_STATUS);
        // Only the declared name ever reaches the manager — never an arbitrary command string.
        expect((await post({ authorization: 'Bearer tok-2' }, '{"command":"rm -rf /"}')).status).toBe(
            BAD_REQUEST_STATUS
        );
        await server.close();
    });

    it('answers 409 when the environment container is gone mid-run', async () => {
        const manager = {
            acquire: async () => {},
            runGate: async () => {
                const error = new Error('Error response from daemon: No such container') as Error & {
                    code?: number;
                };
                error.code = CONTAINER_GONE_CODE;
                throw error;
            },
        };
        const { server, run } = await serveGates(manager, { token: 'tok-3' });
        const response = await run('test');
        expect(response.status).toBe(CONFLICT_STATUS);
        // A harness failure is not a verdict: nothing is recorded for the run.
        expect(server.lastRuns('tok-3')).toEqual([]);
        await server.close();
    });

    // The spawn failure end to end: with docker missing from PATH, the call must not answer 200
    // carrying a verdict for a gate that never ran — the 409 is the harness-failure answer.
    it('answers 409, never a verdict, when the exec cannot spawn docker at all', async () => {
        const noDocker = exec((args) => {
            if (args[0] === 'exec') {
                const error = new Error('spawn docker ENOENT') as Error & { code?: string };
                error.code = 'ENOENT';
                return Promise.reject(error);
            }
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: noDocker });
        const { server, run } = await serveGates(manager, { token: 'tok-enoent' });
        const response = await run('test');
        expect(response.status).toBe(CONFLICT_STATUS);
        await manager.stop();
        await server.close();
    });
});

describe('the gate server: run control (issue #442)', () => {
    const read = (port: number, token: string) =>
        fetch(`http://127.0.0.1:${port}/control`, { headers: { authorization: `Bearer ${token}` } });

    it('answers stop=false until a stop is raised, then true — idempotently, per token', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('tok-a');
        server.openControl('tok-b');
        const port = await server.listen();

        expect(server.controlPolled('tok-a')).toBe(false);
        await expect((await read(port, 'tok-a')).json()).resolves.toEqual({ stop: false, kill: false });
        expect(server.controlPolled('tok-a')).toBe(true);
        expect(server.controlPolled('tok-b')).toBe(false);
        server.raiseStop('tok-a');
        server.raiseStop('tok-a');
        await expect((await read(port, 'tok-a')).json()).resolves.toEqual({ stop: true, kill: false });
        // Another attempt's token is unaffected by the first one's stop.
        await expect((await read(port, 'tok-b')).json()).resolves.toEqual({ stop: false, kill: false });
        await server.close();
    });

    it('raises the kill order beside the stop, idempotently, for the one token only', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('tok-a');
        server.openControl('tok-b');
        const port = await server.listen();

        server.raiseKill('tok-a');
        server.raiseKill('tok-a');
        server.raiseKill('unknown');
        await expect((await read(port, 'tok-a')).json()).resolves.toEqual({ stop: true, kill: true });
        await expect((await read(port, 'tok-b')).json()).resolves.toEqual({ stop: false, kill: false });
        await server.close();
    });

    // Two tokens of one lease open different doors: the supervisor's the run's control, the agent's
    // only the publish and review routes the baked skills call.
    it('opens the control routes to the supervisor token only, and publish and review to the agent token only', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('sup', undefined, { publish: async () => 'unsupported' });
        server.grantAgent('sup', 'agent');
        const port = await server.listen();
        const get = (path: string, token: string) =>
            fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });
        const post = (path: string, token: string) =>
            fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

        expect((await post('/publish', 'agent')).status).not.toBe(FORBIDDEN_STATUS);
        // The agent's own calls never say a supervisor is listening.
        expect(server.controlPolled('sup')).toBe(false);
        expect((await get('/control', 'agent')).status).toBe(FORBIDDEN_STATUS);
        expect((await get('/export/chunk', 'agent')).status).toBe(FORBIDDEN_STATUS);
        expect((await post('/publish', 'sup')).status).toBe(FORBIDDEN_STATUS);
        expect((await get('/control', 'sup')).status).toBe(OK_STATUS);
        expect(server.controlPolled('sup')).toBe(true);
        server.closeControl('sup');
        expect((await post('/publish', 'agent')).status).toBe(UNAUTHORIZED_STATUS);
        expect((await get('/control', 'sup')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('opens without any gate registration and refuses unknown or closed tokens', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('tok-c');
        const port = await server.listen();

        expect((await read(port, 'tok-c')).status).toBe(OK_STATUS);
        expect((await read(port, 'nope')).status).toBe(UNAUTHORIZED_STATUS);
        server.raiseStop('unknown');
        server.closeControl('tok-c');
        expect((await read(port, 'tok-c')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('does not let a gate token read the control channel', async () => {
        const { server, port } = await serveGates(idle, { token: 'gate-tok', gates: [] });

        expect((await read(port, 'gate-tok')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });
});

describe('the gate server: questions (issue #226)', () => {
    const report = (id: string, text = 'Which colour?') => ({
        questionId: id,
        questions: [
            { question: text, header: 'Colour', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Red' }] },
        ],
    });
    const post = (port: number, token: string, body: unknown) =>
        fetch(`http://127.0.0.1:${port}/question`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });
    const get = (port: number, token: string, id: string) =>
        fetch(`http://127.0.0.1:${port}/question/${id}`, { headers: { authorization: `Bearer ${token}` } });

    async function opened(verdict: 'accepted' | 'refused' | 'gone' = 'accepted') {
        const forwarded: string[] = [];
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        server.openControl('tok-q', {
            ask: async (id) => {
                forwarded.push(id);
                return verdict;
            },
        });
        return { server, forwarded, port: await server.listen() };
    }

    it('records a question, answers 202 pending and forwards it once however often it repeats', async () => {
        const { server, forwarded, port } = await opened();

        const first = await post(port, 'tok-q', report('toolu_1'));
        expect(first.status).toBe(202);
        await expect(first.json()).resolves.toEqual({ state: 'pending' });
        expect((await post(port, 'tok-q', report('toolu_1'))).status).toBe(202);

        expect(forwarded).toEqual(['toolu_1']);
        expect(server.hasPendingQuestion('tok-q')).toBe(true);
        await server.close();
    });

    it('reads each state: pending, answered, cancelled — and 404 for an unknown id', async () => {
        const { server, port } = await opened();
        for (const id of ['toolu_1', 'toolu_2', 'toolu_3']) await post(port, 'tok-q', report(id, `Q ${id}?`));
        server.resolveQuestion('tok-q', 'toolu_1', { state: 'answered', answers: { 'Q toolu_1?': 'Blue' } });

        await expect((await get(port, 'tok-q', 'toolu_1')).json()).resolves.toEqual({
            state: 'answered',
            answers: { 'Q toolu_1?': 'Blue' },
        });
        await expect((await get(port, 'tok-q', 'toolu_2')).json()).resolves.toEqual({ state: 'pending' });
        await expect((await get(port, 'tok-q', 'toolu_3')).json()).resolves.toEqual({ state: 'pending' });
        server.cancelQuestions('tok-q');
        await expect((await get(port, 'tok-q', 'toolu_3')).json()).resolves.toEqual({ state: 'cancelled' });
        // A settled question is not reopened by a later answer or cancel.
        expect(server.resolveQuestion('tok-q', 'toolu_2', { state: 'answered', answers: {} })).toBe(false);
        await expect((await get(port, 'tok-q', 'toolu_2')).json()).resolves.toEqual({ state: 'cancelled' });
        expect((await get(port, 'tok-q', 'toolu_9')).status).toBe(NOT_FOUND_STATUS);
        await server.close();
    });

    it('answers 400 for a body the board would refuse, and 413 past 64 KiB', async () => {
        const { server, forwarded, port } = await opened();
        const bad = [
            'not json',
            { questionId: 'has space', questions: report('x').questions },
            { questionId: 'toolu_1', questions: [] },
            report('toolu_1', ''),
            {
                questionId: 'toolu_1',
                questions: [...report('a').questions, ...report('a').questions],
            },
            { questionId: 'toolu_1', questions: [{ ...report('a').questions[0], options: [{ label: 'One' }] }] },
        ];
        for (const body of bad) expect((await post(port, 'tok-q', body)).status).toBe(400);
        expect((await post(port, 'tok-q', report('toolu_1', 'x'.repeat(70_000)))).status).toBe(
            PAYLOAD_TOO_LARGE_STATUS
        );
        expect(forwarded).toEqual([]);
        await server.close();
    });

    it('refuses with 429 refused when the board is at its limit, and records nothing', async () => {
        const { server, port } = await opened('refused');
        const response = await post(port, 'tok-q', report('toolu_1'));
        expect(response.status).toBe(429);
        await expect(response.json()).resolves.toEqual({ state: 'refused' });
        expect((await get(port, 'tok-q', 'toolu_1')).status).toBe(NOT_FOUND_STATUS);
        await server.close();
    });

    it('refuses the sixth question of an attempt with 429', async () => {
        const { server, port } = await opened();
        for (const n of [1, 2, 3, 4, 5]) {
            expect((await post(port, 'tok-q', report(`toolu_${n}`, `Q${n}?`))).status).toBe(202);
        }
        const sixth = await post(port, 'tok-q', report('toolu_6', 'Q6?'));
        expect(sixth.status).toBe(429);
        await expect(sixth.json()).resolves.toEqual({ state: 'refused' });
        await server.close();
    });

    it('answers 401 for a gate token, an unknown token, and a token closed since', async () => {
        const { server, port } = await opened();
        server.register('gate-tok', { key: KEY, image: 'node:24', job: JOB, gates: [] });
        await post(port, 'tok-q', report('toolu_1'));

        expect((await post(port, 'gate-tok', report('toolu_1'))).status).toBe(UNAUTHORIZED_STATUS);
        expect((await get(port, 'gate-tok', 'toolu_1')).status).toBe(UNAUTHORIZED_STATUS);
        expect((await post(port, 'nope', report('toolu_1'))).status).toBe(UNAUTHORIZED_STATUS);
        server.closeControl('tok-q');
        expect((await post(port, 'tok-q', report('toolu_2'))).status).toBe(UNAUTHORIZED_STATUS);
        expect((await get(port, 'tok-q', 'toolu_1')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('counts a question POST as the runner polling, and cancels a question asked after a stop', async () => {
        const { server, forwarded, port } = await opened();
        expect(server.controlPolled('tok-q')).toBe(false);
        await post(port, 'tok-q', report('toolu_1'));
        expect(server.controlPolled('tok-q')).toBe(true);

        server.raiseStop('tok-q');
        const late = await post(port, 'tok-q', report('toolu_2', 'Q2?'));
        await expect(late.json()).resolves.toEqual({ state: 'cancelled' });
        expect(forwarded).toEqual(['toolu_1']);
        await server.close();
    });

    it('drops the record when the forward fails, so the bridge retry forwards again', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        let calls = 0;
        server.openControl('tok-q', {
            ask: async () => {
                calls += 1;
                if (calls === 1) throw new Error('board unreachable');
                return 'accepted';
            },
        });
        const port = await server.listen();

        expect((await post(port, 'tok-q', report('toolu_1'))).status).toBe(500);
        expect((await get(port, 'tok-q', 'toolu_1')).status).toBe(NOT_FOUND_STATUS);
        expect((await post(port, 'tok-q', report('toolu_1'))).status).toBe(202);
        expect(calls).toBe(2);
        await server.close();
    });
});

describe('the gate server: a repeat while the forward is in flight (issue #226)', () => {
    const body = JSON.stringify({
        questionId: 'toolu_1',
        questions: [
            {
                question: 'Which colour?',
                header: 'Colour',
                multiSelect: false,
                options: [{ label: 'Blue' }, { label: 'Red' }],
            },
        ],
    });

    it('answers the repeat as the first, so a failed forward fails both and the bridge retries', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager: idle });
        let fail: (e: Error) => void = () => {};
        let calls = 0;
        server.openControl('tok-q', {
            ask: () => {
                calls += 1;
                if (calls > 1) return Promise.resolve('accepted' as const);
                return new Promise((_resolve, reject) => {
                    fail = reject;
                });
            },
        });
        const port = await server.listen();
        const post = () =>
            fetch(`http://127.0.0.1:${port}/question`, {
                method: 'POST',
                headers: { authorization: 'Bearer tok-q' },
                body,
            });

        const first = post();
        while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
        // The server parses a POST body synchronously before it joins an in-flight id, so the first
        // parse of this body after `first` is the repeat having reached the server: a fact, not a sleep.
        const parse = vi.spyOn(JSON, 'parse');
        const repeat = post();
        try {
            while (!parse.mock.calls.some(([text]) => text === body)) {
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
        } finally {
            parse.mockRestore();
        }
        fail(new Error('board unreachable'));

        expect((await first).status).toBe(500);
        expect((await repeat).status).toBe(500);
        expect((await post()).status).toBe(202);
        expect(calls).toBe(2);
        await server.close();
    });
});

describe('the gate server: run history for the timeout note', () => {
    // A timed-out run's kill note quotes the latest ad-hoc verdicts (issue #339), so the server
    // records them as they complete: one entry per declared gate name, the latest run winning.
    it('records the latest run per gate name, and clears them on unregister', async () => {
        let call = 0;
        const manager = {
            acquire: async () => {},
            runGate: async (_key: string, name: string, _command: string) => {
                call += 1;
                return name === 'lint' ? { exitCode: 3, output: '2 problems' } : { exitCode: 0, output: 'ok' };
            },
        };
        const { server, run } = await serveGates(manager, {
            token: 'tok-hist',
            gates: [
                { name: 'test', command: 'npm test' },
                { name: 'lint', command: 'npm run lint' },
            ],
        });

        expect(server.lastRuns('tok-hist')).toEqual([]);
        await run('test');
        await run('lint');
        await run('test');
        const runs = server.lastRuns('tok-hist');
        expect(runs.map((r) => r.name)).toEqual(['test', 'lint']);
        expect(runs.find((r) => r.name === 'test')?.exitCode).toBe(0);
        expect(runs.find((r) => r.name === 'lint')?.exitCode).toBe(3);
        // Only the run of a DECLARED gate with a verdict is recorded, and each stamp is a real
        // moment the run completed — parseable, close to now.
        expect(runs.every((r) => !Number.isNaN(Date.parse(r.at)) && Date.parse(r.at) <= Date.now())).toBe(true);
        expect(call).toBe(3);

        server.unregister('tok-hist');
        expect(server.lastRuns('tok-hist')).toEqual([]);
        await server.close();
    });

    // The one channel to an agent mid-run (issue #487): a dead service's note rides every answer.
    it('carries the dead-service note in each answer until it is cleared or the token ends', async () => {
        const manager = { acquire: async () => {}, runGate: async () => ({ exitCode: 0, output: 'ok' }) };
        const served = await serveGates(manager, { token: 'tok-dead', gates: [{ name: 'test', command: 'x' }] });
        const { server } = served;
        const run = async () => (await served.run('test').then((r) => r.json())) as Record<string, unknown>;

        expect(await run()).toEqual({ exitCode: 0, output: 'ok' });
        server.setDeadServices('tok-dead', 'service "db" failed');
        expect(await run()).toEqual({ exitCode: 0, output: 'ok', deadServices: 'service "db" failed' });
        server.setDeadServices('tok-dead', null);
        expect(await run()).toEqual({ exitCode: 0, output: 'ok' });
        // An unknown token is ignored, never registered by the set.
        server.setDeadServices('tok-nobody', 'x');
        await server.close();
    });
});

describe('the gate server: body size and bind resilience', () => {
    // The endpoint is reachable from runner containers running repo-controlled instructions; an
    // unbounded body there is an OOM on the driver, which supervises every in-flight job.
    it('refuses an oversized body instead of reading it', async () => {
        const OVERSIZED_PADDING_LENGTH = 10_000;
        const { server, port } = await serveGates(idle, { token: 'tok-4' });
        const response = await fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok-4', 'content-type': 'application/json' },
            body: JSON.stringify({ gate: 'test', padding: 'x'.repeat(OVERSIZED_PADDING_LENGTH) }),
        });
        expect(response.status).toBe(PAYLOAD_TOO_LARGE_STATUS);
        await server.close();
    });

    // A failed bind must not poison the server: the next listen retries, it never answers port 0
    // forever — a driver that started with a bad GATE_LISTEN_HOST and was reconfigured would
    // otherwise hand every later gated job a gate URL nothing listens on.
    it('retries the bind after a failure instead of caching the broken server', async () => {
        const server = createGateServer({ host: '999.999.999.999', manager: idle });
        server.register('tok-5', {
            key: KEY,
            image: 'node:24',
            job: JOB,
            gates: [{ name: 'test', command: 'npm test' }],
        });

        await expect(server.listen()).rejects.toThrow();
        // The retry re-attempts a fresh bind — here still failing (same bad host), which is the
        // point: a refusal, never a silent port 0.
        await expect(server.listen()).rejects.toThrow();
        await server.close();
    });

    // The 'error' listener must stay attached past a successful bind: a server error arriving
    // later, with the listener gone, would surface as an uncaught exception and take the driver
    // down. Emitted here the way the runtime would deliver it — absorbed while a listener is
    // attached, a synchronous throw without one.
    it('keeps an error listener attached after the bind succeeds', async () => {
        const before = createdServers.length;
        const { server, port } = await serveGates(idle, { token: 'tok-late' });
        expect(port).toBeGreaterThan(0);

        const bound = createdServers.slice(before).at(-1)!;
        expect(bound.listenerCount('error')).toBe(1);
        // A late error, arriving after the bind resolved: absorbed, never thrown.
        expect(() => bound.emit('error', new Error('late failure'))).not.toThrow();
        await server.close();
    });
});

/** A Stop or Remove ends a gate where it stands: the docker exec's process dies with its environment. */
describe('cancelling a gate', () => {
    it('tears the environment down when the signal aborts mid-exec, and records no cooldown on it', async () => {
        logs.length = 0;
        let finishExec: (error: ExecError) => void = () => {};
        const execDocker = exec((args) => {
            logs.push(args);
            if (args[0] === 'exec') {
                return new Promise<ExecResult>((_resolve, reject) => {
                    finishExec = reject;
                });
            }
            if (args[0] === 'rm') finishExec(Object.assign(new Error('exit 137'), { code: 137 }));
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker });
        await manager.acquire(KEY, 'node:24', '');
        const cancel = new AbortController();

        const gate = manager.runGate(KEY, 'test', 'npm test', { signal: cancel.signal });
        await new Promise((resolve) => setTimeout(resolve, 5));
        cancel.abort();
        await gate;

        // The fence at acquire, then the cancel's teardown — the exec'd process dies with it.
        expect(logs.filter((args) => args[0] === 'rm' && args[2] === NAME)).toHaveLength(2);
        // The next acquire recreates the environment instead of reusing a dead entry.
        await manager.acquire(KEY, 'node:24', '');
        expect(logs.filter((args) => args[0] === 'run')).toHaveLength(2);
        await manager.stop();
    });

    it('runs nothing for a signal already aborted', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');

        await manager.runGate(KEY, 'test', 'npm test', { signal: AbortSignal.abort() });

        expect(logs.filter((args) => args[0] === 'exec')).toEqual([]);
        await manager.stop();
    });

    it('leaves the environment alone on an ordinary finish', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');

        await manager.runGate(KEY, 'test', 'npm test', { signal: new AbortController().signal });

        expect(logs.filter((args) => args[0] === 'rm')).toHaveLength(1); // the acquire's fence only
        await manager.stop();
    });

    // The agent's own ad-hoc runs: the runner kill never reaches them, the token's cancel does.
    it('cancels an in-flight ad-hoc run on the server, answers 409 and refuses the token after', async () => {
        let aborted = false;
        let started: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        const manager = {
            acquire: async () => {},
            runGate: (_key: string, _name: string, _command: string, { signal }: GateRunOptions = {}) =>
                new Promise<{ exitCode: number; output: string }>((resolve) => {
                    started();
                    signal?.addEventListener('abort', () => {
                        aborted = true;
                        resolve({ exitCode: 137, output: 'killed' });
                    });
                }),
        };
        const { server, run: post } = await serveGates(manager, {
            token: 'tok-cancel',
            gates: [{ name: 'test', command: 't' }],
        });

        const inFlight = post();
        await running;
        server.cancel('tok-cancel');

        expect((await inFlight).status).toBe(CONFLICT_STATUS);
        expect(aborted).toBe(true);
        // A cancelled run is no verdict: nothing for the timeout note to quote.
        expect(server.lastRuns('tok-cancel')).toEqual([]);
        expect((await post()).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });
});
