import { randomUUID } from 'node:crypto';
import type { BoardJob } from './board.js';
import { envFileBody, tailBytes } from './docker.js';
import type { GateRun } from './gates.js';
import { down } from './loop-attempt.js';
import type { JobState } from './loop-attempt.js';
import type { LoopRuntime } from './loop-types.js';
import { worktreeRelDir } from './publish.js';

/** The report must fit the board's 128 KiB body: the raw per-gate tail budget, and its floor. */
const GATES_REPORT_BUDGET_BYTES = 16384;
const PER_GATE_OUTPUT_FLOOR_BYTES = 1024;
const REFUSED_TO_RUN_EXIT_CODE = 125;

/**
 * One gated job's live registration: the checkout key its environment is filed under, the token
 * the runner's agent presents to the ad-hoc endpoint, and the gates the job's `.bellows.yaml`
 * declared. Lives from before the agent starts until the run's exit paths have all been walked.
 * The image and env body the environment was created with ride along so the gates pass can
 * re-acquire — carried, not recomputed, because a body recomputed at gates time would fold in
 * the minted `BELLOWS_GATE_*` lines that only exist after `beginGates` has registered them.
 */
export interface GateSession {
    key: string;
    token: string;
    image: string;
    envBody: string;
    declared: readonly { name: string; command: string }[];
}

export interface GateFailure {
    name: string;
    exitCode: number;
    output: string;
}

/** What one gate looks like on the board, at one moment. */
type GateReport = {
    name: string;
    status: 'running' | 'passed' | 'failed';
    exitCode: number | null;
    output: string | null;
};

/**
 * Ensures the job's gate environment and registers its ad-hoc token, or answers null for a
 * job that has no gates. The token and URL ride the claim's env into the runner's env file —
 * appended after the claim's own lines, where docker's last-wins rule keeps a member-scoped
 * `BELLOWS_GATE_TOKEN` from minting itself a gate credential.
 */
export async function beginGates(rt: LoopRuntime, job: BoardJob, state: JobState): Promise<GateSession | null> {
    const { gates } = rt;
    if (!gates || !job.gates || !job.gates.gates.length || job.gateError) return null;
    // The gates run in the task worktree (issue #35) — the tree the run edits — so the
    // environment is keyed by the worktree path, `<org>/<uuid>/.worktrees/<root id>`. A job
    // that names no repository has no worktree and no gates either.
    const key = worktreeRelDir(job);
    if (!key) return null;
    // The environment starts with the claim's own env — resolved for THIS author and repo —
    // which is exactly what a test suite needs to reach the forge.
    const envBody = envFileBody(job);
    // The job is the kubernetes gate manager's attempt context — its gate Jobs carry the
    // job and lease labels, and their names are derived from them. The docker manager
    // ignores it.
    await gates.manager.acquire(key, job.gates.image, envBody, job);
    // A stand-down that landed while the acquire was in flight leaves the environment here:
    // the caller has stopped waiting and holds no session to release through (issue #126).
    if (down(state)) {
        gates.manager.release(key);
        return null;
    }
    try {
        const port = await gates.server.listen();
        const token = randomUUID();
        gates.server.register(token, { key, image: job.gates.image, envBody, gates: job.gates.gates });
        // Beside `env`, not inside it: the reserved-name filter keeps a member-configured
        // BELLOWS_GATE_* out of the claim lines, and these are the driver's own minted values.
        job.gateEnv = {
            BELLOWS_GATE_URL: gates.advertiseUrl(port),
            BELLOWS_GATE_TOKEN: token,
        };
        // The same check at the far edge — listen can take its time, and nothing registered
        // or live may survive a stand-down detected inside this function.
        if (down(state)) {
            gates.server.unregister(token);
            gates.manager.release(key);
            return null;
        }
        return { key, token, image: job.gates.image, envBody, declared: job.gates.gates };
    } catch (e) {
        // The container came up but registration did not. Released — not stopped — so the
        // cooldown owns it and the next turn reuses it, instead of leaking one live
        // environment per failed claim until the driver restarts.
        gates.manager.release(key);
        throw e;
    }
}

/** The declared gates of one running attempt: what `runDeclaredGates` and its helper share. */
interface GatesRunCtx {
    rt: LoopRuntime;
    job: BoardJob;
    gateSession: GateSession;
    state: JobState;
}

/** One declared gate's re-acquire-then-run outcome, folding a re-acquire failure into a failed gate. */
async function runOneGate(ctx: GatesRunCtx, gate: { name: string; command: string }): Promise<GateRun | null> {
    const { rt, job, gateSession, state } = ctx;
    const { gates } = rt;
    if (!gates) return null;
    return gates.manager
        .acquire(gateSession.key, gateSession.image, gateSession.envBody, job)
        .then(() => {
            // The heartbeat can mark the lease lost while acquire is pending — a slow
            // revival or cluster request outlives the beat that said so. Starting the gate
            // then would run it on a checkout another attempt owns: the same dead work the
            // check before the acquire refuses.
            if (state.lost) return null;
            return gates.manager.runGate(gateSession.key, gate.name, gate.command);
        })
        .catch((e: Error) => ({ exitCode: REFUSED_TO_RUN_EXIT_CODE, output: e.message }));
}

/**
 * Runs every declared gate in order, reporting each state change to the board as it happens.
 * The report REPLACES the stored list — every report carries the whole list so the task view
 * always shows all gates at their current state, never a summary that arrived out of order.
 *
 * Both the reports and a gate whose exec itself throws are best-effort against the RUN, never
 * against the VERDICT: a board hiccup costs the live view, not the gating. A gate that cannot
 * run at all is a failed gate — an exit code of 125 is docker's "container not there", and
 * treating it as a pass would be the one lie this loop must never tell.
 *
 * Each gate re-acquires the environment first, exactly as the ad-hoc endpoint does: the
 * cooldown the agent's last ad-hoc gate call armed can fire while the agent keeps working,
 * and a run that outlives GATE_COOLDOWN_MS must not fail at the finish line over an
 * environment that acquire can revive (acquire cancels a pending teardown and recreates a
 * torn-down one).
 */
export async function runDeclaredGates(
    rt: LoopRuntime,
    job: BoardJob,
    gateSession: GateSession,
    state: JobState
): Promise<GateFailure | null> {
    const { gates, log } = rt;
    if (!gates) return null;
    const runCtx: GatesRunCtx = { rt, job, gateSession, state };
    const results: GateReport[] = [];
    const report = async (): Promise<void> => {
        try {
            // A copy, not the live array: the report is a state-at-a-moment, and a reader
            // (or stub) holding it must not see gates move after the fact.
            // A 409 here is not a kill order — the heartbeat is the one place that decides a
            // superseded run must die (docs/jobs.md); this pump only ever loses freshness.
            await rt.board.gates(job, [...results]);
        } catch (e) {
            log(`job ${job.id}: could not report gate state, continuing: ${(e as Error).message}`);
        }
    };
    // The report must fit the board's 128 KiB body however many gates declared and however
    // verbose they were — JSON escaping can inflate bytes six-fold, so the raw budget per
    // gate shrinks as the list grows (16 gates still get 1 KiB of tail each).
    const perGate = Math.max(
        PER_GATE_OUTPUT_FLOOR_BYTES,
        Math.floor(GATES_REPORT_BUDGET_BYTES / gateSession.declared.length)
    );
    for (const gate of gateSession.declared) {
        // The lease can be reclaimed mid-gates. Everything after that is dead work on a
        // checkout another attempt owns, and the verdict will be refused anyway.
        if (state.lost) return null;
        results.push({ name: gate.name, status: 'running', exitCode: null, output: null });
        await report();
        // Re-acquire, then run, under one catch: an environment that cannot be revived is a
        // gate that cannot run at all — the same failed-gate shape, never a crash of the run.
        const outcome = await runOneGate(runCtx, gate);
        // `runOneGate` never answers null, so a null here is the lost-lease abandonment above.
        if (!outcome) return null;
        const failed = outcome.exitCode !== 0;
        // Replace the gate's own entry — one entry per declared gate, always, so the list the
        // board stores IS the declared list at its current state.
        results[results.length - 1] = {
            name: gate.name,
            status: failed ? 'failed' : 'passed',
            exitCode: outcome.exitCode,
            output: tailBytes(outcome.output, perGate),
        };
        await report();
        if (failed) {
            return { name: gate.name, exitCode: outcome.exitCode ?? REFUSED_TO_RUN_EXIT_CODE, output: outcome.output };
        }
    }
    return null;
}

/** One gate session's teardown: the environment goes back to its cooldown, the token dies. */
export function releaseGateSession(rt: LoopRuntime, session: GateSession): void {
    rt.gates?.server.unregister(session.token);
    rt.gates?.manager.release(session.key);
}
