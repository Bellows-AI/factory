import { describe, expect, it, vi } from 'vitest';
import { createGateManager, createGateServer } from '../src/gates.js';
import { loadDriverConfig } from '../src/config.js';
import { gateEnvContainerName } from '../src/docker.js';

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
    const wrapped = ((handler?: Parameters<typeof actual.createServer>[0]) => {
        const created = realCreateServer(handler);
        createdServers.push(created);
        return created;
    }) as typeof actual.createServer;
    return { ...actual, createServer: wrapped };
});

const KEY = `bellows/44444444-4444-4444-8444-444444444444/.worktrees/55555555-5555-4555-8555-555555555555`;
const NAME = gateEnvContainerName(KEY);
const config = loadDriverConfig({});

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

describe('the gate environment manager', () => {
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

    it('tears the container down after the cooldown, and only then', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 5, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');
        manager.release(KEY);
        // The acquire fence above is also an `rm -f`; only counts AFTER release are teardowns.
        const atRelease = logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME).length;
        await new Promise((resolve) => setTimeout(resolve, 40));
        const afterCooldown = logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME).length;
        expect(afterCooldown).toBe(atRelease + 1);
    });

    it('cancels the teardown when the same environment is acquired again', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 5, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');
        manager.release(KEY);
        const atRelease = logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME).length;
        await manager.acquire(KEY, 'node:24', '');
        await new Promise((resolve) => setTimeout(resolve, 40));
        const afterCooldown = logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME).length;
        expect(afterCooldown).toBe(atRelease);
        await manager.stop();
    });

    it('recreates a container whose teardown already ran', async () => {
        logs.length = 0;
        const manager = createGateManager({ config, cooldownMs: 5, execDocker: recording });
        await manager.acquire(KEY, 'node:24', '');
        manager.release(KEY);
        await new Promise((resolve) => setTimeout(resolve, 40));
        await manager.acquire(KEY, 'node:24', '');
        expect(logs.filter((args) => args[0] === 'run')).toHaveLength(2);
        await manager.stop();
    });

    it('runs a gate by exec and answers its exit code with a tailed output', async () => {
        const gateExec = exec((args) => {
            if (args[0] === 'exec') {
                if (args[4] === 'pass') return { stdout: 'all green\n', stderr: '' };
                return fails(3, '2 problems\n');
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
            exitCode: 3,
            output: '2 problems',
        });
        await manager.stop();
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
            const error = new Error('killed') as Error & { killed?: boolean };
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
        expect(seenOptions.at(-1)).toEqual({ timeout: 30_000 });
        await manager.stop();
    });

    // Docker failing to exec at all — the container was torn down under the caller — is a
    // HARNESS state, not a gate verdict: it rejects with the container-gone code, which is what
    // the ad-hoc endpoint's 409 and the loop's failed-gate path both key on.
    it('rejects a gate whose container the daemon cannot exec into', async () => {
        const gone = exec((args) => {
            if (args[0] === 'exec') {
                const error = new Error('Error response from daemon: No such container') as Error & {
                    code?: number;
                };
                error.code = 125;
                return Promise.reject(error);
            }
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: gone });
        await manager.acquire(KEY, 'node:24', '');

        await expect(manager.runGate(KEY, 'test', 'npm test')).rejects.toMatchObject({ code: 125 });
        await manager.stop();
    });

    // A spawn failure — docker missing from PATH arrives as code 'ENOENT', not a number — never
    // ran a command, so it has no exit status to report: it must reject with the container-gone
    // code like every other harness state, never resolve an exit that did not happen.
    it('rejects a gate whose docker could not run at all', async () => {
        const noDocker = exec((args) => {
            if (args[0] === 'exec') {
                const error = new Error('spawn docker ENOENT') as Error & { code?: string };
                error.code = 'ENOENT';
                return Promise.reject(error);
            }
            return { stdout: '', stderr: '' };
        });
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker: noDocker });
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
        manager.release(KEY);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME)).toHaveLength(2);
    });

    // A gate whose exec outlives its environment's teardown (lost lease → release → cooldown
    // fired, or the drain) must not leave a stale timer behind: one armed on the dead entry
    // would delete the RE-CREATED environment when it fires, failing an innocent job, and hold
    // the event loop open past shutdown.
    it('does not arm a cooldown on an entry that was torn down while a gate ran', async () => {
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
        manager.release(KEY);
        await new Promise((resolve) => setTimeout(resolve, 20)); // the cooldown timer fires on the dead entry
        releaseExec();
        await expect(gate).resolves.toMatchObject({ exitCode: 0 });

        // The re-armed cooldown on the dead entry never fires: no rm beyond the fence+teardown.
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(logs.filter((args) => args[0] === 'rm' && args[1] === '-f' && args[2] === NAME)).toHaveLength(2);
    });
});

describe('the gate server', () => {
    it('runs a declared gate for a bearer token and answers the verdict', async () => {
        const seen: { key: string; name: string; command: string }[] = [];
        const manager = {
            acquire: async () => {},
            runGate: async (key: string, name: string, command: string) => {
                seen.push({ key, name, command });
                return { exitCode: 0, output: 'ok' };
            },
        };
        const server = createGateServer({ host: '127.0.0.1', manager });
        server.register('tok-1', {
            key: KEY,
            image: 'node:24',
            gates: [{ name: 'test', command: 'npm test' }],
        });
        const port = await server.listen();

        const response = await fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok-1' },
            body: JSON.stringify({ gate: 'test' }),
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ exitCode: 0, output: 'ok' });
        expect(seen).toEqual([{ key: KEY, name: 'test', command: 'npm test' }]);
        await server.close();
    });

    it('refuses an unknown token, an undeclared gate and a malformed body', async () => {
        const manager = {
            acquire: async () => {},
            runGate: async () => ({ exitCode: 0, output: '' }),
        };
        const server = createGateServer({ host: '127.0.0.1', manager });
        server.register('tok-2', {
            key: KEY,
            image: 'node:24',
            gates: [{ name: 'test', command: 'npm test' }],
        });
        const port = await server.listen();
        const url = `http://127.0.0.1:${port}/run`;
        const post = (headers: Record<string, string>, body: string) => fetch(url, { method: 'POST', headers, body });

        expect((await post({ authorization: 'Bearer nope' }, '{"gate":"test"}')).status).toBe(401);
        expect((await post({ authorization: 'Bearer tok-2' }, '{"gate":"deploy"}')).status).toBe(404);
        expect((await post({ authorization: 'Bearer tok-2' }, 'not json')).status).toBe(400);
        expect((await post({ authorization: 'Bearer tok-2' }, '{}')).status).toBe(400);
        // Only the declared name ever reaches the manager — never an arbitrary command string.
        expect((await post({ authorization: 'Bearer tok-2' }, '{"command":"rm -rf /"}')).status).toBe(400);
        await server.close();
    });

    it('answers 409 when the environment container is gone mid-run', async () => {
        const manager = {
            acquire: async () => {},
            runGate: async () => {
                const error = new Error('Error response from daemon: No such container') as Error & {
                    code?: number;
                };
                error.code = 125;
                throw error;
            },
        };
        const server = createGateServer({ host: '127.0.0.1', manager });
        server.register('tok-3', {
            key: KEY,
            image: 'node:24',
            gates: [{ name: 'test', command: 'npm test' }],
        });
        const port = await server.listen();
        const response = await fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok-3' },
            body: JSON.stringify({ gate: 'test' }),
        });
        expect(response.status).toBe(409);
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
        const server = createGateServer({ host: '127.0.0.1', manager });
        server.register('tok-enoent', {
            key: KEY,
            image: 'node:24',
            gates: [{ name: 'test', command: 'npm test' }],
        });
        const port = await server.listen();
        const response = await fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok-enoent' },
            body: JSON.stringify({ gate: 'test' }),
        });
        expect(response.status).toBe(409);
        await manager.stop();
        await server.close();
    });

    // The endpoint is reachable from runner containers running repo-controlled instructions; an
    // unbounded body there is an OOM on the driver, which supervises every in-flight job.
    it('refuses an oversized body instead of reading it', async () => {
        const manager = {
            acquire: async () => {},
            runGate: async () => ({ exitCode: 0, output: '' }),
        };
        const server = createGateServer({ host: '127.0.0.1', manager });
        server.register('tok-4', {
            key: KEY,
            image: 'node:24',
            gates: [{ name: 'test', command: 'npm test' }],
        });
        const port = await server.listen();
        const response = await fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok-4', 'content-type': 'application/json' },
            body: JSON.stringify({ gate: 'test', padding: 'x'.repeat(10_000) }),
        });
        expect(response.status).toBe(413);
        await server.close();
    });

    // A failed bind must not poison the server: the next listen retries, it never answers port 0
    // forever — a driver that started with a bad GATE_LISTEN_HOST and was reconfigured would
    // otherwise hand every later gated job a gate URL nothing listens on.
    it('retries the bind after a failure instead of caching the broken server', async () => {
        const manager = { acquire: async () => {}, runGate: async () => ({ exitCode: 0, output: '' }) };
        const server = createGateServer({ host: '999.999.999.999', manager });
        server.register('tok-5', { key: KEY, image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] });

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
        const manager = { acquire: async () => {}, runGate: async () => ({ exitCode: 0, output: '' }) };
        const before = createdServers.length;
        const server = createGateServer({ host: '127.0.0.1', manager });
        server.register('tok-late', { key: KEY, image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] });
        const port = await server.listen();
        expect(port).toBeGreaterThan(0);

        const bound = createdServers.slice(before).at(-1)!;
        expect(bound.listenerCount('error')).toBe(1);
        // A late error, arriving after the bind resolved: absorbed, never thrown.
        expect(() => bound.emit('error', new Error('late failure'))).not.toThrow();
        await server.close();
    });
});
