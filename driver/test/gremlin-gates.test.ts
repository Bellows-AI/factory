import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { gateEnvContainerName } from '../src/docker.js';
import { createGateManager, createGateServer, type GateManager } from '../src/gates.js';
import { createKubernetesGateManager } from '../src/k8s-gates.js';
import { gateEnvSecretName, jobsPath } from '../src/k8s-podspec.js';
import type { K8sRequest } from '../src/k8s-transport.js';
import { newJobState } from '../src/loop-attempt.js';
import { runDeclaredGates, type GateSession } from '../src/loop-gates.js';
import type { LoopRuntime } from '../src/loop-types.js';
import { parseDeadServicePods } from '../src/k8s-transport.js';

/**
 * Gremlin repros for the gate environment (key: gates). Every test asserts the EXPECTED behaviour
 * and fails against aae311d.
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

describe('gremlin/gates: output size', () => {
    // The real defaultExec is promisify(execFile) with only {timeout}: Node's 1 MiB maxBuffer.
    it('reports a PASSING gate that prints more than 1 MiB as passed, not as a harness failure', async () => {
        const run = promisify(execFile);
        const execDocker = (args: string[], options?: { timeout?: number }) =>
            args[0] === 'exec'
                ? (run(
                      'sh',
                      ['-c', 'head -c 2000000 /dev/zero | tr "\\000" a; exit 0'],
                      options
                  ) as Promise<ExecResult>)
                : Promise.resolve(OK);
        const manager = createGateManager({ config, cooldownMs: 1000, execDocker });
        await manager.acquire(KEY, 'node:24', '');

        const outcome = await manager
            .runGate(KEY, 'test', 'npm test --verbose')
            .catch((e: Error & { code?: number }) => ({
                exitCode: e.code ?? null,
                output: e.message,
            }));

        // Observed: rejects with code 125 "stdout maxBuffer length exceeded" — the loop reports a
        // failed gate (gate-fix queued) and the ad-hoc endpoint answers 409 "gate environment is gone".
        expect(outcome.exitCode).toBe(0);
        await manager.stop();
    });
});

describe('gremlin/gates: a timed-out gate', () => {
    it('kills the hung process with the gate, the way the kubernetes deadline kills its pod', async () => {
        const { execDocker, ops } = fakeDocker({
            exec: () => Promise.reject(Object.assign(new Error('killed'), { killed: true, stderr: '' })),
        });
        const manager = createGateManager({ config, cooldownMs: 60_000, gateTimeoutMs: 10, execDocker });
        await manager.acquire(KEY, 'node:24', '');

        expect((await manager.runGate(KEY, 'test', 'npm run dev')).exitCode).toBe(124);

        // Killing the `docker exec` CLIENT leaves `npm run dev` running in the warm container, which
        // the next gate / next round reuses. Expected: the env is torn down (or the process killed).
        // Observed: only the acquire's fence rm and nothing after the exec.
        const afterExec = ops.slice(ops.lastIndexOf(`exec ${NAME} sh`) + 1);
        expect(afterExec.some((op) => op.startsWith('rm -f') || op.startsWith('kill'))).toBe(true);
        await manager.stop();
    });
});

describe('gremlin/gates: ad-hoc cancel races', () => {
    /** A POST whose body is held back until `finish` — the agent's curl, mid-upload. */
    const slowPost = (port: number, token: string) => {
        const body = JSON.stringify({ gate: 'test' });
        let status: Promise<number> = Promise.resolve(0);
        const req = httpRequest({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/run',
            headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(body)) },
        });
        status = new Promise((resolve, reject) => {
            req.on('response', (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            });
            req.on('error', reject);
        });
        req.write(body.slice(0, 3));
        return { finish: () => req.end(body.slice(3)), status };
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
        server.register('tok', {
            key: KEY,
            image: 'node:24',
            job: JOB(LEASE_A),
            gates: [{ name: 'test', command: 't' }],
        });
        const port = await server.listen();

        const post = slowPost(port, 'tok');
        await delay(20); // the handler has authorised the token and is reading the body
        server.cancel('tok');
        post.finish();

        expect(await post.status).toBe(409);
        // Observed: 1 — the cancelled request still calls acquire (docker: `docker run`; k8s: a Secret POST).
        expect(acquires).toBe(0);
        await server.close();
    });

    it('leaves no environment behind at cooldown 0 when a cancelled request lands late', async () => {
        const { execDocker, live } = fakeDocker();
        const manager = createGateManager({ config, cooldownMs: 0, execDocker });
        const server = createGateServer({ host: '127.0.0.1', manager });
        await manager.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        server.register('tok', {
            key: KEY,
            image: 'node:24',
            job: JOB(LEASE_A),
            gates: [{ name: 'test', command: 't' }],
        });
        const port = await server.listen();

        const post = slowPost(port, 'tok');
        await delay(20);
        // The loop's stand-down: cancel the token, then the finally's release.
        server.cancel('tok');
        manager.release(KEY);
        await delay(10);
        expect(live.has(NAME)).toBe(false);
        post.finish();
        await post.status;
        await delay(10);

        // Observed: the late request re-ran `docker run`, and at cooldown 0 nothing ever arms a
        // teardown again — the container lives until the driver restarts.
        expect(live.has(NAME)).toBe(false);
        await server.close();
        await manager.stop();
    });

    it('cancels the in-flight ad-hoc run when the session is released (unregister), not only on cancel', async () => {
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
        server.register('tok', {
            key: KEY,
            image: 'node:24',
            job: JOB(LEASE_A),
            gates: [{ name: 'test', command: 't' }],
        });
        const port = await server.listen();
        void fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: JSON.stringify({ gate: 'test' }),
        }).catch(() => undefined);
        await running;

        // releaseGateSession — the finally of every attempt that was NOT stopped (a timed-out run,
        // an ordinary finish while the agent's curl was still waiting) — only unregisters.
        server.unregister('tok');

        // Observed: false — the docker exec keeps the env's serialize queue busy for up to
        // GATE_TIMEOUT_MS; on kubernetes the gate Job keeps writing the worktree during publish.
        expect(signal?.aborted).toBe(true);
        await server.close();
    });

    it('cancels the ad-hoc run when the agent that asked for it hangs up', async () => {
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
                    return new Promise(() => {});
                },
            },
        });
        server.register('tok', {
            key: KEY,
            image: 'node:24',
            job: JOB(LEASE_A),
            gates: [{ name: 'test', command: 't' }],
        });
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

        expect(signal?.aborted).toBe(true);
        await server.close();
    });
});

describe('gremlin/gates: teardown vs re-acquire', () => {
    it('a re-acquire right after a release (cooldown 0) gets a working environment', async () => {
        // The released container takes 50ms to die; the follow-up's acquire lands inside that.
        const { execDocker } = fakeDocker({ rmDelay: (n) => (n === 0 ? 50 : 0) });
        const manager = createGateManager({ config, cooldownMs: 0, execDocker });
        await manager.acquire(KEY, 'node:24', '');
        manager.release(KEY); // fire-and-forget `docker rm -f`, outside the per-key queue

        // Observed: rejects "Conflict. The container name ... is already in use" — beginGates
        // throws and the attempt is failed runner_error "gate environment could not be started";
        // in runDeclaredGates the same rejection is a failed gate (125) and gate-fix is queued.
        await expect(manager.acquire(KEY, 'node:24', '')).resolves.toBeUndefined();
        await expect(manager.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 0 });
        await manager.stop();
    });

    it('the cooldown teardown firing just before a re-acquire does not fail the next gate', async () => {
        const { execDocker } = fakeDocker({ rmDelay: (n) => (n === 0 ? 50 : 0) });
        const manager = createGateManager({ config, cooldownMs: 5, execDocker });
        await manager.acquire(KEY, 'node:24', '');
        manager.release(KEY);
        await delay(15); // cooldown fired; its rm is still in flight

        const outcome = await manager
            .acquire(KEY, 'node:24', '')
            .then(() => manager.runGate(KEY, 'test', 'npm test'))
            .catch((e: Error & { code?: number }) => ({ exitCode: e.code ?? null, output: e.message }));
        expect(outcome.exitCode).toBe(0);
        await manager.stop();
    });
});

describe('gremlin/gates: two attempts on one checkout key', () => {
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
        manager.release(KEY); // A's finally — no refcount, so B's container goes

        // Observed: exitCode 137 — a real-looking VERDICT (ad-hoc 200 / declared gate failed, gate-fix).
        await expect(gateB).resolves.toMatchObject({ exitCode: 0 });
        await manager.stop();
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

        // Observed: rejects 125 — runDeclaredGates folds it into a FAILED gate for B.
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
        m.release(KEY); // A's finally

        // Observed: deletes B's Secret (B's next gate pod sits CreateContainerConfigError until the
        // deadline → exit 124, a failed gate) and A's credential-bearing Secret is never deleted.
        expect(deleted.some((p) => p.endsWith(`/${gateEnvSecretName(JOB(LEASE_A))}`))).toBe(true);
        expect(deleted.some((p) => p.endsWith(`/${gateEnvSecretName(JOB(LEASE_B))}`))).toBe(false);
    });
});

describe('gremlin/gates: docker/kubernetes parity of concurrent runs', () => {
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

        // Observed: 2 — two `npm test`s in one worktree at once (docker's serialize() forbids it).
        expect(posts).toBe(1);
    });
});

describe('gremlin/gates: Stop during the declared gates', () => {
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

    it('honours a Stop while the per-gate re-acquire hangs (an image pull that never ends)', async () => {
        const manager: GateManager = {
            acquire: () => new Promise(() => {}),
            runGate: async () => ({ exitCode: 0, output: '' }),
            release: () => {},
            stop: async () => {},
        };
        const state = newJobState();
        const gates = runDeclaredGates(rtWith(manager), JOB(LEASE_A), session, state);
        await delay(5);
        state.stopped = true;
        state.abortNow();

        // Observed: never settles — the heartbeat keeps the lease alive and the Stop is ignored.
        const settled = await Promise.race([gates.then(() => 'settled'), delay(200).then(() => 'hung')]);
        expect(settled).toBe('settled');
    });

    it('honours a Stop while the declared gate is queued behind another run on the same env', async () => {
        let execs = 0;
        const { execDocker } = fakeDocker({
            exec: () =>
                execs++ === 0 ? new Promise<ExecResult>(() => {}) : Promise.resolve({ stdout: '', stderr: '' }),
        });
        const manager = createGateManager({ config, cooldownMs: 60_000, gateTimeoutMs: 600_000, execDocker });
        await manager.acquire(KEY, 'node:24', '');
        void manager.runGate(KEY, 'test', 'npm test'); // a previous attempt's orphaned ad-hoc run
        const state = newJobState();
        const gates = runDeclaredGates(rtWith(manager), JOB(LEASE_A), session, state);
        await delay(5);
        state.stopped = true;
        state.abortNow();

        // Observed: hung until the orphan's exec times out (GATE_TIMEOUT_MS, default 10 min): the
        // abort listener is only attached once the queued work STARTS.
        const settled = await Promise.race([gates.then(() => 'settled'), delay(200).then(() => 'hung')]);
        expect(settled).toBe('settled');
        await manager.stop();
    });
});

describe('gremlin/gates: services that never come up', () => {
    const pod = (phase: string, waiting?: string) => ({
        metadata: { name: 'svc-pod', labels: { 'factory.service': 'mongo' } },
        spec: { containers: [{ image: 'mongo:8' }] },
        status: { phase, containerStatuses: waiting ? [{ state: { waiting: { reason: waiting } } }] : [] },
    });

    it('kubernetes: a service pod stuck Pending on ImagePullBackOff is reported dead', () => {
        // docker's `docker run -d` of an unpullable image fails the run as infrastructure; on k8s the
        // pod sits Pending forever, the probe answers [], the gates fail against it and gate-fix runs.
        const dead = parseDeadServicePods(JSON.stringify({ items: [pod('Pending', 'ImagePullBackOff')] }));
        expect(dead.map((d) => d.name)).toEqual(['mongo']);
    });
});

describe('gremlin/gates: unproven claims', () => {
    // U4: release() returns before `entries.delete` when the attempt has no env Secret
    // (k8s-gates.ts:234), so an empty-env attempt's entry outlives its release.
    it('U4 kubernetes: acquire + release with an empty env body leaves no gate environment behind', async () => {
        const posts: string[] = [];
        const request: K8sRequest = async (method, path) => {
            if (method === 'POST') posts.push(path);
            if (method === 'GET' && path.startsWith(`${jobsPath('factory')}/`)) {
                return { status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) };
            }
            if (method === 'GET') return { status: 200, body: JSON.stringify({ items: [] }) };
            return { status: 201, body: '{}' };
        };
        const m = createKubernetesGateManager({ config: k8sConfig, request, sleep: async () => {} });
        await m.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        m.release(KEY);

        // Expected: the released key has no environment, exactly as after a release with a Secret.
        await expect(m.runGate(KEY, 'test', 'npm test')).rejects.toThrow(/no gate environment/);
        expect(posts).toEqual([]);
    });

    // U5 (safety pin, expected to PASS): F6 is same-driver only. Two drivers each hold their own
    // manager; on kubernetes the per-lease Secret names keep them apart, on docker the daemons.
    it('U5 kubernetes: two drivers’ managers on one checkout key never touch each other’s Secret or entry', async () => {
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
        driverA.release(KEY);
        await delay(5);

        const secretA = gateEnvSecretName(JOB(LEASE_A));
        const secretB = gateEnvSecretName(JOB(LEASE_B));
        expect(secretA).not.toBe(secretB);
        expect(deleted.some((p) => p.endsWith(`/${secretA}`))).toBe(true);
        expect(deleted.some((p) => p.endsWith(`/${secretB}`))).toBe(false);

        // B's entry survives A's release: its next gate still runs, against B's own Secret.
        await driverB.runGate(KEY, 'test', 'npm test').catch(() => undefined);
        expect(jobPosts).toHaveLength(1);
        expect(jobPosts[0]).toContain(secretB);
        expect(jobPosts[0]).not.toContain(secretA);
        await driverB.stop();
    });

    it('U5 docker: two drivers’ managers on one checkout key never touch each other’s environment', async () => {
        const dockerA = fakeDocker();
        const dockerB = fakeDocker();
        const driverA = createGateManager({ config, cooldownMs: 0, execDocker: dockerA.execDocker });
        const driverB = createGateManager({ config, cooldownMs: 0, execDocker: dockerB.execDocker });
        await driverA.acquire(KEY, 'node:24', '', JOB(LEASE_A));
        await driverB.acquire(KEY, 'node:24', '', JOB(LEASE_B));
        const bOpsBefore = dockerB.ops.length;
        driverA.release(KEY);
        await delay(5);

        expect(dockerA.live.has(NAME)).toBe(false);
        expect(dockerB.live.has(NAME)).toBe(true);
        expect(dockerB.ops.slice(bOpsBefore)).toEqual([]);
        await expect(driverB.runGate(KEY, 'test', 'npm test')).resolves.toMatchObject({ exitCode: 0 });
        await driverB.stop();
    });
});
