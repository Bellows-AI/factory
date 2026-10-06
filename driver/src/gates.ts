import { execFile } from 'node:child_process';
import { rm as rmFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { gateEnvArgs, gateEnvContainerName, gateExecArgs } from './docker.js';
import { startEnvContainer } from './docker-runner-support.js';
import { reportTail } from './runner.js';
import { CONTAINER_GONE } from './exec-codes.js';
import type { GateRunNote } from './timeout-note.js';
import { networkName } from './services.js';
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from './http.js';

const run = promisify(execFile);

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_SERVER_ERROR = 500;
/** What a gate cancelled before it started answers — discarded by the loop that cancelled it. */
const CANCELLED_EXIT_CODE = 130;
/** execFile's own code when a child's output outgrew `maxBuffer` — the child is killed. */
const STDIO_MAXBUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
/** A passing suite can be verbose; execFile's 1 MiB default is far below what one prints. */
const GATE_OUTPUT_MAX_BUFFER_BYTES = 268_435_456;
/** What a gate whose output outgrew the buffer reports: a verdict, not a missing container. */
const OUTPUT_OVERFLOW_EXIT_CODE = 1;

/**
 * The gate environment: one long-lived container per task worktree, a `docker exec` per
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
    /** True when the environment's `setup` command failed: the gate itself never ran. */
    setupFailed?: true;
}

type ExecDocker = (
    args: string[],
    options?: { timeout?: number; maxBuffer?: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecDocker = (args, options) =>
    run('docker', args, options) as Promise<{ stdout: string; stderr: string }>;

/**
 * Docker exec's own failure code: "the CLI could not run the command in that container" — the
 * container is gone or was never there. It is a HARNESS failure, never a gate verdict, and it
 * travels as a rejection carrying this code so the two consumers can tell it from an exit 3.
 * Exported because the kubernetes manager rejects with the same code for the same meaning —
 * "the harness could not run the gate", which the loop reports as the failed gate it is. The
 * constant lives in exec-codes.ts (a leaf) — see its comment for why gates.ts must not be the
 * module others import it from.
 */

interface Entry {
    name: string;
    image: string;
    envBody: string;
    /** The `.bellows.yaml` setup command, until it has succeeded once in this container. */
    pendingSetup: string | null;
    /** The pending teardown timer, when release() has armed one. */
    teardown: NodeJS.Timeout | null;
    /** The attempt the newest acquire filed — its services network is the one gates must reach. */
    job: BoardJob | null;
    /** The services network this container has joined, so each attempt connects once. */
    network: string | null;
}

/**
 * The attempt one `acquire` is for. The job is the context the kubernetes manager files gate runs
 * under (labels, names, its own per-run env Secret); the docker manager keys the container off the
 * checkout and uses the job only to join the attempt's services network before a gate runs. An
 * aborted `signal` (the attempt's stand-down) cancels the environment's start, and the acquire
 * rejects.
 */
export interface GateAttempt {
    job: BoardJob;
    signal?: AbortSignal;
}

export interface GateManager {
    /**
     * Ensures the environment for the checkout exists, cancelling any teardown already
     * scheduled for it. Idempotent: an existing environment is reused as-is, env included.
     * The attempt's `gates.setup` is run once per environment, lazily before its first gate (a gate
     * answers `setupFailed` when it fails), so an environment no gate ever uses pays nothing.
     */
    acquire(key: string, image: string, envBody?: string, attempt?: GateAttempt): Promise<void>;
    /**
     * Runs one declared gate inside the checkout's environment container. An abort of `signal`
     * cancels the gate where it stands — its process killed, its kubernetes Job deleted — and
     * the run answers whatever the cancellation left; the caller discards it.
     */
    runGate(key: string, name: string, command: string, signal?: AbortSignal): Promise<GateRun>;
    /**
     * Arms the cooldown teardown. Safe to call repeatedly; acquire cancels it. The job is the
     * releaser: a no-op unless it is the attempt the environment is currently filed under — a
     * reclaimed attempt's late release must not tear down the attempt that replaced it.
     */
    release(key: string, job: BoardJob): void;
    /** Tears every environment down now — the driver drain. */
    stop(): Promise<void>;
}

interface DockerExecError {
    killed?: boolean;
    code?: number | string;
    stdout?: string;
    stderr?: string;
    message?: string;
}

/**
 * Turns a failed `docker exec` into either a gate verdict (timeout, or the command's own exit
 * code) or a rejection carrying CONTAINER_GONE — the harness-vs-verdict split `runGate` and the
 * ad-hoc endpoint both key on.
 */
function gateRunFromExecError(error: DockerExecError, gateTimeoutMs: number): GateRun {
    const output = reportTail(`${error.stdout ?? ''}${error.stderr ?? ''}`.trim());
    // The timeout kill: a genuine gate failure, reported as one — exit 124, the convention
    // `timeout` itself uses — with the reason in the tail.
    if (error.killed) {
        return { exitCode: 124, output: output || `[driver] gate killed after ${gateTimeoutMs}ms` };
    }
    // The output outgrew the buffer and execFile killed the client: the gate's own verdict,
    // never "the container is gone".
    if (error.code === STDIO_MAXBUFFER_CODE) {
        return {
            exitCode: OUTPUT_OVERFLOW_EXIT_CODE,
            output: output || `[driver] gate output exceeded ${GATE_OUTPUT_MAX_BUFFER_BYTES} bytes`,
        };
    }
    // Docker itself failed — the container is not there. A harness state, not a verdict: it
    // REJECTS with the code, which is what the ad-hoc endpoint's 409 and the loop's failed-gate
    // path both key on.
    if (error.code === CONTAINER_GONE) {
        throw Object.assign(new Error(output || error.message || 'gate environment is gone'), {
            code: CONTAINER_GONE,
        });
    }
    // Not an exit status — docker never ran (ENOENT, EACCES). A harness state like the branch
    // above: rejected with the code, never returned as an exit that did not happen.
    if (typeof error.code !== 'number') {
        throw Object.assign(new Error(output || error.message || 'docker could not be run'), {
            code: CONTAINER_GONE,
        });
    }
    return { exitCode: error.code, output: output || error.message || `exit ${error.code}` };
}

/** One `docker exec` of a script, answered as a verdict (or a CONTAINER_GONE rejection). */
async function execInContainer({
    execDocker,
    name,
    script,
    gateTimeoutMs,
    onKilled,
}: {
    execDocker: ExecDocker;
    name: string;
    script: string;
    gateTimeoutMs: number;
    /** Called when the exec client was killed (timeout, output overflow) — the script lives on. */
    onKilled: () => void;
}): Promise<GateRun> {
    try {
        const read = await execDocker(gateExecArgs(name, script), {
            timeout: gateTimeoutMs,
            maxBuffer: GATE_OUTPUT_MAX_BUFFER_BYTES,
        });
        return { exitCode: 0, output: reportTail(read.stdout.trim()) };
    } catch (e) {
        const error = e as DockerExecError;
        // The kill took the `docker exec` client only: the gate's process lives on in the warm
        // container, so the environment goes, as it does for a cancel.
        if (error.killed || error.code === STDIO_MAXBUFFER_CODE) onKilled();
        return gateRunFromExecError(error, gateTimeoutMs);
    }
}

const newEntry = (name: string, image: string, envBody: string, job: BoardJob | null): Entry => ({
    name,
    image,
    envBody,
    pendingSetup: job?.gates?.setup ?? null,
    teardown: null,
    job,
    network: null,
});

/**
 * Runs the container's pending setup, then the gate. Setup is once per container: a failed one
 * stays pending, so the next gate retries it, and the failing gate never runs.
 */
async function setupThenGate(
    entry: Pick<Entry, 'pendingSetup'>,
    command: string,
    exec: (script: string) => Promise<GateRun>
): Promise<GateRun> {
    if (entry.pendingSetup) {
        const setupRun = await exec(entry.pendingSetup);
        if (setupRun.exitCode !== 0) return { ...setupRun, setupFailed: true };
        entry.pendingSetup = null;
    }
    return exec(command);
}

/**
 * The per-checkout serialization point, held OUTSIDE the manager's entries on purpose: an entry
 * exists only once its container does, and two cold acquires of the same key (two queued tasks on
 * one member+repo — the concurrency-2 default makes that ordinary) would otherwise both see
 * "no entry" and race their `docker run`s on the same name. Gate runs share it, docker and
 * kubernetes alike: two suites in one worktree give flaky verdicts.
 */
export function keyQueue(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
    const queues = new Map<string, Promise<unknown>>();
    return (key, work) => {
        const chained = (queues.get(key) ?? Promise.resolve()).then(work, work);
        queues.set(
            key,
            chained.catch(() => undefined)
        );
        return chained;
    };
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
    const envFileFor = (key: string): string => join(tmpdir(), `factory-gateenv-${gateEnvContainerName(key)}.env`);

    /**
     * The removal still in flight per key. Not run through `serialize`: a cancel tears the
     * environment down to kill the gate holding that queue, so it would wait on itself. The
     * acquire waits on it instead — a re-create must not meet the name or the env file of the
     * environment still being removed.
     */
    const removals = new Map<string, Promise<void>>();

    const teardown = (key: string, entry: Entry): void => {
        entries.delete(key);
        const removal: Promise<void> = Promise.all([
            execDocker(['rm', '-f', entry.name]).catch(() => undefined),
            rmFile(envFileFor(key)).catch(() => undefined),
        ]).then(() => {
            if (removals.get(key) === removal) removals.delete(key);
        });
        removals.set(key, removal);
    };

    /** An entry the job does not own is another attempt's: its release and cancel are no-ops. */
    const ownedBy = (entry: Entry, job: BoardJob | null): boolean =>
        !entry.job || !job || entry.job.leaseToken === job.leaseToken;

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

    const serialize = keyQueue();

    /**
     * Joins the attempt's services network, so a gate reaches `.bellows.yaml`'s services by name
     * the way the runner does. Once per attempt: the network is named after the lease. A job with
     * no services has no network, and the refused connect is left for the next gate to retry —
     * a gate with nothing to reach is not a harness failure.
     */
    const joinServices = async (entry: Entry): Promise<void> => {
        if (!config.servicesEnabled || !entry.job) return;
        const network = networkName(entry.job);
        if (entry.network === network) return;
        try {
            await execDocker(['network', 'connect', network, entry.name]);
            entry.network = network;
        } catch {
            // No services network for this attempt — nothing to join.
        }
    };

    return {
        async acquire(key, image, envBody = '', attempt?: GateAttempt) {
            const job = attempt?.job;
            const existing = entries.get(key);
            if (existing) {
                if (job) existing.job = job;
                if (existing.teardown) {
                    clearTimeout(existing.teardown);
                    existing.teardown = null;
                }
                return;
            }
            await serialize(key, async () => {
                // Re-check inside the critical section: the acquire we just queued behind may
                // have created the entry this one was looking for.
                const queued = entries.get(key);
                if (queued) {
                    if (job) queued.job = job;
                    return;
                }
                await removals.get(key);
                // The fence every spawn here shares: anything holding the name is a leftover of a
                // container whose teardown never ran (a dead driver's), and this claim exists only
                // because that one is gone.
                await execDocker(['rm', '-f', gateEnvContainerName(key)]).catch(() => undefined);
                const name = gateEnvContainerName(key);
                if (envBody) await writeFile(envFileFor(key), envBody, { mode: 0o600 });
                const args = gateEnvArgs(config, key, image, envBody ? envFileFor(key) : undefined);
                await startEnvContainer(execDocker, name, args, attempt?.signal);
                entries.set(key, newEntry(name, image, envBody, job ?? null));
            });
        },

        // `name` names the gate, and this manager addresses the environment by CHECKOUT KEY —
        // one warm container per checkout, every gate exec'd into it — so the gate's own name
        // never reaches the transport here. The kubernetes manager does use it: a gate run is a
        // Job there, and the name becomes part of the Job's.
        runGate(key, _name, command, signal) {
            const entry = entries.get(key);
            if (!entry) {
                return Promise.reject(
                    Object.assign(new Error(`no gate environment for ${key}`), { code: CONTAINER_GONE })
                );
            }
            // A gate run is activity: it cancels any pending teardown, and re-arms the cooldown
            // when it finishes — the same rule a coding turn obeys, applied to the ad-hoc runs
            // that happen while the agent is still talking.
            if (entry.teardown) {
                clearTimeout(entry.teardown);
                entry.teardown = null;
            }
            // A cancelled gate: killing the `docker exec` client leaves its process running in
            // the container, so the environment itself goes — the next acquire recreates it.
            // Unless the entry has since passed to another attempt, whose gates share it.
            const owner = entry.job;
            const cancel = (): void => {
                if (entries.get(key) !== entry || !ownedBy(entry, owner)) return;
                if (entry.teardown) clearTimeout(entry.teardown);
                teardown(key, entry);
            };
            const cancelled: GateRun = { exitCode: CANCELLED_EXIT_CODE, output: '[driver] gate cancelled' };
            if (signal?.aborted) return Promise.resolve(cancelled);
            const queued = serialize(key, async (): Promise<GateRun> => {
                if (signal?.aborted) return cancelled;
                signal?.addEventListener('abort', cancel, { once: true });
                const exec = (script: string): Promise<GateRun> =>
                    execInContainer({ execDocker, name: entry.name, script, gateTimeoutMs, onKilled: cancel });
                try {
                    await joinServices(entry);
                    return await setupThenGate(entry, command, exec);
                } finally {
                    signal?.removeEventListener('abort', cancel);
                    armCooldown(key, entry);
                }
            });
            if (!signal) return queued;
            // A Stop while the gate still waits its turn answers at once — the run ahead can hold
            // the queue for the whole gate timeout; the queued work itself bails when it starts.
            let onAbort = (): void => {};
            const stoppedWhileQueued = new Promise<GateRun>((resolve) => {
                onAbort = () => resolve(cancelled);
                signal.addEventListener('abort', onAbort, { once: true });
            });
            return Promise.race([queued, stoppedWhileQueued]).finally(() =>
                signal.removeEventListener('abort', onAbort)
            );
        },

        release(key, job) {
            const entry = entries.get(key);
            if (!entry || !ownedBy(entry, job)) return;
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
            await Promise.all(removals.values());
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
/** One gated job's registration with the ad-hoc endpoint. */
export interface GateClaim {
    key: string;
    image: string;
    envBody?: string;
    job: BoardJob;
    gates: readonly { name: string; command: string }[];
    /** The dead-service note the loop's sampler last set (issue #487); set on the stored claim, never at register. */
    deadServices?: string | undefined;
}

export interface GateServer {
    /**
     * Registers one gated job: its minted token, the checkout key, the environment image, the
     * gates that job's `.bellows.yaml` declared, and the job itself — the attempt context every
     * acquire needs (the kubernetes manager refuses one without it). Unregistered on every exit
     * path by the loop.
     */
    register(token: string, claim: GateClaim): void;
    /**
     * Ends the token: no new ad-hoc run, and every one of it still in flight is cancelled (the
     * manager kills its process or deletes its Job) — a finished attempt must not leave a gate
     * writing its worktree. Killing the runner does not stop a gate the agent asked for.
     */
    unregister(token: string): void;
    /** A stop, lost lease or Remove: the same as `unregister`, named for the loop's intent. */
    cancel(token: string): void;
    /**
     * The latest ad-hoc run per declared gate name, as the server recorded it completing (issue
     * #339) — what a timed-out run's kill note quotes as "the last gate verdicts". A harness
     * failure (409/500) is not a verdict and records nothing; unregister clears.
     */
    lastRuns(token: string): readonly GateRunNote[];
    /**
     * Sets the dead-service note (issue #487) every later ad-hoc answer of this token carries as
     * `deadServices` — the one channel to an agent mid-run. Null clears it; an unknown token does nothing.
     */
    setDeadServices(token: string, note: string | null): void;
    /**
     * Opens the run-control channel for one attempt: `GET /control` under this token answers
     * `{ stop }`, false until `raiseStop`. Independent of any gate registration — every launched
     * attempt gets one, gated or not. Idempotent.
     */
    openControl(token: string): void;
    /**
     * Whether a runner has read this control token at least once. A stop is cooperative only when
     * something is listening: an unpolled token (an old image, an unreachable endpoint) is killed
     * at once instead of waiting out the grace.
     */
    controlPolled(token: string): boolean;
    /** Raises the stop on an open control token; repeated calls and unknown tokens do nothing. */
    raiseStop(token: string): void;
    /** Ends the control token: the runner's poller gets 401 from here on. */
    closeControl(token: string): void;
    /** Idempotent. Resolves with the bound port, which is what the advertised URL is built from. */
    listen(): Promise<number>;
    close(): Promise<void>;
}

/** The run-control poll route the runner's stop poller reads (docker/*-executor/stop-poller.cjs). */
export const CONTROL_PATH = '/control';

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

type GateRequest = { ok: true; gate: string } | { ok: false; status: number; error: string };

/** Reads and validates the ad-hoc endpoint's request body: `{"gate": "<declared name>"}`. */
const parseGateRequest = async (request: IncomingMessage): Promise<GateRequest> => {
    const raw = await readBody(request);
    if (raw === null) return { ok: false, status: HTTP_PAYLOAD_TOO_LARGE, error: 'body too large' };
    let parsed: { gate?: unknown };
    try {
        parsed = JSON.parse(raw) as { gate?: unknown };
    } catch {
        return { ok: false, status: HTTP_BAD_REQUEST, error: 'body must be JSON' };
    }
    if (typeof parsed.gate !== 'string' || !parsed.gate.trim()) {
        return { ok: false, status: HTTP_BAD_REQUEST, error: 'gate must be a name' };
    }
    return { ok: true, gate: parsed.gate };
};

/**
 * Acquires the checkout's gate environment and runs the declared gate in it, translating the
 * outcome into the ad-hoc endpoint's response. CONTAINER_GONE means docker itself failed — the
 * environment was torn down under the caller — and is reported 409 rather than 500 so the
 * agent's own retry can re-create the container.
 */
const runRegisteredGate = async (
    manager: Pick<GateManager, 'acquire' | 'runGate'>,
    claim: GateClaim,
    gate: { name: string; command: string },
    signal: AbortSignal
): Promise<{ status: number; body: unknown }> => {
    // A cancelled token must not re-create the environment its cancel just tore down: at
    // cooldown 0 nothing would ever tear the new one down again.
    if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
    try {
        await manager.acquire(claim.key, claim.image, claim.envBody ?? '', claim.job && { job: claim.job });
    } catch (e) {
        return {
            status: HTTP_INTERNAL_SERVER_ERROR,
            body: { error: `gate environment failed to start: ${(e as Error).message}` },
        };
    }
    try {
        const outcome = await manager.runGate(claim.key, gate.name, gate.command, signal);
        // A cancelled run's answer is whatever the kill left — never a verdict to record.
        if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
        return { status: HTTP_OK, body: outcome };
    } catch (e) {
        if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
        if ((e as { code?: number }).code === CONTAINER_GONE) {
            return { status: HTTP_CONFLICT, body: { error: 'gate environment is gone' } };
        }
        return { status: HTTP_INTERNAL_SERVER_ERROR, body: { error: (e as Error).message } };
    }
};

/** Mutates the STORED claim — replacing it would read as a cancel to a request already holding it. */
const setDeadNote = (claim: GateClaim | undefined, note: string | null): void => {
    if (claim) claim.deadServices = note ?? undefined;
};

/** An answered gate run carries the claim's dead-service note beside its verdict (issue #487). */
const withDeadNote = (result: { status: number; body: unknown }, claim: GateClaim): unknown =>
    result.status === HTTP_OK && claim.deadServices
        ? { ...(result.body as object), deadServices: claim.deadServices }
        : result.body;

/**
 * Aborts when the agent hangs up before the answer is written (its runner was killed): the run
 * it asked for is cancelled the same as by the token's own cancel.
 */
const hangupSignal = (reply: ServerResponse): AbortSignal => {
    const hangup = new AbortController();
    reply.on('close', () => {
        if (!reply.writableFinished) hangup.abort();
    });
    return hangup.signal;
};

export function createGateServer({
    host,
    manager,
}: {
    host: string;
    manager: Pick<GateManager, 'acquire' | 'runGate'>;
}): GateServer {
    const claims = new Map<string, GateClaim>();
    /** Per token, the controller every ad-hoc run of it listens on — `cancel` aborts it. */
    const cancels = new Map<string, AbortController>();
    /** Per token, the latest completed run per gate name — the timeout note's raw material. */
    const history = new Map<string, Map<string, GateRunNote>>();
    /** Per control token, whether a stop has been raised on it. */
    const controls = new Map<string, { stop: boolean; polled: boolean }>();
    let server: Server | null = null;
    let listening: Promise<number> | null = null;

    const respond = (reply: ServerResponse, status: number, body: unknown): void => {
        reply.statusCode = status;
        reply.setHeader(CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE);
        reply.end(JSON.stringify(body));
    };

    /** The runner's stop poll: `{ stop }` for an open control token, 401 for any other. */
    const handleControl = (auth: string, reply: ServerResponse): void => {
        const control = controls.get(auth);
        if (control) control.polled = true;
        if (control) respond(reply, HTTP_OK, { stop: control.stop });
        else respond(reply, HTTP_UNAUTHORIZED, { error: 'unknown token' });
    };

    const handle = async (request: IncomingMessage, reply: ServerResponse): Promise<void> => {
        const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        if (request.method === 'GET' && request.url === CONTROL_PATH) return handleControl(auth, reply);
        if (request.method !== 'POST' || request.url !== '/run') {
            return respond(reply, HTTP_NOT_FOUND, { error: 'not found' });
        }
        return handleRun(request, reply, auth);
    };

    /** The ad-hoc gate call: `POST /run` under a gate token. */
    const handleRun = async (request: IncomingMessage, reply: ServerResponse, auth: string): Promise<void> => {
        const claim = claims.get(auth);
        if (!claim) return respond(reply, HTTP_UNAUTHORIZED, { error: 'unknown token' });

        const hangup = hangupSignal(reply);

        const parsedRequest = await readGateRequest(request, auth, claim);
        if (!parsedRequest.ok) return respond(reply, parsedRequest.status, { error: parsedRequest.error });

        // Only a DECLARED name runs. An arbitrary command string here would make the runner's
        // agent a shell on the host through a container the driver owns — the one thing the
        // declare-then-run model exists to prevent.
        const gate = claim.gates.find((candidate) => candidate.name === parsedRequest.gate);
        if (!gate) return respond(reply, HTTP_NOT_FOUND, { error: `no declared gate "${parsedRequest.gate}"` });

        const cancelled = AbortSignal.any([cancels.get(auth)?.signal ?? AbortSignal.abort(), hangup]);
        const result = await runRegisteredGate(manager, claim, gate, cancelled);
        if (result.status === HTTP_OK) record(auth, gate.name, (result.body as { exitCode: number | null }).exitCode);
        return respond(reply, result.status, withDeadNote(result, claim));
    };

    /**
     * The request's body, unless its token was cancelled while the body was still arriving: the
     * claim read before is then the dead session's, and nothing may be acquired for it.
     */
    const readGateRequest = async (request: IncomingMessage, token: string, claim: GateClaim): Promise<GateRequest> => {
        const parsed = await parseGateRequest(request);
        if (claims.get(token) !== claim) return { ok: false, status: HTTP_CONFLICT, error: 'gate run cancelled' };
        return parsed;
    };

    const record = (token: string, name: string, exitCode: number | null): void => {
        const runs = history.get(token) ?? new Map<string, GateRunNote>();
        runs.set(name, { name, exitCode, at: new Date().toISOString() });
        history.set(token, runs);
    };

    return {
        register(token, claim) {
            claims.set(token, { ...claim, envBody: claim.envBody ?? '' });
            history.set(token, new Map());
            cancels.set(token, new AbortController());
        },
        unregister(token) {
            const controller = cancels.get(token);
            claims.delete(token);
            history.delete(token);
            cancels.delete(token);
            controller?.abort();
        },
        cancel(token) {
            this.unregister(token);
        },
        openControl(token) {
            if (!controls.has(token)) controls.set(token, { stop: false, polled: false });
        },
        controlPolled(token) {
            return controls.get(token)?.polled ?? false;
        },
        raiseStop(token) {
            const control = controls.get(token);
            if (control) control.stop = true;
        },
        closeControl(token) {
            controls.delete(token);
        },
        setDeadServices: (token, note) => setDeadNote(claims.get(token), note),
        lastRuns(token) {
            return [...(history.get(token)?.values() ?? [])];
        },
        listen() {
            // One promise per bind, cached: a second claim racing the first's bind awaits the
            // SAME promise instead of racing port 0 against a half-built server — and a failed
            // bind clears both, so the next call retries instead of answering port 0 forever.
            if (listening) return listening;
            const created = createServer((request, reply) => {
                void handle(request, reply).catch(() =>
                    respond(reply, HTTP_INTERNAL_SERVER_ERROR, { error: 'internal error' })
                );
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
            controls.clear();
            history.clear();
            closing.closeAllConnections();
            return new Promise((resolve) => closing.close(() => resolve()));
        },
    };
}
