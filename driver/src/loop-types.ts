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
    /**
     * Whether this attempt holds the kubernetes checkout claim: taken by a successful sync, handed
     * to the runner at launch, and given back by `handBackFence` (`loop-fence.ts`) and by nothing
     * else — a refusal that ends an attempt no runner ever reached would otherwise hold the claim
     * for the life of the cluster (issue #469).
     */
    fenced: boolean;
    /** The task tree's fingerprint the startup sync answered; null when unknown. */
    treeBefore: string | null;
}

/** The completion body the board's `complete` takes: what a conclusion reports. */
export type VerdictBody = Parameters<Board['complete']>[1];

/**
 * A terminal conclusion of the setup phase, as data and never as acting. `runPhases`
 * (`loop-run.ts`) is the only thing that acts on one — the claim handed back, the attempt settled,
 * the line logged, the verdict reported — so a new refusal cannot forget any of it (issue #472,
 * step 3 of #433).
 *
 * - `fault` — a named failure, reported `failed`. The agent never runs.
 * - `leave` — infrastructure, not a verdict: the claim goes back to the board and the lease
 *   decides (issue #307's lock contention, a sync that threw).
 * - `concluded` — the job really is done (a pre-run helper's `control: 'conclude'`, issue #230),
 *   reported `succeeded` with no agent, no gates, no post-helper and no publish.
 */
export type SetupHalt =
    | { halt: 'fault'; log: string; verdict: VerdictBody }
    | { halt: 'leave'; log: string }
    | { halt: 'concluded'; log: string; verdict: VerdictBody };

/**
 * What ends the setup phase: a stand-down the caller must stand down on, or a conclusion to land.
 * A step that is not done answers `null`.
 */
export type SetupConclusion = SetupHalt | typeof STOOD_DOWN;

/** A terminal outcome of a setup step: it already reported and settled, or stood the attempt down. */
export const STOOD_DOWN = 'stood-down' as const;
