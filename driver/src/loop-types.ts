import type { Board, BoardJob, LeaseState } from './board.js';
import type { DriverConfig } from './config.js';
import type { Runner } from './runner.js';
import type { GateManager, GateServer } from './gates.js';
import type { JobState } from './loop-attempt.js';

/**
 * The gate machinery, wired once at startup and handed to the loop only when it exists — an
 * operator who never asked for gates runs a loop that has never heard of them. The manager owns
 * the environment containers; the server owns the ad-hoc endpoint; the loop owns WHEN gates run,
 * because the loop is the only place that knows when the agent has finished talking.
 */
export interface GateStack {
    manager: GateManager;
    server: GateServer;
    /** Builds the URL the runner's agent is told to call, from the server's bound port. */
    advertiseUrl: (port: number) => string;
}

/**
 * Everything a running attempt needs from the loop that spawned it: the board and runner it talks
 * to, the driver's own config and (optional) gate machinery, its logger and sleeper, the reclaim
 * barrier every attempt's startup sync waits on, and the verdict-reporting entry point whose
 * worktree-reclaim side effect lives with the loop's other long-lived state.
 */
export interface LoopRuntime {
    board: Board;
    runner: Runner;
    config: DriverConfig;
    gates?: GateStack;
    log: (message: string) => void;
    sleep: (ms: number) => Promise<void>;
    reclaims: Map<string, Promise<void>>;
    report: (job: BoardJob, result: Parameters<Board['complete']>[1]) => Promise<LeaseState>;
}

/**
 * Everything a setup step or the run phase needs about the one attempt it belongs to. Shared
 * between `loop-run.ts` and `loop-helpers.ts` (the block-helper steps, issue #207) rather than
 * defined in either — both need it, and neither should import runtime state from the other.
 */
export interface AttemptCtx {
    rt: LoopRuntime;
    job: BoardJob;
    state: JobState;
    settle: () => Promise<void>;
    standDown: () => Promise<void>;
}

/**
 * A terminal outcome of a setup step: it already reported and settled, or stood the attempt down.
 * Shared for the same reason `AttemptCtx` is.
 */
export const STOOD_DOWN = 'stood-down' as const;
