import type { ServiceStatus } from './board.js';
import {
    DEAD_SERVICE_STATES,
    SERVICE_READY_POLL_MS,
    SERVICE_RESTART_TIMEOUT_MS,
    SERVICE_RESTART_TIMEOUT_S,
} from './runner.js';
import type { ServiceSpec } from './services.js';

/**
 * Waits until every service in `specs` is listed `running` (issue #560), re-listing every
 * SERVICE_READY_POLL_MS. Throws naming a service listed dead at once; once `timeoutMs` — the part
 * of the SERVICE_RESTART_TIMEOUT_MS budget the caller has left — has passed by the poll count or
 * the clock, whichever is first, it names what is still not running, or the listing error when
 * the last read failed. `signal` is the attempt's stand-down: it ends the wait at the next poll.
 * Running is the bar on purpose: `.bellows.yaml` declares no health checks.
 */
export async function awaitServicesRunning(
    specs: readonly ServiceSpec[],
    list: () => Promise<readonly ServiceStatus[]>,
    sleep: (ms: number) => Promise<void>,
    { timeoutMs = SERVICE_RESTART_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let pending = specs.map(({ name }) => name);
    for (let waited = 0; ; waited += SERVICE_READY_POLL_MS) {
        throwIfStoodDown(signal);
        let readError: Error | null = null;
        const listed = await list().catch((e: Error) => {
            readError = e;
            return null;
        });
        if (listed) {
            // A service that crashes on every start would only burn the timeout: it is the answer.
            const dead = listed.find(
                ({ name, state }) => DEAD_SERVICE_STATES.has(state) && specs.some((s) => s.name === name)
            );
            if (dead) throw new Error(`service "${dead.name}" ${dead.state} after the restart`);
            const running = new Set(listed.filter(({ state }) => state === 'running').map(({ name }) => name));
            pending = specs.map(({ name }) => name).filter((name) => !running.has(name));
            if (pending.length === 0) return;
        }
        if (waited >= timeoutMs || Date.now() >= deadline) {
            const after = `${SERVICE_RESTART_TIMEOUT_S}s after the restart`;
            if (readError)
                throw new Error(`the services could not be listed ${after}: ${(readError as Error).message}`);
            throw new Error(`service ${pending.map((name) => `"${name}"`).join(', ')} not running ${after}`);
        }
        await sleep(SERVICE_READY_POLL_MS);
    }
}

/** Ends a restart the attempt stood down from (issue #560): nothing more is created or polled. */
export function throwIfStoodDown(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error('the restart was abandoned: the attempt stood down');
}
