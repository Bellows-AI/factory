import { randomUUID } from 'node:crypto';
import type { Board, BoardJob, LeaseState } from './board.js';
import type { RunOutcome, RunSession } from './runner.js';
import type { HelperFailureReport } from './helpers.js';
import { preHelperStep, runPostHelperPhase } from './loop-helpers.js';
import type { GateFailure, GateSession } from './loop-gates.js';
import { beginGates, releaseGateSession, runDeclaredGates } from './loop-gates.js';
import { down, heartbeat, newJobState, raceStep, watchOutput } from './loop-attempt.js';
import type { AttemptCtx, LoopRuntime } from './loop-types.js';
import { STOOD_DOWN } from './loop-types.js';
import type { PublishResult, SyncResult } from './publish.js';
import { OPENCODE } from './executors.js';
import { masterPromptRefusalReason } from './master-prompt.js';

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
        await settle();
        log(`job ${job.id}: checkout sync failed: ${synced.reason}`);
        await report(rt, job, {
            status: 'failed',
            exitCode: null,
            output: `The checkout could not be synced with the remote before the run: ${synced.reason}`,
        }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
        return STOOD_DOWN;
    }
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
type RunPhaseResult = { done: false; outcome: RunOutcome; failure: GateFailure | null };

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

    /*
     * The gates run HERE: after the agent has finished talking and before the verdict, with the
     * heartbeat still beating — settle() has deliberately NOT been called yet, because a test
     * suite can take minutes and it must not outrun the lease it runs under.
     */
    let failure: GateFailure | null = null;
    if (gateSession) failure = await runDeclaredGates(rt, job, gateSession, state);

    return { done: false, outcome, failure };
}

/** Whether the finish reason names a run that stopped talking before it was done. */
function isPrematureFinish(outcome: RunOutcome): boolean {
    const finish = outcome.finishReason;
    // A cache-killed run was cut mid-tool-call, so its finish reason reads as one more
    // premature stop — the cache note already says the whole story.
    return typeof finish === 'string' && finish !== 'stop' && !outcome.cacheLost;
}

/** What decides whether a finished run is publish-due: its own outcome plus every failure kind. */
interface PublishGate {
    outcome: RunOutcome;
    failure: GateFailure | null;
    helperFailure: HelperFailureReport | null;
}

/**
 * Publishes a succeeded, ungated-or-passed run — the deterministic end of a task. Answers null
 * when the run does not qualify (a failure, a timeout, a premature stop, or publish disabled).
 */
async function publishIfDue(rt: LoopRuntime, job: BoardJob, gate: PublishGate): Promise<PublishResult | null> {
    const { outcome, failure, helperFailure } = gate;
    const { board, runner, log } = rt;
    if (
        outcome.exitCode !== 0 ||
        outcome.timedOut ||
        isPrematureFinish(outcome) ||
        failure ||
        helperFailure ||
        job.publish === false ||
        !runner.publishGit
    ) {
        return null;
    }
    // The claim's GITHUB_TOKEN was minted at claim time, and a run can outlive its hour. Ask the
    // board for a publish-fresh one; null keeps the claim env, the shape every short run still
    // publishes with.
    const publishToken = await board.publishToken(job);
    if (!publishToken) {
        log(`job ${job.id}: publish-token ask answered nothing fresh — publishing with the claim env`);
    }
    return runner.publishGit(job, publishToken ?? undefined);
}

/** The publication identity to ride the verdict, only when the publish really happened and landed. */
function publicationOf(
    published: PublishResult | null
): NonNullable<Parameters<Board['complete']>[1]['publication']> | null {
    if (
        published?.published &&
        published.repository &&
        published.prNumber &&
        published.prUrl &&
        published.branch &&
        published.baseBranch
    ) {
        return {
            repo: published.repository,
            prNumber: published.prNumber,
            prUrl: published.prUrl,
            headBranch: published.branch,
            baseBranch: published.baseBranch,
        };
    }
    return null;
}

/** What one attempt's conclusion needs to build and report its verdict. */
interface FinishCtx {
    job: BoardJob;
    outcome: RunOutcome;
    failure: GateFailure | null;
    helperFailure: HelperFailureReport | null;
    published: PublishResult | null;
}

/** The verdict output text, annotated with every terminal condition worth telling the author about. */
function buildOutput(rt: LoopRuntime, finish: FinishCtx, publishUnlanded: boolean): string {
    const { job, outcome, failure, helperFailure, published } = finish;
    const { config, log } = rt;
    let output = outcome.timedOut
        ? `${outcome.output}\n[driver] killed after ${config.jobTimeoutMs}ms`
        : outcome.output;
    if (published?.published) {
        output = `${output}\n[driver] published ${published.branch}${published.prUrl ? ` — ${published.prUrl}` : ''}`;
    }
    if (published && published.ok && !published.published) {
        // A silent no-op is how a missing `docker run` once hid behind "the checkout has not
        // been cloned yet" — the reason is the only way to tell an ordinary clean tree from a
        // publisher that cannot see the tree at all.
        log(`job ${job.id}: nothing to publish: ${published.reason}`);
    }
    if (publishUnlanded) {
        output = `${output}\n[driver] publish failed — the work did not land: ${published?.reason}`;
    }
    if (outcome.cacheLost) {
        output =
            `${output}\n[driver] killed — the model provider stopped serving prompt cache: ` +
            `${outcome.cacheLost}. Every turn was re-reading the whole context, so the run was ` +
            'burning its time budget without progressing. Retry when the cache is healthy again, or on another model.';
    }
    if (isPrematureFinish(outcome)) {
        // The finish reason says the run stopped talking; the session's last provider error,
        // when the scrape lifted one, says WHY.
        const cause = outcome.providerError ? ` The session's last provider error: ${outcome.providerError}.` : '';
        output =
            `${output}\n[driver] the agent's run ended before it finished (opencode finish reason: "${outcome.finishReason}") — ` +
            `exit 0, but no completed final message.${cause} Re-queue the task, or follow up to continue the session.`;
    }
    if (failure) {
        output = `${output}\n[driver] gate "${failure.name}" failed (exit ${failure.exitCode})\n${failure.output}`;
    }
    if (helperFailure) {
        output =
            `${output}\n[driver] helper "${helperFailure.helperId}" failed ` +
            `(${helperFailure.result.reason}): ${helperFailure.result.message}`;
    }
    return output;
}

/** Reports the run's final verdict to the board, after settle() and any publish attempt. */
async function reportFinish(rt: LoopRuntime, finish: FinishCtx): Promise<void> {
    const { job, outcome, failure, helperFailure, published } = finish;
    const { log } = rt;
    const publishUnlanded = published !== null && !published.ok;
    const status =
        outcome.exitCode === 0 &&
        !outcome.timedOut &&
        !outcome.cacheLost &&
        !failure &&
        !helperFailure &&
        !isPrematureFinish(outcome) &&
        !publishUnlanded
            ? 'succeeded'
            : 'failed';
    const exitCode = failure ? failure.exitCode : outcome.exitCode;
    const output = buildOutput(rt, finish, publishUnlanded);
    const publication = publicationOf(published);

    const verdict = await report(rt, job, {
        status,
        exitCode,
        output,
        contextTokens: outcome.contextTokens ?? null,
        contextCostUsd: outcome.costUsd ?? null,
        // A number only: an unmeasured read stays off the report and the board stores null.
        ...(typeof outcome.agentTurns === 'number' ? { agentTurns: outcome.agentTurns } : {}),
        // The run's last words, when the close-time read lifted them; absent stays absent.
        ...(outcome.summary ? { summary: outcome.summary } : {}),
        ...(publication ? { publication } : {}),
    });
    log(
        verdict === 'lost'
            ? `job ${job.id}: finished ${status}, but the board had already reclaimed it`
            : `job ${job.id}: ${status} (exit ${exitCode}${failure ? ', gates' : ''}${helperFailure ? ', helper' : ''})`
    );
}

/** The verdict is reported, then the task worktree reclaim barrier is armed — see `report` in loop.ts. */
async function report(rt: LoopRuntime, job: BoardJob, result: Parameters<Board['complete']>[1]): Promise<LeaseState> {
    return rt.report(job, result);
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
        await report(rt, job, { status: 'failed', exitCode: null, output: executorRefusal }).catch((e: Error) =>
            log(`job ${job.id}: could not report the executor failure: ${e.message}`)
        );
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
        await report(rt, job, { status: 'failed', exitCode: null, output: promptRefusal }).catch((e: Error) =>
            log(`job ${job.id}: could not report the master-prompt failure: ${e.message}`)
        );
        return;
    }

    const state = newJobState();
    const beating = heartbeat(rt, job, state);
    // Armed before the run so the runner can hand over tails from its first chunk.
    const onOutput = watchOutput(rt, job, state);
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

        const ctx: AttemptCtx = { rt, job, state, settle, standDown };
        const gateSession = await runSetup(ctx);
        if (gateSession === STOOD_DOWN) return;

        try {
            const outcome = await runAttempt(ctx, { session, gateSession, executorType, onOutput });
            if (outcome.done) return;
            const helperFailure = await runPostHelperPhase(rt, job, state);
            const published = await publishIfDue(rt, job, {
                outcome: outcome.outcome,
                failure: outcome.failure,
                helperFailure,
            });
            await settle();
            await reportFinish(rt, {
                job,
                outcome: outcome.outcome,
                failure: outcome.failure,
                helperFailure,
                published,
            });
        } finally {
            if (gateSession) releaseGateSession(rt, gateSession);
        }
    } catch (e) {
        // The container never ran — docker is missing, or the daemon refused. Deliberately NOT
        // reported as a failed job: that would blame the command for the driver's problem. The
        // lease simply expires and the job is offered again, which is visible in `attempts`.
        await settle();
        log(`job ${job.id}: could not run, leaving it to the lease: ${(e as Error).message}`);
    }
}
