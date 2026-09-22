import { randomUUID } from 'node:crypto';
import type { Board, BoardJob, HeartbeatVerdict, LeaseState, Reclaim, ReclaimAck, RuntimeReport } from './board.js';
import type { DriverConfig } from './config.js';
import { currentActivity, envFileBody, tailBytes, workspacePathOf } from './docker.js';
import type { GateManager, GateServer } from './gates.js';
import type { RunOutcome, RunSession, Runner, RuntimeSample } from './docker.js';
import type { PublishResult, ReclaimResult, SyncResult } from './publish.js';
import { worktreeRelDir } from './publish.js';

export interface Loop {
    /** Resolves once `stop()` has been called and every in-flight job has finished. */
    start(): Promise<void>;
    stop(): void;
}

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

export interface LoopDeps {
    board: Board;
    runner: Runner;
    config: DriverConfig;
    gates?: GateStack;
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The bridge connects a few seconds in; two minutes of looking is generous and bounded. */
const REMOTE_POLL_MS = 3_000;
const REMOTE_LOOKUPS = 40;

/** How often freshly arrived output is flushed to the board — the pace the dashboard polls at. */
const PROGRESS_MS = 2_000;

/**
 * How often the heartbeat polls while the attempt is still SETTING UP — before the runner exists.
 * The run phase paces its beats at a third of the lease (100s at the default), which would leave a
 * Stop issued while the dashboard says "Waiting for the executor…" unobserved for a minute and a
 * half — through the whole checkout sync and gate-environment boot (issue #126). The setup phase
 * polls at this pace instead, so a stop there is answered — the attempt stands down without
 * spawning — within one period, and the row settles `stopped` right away.
 */
const SETUP_POLL_MS = 2_000;

interface JobState {
    finished: boolean;
    lost: boolean;
    /**
     * True once the board answered a Stop while this attempt ran: the container is killed and the
     * run is settled on the board — the turn ends, and the session it kept is what the follow-up
     * continues (docs/jobs.md).
     */
    stopped: boolean;
    /**
     * True once the board answered that the thread was removed while this attempt ran. The
     * container is killed and nothing is parked or reported: the rows are gone and the tree now
     * belongs to the queue's reclaim.
     */
    removed: boolean;
    /**
     * True once `runner.run` has been called. The heartbeat paces itself at `SETUP_POLL_MS` until
     * this turns — a verdict arriving during the setup phase must be answered in seconds, not a
     * beat period — and at the lease's third afterwards (issue #126).
     */
    launched: boolean;
    /** Resolves the moment the run ends, so the heartbeat can stop waiting out its period. */
    woken: Promise<void>;
    wake: () => void;
    /**
     * Resolves the moment any verdict ends the attempt where it stands — stop, lost lease, Remove.
     * The setup races (raceStep) wait on this, so a slow sync or gate boot stops holding a
     * stand-down in place.
     */
    abort: Promise<void>;
    abortNow: () => void;
}

/**
 * One gated job's live registration: the checkout key its environment is filed under, the token
 * the runner's agent presents to the ad-hoc endpoint, and the gates the job's `.bellows.yaml`
 * declared. Lives from before the agent starts until the run's exit paths have all been walked.
 * The image and env body the environment was created with ride along so the gates pass can
 * re-acquire — carried, not recomputed, because a body recomputed at gates time would fold in
 * the minted `BELLOWS_GATE_*` lines that only exist after `beginGates` has registered them.
 */
interface GateSession {
    key: string;
    token: string;
    image: string;
    envBody: string;
    declared: readonly { name: string; command: string }[];
}

interface GateFailure {
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

function newJobState(): JobState {
    let wake = () => {};
    const woken = new Promise<void>((resolve) => {
        wake = resolve;
    });
    let abortNow = () => {};
    const abort = new Promise<void>((resolve) => {
        abortNow = resolve;
    });
    return {
        finished: false,
        lost: false,
        stopped: false,
        removed: false,
        launched: false,
        woken,
        wake,
        abort,
        abortNow,
    };
}

/** The verdicts that end an attempt where it stands: a stop, a lost lease, a removed thread. */
const down = (state: JobState): boolean => state.stopped || state.lost || state.removed;

/** The loser side of every setup race: the stand-down resolved, the step did not. */
const RACE_LOST = Symbol('raceStep: the stand-down won');

/**
 * Races one slow setup step against the attempt's stand-down, so a Stop (or a lost lease, or a
 * Remove) observed while the driver is "waiting for the executor" ends the wait within a
 * heartbeat's setup poll instead of the step's own unbounded duration (issue #126). Answers null
 * when the stand-down won and the step is STILL RUNNING: the caller stands the attempt down and
 * the step is abandoned to its own cleanup — which is why a rejection is swallowed here, the
 * abandoned step's finally is the only cleanup it needs and its verdict is nobody's business
 * anymore. A step that finished first answers `{ value }` even when the stand-down landed in the
 * same instant — the caller's own flag check decides.
 */
async function raceStep<T>(state: JobState, step: Promise<T>): Promise<{ value: T } | null> {
    // A side-band subscriber, so the loser of the race can never become an unhandled rejection:
    // subscribing neither consumes the step from the race nor changes its result.
    step.catch(() => {});
    const lost = state.abort.then((): typeof RACE_LOST => RACE_LOST);
    const outcome: T | typeof RACE_LOST = await Promise.race([step, lost] as const);
    return outcome === RACE_LOST ? null : { value: outcome };
}

export function createLoop({ board, runner, config, gates, log = () => {}, sleep = wait }: LoopDeps): Loop {
    let running = true;
    const active = new Set<Promise<void>>();

    /*
     * In-flight worktree reclaims, keyed by the thread's ROOT id (`rootJobId ?? id`, the same
     * reading worktreeRelDir uses — the key the task worktree itself is filed under). report()
     * registers the reclaim here before it starts and drops the entry when it settles; the
     * attempt waits on its root's entry before its startup sync (runJob, issue #126 moved the
     * wait in from the claim loop), so a follow-up claimed while the
     * thread's tree is being removed waits out the removal instead of syncing against it. This
     * closes the race for reclaims and claims that both leave THIS driver; it cannot close it
     * across drivers — docker's documented bound is one driver per daemon (docs/jobs.md), and
     * under kubernetes reclaimWorktree holds the checkout claim for the removal's duration,
     * which is what makes it mutually exclusive with a follow-up's claim-taking sync there.
     */
    const reclaims = new Map<string, Promise<void>>();

    /**
     * Beats until the run finishes.
     *
     * The beat comes FIRST, not after a full period: the stop flag is read the moment the attempt
     * exists, so the first observation never waits out a whole lease third (issue #126). The pace
     * is `SETUP_POLL_MS` while the runner has not spawned — the phase a stop must interrupt in
     * seconds — and a third of the lease once it has.
     *
     * A 409 means the lease was reclaimed while this container was still working: the job belongs
     * to another worker now, so this one is killed rather than left to finish and report. The board
     * would refuse the report anyway — but by then the two runs have both been writing to the same
     * checkout, which is the thing actually worth preventing. A 404 means the thread was REMOVED
     * (issue #41): same kill, and nothing left to park against or report to. A Stop — the board
     * answers `cancelRequested` on a still-held beat — kills the container too, and the board
     * settles the run `stopped` when the park lands: the turn ends, and the session survives for
     * the follow-up that continues the conversation.
     */
    function heartbeat(job: BoardJob, state: JobState): Promise<void> {
        const every = Math.max(1_000, Math.floor((config.leaseSeconds * 1000) / 3));
        return (async () => {
            let complained = false;
            while (!state.finished && !down(state)) {
                let verdict: HeartbeatVerdict | undefined;
                try {
                    verdict = await board.heartbeat(job);
                    complained = false;
                } catch (e) {
                    // A board that is briefly unreachable is not a lost lease. Keep working: the
                    // lease outlives several missed beats, and giving up here would kill a run
                    // over one failed request. Rate-limited to the first failure in a row — at
                    // the setup poll's pace a long outage must not write a log line every two
                    // seconds.
                    if (!complained) {
                        complained = true;
                        log(`job ${job.id}: heartbeat failed, continuing: ${(e as Error).message}`);
                    }
                }
                if (verdict !== undefined) {
                    if (verdict === 'lost') {
                        state.lost = true;
                        log(`job ${job.id}: lease lost, killing the runner`);
                    } else if (verdict === 'removed') {
                        state.removed = true;
                        log(`job ${job.id}: removed while it ran, killing the runner`);
                    } else if (verdict.cancelRequested) {
                        state.stopped = true;
                        log(`job ${job.id}: stop requested, killing the runner`);
                    }
                    if (down(state)) {
                        // The flag lands before the kill: the setup races read the abort signal,
                        // so a slow teardown never holds the stand-down in place.
                        state.abortNow();
                        if (state.launched) {
                            await runner.kill(job);
                        } else {
                            // Before the spawn there is no container — the kill is best-effort
                            // reclamation, and both executors swallow its rejections. Awaited,
                            // an unresponsive daemon would hold `beating`, and with it settle()
                            // and the stop's park, past the setup poll period. Settlement must
                            // not wait on it; the kill still runs, unobserved.
                            void runner.kill(job).catch(() => {});
                        }
                    }
                }
                if (state.finished || down(state)) return;
                // Raced against the run finishing, not simply awaited. A plain sleep would hold
                // every finished job for the remainder of the period before its result could be
                // reported; a settled stop, lease or Remove resolves `abort` for the setup races
                // and `woken` ends the loop outright.
                await Promise.race([sleep(state.launched ? every : SETUP_POLL_MS), state.woken]);
            }
        })();
    }

    /**
     * Polls the running container for the Remote Control id and reports the first one it sees.
     *
     * Unlike the local session id this cannot be minted in advance — Anthropic's backend assigns it
     * when the bridge connects, a few seconds into the run — so the worker has to go and find it.
     * It is the id the Claude UI addresses the session by, and therefore the one a link is built
     * from.
     *
     * Gives up quietly after `REMOTE_LOOKUPS` tries: a session that has not registered by then is a
     * Remote Control that did not connect, and the run is no less valid for it.
     */
    function watchRemote(job: BoardJob, session: RunSession, state: JobState): Promise<void> {
        return (async () => {
            for (let i = 0; i < REMOTE_LOOKUPS && !state.finished && !state.lost; i += 1) {
                await Promise.race([sleep(REMOTE_POLL_MS), state.woken]);
                if (state.finished) return;
                let remote: string | null;
                try {
                    remote = await runner.remoteSessionId(job, session.id);
                } catch (e) {
                    log(`job ${job.id}: could not read the remote session: ${(e as Error).message}`);
                    return;
                }
                if (!remote) continue;
                try {
                    await board.session(job, session.id, remote);
                    log(`job ${job.id}: remote session ${remote}`);
                } catch (e) {
                    log(`job ${job.id}: could not report the remote session: ${(e as Error).message}`);
                }
                return;
            }
        })();
    }

    /**
     * Streams the runner's output tail to the board while the run goes, so the dashboard shows the
     * work instead of a spinner.
     *
     * The runner calls back with its newest tail whenever it has one; this flushes at most once
     * per period, and only what changed — the runner's chunk rate is the container's, the board's
     * is this period. A sample of the container's vitals rides the same flush: at most one
     * `docker stats` round-trip in flight at a time, kicked each period, and a flush fires when
     * EITHER the tail or the sample changed — a quiet agent burning CPU is exactly the "is it
     * stuck" question this answers, so the sample alone is worth a report (it travels only once a
     * tail exists; a run with no output at all has nothing to show vitals beside).
     *
     * Deliberately not a second heartbeat. A `409` here is NOT acted on — the heartbeat is the one
     * place that decides a superseded run must die (docs/jobs.md) — and a failure costs freshness,
     * never the run, because the complete report carries the final tail regardless.
     */
    function watchOutput(job: BoardJob, runner: Runner, state: JobState): (tail: string) => void {
        let latest: string | null = null;
        let sent: string | null = null;
        // A box, not a bare variable: the sample is written from the sampling callback, and a bare
        // `let` read after the await would have TypeScript narrowing it to the initial null.
        const sample: { value: RuntimeSample | null } = { value: null };
        let sentSample: RuntimeSample | null = null;
        let sampling = false;
        let complained = false;
        void (async () => {
            while (!state.finished && !state.lost) {
                await Promise.race([sleep(PROGRESS_MS), state.woken]);
                if (state.finished || state.lost) return;
                // The pump starts with the attempt now, but the runner does not exist until
                // launch — sampling before that is a daemon lookup per period that can answer
                // nothing (issue #126 moved the start earlier to cover the setup phase).
                if (!state.launched) continue;
                if (!sampling) {
                    sampling = true;
                    runner
                        .sampleRuntime(job)
                        .then((read) => {
                            if (read) sample.value = { ...read, sampledAt: new Date().toISOString() };
                        })
                        .catch(() => {})
                        .finally(() => {
                            sampling = false;
                        });
                }
                const sampled = sample.value !== sentSample;
                if (latest === null || (latest === sent && !sampled)) continue;
                sent = latest;
                sentSample = sample.value;
                const runtime: RuntimeReport | null = sample.value
                    ? {
                          cpuPercent: sample.value.cpuPercent,
                          memUsedMb: sample.value.memUsedMb,
                          memPercent: sample.value.memPercent,
                          // The attempt's service fleet, when the attempt declared any — absent
                          // (never an empty array) otherwise, so the wire shape of a service-less
                          // job is byte-identical to what it always was.
                          ...(sample.value.services ? { services: sample.value.services } : {}),
                          // Derived at flush, from the tail being flushed — the activity line and
                          // the numbers must describe the same moment.
                          activity: currentActivity(latest),
                          sampledAt: sample.value.sampledAt,
                      }
                    : null;
                let verdict: 'held' | 'lost';
                try {
                    verdict = await board.progress(job, latest, runtime ?? undefined);
                    complained = false;
                } catch (e) {
                    // Rate-limited to the first failure in a row: a board unreachable for a
                    // three-hour session must not write a log line every two seconds.
                    if (!complained) {
                        complained = true;
                        log(`job ${job.id}: could not stream output, continuing: ${(e as Error).message}`);
                    }
                    continue;
                }
                // The board no longer recognises this attempt. Killing the container is the
                // heartbeat's verdict alone; this pump just stops talking.
                if (verdict === 'lost') return;
            }
        })();
        return (tail) => {
            latest = tail;
        };
    }

    /**
     * Ensures the job's gate environment and registers its ad-hoc token, or answers null for a
     * job that has no gates. The token and URL ride the claim's env into the runner's env file —
     * appended after the claim's own lines, where docker's last-wins rule keeps a member-scoped
     * `BELLOWS_GATE_TOKEN` from minting itself a gate credential.
     */
    async function beginGates(job: BoardJob, state: JobState): Promise<GateSession | null> {
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
    async function runDeclaredGates(
        job: BoardJob,
        gateSession: GateSession,
        state: JobState
    ): Promise<GateFailure | null> {
        if (!gates) return null;
        const results: GateReport[] = [];
        const report = async (): Promise<void> => {
            try {
                // A copy, not the live array: the report is a state-at-a-moment, and a reader
                // (or stub) holding it must not see gates move after the fact.
                // A 409 here is not a kill order — the heartbeat is the one place that decides a
                // superseded run must die (docs/jobs.md); this pump only ever loses freshness.
                await board.gates(job, [...results]);
            } catch (e) {
                log(`job ${job.id}: could not report gate state, continuing: ${(e as Error).message}`);
            }
        };
        // The report must fit the board's 128 KiB body however many gates declared and however
        // verbose they were — JSON escaping can inflate bytes six-fold, so the raw budget per
        // gate shrinks as the list grows (16 gates still get 1 KiB of tail each).
        const perGate = Math.max(1024, Math.floor((16 * 1024) / gateSession.declared.length));
        for (const gate of gateSession.declared) {
            // The lease can be reclaimed mid-gates. Everything after that is dead work on a
            // checkout another attempt owns, and the verdict will be refused anyway.
            if (state.lost) return null;
            results.push({ name: gate.name, status: 'running', exitCode: null, output: null });
            await report();
            // Re-acquire, then run, under one catch: an environment that cannot be revived is a
            // gate that cannot run at all — the same failed-gate shape, never a crash of the run.
            const outcome = await gates.manager
                .acquire(gateSession.key, gateSession.image, gateSession.envBody, job)
                .then(() => {
                    // The heartbeat can mark the lease lost while acquire is pending — a slow
                    // revival or cluster request outlives the beat that said so. Starting the gate
                    // then would run it on a checkout another attempt owns: the same dead work the
                    // check before the acquire refuses.
                    if (state.lost) return null;
                    return gates.manager.runGate(gateSession.key, gate.name, gate.command);
                })
                .catch((e: Error) => ({ exitCode: 125, output: e.message }));
            // `runGate` never answers null, so a null here is the lost-lease abandonment above.
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
                return { name: gate.name, exitCode: outcome.exitCode ?? 125, output: outcome.output };
            }
        }
        return null;
    }

    /**
     * One attempt, end to end: the startup setup (the reclaim barrier, the checkout sync, the
     * gates re-read, the gate environment) and the run itself. The setup lives here rather than in
     * the claim loop so the attempt's state — heartbeat, abort signal, cleanup — covers all of it:
     * a Stop issued while the dashboard says "Waiting for the executor…" interrupts the setup
     * within one heartbeat poll and stands the attempt down before anything spawns (issue #126).
     */
    async function runJob(job: BoardJob): Promise<void> {
        const executorType = job.executorType;
        const executorRefusal =
            executorType === null
                ? 'The selected executor no longer exists. Choose a configured executor and start a new task.'
                : executorType === 'opencode' && config.remoteControl
                  ? 'The selected OpenCode executor cannot run with Remote Control enabled.'
                  : null;
        if (executorRefusal) {
            log(`job ${job.id}: executor selection is not runnable, failing`);
            await report(job, { status: 'failed', exitCode: null, output: executorRefusal }).catch((e: Error) =>
                log(`job ${job.id}: could not report the executor failure: ${e.message}`)
            );
            return;
        }

        const state = newJobState();
        const beating = heartbeat(job, state);
        // Armed before the run so the runner can hand over tails from its first chunk. The pump
        // stops itself the moment the run finishes; the final complete report carries the tail
        // that matters.
        const onOutput = watchOutput(job, runner, state);
        // A resumed job already has its session, and the board already knows it. A fresh one gets
        // one minted here rather than read back from the runner, and reported before the container
        // exists: the whole point is that the board holds the session for the attempt even if the
        // run dies before it produces a line of output.
        //
        // opencode is the exception on both halves, and for the same reason: it mints its own
        // session ids (`ses_…`) and cannot adopt one, so a fresh run gets none — the runner
        // scrapes the id the run used and reports it when the outcome lands. A follow-up claim
        // carries the session opencode itself created, restored via `--session` on the runner.
        const session: RunSession | null =
            executorType === 'opencode'
                ? job.resumeSessionId
                    ? { id: job.resumeSessionId, resume: true }
                    : null
                : job.resumeSessionId
                  ? { id: job.resumeSessionId, resume: true }
                  : { id: randomUUID(), resume: false };

        // (Only under Remote Control, assigned at launch — a headless run registers no bridge, so
        // looking for one would be forty `docker exec`s that can never find anything. Remote
        // Control is claude-code only — the config refuses the combination — and a claude-code job
        // always has a session.)
        let watching: Promise<void> = Promise.resolve();

        const settle = async () => {
            state.finished = true;
            state.wake();
            await Promise.all([beating, watching]);
        };

        /*
         * Lands a verdict the heartbeat observed before the runner spawned — a Stop, a lost lease
         * or a Remove that arrived while this attempt was still syncing its checkout or booting
         * its gate environment (issue #126). A stop parks the row: the board reads its own stop
         * stamp and settles it `stopped` right away, because there is no container to wait out —
         * the runner never spawned. A lost lease and a Remove report nothing, exactly as they do
         * not after a run: the row belongs to its new holder, or to nobody.
         */
        const standDown = async (): Promise<void> => {
            await settle();
            if (state.stopped) {
                const verdict = await board.suspend(job);
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

        /*
         * The session the run actually used, when the runner could only learn it after the fact
         * (opencode scrapes it at close; claude-code's was minted and reported at spawn). Reported
         * while the lease is still live, BEFORE the park or the verdict — a follow-up can only be
         * asked for once the task is finished, and it resumes exactly this. A 'lost' verdict is
         * not acted on: the heartbeat is what kills a superseded run, and losing the link is not
         * losing the job. An opencode run ALWAYS leaves a session, so an empty scrape is the
         * readout having failed every try — said out loud, because the cost is a task that can
         * never take a follow-up, and a verdict without its finish reason or context. The reason
         * says which failure it was: the runner carries the readout's own error line, the docker
         * rejection, or its absence. The stopped path calls this too (issue #152): a stop's park
         * lands the row terminal, and a session reported after it is refused — the stopped task
         * would settle sessionless with nothing to follow up.
         */
        const reportScrapedSession = async (outcome: RunOutcome): Promise<void> => {
            if (outcome.sessionId) {
                try {
                    await board.session(job, outcome.sessionId, null);
                    log(`job ${job.id}: session ${outcome.sessionId}`);
                } catch (e) {
                    log(`job ${job.id}: could not report the session, continuing: ${(e as Error).message}`);
                }
            } else if (executorType === 'opencode') {
                log(
                    `job ${job.id}: the session readout came up empty (${outcome.readoutError ?? 'no session in the database'}) — ` +
                        'no session to follow up, finish reason and context stats unread'
                );
            }
        };

        /*
         * One gate session's teardown: the environment goes back to its cooldown, and the token
         * dies with the attempt — a follow-up's claim registers its own. Shared by the run's
         * cleanup finally and the stand-down branch after beginGates, whose early return
         * bypasses that finally.
         */
        const releaseGateSession = (session: GateSession): void => {
            gates?.server.unregister(session.token);
            gates?.manager.release(session.key);
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
                    await board.session(job, session.id, null);
                } catch (e) {
                    // Losing the link is not losing the job. A 'lost' verdict is not acted on
                    // either — the heartbeat is what kills a superseded run, and duplicating that
                    // here would give two places that decide it.
                    log(`job ${job.id}: could not report the session, continuing: ${(e as Error).message}`);
                }
            }

            /*
             * The reclaim barrier (see `reclaims`): an in-flight removal of THIS thread's
             * tree is waited out before the sync — the first touch of the task worktree — so
             * a follow-up claimed while its thread's tree was being deleted never syncs
             * against, or resurrects work on top of, a tree mid-removal. Raced against the
             * stand-down like every slow setup step: a removal is unbounded, and a stop
             * issued into the wait must not wait it out (issue #126).
             */
            const inflight = reclaims.get(job.rootJobId ?? job.id);
            if (inflight) await raceStep(state, inflight);
            if (down(state)) return standDown();

            /*
             * Before anything reads the tree — the gates refusal just below, the agent this
             * run — the task worktree is made ready to run on. A STARTING claim syncs it
             * with the remote default: fetch, create the worktree branched off
             * origin/<default> or rebase the existing one onto it, autostashing uncommitted
             * edits. Clones are created once and otherwise left untouched by the workspace
             * reconcile, so without this every task after a main update starts from stale
             * code and a stale gates file. A claim that CONTINUES a session — a follow-up,
             * or a parked job resumed — RESTORES instead (issue #58): no fetch, no rebase,
             * the tree kept as the run before it left it or recreated from the surviving
             * thread branch, because git operations that touch the remote belong to a task's
             * beginning and end, never its middle. The runners read the claim and pick the
             * mode. A sync failure fails the
             * attempt with the reason (the tree's state is unknown enough that running on it
             * would compound whatever went wrong), the same author's-problem channel the
             * gates refusal below uses.
             *
             * A sync that THROWS is a different outcome and gets the different answer: the
             * fence each runner now runs inside its sync (docker's sweep, kubernetes's
             * checkout claim) can refuse this attempt — the claim's stand-down against a
             * live newer attempt throws by design. That is the fence's verdict, not the
             * command's, so it is NOT a failed job: the attempt ran nothing, the lease
             * simply expires and the job is offered again, the same answer a runner that
             * cannot start gets below.
             *
             * The sync is raced against the stand-down (issue #126): it is the slowest thing
             * an attempt does before the runner exists — a fresh clone of a large repo, a
             * slow fetch — and a stop issued into it must not wait out the git. A stop that
             * won the race abandons the sync to its own cleanup and hands the checkout fence
             * back only once the sync has settled: kubernetes's failure arm releases the
             * claim inside the runner itself, and a SUCCESSFUL abandoned sync has nothing
             * left live, so the release chained here is safe — the job's pod is already gone.
             */
            const syncing = runner.syncCheckout(job);
            let syncedOut: { value: SyncResult } | null;
            try {
                syncedOut = await raceStep(state, syncing);
            } catch (e) {
                await settle();
                log(`job ${job.id}: checkout sync threw, leaving it to the lease: ${(e as Error).message}`);
                return;
            }
            if (syncedOut === null) {
                void syncing
                    .then((result) => {
                        if (result.ok) return runner.releaseFence?.(job);
                    })
                    .catch(() => {});
                return standDown();
            }
            if (down(state)) {
                // The sync had already finished when the stand-down was observed. An ok sync
                // holds the checkout (kubernetes's claim) with no run ever to release it, so the
                // fence goes back here — the same release the terminal refusals below make; a
                // failed sync released its own claim inside the runner.
                if (syncedOut.value.ok) await runner.releaseFence?.(job);
                return standDown();
            }
            const synced = syncedOut.value;
            if (!synced.ok) {
                await settle();
                log(`job ${job.id}: checkout sync failed: ${synced.reason}`);
                await report(job, {
                    status: 'failed',
                    exitCode: null,
                    output: `The checkout could not be synced with the remote before the run: ${synced.reason}`,
                }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                return;
            }

            /*
             * The claim's gates decision was read from the tree BEFORE the sync freshened
             * it — a repository whose `.bellows.yaml` just arrived would run ungated for its
             * whole first task if the stale answer stood. Re-read now that the tree is
             * current, and let the refusals below act on what the tree actually holds. Null
             * (a refused or lost answer) keeps the claim's decision; nothing here is worth a
             * second writer on the verdict.
             */
            const freshOut = await raceStep(state, board.rereadGates(job));
            if (freshOut === null || down(state)) {
                // The checkout is fenced and held from here until runner.run's cleanup — every
                // exit that skips the run hands the fence back first.
                await runner.releaseFence?.(job);
                return standDown();
            }
            const fresh = freshOut.value;
            if (fresh) {
                job.gates = fresh.gates ?? null;
                job.gateError = fresh.gateError ?? null;
            } else {
                log(`job ${job.id}: gates re-read refused, keeping the claim's decision`);
            }

            /*
             * A gates file that exists but cannot be honoured is a FAILED job with the reason,
             * before anything runs. Reading it as "no gates" would run the task and call the
             * work verified when nothing checked it — the one outcome worse than the failure,
             * and the reason this is a refusal rather than a fallback.
             */
            if (job.gateError) {
                /*
                 * The sync took the checkout (kubernetes's claim) and this refusal never
                 * reaches runner.run, whose cleanup is what releases it — so the fence goes
                 * back here, ownership-checked inside the runner, before the job is failed
                 * and the way to a replacement claimant opens. Without this the
                 * factory-job-<id>-claim ConfigMap would outlive the job indefinitely.
                 */
                await runner.releaseFence?.(job);
                await settle();
                log(`job ${job.id}: its gates file could not be read, failing`);
                await report(job, {
                    status: 'failed',
                    exitCode: null,
                    output: `This job's .bellows.yaml could not be read as a gate declaration: ${job.gateError}`,
                }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                return;
            }

            // Gates need the driver's gate machinery, which exists whenever the stack was
            // built for the executor — under both executors it is. A driver built without
            // it gets the honest answer: a named failure, never a run whose declared
            // checks silently did not happen.
            if (job.gates?.gates?.length && !gates) {
                // Same as the gateError refusal above: this branch completes the job without
                // runner.run, so the checkout the sync fenced is released here, not held
                // forever by a claim whose attempt never runs.
                await runner.releaseFence?.(job);
                await settle();
                const why = 'this driver was started with no gate environment configured';
                log(`job ${job.id}: declares gates this driver cannot run, failing`);
                await report(job, {
                    status: 'failed',
                    exitCode: null,
                    output: `This job declares verification gates in .bellows.yaml, and ${why}. Re-queue it against a driver built with the GATE_* configuration set.`,
                }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                return;
            }

            /*
             * The gate environment comes up BEFORE the agent does, because the agent's ad-hoc
             * gate calls land mid-run — "partially run tests" happens while the session is
             * working, not after it. A failure here is the author's problem (an image the daemon
             * cannot fetch, an env value no env file can carry), not the command's: the job is
             * FAILED with that reason rather than left to a lease that would retry a typo
             * forever.
             */
            let gateSession: GateSession | null = null;
            try {
                const gateOut = await raceStep(state, beginGates(job, state));
                gateSession = gateOut === null ? null : gateOut.value;
                if (down(state)) {
                    // This return skips the run try's cleanup finally below, so a session the
                    // caller now holds is released here — the same teardown the finally makes,
                    // not a duplicate: beginGates' own checks released only what existed before
                    // it handed the session back.
                    if (gateSession) {
                        releaseGateSession(gateSession);
                        gateSession = null;
                    }
                    await runner.releaseFence?.(job);
                    return standDown();
                }
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
                return;
            }
            try {
                // The last look before the spawn: a verdict landing between the check above and
                // the runner's own setup would otherwise start a container over a stop the
                // driver already knows about (issue #126). From here the heartbeat paces itself
                // at the lease's third — the run phase's rhythm.
                if (down(state)) {
                    await runner.releaseFence?.(job);
                    return standDown();
                }
                state.launched = true;
                watching = config.remoteControl && session ? watchRemote(job, session, state) : Promise.resolve();

                const outcome = await runner.run(job, session, onOutput);

                if (state.lost) {
                    await settle();
                    return;
                }

                if (state.removed) {
                    // The heartbeat already killed the container. The thread's rows are gone and
                    // its tree belongs to the queue's reclaim (issue #41): nothing to park against,
                    // nobody to hand a verdict to — the job finishes by being gone.
                    await settle();
                    log(`job ${job.id}: removed while it ran; the queue owns the tree`);
                    return;
                }

                if (state.stopped) {
                    // The heartbeat already killed the container. The park is the user's stop
                    // landing: the board reads its own stop stamp and settles the row `stopped` —
                    // the turn ends, the session is kept for the follow-up that continues the
                    // conversation. Reporting an exit code here would make a killed run
                    // indistinguishable from one that ended on its own (docs/jobs.md).
                    // The scraped session goes first (issue #152): under opencode the id is only
                    // learned at close, and the board accepts the report only while the row still
                    // runs under this lease — park first and the stopped task settles sessionless,
                    // with no follow-up to continue it. The scrape is awaited by both runners
                    // before the outcome resolves, so the id here is final.
                    await settle();
                    await reportScrapedSession(outcome);
                    const verdict = await board.suspend(job);
                    log(
                        verdict === 'lost'
                            ? `job ${job.id}: stopped, but the board had already reclaimed it`
                            : `job ${job.id}: stopped, the board has settled the turn`
                    );
                    return;
                }

                /*
                 * The runner, not this loop, knows what a refused start looks like on its platform,
                 * and stamps `started: false` for it — docker from its daemon-error signature, a
                 * container that never existed. This loop interprets no exit codes: a pod that
                 * genuinely exited 125 started and finished, and that is a verdict to report. Saying
                 * nothing here would rerun the job until attempts run out and retire it dead, blaming
                 * the command for infrastructure — the same rule the catch below applies to a spawn
                 * that never happened. The lease expires and the job is offered again.
                 */
                if (!outcome.started) {
                    await settle();
                    log(`job ${job.id}: the runner reports the container never started, leaving it to the lease`);
                    return;
                }

                // Parked, not finished: the container is gone, the session is kept, and the job goes
                // back on the board for somebody to pick up from the Claude UI. Reporting an exit code
                // here would make an idle session indistinguishable from a run that ended — and
                // running the gates of a session somebody is still driving would report a verdict
                // about a conversation that has not ended.
                if (outcome.idled) {
                    await settle();
                    const verdict = await board.suspend(job);
                    log(
                        verdict === 'lost'
                            ? `job ${job.id}: idle, but the board had already reclaimed it`
                            : `job ${job.id}: idle for ${config.idleMs}ms, parked on standby`
                    );
                    return;
                }

                // The session the run actually used, when the runner could only learn it after the
                // fact (opencode scrapes it at close). Reported while the lease is still live, BEFORE
                // the verdict — a follow-up can only be asked for once the task is finished, and it
                // resumes exactly this. A 'lost' verdict is not acted on: the heartbeat is what kills
                // a superseded run, and losing the link is not losing the job.
                await reportScrapedSession(outcome);

                /*
                 * The gates run HERE: after the agent has finished talking and before the verdict,
                 * with the heartbeat still beating — settle() has deliberately NOT been called yet,
                 * because a test suite can take minutes and it must not outrun the lease it runs
                 * under. This is the "gates pass prior to push" enforcement this system can
                 * honestly make: a run is never reported succeeded while a declared gate fails,
                 * and the failing gate's output rides in the verdict the author reads.
                 */
                let failure: GateFailure | null = null;
                if (gateSession) failure = await runDeclaredGates(job, gateSession, state);

                /*
                 * A zero exit code is not proof of completion. opencode records HOW the run's last
                 * message ended, and `length` — the model's context limit, hit mid-task — exits 0
                 * like a real finish does. The runner scrapes the reason at close; a reason that
                 * is anything but `stop` is a run that stopped talking, and reporting it
                 * succeeded would hang a green verdict over a task no work was finished on. A
                 * scrape that found nothing (or never ran — claude-code) leaves the exit code in
                 * charge.
                 */
                const finish = outcome.finishReason;
                // A cache-killed run was cut mid-tool-call, so its finish reason reads as one more
                // premature stop — the cache note already says the whole story, and stacking
                // "ended before it finished" on top would send its reader chasing a second cause.
                const premature = typeof finish === 'string' && finish !== 'stop' && !outcome.cacheLost;

                /*
                 * The deterministic end of a task. A run that succeeded — clean exit, no timeout,
                 * no premature stop, gates passed — may not report success while its work exists
                 * only in a local checkout: published here, AFTER the gates, so nothing is ever
                 * pushed past a failing check and no author was ever asked. The executor's
                 * AGENTS.md tells the agent this is the shape of a finished task; this call is
                 * what makes it enforcement rather than hope. A publish failure fails the
                 * verdict — a green badge over work that landed nowhere is the exact lie this
                 * exists to prevent — and the reason rides the output the author reads.
                 *
                 * The publish flag is the BOARD's decision, not this run's: on a workflow task
                 * only the graph's publish node may push, so a mid-loop review success never
                 * does. The flag rides the claim (`publish: false`), and both executors read the
                 * same claim here — docker and kubernetes gate the same publish sequence on it.
                 * An ABSENT flag is a board that predates the field, which published every
                 * succeeded gated run — so absent reads as "publish", byte-identically.
                 */
                let published: PublishResult | null = null;
                if (
                    outcome.exitCode === 0 &&
                    !outcome.timedOut &&
                    !premature &&
                    !failure &&
                    job.publish !== false &&
                    runner.publishGit
                ) {
                    // The claim's GITHUB_TOKEN was minted at claim time, and a run can outlive
                    // its hour — job 43379d3a pushed with a token 34 minutes past expiry and the
                    // publish failed on 401 with the work done and the gates green. Ask the
                    // board for a publish-fresh one; null — nothing fresher, or the ask failed —
                    // keeps the claim env, the shape every short run still publishes with.
                    const publishToken = await board.publishToken(job);
                    // Null doubles as the route's honest "nothing fresher" and its failure shape —
                    // any non-ok answer (a 401 among them) comes back as null, and jobs 9bf1002a,
                    // 4bcfe8be and b0ac2284 (2026-09-14) pushed with dead claim credentials for
                    // hours before anyone looked, because the degradation was silent. Publish
                    // goes ahead with the claim env either way; it just says so.
                    if (!publishToken) {
                        log(`job ${job.id}: publish-token ask answered nothing fresh — publishing with the claim env`);
                    }
                    published = await runner.publishGit(job, publishToken ?? undefined);
                }

                // The last thing this attempt does, and the first moment the heartbeat may stop.
                await settle();

                const publishUnlanded = published !== null && !published.ok;
                const status =
                    outcome.exitCode === 0 &&
                    !outcome.timedOut &&
                    !outcome.cacheLost &&
                    !failure &&
                    !premature &&
                    !publishUnlanded
                        ? 'succeeded'
                        : 'failed';
                const exitCode = failure ? failure.exitCode : outcome.exitCode;
                let output = outcome.timedOut
                    ? `${outcome.output}\n[driver] killed after ${config.jobTimeoutMs}ms`
                    : outcome.output;
                if (published?.published) {
                    output = `${output}\n[driver] published ${published.branch}${published.prUrl ? ` — ${published.prUrl}` : ''}`;
                }
                if (published && published.ok && !published.published) {
                    // A silent no-op is how a missing `docker run` once hid behind "the checkout
                    // has not been cloned yet" — the reason is the only way to tell an ordinary
                    // clean tree from a publisher that cannot see the tree at all.
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
                if (premature) {
                    // The finish reason says the run stopped talking; the session's last provider
                    // error, when the scrape lifted one, says WHY. Observed 2026-09-11: a 429 rate
                    // limit cut a run off mid-tool-call and the note named only "tool-calls",
                    // sending its reader into the session database for the cause.
                    const cause = outcome.providerError
                        ? ` The session's last provider error: ${outcome.providerError}.`
                        : '';
                    output =
                        `${output}\n[driver] the agent's run ended before it finished (opencode finish reason: "${finish}") — ` +
                        `exit 0, but no completed final message.${cause} Re-queue the task, or follow up to continue the session.`;
                }
                if (failure) {
                    output = `${output}\n[driver] gate "${failure.name}" failed (exit ${failure.exitCode})\n${failure.output}`;
                }

                // The publication's identity rides the verdict ONLY when the publish really happened and
                // every half of it resolved — a no-op or failed publish answers no publication,
                // and the board must not record a thread as having shipped a PR it did not.
                const publication =
                    published?.published &&
                    published.repository &&
                    published.prNumber &&
                    published.prUrl &&
                    published.branch &&
                    published.baseBranch
                        ? {
                              repo: published.repository,
                              prNumber: published.prNumber,
                              prUrl: published.prUrl,
                              headBranch: published.branch,
                              baseBranch: published.baseBranch,
                          }
                        : null;

                const verdict = await report(job, {
                    status,
                    exitCode,
                    output,
                    contextTokens: outcome.contextTokens ?? null,
                    contextCostUsd: outcome.costUsd ?? null,
                    // A number only: an unmeasured read stays off the report and the board
                    // stores null — the driver keeps the never-zero contract on the wire.
                    ...(typeof outcome.agentTurns === 'number' ? { agentTurns: outcome.agentTurns } : {}),
                    // The run's last words, when the close-time read lifted them; absent stays
                    // absent, and the board stores null.
                    ...(outcome.summary ? { summary: outcome.summary } : {}),
                    ...(publication ? { publication } : {}),
                });
                log(
                    verdict === 'lost'
                        ? `job ${job.id}: finished ${status}, but the board had already reclaimed it`
                        : `job ${job.id}: ${status} (exit ${exitCode}${failure ? ', gates' : ''})`
                );
            } finally {
                if (gateSession) releaseGateSession(gateSession);
            }
        } catch (e) {
            // The container never ran — docker is missing, or the daemon refused. Deliberately NOT
            // reported as a failed job: that would blame the command for the driver's problem. The
            // lease simply expires and the job is offered again, which is visible in `attempts`.
            await settle();
            log(`job ${job.id}: could not run, leaving it to the lease: ${(e as Error).message}`);
        }
    }

    /**
     * The verdict is reported, then the task worktree is reclaimed — but only when the thread is
     * DONE, not merely terminal (issue #47, revised): the board answers the verdict AND whether
     * every member of the thread is terminal AND the user has declared it done, in one
     * lease-guarded round trip computed in the same transaction as the verdict. A thread that
     * finished without the user's done keeps its tree — a failed task's tree is exactly what its
     * next turn continues from, and the tree is the user's to free; `POST /api/jobs/:id/done`
     * queues the reclaim itself when the thread is already terminal, so the queue drain below is
     * the ordinary path and this verdict-time reclaim is the one that covers a done declared
     * while a follow-up was still moving. There is no separate thread read left to race a
     * follow-up's insertion: reclaim sits downstream of the verdict and runs only when the answer
     * says done-and-terminal, so a follow-up still queued keeps its tree.
     *
     * Best-effort by contract — the verdict is already safe the moment it is on the board, so a
     * runner that refuses the tree or a transport hiccup can cost the reclaim but never the
     * verdict. A refused tree stays on the disk (the script it runs deletes only what the sync
     * created) and is logged rather than turned into a bomb in the author's mouth.
     *
     * The removal is registered under the thread's ROOT id in the reclaim barrier BEFORE it
     * starts and the entry is dropped when it settles: a follow-up of the same thread claimed by
     * this driver while the removal is in flight then waits it out before its startup sync (see
     * `reclaims`), instead of syncing against a tree mid-deletion.
     */
    async function report(job: BoardJob, result: Parameters<Board['complete']>[1]): Promise<LeaseState> {
        const verdict = await board.complete(job, result);
        if (verdict.state !== 'held' || !verdict.threadDone) return verdict.state;
        const root = job.rootJobId ?? job.id;
        // Registered before the removal starts — the set and the start are one synchronous block,
        // so no claimant can observe the in-between. The entry is dropped only while it is still
        // the one registered: a replacement reclaim for the same root is never undone by a
        // predecessor settling late.
        let reclaim: Promise<void> = Promise.resolve();
        reclaim = (async () => {
            try {
                const outcome = await runner.reclaimWorktree(job);
                if (!outcome.ok) {
                    log(`job ${job.id}: the task worktree could not be reclaimed: ${outcome.reason}`);
                }
            } catch (e) {
                log(`job ${job.id}: the task worktree could not be reclaimed: ${(e as Error).message}`);
            } finally {
                if (reclaims.get(root) === reclaim) reclaims.delete(root);
            }
        })();
        reclaims.set(root, reclaim);
        return verdict.state;
    }

    function track(job: BoardJob): void {
        const promise = runJob(job).finally(() => active.delete(promise));
        active.add(promise);
    }

    /**
     * Drains the board's worktree-reclaim queue (issue #41), one row at a time: a Remove deleted
     * a thread, or a done landed on an already-terminal one, and this loop is the worker half of
     * taking the tree down. Claim a row, remove the tree the thread left behind, then ack so the
     * row stops being offered.
     *
     * The tree is reclaimed with the same runner call a terminal thread's report() uses, fed a
     * job synthesised from the row: the thread's identity — its root id, repo label and workspace
     * path — is all the tree is filed under. The row's own id rides as the lease token, which is
     * exactly what makes the removal hold the checkout against a live attempt's startup sync
     * under kubernetes (the claim ConfigMap is keyed by the job id, and its holder data carries
     * the lease token), and the short claim
     * lease bounds how long a driver that dies mid-removal holds the row.
     *
     * A removed thread has no follow-ups — every row was deleted — so there is no reclaim barrier
     * entry to take here: nothing can claim that root again, and this loop's owns each root it is
     * handed once. A refused tree or a throw — in the reclaim or its ack — simply skips the ack,
     * and the row is offered again when its lease expires; a refused tree also stays on the disk,
     * exactly as a refused terminal reclaim leaves it.
     */
    async function drainReclaims(): Promise<void> {
        while (running) {
            let reclaim: Reclaim | null;
            try {
                reclaim = await board.claimReclaim(config.worker);
            } catch (e) {
                log(`reclaim claim failed, retrying: ${(e as Error).message}`);
                await sleep(config.pollMs);
                continue;
            }
            if (!reclaim) {
                await sleep(config.pollMs);
                continue;
            }
            const removed: BoardJob = {
                id: reclaim.rootJobId,
                command: '',
                attempts: 1,
                leaseToken: reclaim.id,
                leaseExpiresAt: reclaim.leaseExpiresAt,
                resumeSessionId: null,
                followUp: false,
                userId: null,
                workspacePath: reclaim.workspacePath,
                rootJobId: reclaim.rootJobId,
                repo: reclaim.repo,
                // Removed-thread reclamation runs only the bundled git maintenance script. It is
                // not task execution and the deleted rows no longer carry an executor selection.
                executorType: 'claude-code',
            };
            let outcome: ReclaimResult;
            try {
                outcome = await runner.reclaimWorktree(removed);
            } catch (e) {
                log(
                    `reclaim ${reclaim.id}: the worktree reclaim threw, leaving it to the lease: ${(e as Error).message}`
                );
                continue;
            }
            if (!outcome.ok) {
                log(`reclaim ${reclaim.id}: the task worktree could not be reclaimed: ${outcome.reason}`);
                continue;
            }
            let ack: ReclaimAck;
            try {
                ack = await board.ackReclaim(reclaim.id, config.worker);
            } catch (e) {
                log(`reclaim ${reclaim.id}: the ack threw, leaving it to the lease: ${(e as Error).message}`);
                continue;
            }
            if (ack === 'lost') {
                log(`reclaim ${reclaim.id}: ack refused, the row is re-leased to another worker`);
            } else if (ack === 'missing') {
                log(`reclaim ${reclaim.id}: already acked elsewhere`);
            }
        }
    }

    return {
        stop() {
            running = false;
        },

        async start() {
            log(
                `polling ${config.boardUrl} every ${config.pollMs}ms as "${config.worker}", ` +
                    `${config.concurrency} at a time, executor images ` +
                    `claude-code=${config.executorImages['claude-code']}, opencode=${config.executorImages.opencode}`
            );

            // Drains the board's removed-thread queue in parallel with the claim loop. This loop
            // ends when running is set to false (via stop()) — no orphaning a removal mid-reclaim
            // — and its return is awaited after all in-flight jobs settle.
            const draining = drainReclaims();

            while (running) {
                if (active.size >= config.concurrency) {
                    await Promise.race(active);
                    continue;
                }

                let job: BoardJob | null;
                try {
                    job = await board.claim(config.worker);
                } catch (e) {
                    log(`claim failed, retrying: ${(e as Error).message}`);
                    await sleep(config.pollMs);
                    continue;
                }

                if (!job) {
                    await sleep(config.pollMs);
                    continue;
                }

                /*
                 * A job whose author has no workspace is FAILED, never run in a fallback location.
                 *
                 * There is no safe fallback left. Checkouts are per member now, so both `<mount>`
                 * and `<mount>/<org>` are the parent of everybody's tree — handing either to a
                 * container that may be running --dangerously-skip-permissions would let one
                 * member's job read and edit another's working copy.
                 *
                 * Reported with a reason rather than dropped, so the job reaches a terminal state
                 * somebody can see instead of being reclaimed on every lease expiry forever.
                 */
                if (!workspacePathOf(job)) {
                    log(`job ${job.id}: no workspace for its author, failing`);
                    await report(job, {
                        status: 'failed',
                        exitCode: null,
                        output: 'This job has no workspace. It was queued by an account this board cannot resolve a checkout directory for, or the board has no workspace root configured.',
                    }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                    continue;
                }

                /*
                 * A repo job runs in its task worktree (issue #35), so the same rule the null
                 * workspacePath above applies extends there: a board-shaped repo label this
                 * driver cannot resolve a worktree path for is failed with a reason, never run
                 * in a fallback location. The board's own shape validation is not this
                 * process's to trust.
                 */
                if (job.repo && !worktreeRelDir(job)) {
                    log(`job ${job.id}: no resolvable task worktree for its repo label, failing`);
                    await report(job, {
                        status: 'failed',
                        exitCode: null,
                        output: `This job names repository ${job.repo}, but its workspace and thread do not resolve to a task worktree directory this driver can run it in.`,
                    }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                    continue;
                }

                /*
                 * A job's session cannot follow a profile whose type changed — with one carve-out:
                 * a FOLLOW-UP under opencode runs, because its session is opencode's own and the
                 * runner restores it with `--session`. What is still refused is a resume claim
                 * carrying nothing to deliver: standby is a Remote Control feature and opencode
                 * cannot run under Remote Control, so a parked claim under opencode means the
                 * profile changed type while something was parked. Restoring a claude-code
                 * session is impossible — opencode has none in its database — and resuming it
                 * without a command would idle a headless run to its deadline.
                 */
                if (job.executorType === 'opencode' && job.resumeSessionId && !job.followUp) {
                    log(`job ${job.id}: carries a session its selected OpenCode executor cannot restore, failing`);
                    await report(job, {
                        status: 'failed',
                        exitCode: null,
                        output: 'This job was parked with a Claude Code session, and its selected OpenCode executor cannot restore that session. Start a new task to run it fresh.',
                    }).catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                    continue;
                }

                /*
                 * The attempt takes it from here — the reclaim barrier, the checkout sync, the
                 * gates re-read and refusals, the gate environment and the run are all runJob's
                 * (they moved in from this loop so the attempt's heartbeat and abort signal cover
                 * the whole setup: a stop issued while the dashboard says "Waiting for the
                 * executor…" now stands the attempt down within one heartbeat poll, issue #126).
                 */
                track(job);
            }

            // Claiming has stopped; let what is already running finish rather than orphaning
            // containers that are mid-edit in a checkout.
            if (active.size) log(`draining ${active.size} running job(s)`);
            await Promise.all(active);
            await draining;
        },
    };
}
