import { request as httpRequest } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { gateEnvContainerName } from '../src/docker.js';
import { createGateManager, createGateServer } from '../src/gates.js';
import { createKubernetesGateManager } from '../src/k8s-gates.js';
import { gateEnvSecretName, jobsPath } from '../src/k8s-podspec.js';
import type { K8sRequest } from '../src/k8s-transport.js';

/**
 * The gate environment's owner (issue #436): release and cancel act only for the attempt the
 * environment is filed under, a cancelled or hung-up ad-hoc request leaves nothing behind, a
 * teardown is finished before a re-acquire, and kubernetes serializes runs like docker.
 */

const KEY = 'bellows/44444444-4444-4444-8444-444444444444/.worktrees/55555555-5555-4555-8555-555555555555';
const NAME = gateEnvContainerName(KEY);
const config = loadDriverConfig({});
const k8sConfig = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory', GATE_TIMEOUT_MS: '30000' });

const JOB = (lease: string): BoardJob => ({
    id: '55555555-5555-4555-8555-555555555555',
    command: 'fix the failing build',
    attempts: 1,
    leaseToken: lease,
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    masterPrompt: 'You are running inside Factory.',
    resumeSessionId: null,
    followUp: false,
    userId: '44444444-4444-4444-8444-444444444444',
    workspacePath: 'bellows/44444444-4444-4444-8444-444444444444',
});
const LEASE_A = '22222222-2222-4222-8222-222222222222';
const LEASE_B = '33333333-3333-4333-8333-333333333333';

type ExecResult = { stdout: string; stderr: string };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const OK: ExecResult = { stdout: '', stderr: '' };

/**
 * A docker daemon with state: names are live or not, `rm -f` takes `rmDelay(n)` ms for the n-th
 * removal, a second rm of a name already being removed fails the way docker does, `run` on a live
 * name is a name conflict, and `exec` on a missing name is docker's 125.
 */
function fakeDocker(options: { rmDelay?: (n: number) => number; exec?: (args: string[]) => Promise<ExecResult> } = {}) {
    const live = new Set<string>();
    const removing = new Set<string>();
    const ops: string[] = [];
    let removals = 0;
    const execDocker = async (args: string[]): Promise<ExecResult> => {
        ops.push(args[0] === 'run' ? 'run' : args.slice(0, 3).join(' '));
        if (args[0] === 'rm') {
            const name = args[2]!;
            if (!live.has(name)) return OK;
            if (removing.has(name)) {
                throw Object.assign(new Error(`removal of container ${name} is already in progress`), { code: 1 });
            }
            removing.add(name);
            await delay(options.rmDelay?.(removals++) ?? 0);
            live.delete(name);
            removing.delete(name);
            return OK;
        }
        if (args[0] === 'run') {
            const name = args[args.indexOf('--name') + 1]!;
            if (live.has(name)) {
                throw Object.assign(new Error(`Conflict. The container name "/${name}" is already in use`), {
                    code: 125,
                });
            }
            live.add(name);
            return OK;
        }
        if (args[0] === 'exec') {
            if (!live.has(args[1]!) || removing.has(args[1]!)) {
                throw Object.assign(new Error('No such container'), { code: 125, stderr: 'No such container' });
            }
            return options.exec ? options.exec(args) : { stdout: 'ok', stderr: '' };
        }
        return OK;
    };
    return { execDocker, live, ops };
}

describe('gate ownership: ad-hoc cancel races', () => {
    /** A POST whose body is held back until `finish` — the agent's curl, mid-upload. */
    const slowPost = (port: number, token: string) => {
        const body = JSON.stringify({ gate: 'test' });
        const req = httpRequest({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/run',
            headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(body)) },
        });
        const status = new Promise<number>((resolve, reject) => {
            req.on('response', (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            });
            req.on('error', reject);
        });
        req.write(body.slice(0, 3));
        return { finish: () => req.end(body.slice(3)), status };
    };
    const claim = {
        key: KEY,
        image: 'node:24',
        job: JOB(LEASE_A),
        gates: [{ name: 'test', command: 't' }],
    };

    /** A server whose gate never answers; `signal()` is the one its run was given. */
    const hungServer = () => {
        let signal: AbortSignal | undefined;
        let started: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        const server = createGateServer({
            host: '127.0.0.1',
            manager: {
                acquire: async () => {},
                runGate: (_k, _n, _c, s) => {
                    signal = s;
                    started();
                    return new Promise(() => {}); // a 10-minute suite
                },
            },
        });
        return { server, running, signal: () => signal };
    };

    it('does not acquire (re-create) the environment for a request whose body lands after cancel', async () => {
        let acquires = 0;
        const server = createGateServer({
            host: '127.0.0.1',
            manager: {
                acquire: async () => {
                    acquires += 1;
                },
                runGate: async () => ({ exitCode: 0, output: '' }),
            },
        });
        server.register('tok', claim);
        const port = await server.listen();

        const post = slowPost(port, 'tok');
        await delay(20); // the handler has authorised the token and is reading the body
        server.cancel('tok');
        post.finish();

        expect(await post.status).toBe(409);
        expect(acquires).toBe(0);
        await server.close();
    });

    it('leaves no environment behind at cooldown 0 when a cancelled request lands late', async () => {
        const { execDocker, live } = fakeDocker();
        const manager = createGateManager({ config, cooldownMs: 0, execDocker });
        const server = createGateServer({ host: '127.0.0.1', manager });
        await manager.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        server.register('tok', claim);
        const port = await server.listen();

        const post = slowPost(port, 'tok');
        await delay(20);
        // The loop's stand-down: cancel the token, then the finally's release.
        server.cancel('tok');
        manager.release(KEY, JOB(LEASE_A));
        await delay(10);
        expect(live.has(NAME)).toBe(false);
        post.finish();
        await post.status;
        await delay(10);

        expect(live.has(NAME)).toBe(false);
        await server.close();
        await manager.stop();
    });

    it('cancels the in-flight ad-hoc run when the session is released (unregister)', async () => {
        const { server, running, signal } = hungServer();
        server.register('tok', claim);
        const port = await server.listen();
        void fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: JSON.stringify({ gate: 'test' }),
        }).catch(() => undefined);
        await running;

        server.unregister('tok');

        expect(signal()?.aborted).toBe(true);
        await server.close();
    });

    it('cancels the ad-hoc run when the agent that asked for it hangs up', async () => {
        const { server, running, signal } = hungServer();
        server.register('tok', claim);
        const port = await server.listen();
        const client = new AbortController();
        void fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: JSON.stringify({ gate: 'test' }),
            signal: client.signal,
        }).catch(() => undefined);
        await running;

        client.abort(); // the runner was killed (timeout) — its curl is gone
        await delay(20);

        expect(signal()?.aborted).toBe(true);
        await server.close();
    });
});

describe('gate ownership: teardown vs re-acquire', () => {
    it('a re-acquire right after a release (cooldown 0) gets a working environment', async () => {
        // The released container takes 50ms to die; the follow-up's acquire lands inside that.
        const { execDocker } = fakeDocker({ rmDelay: (n) => (n === 0 ? 50 : 0) });
        const manager = createGateManager({ config, cooldownMs: 0, execDocker });
        await manager.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        manager.release(KEY, JOB(LEASE_A));

        await expect(manager.acquire(KEY, 'node:24', '', JOB(LEASE_B))).resolves.toBeUndefined();
        await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 0 });
        await manager.stop();
    });

    it('the cooldown teardown firing just before a re-acquire does not fail the next gate', async () => {
        const { execDocker } = fakeDocker({ rmDelay: (n) => (n === 0 ? 50 : 0) });
        const manager = createGateManager({ config, cooldownMs: 5, execDocker });
        await manager.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        manager.release(KEY, JOB(LEASE_A));
        await delay(15); // cooldown fired; its rm is still in flight

        await manager.acquire(KEY, 'node:24', '', JOB(LEASE_B));
        await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 0 });
        await manager.stop();
    });
});

describe('gate ownership: two attempts on one checkout key', () => {
    it('docker: attempt A releasing (cooldown 0) does not kill attempt B’s gate mid-run', async () => {
        // An exec that notices its container vanishing under it dies the way docker exec does: 137.
        const docker = fakeDocker({
            exec: async (args) => {
                await delay(20);
                if (!docker.live.has(args[1]!)) {
                    throw Object.assign(new Error('exit 137'), { code: 137, stdout: '', stderr: '' });
                }
                return { stdout: 'ok', stderr: '' };
            },
        });
        const manager = createGateManager({ config, cooldownMs: 0, execDocker: docker.execDocker });
        await manager.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        await manager.acquire(KEY, 'node:24', '', JOB(LEASE_B)); // reclaimed attempt, same root worktree
        const gateB = manager.runGate(KEY, 'test', 'npm test'); // B's gate is running
        await delay(5);
        manager.release(KEY, JOB(LEASE_A)); // A's finally

        await expect(gateB).resolves.toMatchObject({ exitCode: 0 });
        manager.release(KEY, JOB(LEASE_B));
        await manager.stop();
        expect(docker.live.has(NAME)).toBe(false);
    });

    it('docker: cancelling attempt A’s gate does not fail attempt B’s gate queued behind it', async () => {
        let finishA: () => void = () => {};
        let execs = 0;
        const { execDocker } = fakeDocker({
            exec: () =>
                execs++ === 0
                    ? new Promise<ExecResult>((resolve) => {
                          finishA = () => resolve({ stdout: '', stderr: '' });
                      })
                    : Promise.resolve({ stdout: 'ok', stderr: '' }),
        });
        const manager = createGateManager({ config, cooldownMs: 60_000, execDocker });
        await manager.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        const cancelA = new AbortController();
        const gateA = manager.runGate(KEY, 'test', 'npm test', cancelA.signal);
        await delay(5);
        await manager.acquire(KEY, 'node:24', '', JOB(LEASE_B)); // fast path: entry exists
        const gateB = manager.runGate(KEY, 'test', 'npm test');
        cancelA.abort(); // A's lease is lost
        finishA();
        await gateA.catch(() => undefined);

        await expect(gateB).resolves.toMatchObject({ exitCode: 0 });
        await manager.stop();
    });

    it('kubernetes: attempt A’s release deletes A’s env Secret, not attempt B’s', async () => {
        const deleted: string[] = [];
        const request: K8sRequest = async (method, path) => {
            if (method === 'DELETE') deleted.push(path);
            return { status: 201, body: '{}' };
        };
        const m = createKubernetesGateManager({ config: k8sConfig, request, sleep: async () => {} });
        await m.acquire(KEY, 'node:24', 'A=1\n', JOB(LEASE_A));
        await m.acquire(KEY, 'node:24', 'A=1\n', JOB(LEASE_B));
        m.release(KEY, JOB(LEASE_A)); // A's finally

        expect(deleted.some((p) => p.endsWith(`/${gateEnvSecretName(JOB(LEASE_A))}`))).toBe(true);
        expect(deleted.some((p) => p.endsWith(`/${gateEnvSecretName(JOB(LEASE_B))}`))).toBe(false);

        // B's entry survives A's release, and B's own release deletes B's Secret.
        m.release(KEY, JOB(LEASE_B));
        expect(deleted.some((p) => p.endsWith(`/${gateEnvSecretName(JOB(LEASE_B))}`))).toBe(true);
    });
});

describe('gate setup: kubernetes runs it as its own Job once per attempt', () => {
    const WITH_SETUP: BoardJob = { ...JOB(LEASE_A), gates: { image: 'node:24', setup: 'npm ci', gates: [] } };

    /** Every created gate Job's command, in order; the pod list answers `setupExit` for the setup Job. */
    const fakeCluster = (setupExit: () => number) => {
        const commands: string[] = [];
        let lastCommand = '';
        const request: K8sRequest = async (method, path, body) => {
            if (method === 'POST' && path === jobsPath('factory')) {
                const spec = body as { spec: { template: { spec: { containers: { command: string[] }[] } } } };
                lastCommand = spec.spec.template.spec.containers[0]?.command[2] ?? '';
                commands.push(lastCommand);
                return { status: 201, body: '{}' };
            }
            if (method === 'GET' && path.startsWith(`${jobsPath('factory')}/`)) {
                return { status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) };
            }
            if (method === 'GET' && path.includes('/log')) return { status: 200, body: 'log' };
            if (method === 'GET') {
                const exitCode = lastCommand === 'npm ci' ? setupExit() : 0;
                const pod = {
                    metadata: { name: 'p' },
                    status: { containerStatuses: [{ state: { terminated: { exitCode } } }] },
                };
                return { status: 200, body: JSON.stringify({ items: [pod] }) };
            }
            return { status: 201, body: '{}' };
        };
        return { request, commands };
    };

    it('runs setup before the first gate only, across the per-gate re-acquires', async () => {
        const cluster = fakeCluster(() => 0);
        const m = createKubernetesGateManager({ config: k8sConfig, request: cluster.request, sleep: async () => {} });
        await m.acquire(KEY, 'node:24', '', WITH_SETUP);
        await m.runGate(KEY, 'test', 'npm test');
        await m.acquire(KEY, 'node:24', '', WITH_SETUP);
        await m.runGate(KEY, 'lint', 'npm run lint');

        expect(cluster.commands).toEqual(['npm ci', 'npm test', 'npm run lint']);
    });

    it('answers a failed setup as setupFailed and does not run the gate', async () => {
        const SETUP_EXIT_CODE = 9;
        const cluster = fakeCluster(() => SETUP_EXIT_CODE);
        const m = createKubernetesGateManager({ config: k8sConfig, request: cluster.request, sleep: async () => {} });
        await m.acquire(KEY, 'node:24', '', WITH_SETUP);

        await expect(m.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({
            exitCode: SETUP_EXIT_CODE,
            setupFailed: true,
        });
        expect(cluster.commands).toEqual(['npm ci']);
    });
});

describe('gate ownership: docker/kubernetes parity of concurrent runs', () => {
    it('kubernetes serializes two gate runs on one checkout, as docker does', async () => {
        let posts = 0;
        const request: K8sRequest = async (method, path) => {
            if (method === 'POST' && path === jobsPath('factory')) posts += 1;
            if (method === 'GET' && path.startsWith(`${jobsPath('factory')}/`)) {
                return { status: 200, body: JSON.stringify({ status: { active: 1 } }) };
            }
            if (method === 'GET') return { status: 200, body: JSON.stringify({ items: [] }) };
            return { status: 201, body: '{}' };
        };
        const m = createKubernetesGateManager({ config: k8sConfig, request, sleep: () => delay(2) });
        await m.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        const stop = new AbortController();
        void m.runGate(KEY, 'test', 'npm test', stop.signal).catch(() => undefined); // the orphaned ad-hoc run
        void m.runGate(KEY, 'test', 'npm test', stop.signal).catch(() => undefined); // the declared gate
        await delay(30);
        stop.abort();

        expect(posts).toBe(1);
    });
});

describe('gate ownership: pins', () => {
    it('kubernetes: acquire + release with an empty env body leaves no gate environment behind', async () => {
        const posts: string[] = [];
        const request: K8sRequest = async (method, path) => {
            if (method === 'POST') posts.push(path);
            return { status: 201, body: '{}' };
        };
        const m = createKubernetesGateManager({ config: k8sConfig, request, sleep: async () => {} });
        await m.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        m.release(KEY, JOB(LEASE_A));

        await expect(m.runGate(KEY, 'test', 'npm test')).rejects.toThrow(/no gate environment/);
        expect(posts).toEqual([]);
    });

    it('kubernetes: two drivers’ managers on one checkout key never touch each other’s Secret or entry', async () => {
        const deleted: string[] = [];
        const jobPosts: string[] = [];
        const request: K8sRequest = async (method, path, body) => {
            if (method === 'DELETE') deleted.push(path);
            if (method === 'POST' && path === jobsPath('factory')) jobPosts.push(JSON.stringify(body));
            if (method === 'GET' && path.startsWith(`${jobsPath('factory')}/`)) {
                return { status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) };
            }
            if (method === 'GET') return { status: 200, body: JSON.stringify({ items: [] }) };
            return { status: 201, body: '{}' };
        };
        const driverA = createKubernetesGateManager({ config: k8sConfig, request, sleep: async () => {} });
        const driverB = createKubernetesGateManager({ config: k8sConfig, request, sleep: async () => {} });
        await driverA.acquire(KEY, 'node:24', 'A=1\n', JOB(LEASE_A));
        await driverB.acquire(KEY, 'node:24', 'B=1\n', JOB(LEASE_B));
        driverA.release(KEY, JOB(LEASE_A));
        await delay(5);

        const secretA = gateEnvSecretName(JOB(LEASE_A));
        const secretB = gateEnvSecretName(JOB(LEASE_B));
        expect(secretA).not.toBe(secretB);
        expect(deleted.some((p) => p.endsWith(`/${secretA}`))).toBe(true);
        expect(deleted.some((p) => p.endsWith(`/${secretB}`))).toBe(false);

        await driverB.runGate(KEY, 'test', 'npm test').catch(() => undefined);
        expect(jobPosts).toHaveLength(1);
        expect(jobPosts[0]).toContain(secretB);
        expect(jobPosts[0]).not.toContain(secretA);
        await driverB.stop();
    });

    it('docker: two drivers’ managers on one checkout key never touch each other’s environment', async () => {
        const dockerA = fakeDocker();
        const dockerB = fakeDocker();
        const driverA = createGateManager({ config, cooldownMs: 0, execDocker: dockerA.execDocker });
        const driverB = createGateManager({ config, cooldownMs: 0, execDocker: dockerB.execDocker });
        await driverA.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        await driverB.acquire(KEY, 'node:24', '', JOB(LEASE_B));
        const bOpsBefore = dockerB.ops.length;
        driverA.release(KEY, JOB(LEASE_A));
        await delay(5);

        expect(dockerA.live.has(NAME)).toBe(false);
        expect(dockerB.live.has(NAME)).toBe(true);
        expect(dockerB.ops.slice(bOpsBefore)).toEqual([]);
        await expect(driverB.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 0 });
        await driverB.stop();
    });
});
