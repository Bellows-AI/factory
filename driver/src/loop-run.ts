import { randomUUID } from 'node:crypto';
import type { BoardJob } from './board.js';
import type { DeadService, RunOutcome, RunSession } from './runner.js';
import { preHelperStep, runPostHelperPhase } from './loop-helpers.js';
import type { GateFailure, GateSession } from './loop-gates.js';
import { beginGates, probeDeadServices, releaseGateSession, runDeclaredGates } from './loop-gates.js';
import { down, heartbeat, newJobState, raceStep, watchOutput } from './loop-attempt.js';
import type { GateRunNote } from './timeout-note.js';
import type { AttemptCtx, LoopRuntime } from './loop-types.js';
import { STOOD_DOWN } from './loop-types.js';
import { TRANSIENT_SYNC_REASON, type SyncResult } from './publish.js';
import { blockedReason, gateSkipReason, publishIfDue, report, reportFinish } from './loop-verdict.js';
import { OPENCODE } from './executors.js';
import { masterPromptRefusalReason } from './master-prompt.js';
import { uploadRunArtifacts } from './artifacts.js';

function pickSession(job: BoardJob, executorType: BoardJob['executorType']): RunSession | null {
    // opencode mints its own session ids (`ses_…`) and cannot adopt one, so a fresh run gets
    // none — the runner scrapes the id the run used and reports it when the outcome lands. A
    // follow-up claim carries the session opencode itself created, restored via `--session` on
    // the runner.
    if (executorType === OPENCODE) return job.resumeSessionId ? { id: job.resumeSessionId, resume: true } : null;
    return job.resumeSessionId ? { id: job.resumeSessionId, resume: true } : { id: randomUUID(), resume: false };
}

/** The refusal reason for an executor selection this loop cannot run, or null when it can. */
function executorRefusalReason(_rt: LoopRuntime, job: BoardJob): string | null {
    if (job.executorType === null) {
        return 'The selected executor no longer exists. Choose a configured executor and start a new task.';
    }
    return null;
}

/**
 * Reported while the lease is still live, BEFORE the park or the verdict — a follow-up can only
 * be asked for once the task is finished, and it resumes exactly this. A 'lost' verdict is not
 * acted on: the heartbeat is what kills a superseded run, and losing the link is not losing the
 * job. An opencode run ALWAYS leaves a session, so an empty scrape is the readout having failed
 * every try — said out loud, because the cost is a task that can never take a follow-up, and a
 * verdict without its finish reason or context. The stopped path calls this too (issue #152): a
 * stop's park lands the row terminal, and a session reported after it is refused — the stopped
 * task would settle sessionless with nothing to follow up.
 */
async function reportScrapedSession(
    rt: LoopRuntime,
    job: BoardJob,
    executorType: BoardJob['executorType'],
    outcome: RunOutcome
): Promise<void> {
    const { board, log } = rt;
    if (outcome.sessionId) {
        try {
            await board.session(job, outcome.sessionId);
            log(`job ${job.id}: session ${outcome.sessionId}`);
        } catch (e) {
            log(`job ${job.id}: could not report the session, continuing: ${(e as Error).message}`);
        }
    } else if (executorType === OPENCODE) {
        log(
            `job ${job.id}: the session readout came up empty (${outcome.readoutError ?? 'no session in the database'}) — ` +
                'no session to follow up, finish reason and context stats unread'
        );
    }
}

/**
 * The reclaim barrier (see `reclaims`): an in-flight removal of THIS thread's tree is waited out
 * before the sync — the first touch of the task worktree — so a follow-up claimed while its
 * thread's tree was being deleted never syncs against, or resurrects work on top of, a tree
 * mid-removal.
 */
async function waitReclaimBarrier(ctx: AttemptCtx): Promise<typeof STOOD_DOWN | null> {
    const { rt, job, state, standDown } = ctx;
    const inflight = rt.reclaims.get(job.rootJobId ?? job.id);
    if (inflight) await raceStep(state, inflight);
    if (down(state)) {
        await standDown();
        return STOOD_DOWN;
    }
    return null;
}

/** Syncs the task worktree with the remote default (or restores it), racing the stand-down. */
async function syncCheckoutStep(ctx: AttemptCtx): Promise<typeof STOOD_DOWN | null> {
    const { rt, job, state, settle, standDown } = ctx;
    const { runner, log } = rt;
    const syncing = runner.syncCheckout(job);
    let syncedOut: { value: SyncResult } | null;
    try {
        syncedOut = await raceStep(state, syncing);
    } catch (e) {
        await settle();
        log(`job ${job.id}: checkout sync threw, leaving it to the lease: ${(e as Error).message}`);
        return STOOD_DOWN;
    }
    if (syncedOut === null) {
        void syncing
            .then((result) => {
                if (result.ok) return runner.releaseFence?.(job);
            })
            .catch(() => {});
        await standDown();
        return STOOD_DOWN;
    }
    if (down(state)) {
        // The sync had already finished when the stand-down was observed. An ok sync
        // holds the checkout (kubernetes's claim) with no run ever to release it, so the
        // fence goes back here — the same release the terminal refusals below make; a
        // failed sync released its own claim inside the runner.
        if (syncedOut.value.ok) await runner.releaseFence?.(job);
        await standDown();
        return STOOD_DOWN;
    }
    const synced = syncedOut.value;
    if (!synced.ok) {
        if (synced.reason !== null && TRANSIENT_SYNC_REASON.test(synced.reason)) {
            /*
             * Lock contention on the shared checkout (issue #307) is infrastructure, not a
             * verdict: the script already waited out the checkout's sync lock and retried the
             * fetch, so reporting `failed` here would spend the RUN on what a re-claim spends
             * an attempt on. The claim goes back to the board — the lease expires and the job
             * is offered again, exactly like a sync that threw — and maxAttempts governs. The
             * kubernetes checkout claim was already released inside syncCheckout before it
             * answered, the same discipline the ordinary sync-failure report below relies on.
             */
            await settle();
            log(`job ${job.id}: checkout sync was lock-blocked, leaving it to the lease: ${synced.reason}`);
            return STOOD_DOWN;
        }
        await settle();
        log(`job ${job.id}: checkout sync failed: ${synced.reason}`);
        await report(rt, job, {
            status: 'failed',
            exitCode: null,
            output: `The checkout could not be synced with the remote before the run: ${synced.reason}`,
            failureKind: 'runner_error',
        }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
        return STOOD_DOWN;
    }
    ctx.treeBefore = synced.fingerprint ?? null;
    return null;
}

/**
 * Re-reads the claim's gates decision now that the sync has freshened the tree, and refuses the
 * job when its `.bellows.yaml` cannot be read, or declares gates this driver cannot run.
 */
async function rereadGatesStep(ctx: AttemptCtx): Promise<typeof STOOD_DOWN | null> {
    const { rt, job, state, settle, standDown } = ctx;
    const { board, runner, log } = rt;

    const freshOut = await raceStep(state, board.rereadGates(job));
    if (freshOut === null || down(state)) {
        await runner.releaseFence?.(job);
        await standDown();
        return STOOD_DOWN;
    }
    const fresh = freshOut.value;
    if (fresh) {
        job.gates = fresh.gates ?? null;
        job.gateError = fresh.gateError ?? null;
    } else {
        log(`job ${job.id}: gates re-read refused, keeping the claim's decision`);
    }

    if (job.gateError) {
        await runner.releaseFence?.(job);
        await settle();
        log(`job ${job.id}: its gates file could not be read, failing`);
        await report(rt, job, {
            status: 'failed',
            exitCode: null,
            output: `This job's .bellows.yaml could not be read as a gate declaration: ${job.gateError}`,
            failureKind: 'runner_error',
        }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
        return STOOD_DOWN;
    }

    if (job.gates?.gates?.length && !rt.gates) {
        await runner.releaseFence?.(job);
        await settle();
        const why = 'this driver was started with no gate environment configured';
        log(`job ${job.id}: declares gates this driver cannot run, failing`);
        await report(rt, job, {
            status: 'failed',
            exitCode: null,
            output: `This job declares verification gates in .bellows.yaml, and ${why}. Re-queue it against a driver built with the GATE_* configuration set.`,
            failureKind: 'runner_error',
        }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
        return STOOD_DOWN;
    }
    return null;
}

/** Starts the job's gate environment, or answers null for a job that declares none. */
async function acquireGateSession(ctx: AttemptCtx): Promise<GateSession | null | typeof STOOD_DOWN> {
    const { rt, job, state, settle, standDown } = ctx;
    const { board, runner, log } = rt;
    try {
        const gateOut = await raceStep(state, beginGates(rt, job, state));
        let gateSession = gateOut === null ? null : gateOut.value;
        if (down(state)) {
            if (gateSession) {
                releaseGateSession(rt, gateSession);
                gateSession = null;
            }
            await runner.releaseFence?.(job);
            await standDown();
            return STOOD_DOWN;
        }
        return gateSession;
    } catch (e) {
        await settle();
        log(`job ${job.id}: gate environment failed, failing with a reason: ${(e as Error).message}`);
        await board
            .complete(job, {
                status: 'failed',
                exitCode: null,
                output: `The gate environment declared in .bellows.yaml could not be started: ${(e as Error).message}`,
                failureKind: 'runner_error',
            })
            .catch((err: Error) => log(`job ${job.id}: could not report the failure: ${err.message}`));
        return STOOD_DOWN;
    }
}

/**
 * The setup phase of one attempt: the reclaim barrier, the checkout sync, the gates re-read and
 * its refusals, the job's declared PRE block-helper steps, and the gate environment. Answers the
 * gate session to run with (null when the job declares none), or `'stood-down'` when a setup step
 * already reported and settled the attempt — the caller must not fall through to the run in that
 * case.
 */
async function runSetup(ctx: AttemptCtx): Promise<GateSession | null | typeof STOOD_DOWN> {
    for (const step of [waitReclaimBarrier, syncCheckoutStep, rereadGatesStep, preHelperStep]) {
        const outcome = await step(ctx);
        if (outcome === STOOD_DOWN) return STOOD_DOWN;
    }
    return acquireGateSession(ctx);
}

/** A short-circuit outcome of the run phase: settled with nothing left for the caller to do. */
type RunPhaseDone = { done: true };

/** The run phase's ordinary conclusion: what to report, and the gate failure (if any) behind it. */
type RunPhaseResult = {
    done: false;
    outcome: RunOutcome;
    failure: GateFailure | null;
    /** The declared services found dead before the gates — which were skipped for them. */
    deadServices: DeadService[];
    /**
     * When `runner.run` resolved — the moment the run ended, and the timestamp the timeout
     * note's active/idle verdict is measured at. The verdict builds later: the declared gates,
     * the post-helpers and the session scrape can each run minutes after a kill, and aging the
     * last output from VERDICT time would report a run that was streaming when it died as idle.
     */
    endedAt: number;
    /** The agent's blocked report, or null. */
    blocked: string | null;
    /** Why the declared gates were skipped, or null. */
    gatesSkipped: string | null;
    /** Whether the failed gate's tree differs from the synced one; null when unmeasured. */
    treeChanged: boolean | null;
};

/** Handles the run-ended verdicts that are not an ordinary finish: lost, removed, stopped. */
async function settleNonFinish(
    ctx: AttemptCtx,
    executorType: BoardJob['executorType'],
    outcome: RunOutcome
): Promise<boolean> {
    const { rt, job, state, settle } = ctx;
    const { log } = rt;
    if (state.lost) {
        await settle();
        return true;
    }
    if (state.removed) {
        await settle();
        log(`job ${job.id}: removed while it ran; the queue owns the tree`);
        return true;
    }
    if (state.stopped) {
        await settle();
        await reportScrapedSession(rt, job, executorType, outcome);
        // The artifacts ride the same pre-park window the session report does (issue #325):
        // the park lands the row terminal, and an upload refused after it is a lost artifact.
        await uploadRunArtifacts(rt, job, outcome);
        const verdict = await rt.board.suspend(job);
        log(
            verdict === 'lost'
                ? `job ${job.id}: stopped, but the board had already reclaimed it`
                : `job ${job.id}: stopped, the board has settled the turn`
        );
        return true;
    }
    return false;
}

/** What one run needs beyond its `AttemptCtx`: the session, its gates, and its I/O plumbing. */
interface RunInputs {
    session: RunSession | null;
    gateSession: GateSession | null;
    executorType: BoardJob['executorType'];
    onOutput: (tail: string) => void;
}

/** The run itself: spawn, and resolve to what to report (or nothing). */
async function runAttempt(ctx: AttemptCtx, inputs: RunInputs): Promise<RunPhaseDone | RunPhaseResult> {
    const { rt, job, state, settle, standDown } = ctx;
    const { session, gateSession, executorType, onOutput } = inputs;
    const { runner, log } = rt;
    if (down(state)) {
        await runner.releaseFence?.(job);
        await standDown();
        return { done: true };
    }
    state.launched = true;

    const outcome = await runner.run(job, session, onOutput);
    // The run's end, stamped HERE — not at verdict time: the gates, helpers and session scrape
    // below can run minutes after a kill, and the timeout note's active/idle verdict must
    // describe the run as it ended, not as it was reported.
    const endedAt = Date.now();

    if (await settleNonFinish(ctx, executorType, outcome)) return { done: true };

    /*
     * The runner, not this loop, knows what a refused start looks like on its platform, and
     * stamps `started: false` for it. Saying nothing here would rerun the job until attempts
     * run out and retire it dead, blaming the command for infrastructure.
     */
    if (!outcome.started) {
        await settle();
        log(`job ${job.id}: the runner reports the container never started, leaving it to the lease`);
        return { done: true };
    }

    await reportScrapedSession(rt, job, executorType, outcome);
    // The artifacts upload HERE (issue #325): while the lease is still live — settle() has
    // deliberately not been called — and before the gates, so a gate suite that runs minutes
    // cannot push the upload past a reclaim. Best-effort throughout; a failed upload costs
    // retention, never the run.
    await uploadRunArtifacts(rt, job, outcome);
    // The session minted and reported before the spawn never ran — no transcript exists under it,
    // so a follow-up resuming it would find no conversation. A resumed session is the parent's
    // and stays.
    if (outcome.refused && session && !session.resume) {
        await rt.board
            .session(job, null)
            .catch((e: Error) => log(`job ${job.id}: could not clear the unused session: ${e.message}`));
    }

    /*
     * The gates run HERE: after the agent has finished talking and before the verdict, with the
     * heartbeat still beating — settle() has deliberately NOT been called yet, because a test
     * suite can take minutes and it must not outrun the lease it runs under. A run that did not
     * finish cleanly skips them: a gate over work that never happened fires gate-fix for nothing.
     */
    const blocked = blockedReason(outcome);
    const gated =
        gateSession && !outcome.refused && !state.lost
            ? await runGatesPhase(ctx, gateSession, outcome, blocked)
            : { failure: null, deadServices: [], gatesSkipped: null };
    // A cancelled gate answers no failure, so a stand-down during the gates lands here too.
    const treeChanged = gated.failure ? await treeChangedSinceSync(ctx) : null;
    if (down(state)) {
        await settleDownAfterGates(ctx);
        return { done: true };
    }

    return { done: false, outcome, ...gated, endedAt, blocked, treeChanged };
}

/** What the gates phase of one attempt found: the failed gate, the dead services, or why it skipped. */
interface GatesPhase {
    failure: GateFailure | null;
    deadServices: DeadService[];
    gatesSkipped: string | null;
}

/** The declared gates, unless the run did not finish cleanly or a declared service is dead. */
async function runGatesPhase(
    ctx: AttemptCtx,
    gateSession: GateSession,
    outcome: RunOutcome,
    blocked: string | null
): Promise<GatesPhase> {
    const { rt, job, state } = ctx;
    const gatesSkipped = gateSkipReason(outcome, blocked);
    if (gatesSkipped !== null) {
        rt.log(`job ${job.id}: gates skipped — ${gatesSkipped}`);
        return { failure: null, deadServices: [], gatesSkipped };
    }
    // A gate against a dead service fails on an environment the agent cannot fix, and a
    // failed gate is what the workflow's gate-fix edge spends a round on (issue #423).
    const deadServices = await probeDeadServices(rt, job);
    const failure = deadServices.length === 0 ? await runDeclaredGates(rt, job, gateSession, state) : null;
    return { failure, deadServices, gatesSkipped: null };
}

/**
 * A stop, lost lease or Remove observed while the declared gates ran: the running gate was
 * cancelled (`runDeclaredGates`), and the attempt settles exactly as a stop of the run itself
 * does — parked `stopped`, never a verdict a `gate-failed` edge could read.
 */
async function settleDownAfterGates(ctx: AttemptCtx): Promise<void> {
    const { rt, job, state, settle } = ctx;
    await settle();
    if (state.stopped) {
        const verdict = await rt.board.suspend(job);
        rt.log(
            verdict === 'lost'
                ? `job ${job.id}: stopped during its gates, but the board had already reclaimed it`
                : `job ${job.id}: stopped during its gates — the gates were cancelled, the board has settled the turn`
        );
    } else if (state.removed) {
        rt.log(`job ${job.id}: removed during its gates; the queue owns the tree`);
    }
}

/**
 * Whether the task tree moved since the startup sync — the probe re-read after a failed gate.
 * Null whenever either half is unknown: no before-fingerprint, no probe, or a probe that failed.
 */
async function treeChangedSinceSync(ctx: AttemptCtx): Promise<boolean | null> {
    const { rt, job, treeBefore, state } = ctx;
    if (treeBefore === null || !rt.runner.probeTree) return null;
    // A stand-down cancels the probe's transport and stops waiting on it; the caller rechecks.
    const cancel = new AbortController();
    void state.abort.then(() => cancel.abort());
    const raced = await raceStep(
        state,
        rt.runner.probeTree(job, cancel.signal).catch(() => null)
    );
    const after = raced?.value ?? null;
    return after === null ? null : after !== treeBefore;
}

/** The ad-hoc gate history one attempt's timeout note quotes, read before the session's teardown. */
function gateHistory(rt: LoopRuntime, gateSession: GateSession | null): readonly GateRunNote[] {
    if (gateSession === null) return [];
    return rt.gates?.server.lastRuns(gateSession.token) ?? [];
}

/**
 * One attempt, end to end: the startup setup (the reclaim barrier, the checkout sync, the
 * gates re-read, the gate environment) and the run itself. The setup lives here rather than in
 * the claim loop so the attempt's state — heartbeat, abort signal, cleanup — covers all of it:
 * a Stop issued while the dashboard says "Waiting for the executor…" interrupts the setup
 * within one heartbeat poll and stands the attempt down before anything spawns (issue #126).
 */
export async function runJob(rt: LoopRuntime, job: BoardJob): Promise<void> {
    const { log } = rt;
    const executorType = job.executorType;
    const executorRefusal = executorRefusalReason(rt, job);
    if (executorRefusal) {
        log(`job ${job.id}: executor selection is not runnable, failing`);
        await report(rt, job, {
            status: 'failed',
            exitCode: null,
            output: executorRefusal,
            failureKind: 'runner_error',
        }).catch((e: Error) => log(`job ${job.id}: could not report the executor failure: ${e.message}`));
        return;
    }

    // The board always renders a master prompt for every agent claim (server/src/db/master-prompt.ts);
    // a missing, oversized or malformed one is a contract violation, never a reason to run the
    // agent with no Factory execution context. Checked before any setup — including a helper-only
    // node's pre-helper, which might otherwise conclude the job without ever spawning an agent —
    // because the board cannot know ahead of a run whether a pre-helper will conclude it.
    const promptRefusal = masterPromptRefusalReason(job);
    if (promptRefusal) {
        log(`job ${job.id}: master prompt is not runnable, failing`);
        await report(rt, job, {
            status: 'failed',
            exitCode: null,
            output: promptRefusal,
            failureKind: 'runner_error',
        }).catch((e: Error) => log(`job ${job.id}: could not report the master-prompt failure: ${e.message}`));
        return;
    }

    const state = newJobState();
    const beating = heartbeat(rt, job, state);
    // Armed before the run so the runner can hand over tails from its first chunk; the pump's
    // snapshot is the liveness read the timeout note is built from (issue #339).
    const outputPump = watchOutput(rt, job, state);
    const onOutput = outputPump.push;
    const session = pickSession(job, executorType);

    const settle = async () => {
        state.finished = true;
        state.wake();
        await beating;
    };

    /*
     * Lands a verdict the heartbeat observed before the runner spawned — a Stop, a lost lease
     * or a Remove that arrived while this attempt was still syncing its checkout or booting
     * its gate environment (issue #126).
     */
    const standDown = async (): Promise<void> => {
        await settle();
        if (state.stopped) {
            const verdict = await rt.board.suspend(job);
            log(
                verdict === 'lost'
                    ? `job ${job.id}: stopped during setup, but the board had already reclaimed it`
                    : `job ${job.id}: stopped during setup — stood down before the runner spawned, the board has settled the turn`
            );
        } else if (state.lost) {
            log(`job ${job.id}: the lease was lost during setup, leaving the job to its holder`);
        } else if (state.removed) {
            log(`job ${job.id}: removed during setup; the queue owns the tree`);
        }
    };

    try {
        log(
            `job ${job.id}: attempt ${job.attempts} ` +
                (session
                    ? `${session.resume ? 'resuming' : 'starting as'} session ${session.id}`
                    : 'starting (headless opencode run: no session id)')
        );
        if (session && !session.resume) {
            try {
                await rt.board.session(job, session.id);
            } catch (e) {
                log(`job ${job.id}: could not report the session, continuing: ${(e as Error).message}`);
            }
        }

        const ctx: AttemptCtx = { rt, job, state, settle, standDown, treeBefore: null };
        const gateSession = await runSetup(ctx);
        if (gateSession === STOOD_DOWN) return;
        // A stand-down kills the runner, but not a gate its agent asked for: the token dies and
        // every ad-hoc run of it in flight is cancelled the moment the verdict lands.
        if (gateSession) void state.abort.then(() => rt.gates?.server.cancel(gateSession.token));

        try {
            const outcome = await runAttempt(ctx, { session, gateSession, executorType, onOutput });
            if (outcome.done) return;
            const helperFailure = await runPostHelperPhase(rt, job, state);
            const published = await publishIfDue(rt, job, {
                outcome: outcome.outcome,
                failure: outcome.failure,
                deadServices: outcome.deadServices,
                helperFailure,
                blocked: outcome.blocked,
            });
            await settle();
            // The liveness read and the gate verdicts are read BEFORE the finally below
            // releases the gate session — unregistering clears the recorded runs.
            await reportFinish(rt, {
                job,
                outcome: outcome.outcome,
                failure: outcome.failure,
                deadServices: outcome.deadServices,
                helperFailure,
                published,
                endedAt: outcome.endedAt,
                activity: outputPump.snapshot(),
                gateRuns: gateHistory(rt, gateSession),
                blocked: outcome.blocked,
                gatesSkipped: outcome.gatesSkipped,
                treeChanged: outcome.treeChanged,
            });
        } finally {
            if (gateSession) releaseGateSession(rt, gateSession);
            // The services outlived run() for the declared gates' sake; they go now, on every
            // exit path — a thrown run included, whose own cleanup no longer takes them.
            await rt.runner
                .releaseServices(job)
                .catch((e: Error) => log(`job ${job.id}: could not tear down the services: ${e.message}`));
        }
    } catch (e) {
        // The container never ran — docker is missing, or the daemon refused. Deliberately NOT
        // reported as a failed job: that would blame the command for the driver's problem. The
        // lease simply expires and the job is offered again, which is visible in `attempts`.
        await settle();
        log(`job ${job.id}: could not run, leaving it to the lease: ${(e as Error).message}`);
    }
}
