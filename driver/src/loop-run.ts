import { randomUUID } from 'node:crypto';
import type { BoardJob, VerdictEvidence } from './board.js';
import { evidenceDecision, evidencePolicyActive, type GatesOutcome, gatesEvidenceOf } from './evidence-policy.js';
import type { DeadService, RunOutcome, RunSession } from './runner.js';
import { preHelperStep, runPostHelperPhase } from './loop-helpers.js';
import type { GateFailure, GateSession } from './loop-gates.js';
import {
    beginGates,
    closeRunControl,
    openRunControl,
    probeDeadServices,
    releaseGateSession,
    runDeclaredGates,
} from './loop-gates.js';
import { heartbeat, newJobState, raceStep, stopIfDraining, watchOutput } from './loop-attempt.js';
import type { GateRunNote } from './timeout-note.js';
import { concludeSetup, handBackFence, releaseAbandonedSync, standDown } from './loop-fence.js';
import type { AttemptCtx, LoopRuntime, SetupConclusion } from './loop-types.js';
import { STOOD_DOWN } from './loop-types.js';
import type { HelperFailureReport } from './helpers.js';
import { TRANSIENT_SYNC_REASON, type PublishResult, type SyncResult } from './publish.js';
import { agentFaults, gatesEligible, ledgerOf, postHelperSkipWhy, skipWhyOf } from './loop-ledger.js';
import {
    askPublishToken,
    publishBranch,
    publishModeOf,
    publishOptionsOf,
    report,
    reportFinish,
} from './loop-verdict.js';
import { OPENCODE } from './executors.js';
import { masterPromptRefusalReason } from './master-prompt.js';
import { uploadRunArtifacts } from './artifacts.js';
import { AGENTLESS_OUTCOME, isAgentless } from './loop-agentless.js';
import { awaitSyncTurn } from './sync-queue.js';

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
    if (job.executorRefusal) return job.executorRefusal;
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
async function waitReclaimBarrier(ctx: AttemptCtx): Promise<SetupConclusion | null> {
    const { rt, job, state } = ctx;
    const inflight = rt.reclaims.get(job.rootJobId ?? job.id);
    return inflight && (await raceStep(state.signal, inflight)) === null ? STOOD_DOWN : null;
}

/** Syncs the task worktree with the remote default (or restores it), racing the stand-down. */
async function syncCheckoutStep(ctx: AttemptCtx): Promise<SetupConclusion | null> {
    const { rt, job, state } = ctx;
    const { runner } = rt;
    const turn = await awaitSyncTurn(ctx);
    if (turn === STOOD_DOWN || 'halt' in turn) return turn;
    const syncing = runner.syncCheckout(job, state.signal);
    turn.release(syncing);
    let syncedOut: { value: SyncResult } | null;
    try {
        syncedOut = await raceStep(state.signal, syncing);
    } catch (e) {
        // A sync that threw took its own claim down inside the runner, so nothing is held here.
        return { halt: 'leave', log: `checkout sync threw, leaving it to the lease: ${(e as Error).message}` };
    }
    if (syncedOut === null) {
        // The abandoned sync owns the claim until it answers, and nothing this attempt settles can
        // release one it never took — so it hands back its own when it lands.
        releaseAbandonedSync(rt, job, syncing);
        return STOOD_DOWN;
    }
    const synced = syncedOut.value;
    // An ok sync holds the checkout (kubernetes's claim) with no run yet to release it, so the
    // attempt holds it from here — even when a stand-down landed as the sync finished, in which
    // case the stand-down fence is what gives it back. A failed sync released its own.
    if (synced.ok) {
        ctx.fenced = true;
        ctx.treeBefore = synced.fingerprint ?? null;
        return null;
    }
    if (synced.reason !== null && TRANSIENT_SYNC_REASON.test(synced.reason)) {
        /*
         * Lock contention on the shared checkout (issues #307, #559) is infrastructure, not a
         * verdict: this driver's own syncs of the clone are queued above, so the lock the
         * script waited out is another driver's (or, on docker, a stood-down sibling's sync
         * container still finishing), or the fetch kept losing ref locks to a concurrent git. The claim goes straight back to the board, which refunds the
         * attempt and defers the next claim. The kubernetes checkout claim was already
         * released inside `syncCheckout` before it answered, the same discipline the
         * ordinary sync-failure refusal below relies on.
         */
        return { halt: 'requeue', log: `checkout sync was lock-blocked, requeueing: ${synced.reason}` };
    }
    return {
        halt: 'fault',
        log: `checkout sync failed: ${synced.reason}`,
        verdict: {
            status: 'failed',
            exitCode: null,
            output: `The checkout could not be synced with the remote before the run: ${synced.reason}`,
            failureKind: 'runner_error',
        },
    };
}

/**
 * Re-reads the claim's gates decision now that the sync has freshened the tree, and refuses the
 * job when its `.bellows.yaml` cannot be read, or declares gates this driver cannot run.
 */
async function rereadGatesStep(ctx: AttemptCtx): Promise<SetupConclusion | null> {
    const { rt, job, state } = ctx;
    const { board, log } = rt;

    const freshOut = await raceStep(state.signal, board.rereadGates(job, state.signal));
    if (freshOut === null) return STOOD_DOWN;
    const fresh = freshOut.value;
    if (fresh) {
        job.gates = fresh.gates ?? null;
        job.gateError = fresh.gateError ?? null;
    } else if (job.gatesSource === 'clone') {
        // Issue #444: the claim read the base clone, whose checked-out files may lag the tree this
        // run edits, and nothing replaced that answer — never gate against a stale declaration.
        return {
            halt: 'fault',
            log: "gates re-read refused and the claim's gates came from the base clone, failing",
            verdict: {
                status: 'failed',
                exitCode: null,
                output:
                    "The board refused the post-sync .bellows.yaml re-read, and this claim's gates were read from " +
                    'the base clone, not the task worktree — the run will not be gated against a stale declaration.',
                failureKind: 'runner_error',
            },
        };
    } else {
        log(`job ${job.id}: gates re-read refused, keeping the claim's decision`);
    }

    if (job.gateError) {
        return {
            halt: 'fault',
            log: 'its gates file could not be read, failing',
            verdict: {
                status: 'failed',
                exitCode: null,
                output: `This job's .bellows.yaml could not be read as a gate declaration: ${job.gateError}`,
                failureKind: 'config',
            },
        };
    }

    if (job.gates?.gates?.length && !rt.gates) {
        const why = 'this driver was started with no gate environment configured';
        return {
            halt: 'fault',
            log: 'declares gates this driver cannot run, failing',
            verdict: {
                status: 'failed',
                exitCode: null,
                output: `This job declares verification gates in .bellows.yaml, and ${why}. Re-queue it against a driver built with the GATE_* configuration set.`,
                failureKind: 'runner_error',
            },
        };
    }
    return null;
}

/**
 * Starts the job's gate environment, or answers null for a job that declares none. The last setup
 * step, and the only one with an answer of its own: the session to run the gates with, or the
 * conclusion that ends the attempt here.
 */
async function acquireGateSession(ctx: AttemptCtx): Promise<GateSession | null | SetupConclusion> {
    const { rt, job, state } = ctx;
    try {
        const gateOut = await raceStep(state.signal, beginGates(rt, job, state));
        return gateOut === null ? STOOD_DOWN : gateOut.value;
    } catch (e) {
        return {
            halt: 'fault',
            log: `gate environment failed, failing with a reason: ${(e as Error).message}`,
            verdict: {
                status: 'failed',
                exitCode: null,
                output: `The gate environment declared in .bellows.yaml could not be started: ${(e as Error).message}`,
                failureKind: 'runner_error',
            },
        };
    }
}

/** One setup step: `null` to continue, or the conclusion that ends the attempt here. */
type SetupStep = (ctx: AttemptCtx) => Promise<SetupConclusion | null>;

/** The steps of the setup phase, in order — the reclaim barrier and the sync before anything reads the tree. */
const setupSteps: readonly SetupStep[] = [waitReclaimBarrier, syncCheckoutStep, rereadGatesStep, preHelperStep];

/** Whether a step's answer ends the attempt, rather than answering the gate session to run with. */
const isConclusion = (answer: GateSession | null | SetupConclusion): answer is SetupConclusion =>
    answer === STOOD_DOWN || (answer !== null && 'halt' in answer);

/**
 * Acts on the one conclusion an attempt reached. Every exit from setup goes through here, which is
 * what makes a new refusal safe (issue #472): a stand-down settles the attempt and parks it, and
 * wins over whatever the step concluded — the attempt is down whatever the step found — while a
 * `SetupHalt` hands the claim back, settles, says why and reports it. Answers whether the attempt
 * is finished here; a step that answers `null` with the attempt still up is not.
 */
async function conclude(ctx: AttemptCtx, conclusion: SetupConclusion | null): Promise<boolean> {
    if (await standDown(ctx, 'setup')) return true;
    if (conclusion === null) return false;
    if (conclusion !== STOOD_DOWN) await concludeSetup(ctx, conclusion);
    return true;
}

/**
 * The setup phase of one attempt: the reclaim barrier, the checkout sync, the gates re-read and
 * its refusals, the job's declared PRE block-helper steps, and the gate environment. Answers the
 * gate session to run with (null when the job declares none), or `STOOD_DOWN` when the attempt is
 * finished here — settled, released and reported by this function alone, so the caller must not
 * fall through to the run.
 */
async function runPhases(ctx: AttemptCtx): Promise<GateSession | null | typeof STOOD_DOWN> {
    for (const step of setupSteps) {
        if (await conclude(ctx, await step(ctx))) return STOOD_DOWN;
    }
    const booted = await acquireGateSession(ctx);
    const session = isConclusion(booted) ? null : booted;
    if (await conclude(ctx, isConclusion(booted) ? booted : null)) {
        // A session the boot handed back is released HERE when the attempt ended meanwhile: the
        // caller never runs, so the cleanup that would have released it never comes.
        if (session) releaseGateSession(ctx.rt, session, ctx.job);
        return STOOD_DOWN;
    }
    return session;
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
    /** The services found dead before the gates and restarted for them (issue #560). */
    recoveredServices: DeadService[];
    /**
     * When `runner.run` resolved — the moment the run ended, and the timestamp the timeout
     * note's active/idle verdict is measured at. The verdict builds later: the declared gates,
     * the post-helpers and the session scrape can each run minutes after a kill, and aging the
     * last output from VERDICT time would report a run that was streaming when it died as idle.
     */
    endedAt: number;
    /** Why the declared gates were skipped, or null. */
    gatesSkipped: string | null;
    /** Whether the failed gate's tree differs from the synced one; null when unmeasured. */
    treeChanged: boolean | null;
    /** The revision-bound evidence record; null when no policy is configured. */
    evidence: VerdictEvidence | null;
};

/** What one run needs beyond its `AttemptCtx`: the session, its gates, and its I/O plumbing. */
interface RunInputs {
    session: RunSession | null;
    gateSession: GateSession | null;
    executorType: BoardJob['executorType'];
    onOutput: (tail: string) => void;
}

/** What an agent run leaves behind: its scraped session and its artifacts. An agent-less node leaves neither. */
async function reportRunTail(
    rt: LoopRuntime,
    job: BoardJob,
    executorType: BoardJob['executorType'],
    outcome: RunOutcome
): Promise<void> {
    if (isAgentless(job)) return;
    await reportScrapedSession(rt, job, executorType, outcome);
    await uploadRunArtifacts(rt, job, outcome);
}

/**
 * The spawn: answers the run's outcome, or null when a stand-down landed first (already settled).
 * An agent-less node (issue #503) launches nothing — it answers a clean run for the gates and the
 * publish to follow, after handing back the claim the sync took, since no runner comes to release it.
 */
async function launchRun(
    ctx: AttemptCtx,
    session: RunSession | null,
    onOutput: (tail: string) => void
): Promise<RunOutcome | null> {
    const { rt, job, state } = ctx;
    const agentless = isAgentless(job);
    // Every launched attempt gets a control endpoint (issue #442), minted before the stand-down
    // check so the env the runner is launched with already names it.
    if (!agentless) await openRunControl(rt, job, state);
    // A Stop, lost lease or Remove that landed during setup, before the spawn: nothing runs, and
    // the stand-down fence releases a claim the runner never took.
    if (await standDown(ctx, 'setup')) return null;
    if (agentless) {
        // The services the gates test against start under the checkout claim, as run() starts them.
        const refused = await rt.runner.startServices(job);
        await handBackFence(ctx);
        return refused ?? AGENTLESS_OUTCOME;
    }
    // Reported here, not at attempt start: a setup that concludes the job starts no session, and a
    // session id reported for one would name a conversation that never existed.
    await reportNewSession(rt, job, session);
    state.launched = true;
    // The launch hands the checkout claim to the runner, which releases it when the run ends.
    ctx.fenced = false;

    state.running = true;
    return rt.runner.run(job, session, onOutput).finally(() => {
        state.running = false;
    });
}

/** The run itself: spawn, and resolve to what to report (or nothing). */
async function runAttempt(ctx: AttemptCtx, inputs: RunInputs): Promise<RunPhaseDone | RunPhaseResult> {
    const { rt, job, state, settle } = ctx;
    const { log } = rt;
    const { session, gateSession, executorType, onOutput } = inputs;
    const outcome = await launchRun(ctx, session, onOutput);
    if (outcome === null) return { done: true };
    // The run's end, stamped HERE — not at verdict time: the gates, helpers and session scrape
    // below can run minutes after a kill, and the timeout note's active/idle verdict must
    // describe the run as it ended, not as it was reported.
    const endedAt = Date.now();

    // A draining attempt settles as stopped even after a clean exit: the agent stopped because it
    // was asked to, so no gates, helpers, publish or `complete` follow (issue #442). A stop after
    // the run still reports the session and uploads the artifacts BEFORE the park.
    stopIfDraining(state);
    const lastWords = () => reportRunTail(rt, job, executorType, outcome);
    if (await standDown(ctx, 'its run', lastWords)) return { done: true };

    /*
     * The runner, not this loop, knows what a refused start looks like on its platform, and
     * stamps `started: false` for it. Saying nothing here would rerun the job until attempts
     * run out and retire it dead, blaming the command for infrastructure.
     */
    const leftToLease = leaseLeftWhy(outcome);
    if (leftToLease !== null) {
        await settle();
        log(`job ${job.id}: ${leftToLease}, leaving it to the lease`);
        return { done: true };
    }

    // The artifacts upload HERE (issue #325): while the lease is still live — settle() has
    // deliberately not been called — and before the gates, so a gate suite that runs minutes
    // cannot push the upload past a reclaim. Best-effort throughout; a failed upload costs
    // retention, never the run.
    await reportRunTail(rt, job, executorType, outcome);
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
    const gating = gateSession && !outcome.refused && !state.lost ? gateSession : null;
    // The tree is read BEFORE the gates: a gate that writes a non-ignored artifact (a timestamped
    // report) must not read as the agent's progress. Under an evidence policy it is read gated or
    // not: it is the revision the evidence is bound to.
    const treeAfter = gating || evidencePolicyActive(job) ? await probeTreeNow(ctx) : null;
    if (await standDown(ctx, 'its gates')) return { done: true };
    const gated = gating
        ? await runGatesPhase(ctx, gating, outcome)
        : { failure: null, deadServices: [], gatesSkipped: null, recoveredServices: [] };
    // A cancelled gate answers no failure, so a stand-down during the gates lands here too.
    const treeChanged =
        gated.failure && ctx.treeBefore !== null && treeAfter !== null ? treeAfter !== ctx.treeBefore : null;
    if (await standDown(ctx, 'its gates')) return { done: true };

    const evidence = evidencePolicyActive(job)
        ? { treeBefore: ctx.treeBefore, treeAfter, gates: gatesOutcomeOf(gating !== null, gated) }
        : null;
    return { done: false, outcome, ...gated, endedAt, treeChanged, evidence };
}

/**
 * Why the loop reports no verdict for this outcome and leaves the job to the lease, or null when it
 * reports: a container that never started, or a runner the platform took away (issue #560).
 */
function leaseLeftWhy(outcome: RunOutcome): string | null {
    if (outcome.infraLoss) return `infrastructure loss: ${outcome.infraLoss}`;
    return outcome.started ? null : 'the runner reports the container never started';
}

/** How the declared gates ended for the evidence record: `none` when none were declared to run. */
function gatesOutcomeOf(declared: boolean, gated: GatesPhase): GatesOutcome {
    if (!declared) return 'none';
    if (gated.gatesSkipped !== null || gated.deadServices.length > 0) return 'incomplete';
    return gated.failure ? 'failed' : 'passed';
}

/** What the gates phase of one attempt found: the failed gate, the dead services, or why it skipped. */
interface GatesPhase {
    failure: GateFailure | null;
    deadServices: DeadService[];
    gatesSkipped: string | null;
    /** The services found dead before the gates and restarted for them (issue #560): noted, not faults. */
    recoveredServices: DeadService[];
}

/** The declared gates, unless the run did not finish cleanly or a declared service is dead. */
async function runGatesPhase(ctx: AttemptCtx, gateSession: GateSession, outcome: RunOutcome): Promise<GatesPhase> {
    const { rt, job, state } = ctx;
    const agent = agentFaults(outcome);
    const gatesSkipped = gatesEligible(agent) ? null : skipWhyOf(agent);
    if (gatesSkipped !== null) {
        rt.log(`job ${job.id}: gates skipped — ${gatesSkipped}`);
        // The services' faults are the run's too, gates or not: a blocked agent is the one that
        // most needs to be told its environment was dead (issue #487).
        return {
            failure: null,
            deadServices: await probeDeadServices(rt, job),
            gatesSkipped,
            recoveredServices: [],
        };
    }
    // A gate against a dead service fails on an environment the agent cannot fix, and a
    // failed gate is what the workflow's gate-fix edge spends a round on (issue #423). The
    // services are stateless fixtures, so a dead one is restarted first; only a restart that
    // cannot bring the fleet back is the run's fault (issue #560).
    const deadBefore = await probeDeadServices(rt, job);
    let recoveredServices: DeadService[] = [];
    if (deadBefore.length > 0) {
        const restartFailure = await restartDeadServices(rt, job, state.signal, deadBefore);
        // A stand-down during the restart runs no gates; the caller's fence settles the attempt.
        if (restartFailure === STOOD_DOWN)
            return { failure: null, deadServices: [], gatesSkipped: null, recoveredServices };
        if (restartFailure !== null) {
            const deadServices = deadBefore.map((dead) => ({ ...dead, restartFailure }));
            return { failure: null, deadServices, gatesSkipped: null, recoveredServices };
        }
        recoveredServices = deadBefore;
    }
    const failure = await runDeclaredGates(rt, job, gateSession, state);
    // A service OOM-killed by the suite fails the gate for a reason the agent cannot fix: re-probe.
    const deadAfter = failure ? await probeDeadServices(rt, job) : [];
    return { failure, deadServices: deadAfter, gatesSkipped: null, recoveredServices };
}

/**
 * Restarts the fleet `dead` was found in; null when it is back, else why it is not. Raced against
 * the attempt's stand-down, which also aborts the restart itself: a Stop or lost lease must not
 * wait out its budget, nor see services recreated after the kill took them.
 */
async function restartDeadServices(
    rt: LoopRuntime,
    job: BoardJob,
    signal: AbortSignal,
    dead: readonly DeadService[]
): Promise<string | null | typeof STOOD_DOWN> {
    rt.log(
        `job ${job.id}: ${dead.map(({ name }) => `service "${name}"`).join(', ')} dead before the gates, restarting`
    );
    try {
        return (await raceStep(signal, rt.runner.restartServices(job, signal))) === null ? STOOD_DOWN : null;
    } catch (e) {
        rt.log(`job ${job.id}: the service restart failed: ${(e as Error).message}`);
        return (e as Error).message;
    }
}

/**
 * The post-helpers, then the publish, each fenced on a stand-down: a Stop, lost lease or Remove
 * that lands during either must not push to a tree another attempt owns or open a PR for a
 * deleted thread. Null when the attempt stood down (already settled), nothing left to report.
 */
async function runPostHelpersAndPublish(
    ctx: AttemptCtx,
    outcome: RunPhaseResult
): Promise<{
    helperFailure: HelperFailureReport | null;
    published: PublishResult | null;
    policyRefusal: string | null;
} | null> {
    const { rt, job, state } = ctx;
    const helperFailure = await runPostHelperPhase(rt, job, state, postHelperSkipWhy(outcome.outcome));
    if (await standDown(ctx, 'its post-helpers')) return null;
    const ledger = ledgerOf({ ...outcome, helperFailure, published: null });
    let published: PublishResult | null = null;
    const policyRefusal: string | null = null;
    const mode = publishModeOf(rt, job, ledger);
    if (mode !== null) {
        // The configured evidence is enforced HERE, whatever the agent chose to run: a refusal
        // pushes nothing, and an authorisation binds the push to the revision it assessed. A
        // refused draft is no refusal of its own: the services fault already fails the verdict.
        const decision = evidenceDecision(job.policy, gatesEvidenceOf(outcome.evidence), job.review);
        if (!decision.ok) return { helperFailure, published, policyRefusal: mode === 'draft' ? null : decision.reason };
        const publishToken = await askPublishToken(rt, job);
        // The fence sits BETWEEN the ask and the push: a Stop during the ask killed the runner,
        // and pushing now would outlive it. The push itself is never fenced — it cannot be
        // recalled (issue #472).
        if (await standDown(ctx, 'its publish')) return null;
        published = await publishBranch(rt, job, publishToken, publishOptionsOf(mode, decision.revision));
        // A lease lost while the push ran stands down here WITHOUT reporting what it pushed: the
        // next holder re-runs the publish (`publishBranch` is the one call that is not abortable).
        if (await standDown(ctx, 'its publish')) return null;
        // The agent already shipped its work as a draft: a clean tree leaves nothing to push, and
        // the verdict still carries the publication the agent made.
        if (published?.ok && !published.published && state.draftPublication) published = state.draftPublication;
    }
    return { helperFailure, published, policyRefusal };
}

/** Tells the board the id of a session this attempt starts; a failed report never blocks the run. */
async function reportNewSession(
    rt: LoopRuntime,
    job: BoardJob,
    session: ReturnType<typeof pickSession>
): Promise<void> {
    if (!session || session.resume) return;
    try {
        await rt.board.session(job, session.id);
    } catch (e) {
        rt.log(`job ${job.id}: could not report the session, continuing: ${(e as Error).message}`);
    }
}

/**
 * The task tree's fingerprint as the run left it, before the gates; compared with the startup
 * sync's to answer whether the tree moved. Null when unknown: no before-fingerprint, no probe, or
 * a probe that failed.
 */
async function probeTreeNow(ctx: AttemptCtx): Promise<string | null> {
    const { rt, job, treeBefore, state } = ctx;
    if (treeBefore === null || !rt.runner.probeTree) return null;
    // The attempt's own signal is the probe's transport abort AND the race: a stand-down cancels
    // the request in flight and stops waiting on it, and the caller rechecks (issue #472).
    const raced = await raceStep(
        state.signal,
        rt.runner.probeTree(job, state.signal).catch(() => null)
    );
    return raced?.value ?? null;
}

/** The ad-hoc gate history one attempt's timeout note quotes, read before the session's teardown. */
function gateHistory(rt: LoopRuntime, gateSession: GateSession | null): readonly GateRunNote[] {
    if (gateSession === null) return [];
    return rt.gates?.server.lastRuns(gateSession.token) ?? [];
}

/**
 * A launch the board refused in the claim itself: the executor selection (`runner_error`), then
 * the selected skills (issue #545: `config`, since the member fixes the settings or the selection
 * and retries). True when the task was failed here and nothing may launch.
 */
async function failOnClaimRefusal(rt: LoopRuntime, job: BoardJob): Promise<boolean> {
    const executorRefusal = executorRefusalReason(rt, job);
    const [reason, failureKind, what] = executorRefusal
        ? ([executorRefusal, 'runner_error', 'executor selection'] as const)
        : ([job.skillRefusal, 'config', 'selected skills'] as const);
    if (!reason) return false;
    rt.log(`job ${job.id}: ${what} is not runnable, failing`);
    await report(rt, job, { status: 'failed', exitCode: null, output: reason, failureKind }).catch((e: Error) =>
        rt.log(`job ${job.id}: could not report the ${what} failure: ${e.message}`)
    );
    return true;
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
    if (await failOnClaimRefusal(rt, job)) return;

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
        if (state.graceTimer) clearTimeout(state.graceTimer);
        state.wake();
        await beating;
    };

    /*
     * Lands a verdict the heartbeat observed before the runner spawned — a Stop, a lost lease
     * or a Remove that arrived while this attempt was still syncing its checkout or booting
     * its gate environment (issue #126). `standDown` (`loop-fence.ts`) is the only thing that
     * acts on one: it releases a claim the runner never took, settles and parks the attempt.
     */
    const ctx: AttemptCtx = { rt, job, state, settle, fenced: false, treeBefore: null };
    try {
        log(
            `job ${job.id}: attempt ${job.attempts} ` +
                (session
                    ? `${session.resume ? 'resuming' : 'starting as'} session ${session.id}`
                    : 'starting (headless opencode run: no session id)')
        );

        const gateSession = await runPhases(ctx);
        if (gateSession === STOOD_DOWN) return;
        state.gateToken = gateSession?.token ?? null;
        // A stand-down kills the runner, but not a gate its agent asked for: the token dies and
        // every ad-hoc run of it in flight is cancelled the moment the verdict lands.
        if (gateSession)
            state.signal.addEventListener('abort', () => rt.gates?.server.cancel(gateSession.token), {
                once: true,
            });

        try {
            const outcome = await runAttempt(ctx, { session, gateSession, executorType, onOutput });
            if (outcome.done) return;
            const closing = await runPostHelpersAndPublish(ctx, outcome);
            if (closing === null) return;
            const { helperFailure, published, policyRefusal } = closing;
            await settle();
            // The liveness read and the gate verdicts are read BEFORE the finally below
            // releases the gate session — unregistering clears the recorded runs.
            await reportFinish(rt, {
                job,
                outcome: outcome.outcome,
                failure: outcome.failure,
                deadServices: outcome.deadServices,
                recoveredServices: outcome.recoveredServices,
                helperFailure,
                published,
                endedAt: outcome.endedAt,
                deadlineExtensionMs: state.deadlineExtensionMs,
                activity: outputPump.snapshot(),
                gateRuns: gateHistory(rt, gateSession),
                gatesSkipped: outcome.gatesSkipped,
                treeChanged: outcome.treeChanged,
                evidence: outcome.evidence,
                policyRefusal,
            });
        } finally {
            closeRunControl(rt, state);
            if (gateSession) releaseGateSession(rt, gateSession, job);
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
        // A killed run can reject (the runner's own Job vanished under it): the stand-down
        // that killed it owns the settlement, not the lease.
        stopIfDraining(state);
        if (await standDown(ctx, 'its run')) return;
        // A throw is the path that would otherwise leak the claim: no runner ever launched, so none
        // of them releases it, and it would sit there until the cluster noticed (issue #469).
        await handBackFence(ctx);
        await settle();
        log(`job ${job.id}: could not run, leaving it to the lease: ${(e as Error).message}`);
    }
}
