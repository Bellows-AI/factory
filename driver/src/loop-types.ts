import type { Board, BoardJob, LeaseState } from './board.js';
import type { DriverConfig } from './config.js';
import type { Runner } from './docker.js';
import type { GateManager, GateServer } from './gates.js';

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
