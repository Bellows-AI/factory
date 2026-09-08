import { execFile } from 'node:child_process';
import { rm as rmFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DriverConfig } from './config.js';
import { gateEnvArgs, gateEnvContainerName, gateExecArgs, reportTail } from './docker.js';

const run = promisify(execFile);

/**
 * The gate environment: one long-lived container per member+repo checkout, a `docker exec` per
 * gate, and a loopback HTTP server the coding agent reaches the gates through.
 *
 * Why a container that stays up rather than a container per gate: the issue asks for both halves
 * of that trade by name — gates share the agent's workspace and stay alive across a task's turns,
 * with a cooldown before teardown — and `npm install` once per turn is precisely the cost the
 * cooldown exists to avoid. The container is a sleeper (`sleep infinity`); everything that runs in
 * it arrives as an explicit `docker exec`, which is also what keeps the fence and the labels the
 * same shape as every other spawn this driver does.
 *
 * This module is still a client of nothing but docker and the loopback interface: it imports no
 * board, no database and no core, per this package's zero-dependency rule.
 */

/** What one gate run came back with. `exitCode` follows docker exec's exit status. */
export interface GateRun {
    exitCode: number | null;
    output: string;
}

type ExecDocker = (args: string[], options?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecDocker = (args, options) =>
    run('docker', args, options) as Promise<{ stdout: string; stderr: string }>;

/**
 * Docker exec's own failure code: "the CLI could not run the command in that container" — the
 * container is gone or was never there. It is a HARNESS failure, never a gate verdict, and it
 * travels as a rejection carrying this code so the two consumers can tell it from an exit 3.
 */
const CONTAINER_GONE = 125;

interface Entry {
    name: string;
    image: string;
    envBody: string;
    /** The pending teardown timer, when release() has armed one. */
    teardown: NodeJS.Timeout | null;
}

export interface GateManager {
    /**
     * Ensures the environment container for the checkout exists, cancelling any teardown already
     * scheduled for it. Idempotent: an existing container is reused as-is, env included.
     */
    acquire(key: string, image: string, envBody?: string): Promise<void>;
    /** Runs one declared gate inside the checkout's environment container. */
    runGate(key: string, name: string, command: string): Promise<GateRun>;
    /** Arms the cooldown teardown. Safe to call repeatedly; acquire cancels it. */
    release(key: string): void;
    /** Tears every environment down now — the driver drain. */
    stop(): Promise<void>;
}

export function createGateManager({
    config,
    cooldownMs,
    gateTimeoutMs = 600_000,
    execDocker = defaultExec,
}: {
    config: DriverConfig;
    cooldownMs: number;
    /** The wall-clock cap on ONE gate. A hung gate must fail the gate, not stall the verdict forever. */
    gateTimeoutMs?: number;
    execDocker?: ExecDocker;
}): GateManager {
    const entries = new Map<string, Entry>();
    /**
     * The per-checkout serialization point, held OUTSIDE `entries` on purpose: an entry exists
     * only once its container does, and two cold acquires of the same key (two queued tasks on
     * one member+repo — the concurrency-2 default makes that ordinary) would otherwise both see
     * "no entry" and race their `docker run`s on the same name.
     */
    const queues = new Map<string, Promise<unknown>>();

    const envFileFor = (key: string): string => join(tmpdir(), `factory-gateenv-${gateEnvContainerName(key)}.env`);

    const teardown = (key: string, entry: Entry): void => {
        entries.delete(key);
        void execDocker(['rm', '-f', entry.name]).catch(() => undefined);
        void rmFile(envFileFor(key)).catch(() => undefined);
    };

    /**
     * Re-arms the cooldown after activity. A no-op at cooldown 0, where teardown is
     * RELEASE-driven — arming here would remove the container between the gates of one run,
     * breaking every multi-gate checkout — and the timer is the ordinary path otherwise.
     *
     * The guard is what keeps a stale timer impossible: the entry can have been torn down (and
     * the key re-created) while this gate's exec was still running, and a timer armed on the
     * dead object would later delete the NEW environment by name and hold the event loop open
     * past shutdown. Only a live entry may arm.
     */
    const armCooldown = (key: string, entry: Entry): void => {
        if (entries.get(key) !== entry) return;
        if (cooldownMs <= 0) return;
        if (entry.teardown) clearTimeout(entry.teardown);
        entry.teardown = setTimeout(() => {
            entry.teardown = null;
            teardown(key, entry);
        }, cooldownMs);
    };

    const serialize = <T>(key: string, work: () => Promise<T>): Promise<T> => {
        const chained = (queues.get(key) ?? Promise.resolve()).then(work, work);
        queues.set(key, chained.catch(() => undefined));
        return chained;
    };

    return {
        async acquire(key, image, envBody = '') {
            const existing = entries.get(key);
            if (existing) {
                if (existing.teardown) {
                    clearTimeout(existing.teardown);
                    existing.teardown = null;
                }
                return;
            }
            await serialize(key, async () => {
                // Re-check inside the critical section: the acquire we just queued behind may
                // have created the entry this one was looking for.
                if (entries.has(key)) return;
                // The fence every spawn here shares: anything holding the name is a leftover of a
                // container whose teardown never ran (a dead driver's), and this claim exists only
                // because that one is gone.
                await execDocker(['rm', '-f', gateEnvContainerName(key)]).catch(() => undefined);
                const name = gateEnvContainerName(key);
                if (envBody) {
                    await writeFile(envFileFor(key), envBody, { mode: 0o600 });
                }
                await execDocker(gateEnvArgs(config, key, image, envBody ? envFileFor(key) : undefined));
                entries.set(key, { name, image, envBody, teardown: null });
            });
        },

        runGate(key, name, command) {
            const entry = entries.get(key);
            if (!entry) {
                return Promise.reject(
                    Object.assign(new Error(`no gate environment for ${key}`), { code: CONTAINER_GONE }),
                );
            }
            // A gate run is activity: it cancels any pending teardown, and re-arms the cooldown
            // when it finishes — the same rule a coding turn obeys, applied to the ad-hoc runs
            // that happen while the agent is still talking.
            if (entry.teardown) {
                clearTimeout(entry.teardown);
                entry.teardown = null;
            }
            return serialize(key, async () => {
                try {
                    const read = await execDocker(gateExecArgs(entry.name, command), { timeout: gateTimeoutMs });
                    return { exitCode: 0, output: reportTail(read.stdout.trim()) };
                } catch (e) {
                    const error = e as {
                        killed?: boolean;
                        code?: number | string;
                        stdout?: string;
                        stderr?: string;
                        message?: string;
                    };
                    const output = reportTail(`${error.stdout ?? ''}${error.stderr ?? ''}`.trim());
                    // The timeout kill: a genuine gate failure, reported as one — exit 124, the
                    // convention `timeout` itself uses — with the reason in the tail.
                    if (error.killed) {
                        return {
                            exitCode: 124,
                            output: output || `[driver] gate killed after ${gateTimeoutMs}ms`,
                        };
                    }
                    // Docker itself failed — the container is not there. A harness state, not a
                    // verdict: it REJECTS with the code, which is what the ad-hoc endpoint's 409
                    // and the loop's failed-gate path both key on.
                    if (error.code === CONTAINER_GONE) {
                        throw Object.assign(new Error(output || error.message || 'gate environment is gone'), {
                            code: CONTAINER_GONE,
                        });
                    }
                    // Not an exit status — docker never ran (ENOENT, EACCES). A harness state
                    // like the branch above: rejected with the code, never returned as an exit
                    // that did not happen.
                    if (typeof error.code !== 'number') {
                        throw Object.assign(new Error(output || error.message || 'docker could not be run'), {
                            code: CONTAINER_GONE,
                        });
                    }
                    return { exitCode: error.code, output: output || error.message || `exit ${error.code}` };
                } finally {
                    armCooldown(key, entry);
                }
            });
        },

        release(key) {
            const entry = entries.get(key);
            if (!entry) return;
            // Cooldown 0 means "tear down the moment the run's exits are walked" — the loop's
            // release, not a gate's finish.
            if (cooldownMs <= 0) {
                if (entry.teardown) clearTimeout(entry.teardown);
                teardown(key, entry);
                return;
            }
            armCooldown(key, entry);
        },

        async stop() {
            for (const [key, entry] of entries) {
                if (entry.teardown) clearTimeout(entry.teardown);
                teardown(key, entry);
            }
        },
    };
}

/**
 * The ad-hoc channel: a tiny HTTP server the RUNNER's agent calls to run one declared gate and
 * read its output, mid-run — "partially run tests in the environment image".
 *
 * The security posture, in one place: the endpoint listens on loopback by default (the bind
 * address is the access control, the dashboard's own rule); a call must carry a bearer token the
 * loop minted for ONE job; and the only thing a call can ask for is a gate NAME the job's own
 * `.bellows.yaml` declared — never an arbitrary command. The values travel by env file into the
 * runner, never in argv, like every credential here.
 */
export interface GateServer {
    /**
     * Registers one gated job: its minted token, the checkout key, the environment image and the
     * gates that job's `.bellows.yaml` declared. Unregistered on every exit path by the loop.
     */
    register(
        token: string,
        claim: { key: string; image: string; envBody?: string; gates: readonly { name: string; command: string }[] },
    ): void;
    unregister(token: string): void;
    /** Idempotent. Resolves with the bound port, which is what the advertised URL is built from. */
    listen(): Promise<number>;
    close(): Promise<void>;
}

export function createGateServer({
    host,
    manager,
}: {
    host: string;
    manager: Pick<GateManager, 'acquire' | 'runGate'>;
}): GateServer {
    const claims = new Map<string, { key: string; image: string; envBody: string; gates: readonly { name: string; command: string }[] }>();
    let server: Server | null = null;
    let listening: Promise<number> | null = null;

    const respond = (reply: ServerResponse, status: number, body: unknown): void => {
        reply.statusCode = status;
        reply.setHeader('content-type', 'application/json');
        reply.end(JSON.stringify(body));
    };

    /** `{"gate":"<≤64 chars>"}` — a body many times that size is an attack, not a request. */
    const BODY_LIMIT = 4096;

    const readBody = async (request: IncomingMessage): Promise<string | null> => {
        const declared = Number(request.headers['content-length'] ?? '0');
        if (Number.isFinite(declared) && declared > BODY_LIMIT) return null;
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of request) {
            total += (chunk as Buffer).length;
            if (total > BODY_LIMIT) return null;
            chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks).toString('utf8');
    };

    const handle = async (request: IncomingMessage, reply: ServerResponse): Promise<void> => {
        if (request.method !== 'POST' || request.url !== '/run') {
            return respond(reply, 404, { error: 'not found' });
        }
        const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        const claim = claims.get(auth);
        if (!claim) return respond(reply, 401, { error: 'unknown token' });

        const raw = await readBody(request);
        if (raw === null) return respond(reply, 413, { error: 'body too large' });
        let parsed: { gate?: unknown };
        try {
            parsed = JSON.parse(raw) as { gate?: unknown };
        } catch {
            return respond(reply, 400, { error: 'body must be JSON' });
        }
        if (typeof parsed.gate !== 'string' || !parsed.gate.trim()) {
            return respond(reply, 400, { error: 'gate must be a name' });
        }
        const gate = claim.gates.find((candidate) => candidate.name === parsed.gate);
        // Only a DECLARED name runs. An arbitrary command string here would make the runner's
        // agent a shell on the host through a container the driver owns — the one thing the
        // declare-then-run model exists to prevent.
        if (!gate) return respond(reply, 404, { error: `no declared gate "${parsed.gate}"` });

        try {
            await manager.acquire(claim.key, claim.image, claim.envBody);
        } catch (e) {
            return respond(reply, 500, { error: `gate environment failed to start: ${(e as Error).message}` });
        }
        try {
            const outcome = await manager.runGate(claim.key, gate.name, gate.command);
            return respond(reply, 200, outcome);
        } catch (e) {
            // CONTAINER_GONE means docker itself failed — the environment was torn down under the
            // caller. A 409 tells the agent to ask again rather than read a harness state as a
            // gate verdict; the agent's own retry re-creates the container if it is really gone.
            if ((e as { code?: number }).code === 125) {
                return respond(reply, 409, { error: 'gate environment is gone' });
            }
            return respond(reply, 500, { error: (e as Error).message });
        }
    };

    return {
        register(token, claim) {
            claims.set(token, { key: claim.key, image: claim.image, envBody: claim.envBody ?? '', gates: claim.gates });
        },
        unregister(token) {
            claims.delete(token);
        },
        listen() {
            // One promise per bind, cached: a second claim racing the first's bind awaits the
            // SAME promise instead of racing port 0 against a half-built server — and a failed
            // bind clears both, so the next call retries instead of answering port 0 forever.
            if (listening) return listening;
            const created = createServer((request, reply) => {
                void handle(request, reply).catch(() => respond(reply, 500, { error: 'internal error' }));
            });
            server = created;
            const pending = new Promise<number>((resolve, reject) => {
                // The listener stays attached past the bind: a server error arriving later would
                // otherwise surface as an uncaught exception and take the driver down. Only the
                // first error settles the promise; past the bind the handler absorbs the rest.
                let settled = false;
                created.on('error', (error) => {
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                });
                created.listen(0, host, () => {
                    settled = true;
                    const address = created.address();
                    resolve(typeof address === 'object' && address ? address.port : 0);
                });
            });
            listening = pending;
            pending.catch(() => {
                if (listening === pending) listening = null;
                if (server === created) server = null;
            });
            return listening;
        },
        close() {
            if (!server) return Promise.resolve();
            const closing = server;
            server = null;
            listening = null;
            claims.clear();
            closing.closeAllConnections();
            return new Promise((resolve) => closing.close(() => resolve()));
        },
    };
}
