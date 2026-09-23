import type { BoardJob, HeartbeatVerdict, RuntimeReport } from './board.js';
import { currentActivity } from './runner.js';
import type { RunSession, RuntimeSample } from './runner.js';
import type { LoopRuntime } from './loop-types.js';

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
const MIN_HEARTBEAT_PERIOD_MS = 1_000;
const HEARTBEAT_PERIOD_DIVISOR = 3;
const MS_PER_SECOND = 1_000;

export interface JobState {
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

export function newJobState(): JobState {
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
export const down = (state: JobState): boolean => state.stopped || state.lost || state.removed;

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
export async function raceStep<T>(state: JobState, step: Promise<T>): Promise<{ value: T } | null> {
    // A side-band subscriber, so the loser of the race can never become an unhandled rejection:
    // subscribing neither consumes the step from the race nor changes its result.
    step.catch(() => {});
    const lost = state.abort.then((): typeof RACE_LOST => RACE_LOST);
    const outcome: T | typeof RACE_LOST = await Promise.race([step, lost] as const);
    return outcome === RACE_LOST ? null : { value: outcome };
}

/** Folds one heartbeat verdict into the attempt's state, and kills the runner when it stands down. */
async function applyHeartbeatVerdict(rt: LoopRuntime, job: BoardJob, state: JobState, verdict: HeartbeatVerdict) {
    const { runner, log } = rt;
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
    if (!down(state)) return;
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

/** One heartbeat poll: reads the board's verdict (rate-limiting its own failure log), and folds it in. */
async function beat(rt: LoopRuntime, job: BoardJob, state: JobState, complained: boolean): Promise<boolean> {
    const { board, log } = rt;
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
    if (verdict !== undefined) await applyHeartbeatVerdict(rt, job, state, verdict);
    return complained;
}

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
export function heartbeat(rt: LoopRuntime, job: BoardJob, state: JobState): Promise<void> {
    const { config, sleep } = rt;
    const every = Math.max(
        MIN_HEARTBEAT_PERIOD_MS,
        Math.floor((config.leaseSeconds * MS_PER_SECOND) / HEARTBEAT_PERIOD_DIVISOR)
    );
    return (async () => {
        let complained = false;
        while (!state.finished && !down(state)) {
            complained = await beat(rt, job, state, complained);
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
export function watchRemote(rt: LoopRuntime, job: BoardJob, session: RunSession, state: JobState): Promise<void> {
    const { board, runner, log, sleep } = rt;
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

/** The runtime report for one flush, derived from the sample and the tail being flushed together. */
function buildRuntimeReport(sample: RuntimeSample, latest: string): RuntimeReport {
    return {
        cpuPercent: sample.cpuPercent,
        memUsedMb: sample.memUsedMb,
        memPercent: sample.memPercent,
        // The attempt's service fleet, when the attempt declared any — absent
        // (never an empty array) otherwise, so the wire shape of a service-less
        // job is byte-identical to what it always was.
        ...(sample.services ? { services: sample.services } : {}),
        // Derived at flush, from the tail being flushed — the activity line and
        // the numbers must describe the same moment.
        activity: currentActivity(latest),
        sampledAt: sample.sampledAt,
    };
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
/**
 * The output pump's whole mutable state, bundled so every step function takes it as one value:
 * the newest tail (set from outside, by the returned callback), what was last flushed of it and
 * of the runtime sample, whether a sample fetch is already in flight, and the flush failure
 * rate-limit flag.
 */
interface OutputPump {
    latest: string | null;
    sent: string | null;
    sample: RuntimeSample | null;
    sentSample: RuntimeSample | null;
    sampling: boolean;
    complained: boolean;
}

/** Kicks off one runtime sample fetch, unless one is already in flight; the pump holds the newest. */
function kickSample(rt: LoopRuntime, job: BoardJob, pump: OutputPump): void {
    if (pump.sampling) return;
    pump.sampling = true;
    rt.runner
        .sampleRuntime(job)
        .then((read) => {
            if (read) pump.sample = { ...read, sampledAt: new Date().toISOString() };
        })
        .catch(() => {})
        .finally(() => {
            pump.sampling = false;
        });
}

/**
 * Flushes the pump's newest tail+sample pair to the board, when either changed since the last
 * flush; answers `'skip'` when there is nothing new, or a flush just failed (rate-limited to one
 * log line per outage) — the caller simply continues either way. `'lost'` ends the pump outright.
 */
async function flushIfChanged(rt: LoopRuntime, job: BoardJob, pump: OutputPump): Promise<'held' | 'lost' | 'skip'> {
    const { board, log } = rt;
    const sampled = pump.sample !== pump.sentSample;
    if (pump.latest === null || (pump.latest === pump.sent && !sampled)) return 'skip';
    const latest = pump.latest;
    pump.sent = latest;
    pump.sentSample = pump.sample;
    const runtime: RuntimeReport | null = pump.sample ? buildRuntimeReport(pump.sample, latest) : null;
    try {
        const verdict = await board.progress(job, latest, runtime ?? undefined);
        pump.complained = false;
        return verdict;
    } catch (e) {
        // Rate-limited to the first failure in a row: a board unreachable for a
        // three-hour session must not write a log line every two seconds.
        if (!pump.complained) {
            pump.complained = true;
            log(`job ${job.id}: could not stream output, continuing: ${(e as Error).message}`);
        }
        return 'skip';
    }
}

export function watchOutput(rt: LoopRuntime, job: BoardJob, state: JobState): (tail: string) => void {
    const { sleep } = rt;
    const pump: OutputPump = {
        latest: null,
        sent: null,
        sample: null,
        sentSample: null,
        sampling: false,
        complained: false,
    };
    void (async () => {
        while (!state.finished && !state.lost) {
            await Promise.race([sleep(PROGRESS_MS), state.woken]);
            if (state.finished || state.lost) return;
            // The pump starts with the attempt now, but the runner does not exist until
            // launch — sampling before that is a daemon lookup per period that can answer
            // nothing (issue #126 moved the start earlier to cover the setup phase).
            if (!state.launched) continue;
            kickSample(rt, job, pump);
            const verdict = await flushIfChanged(rt, job, pump);
            // The board no longer recognises this attempt. Killing the container is the
            // heartbeat's verdict alone; this pump just stops talking.
            if (verdict === 'lost') return;
        }
    })();
    return (tail) => {
        pump.latest = tail;
    };
}
