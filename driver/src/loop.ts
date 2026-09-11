import { randomUUID } from 'node:crypto';
import type { Board, BoardJob, RuntimeReport } from './board.js';
import type { DriverConfig } from './config.js';
import { currentActivity, envFileBody, tailBytes, workspacePathOf } from './docker.js';
import type { GateManager, GateServer } from './gates.js';
import type { RunSession, Runner, RuntimeSample } from './docker.js';
import type { SyncResult } from './publish.js';
import { worktreeRelDir } from './publish.js';
import type { PublishResult } from './publish.js';

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

interface JobState {
    finished: boolean;
    lost: boolean;
    /** Resolves the moment the run ends, so the heartbeat can stop waiting out its period. */
    woken: Promise<void>;
    wake: () => void;
}

/**
 * One gated job's live registration: the checkout key its environment is filed under, the token
 * the runner's agent presents to the ad-hoc endpoint, and the gates the job's `.bellows.yaml`
 * declared. Lives from before the agent starts until the run's exit paths have all been walked.
 */
interface GateSession {
    key: string;
    token: string;
    declared: readonly { name: string; command: string }[];
}

interface GateFailure {
    name: string;
    exitCode: number;
    output: string;
}

/** What one gate looks like on the board, at one moment. */
type GateReport = { name: string; status: 'running' | 'passed' | 'failed'; exitCode: number | null; output: string | null };

function newJobState(): JobState {
    let wake = () => {};
    const woken = new Promise<void>((resolve) => {
        wake = resolve;
    });
    return { finished: false, lost: false, woken, wake };
}

export function createLoop({ board, runner, config, gates, log = () => {}, sleep = wait }: LoopDeps): Loop {
    let running = true;
    const active = new Set<Promise<void>>();

    /**
     * Beats until the run finishes.
     *
     * A 409 means the lease was reclaimed while this container was still working: the job belongs
     * to another worker now, so this one is killed rather than left to finish and report. The board
     * would refuse the report anyway — but by then the two runs have both been writing to the same
     * checkout, which is the thing actually worth preventing.
     */
    function heartbeat(job: BoardJob, state: JobState): Promise<void> {
        const every = Math.max(1_000, Math.floor((config.leaseSeconds * 1000) / 3));
        return (async () => {
            while (!state.finished && !state.lost) {
                // Raced against the run finishing, not simply awaited. The beat period is a third
                // of the lease — 100s at the default — and a plain sleep would hold every finished
                // job for the remainder of it before its result could be reported.
                await Promise.race([sleep(every), state.woken]);
                if (state.finished) return;
                let verdict;
                try {
                    verdict = await board.heartbeat(job);
                } catch (e) {
                    // A board that is briefly unreachable is not a lost lease. Keep working: the
                    // lease outlives several missed beats, and giving up here would kill a run
                    // over one failed request.
                    log(`job ${job.id}: heartbeat failed, continuing: ${(e as Error).message}`);
                    continue;
                }
                if (verdict === 'lost') {
                    state.lost = true;
                    log(`job ${job.id}: lease lost, killing the runner`);
                    await runner.kill(job);
                }
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
    async function beginGates(job: BoardJob): Promise<GateSession | null> {
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
            return { key, token, declared: job.gates.gates };
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
     */
    async function runDeclaredGates(job: BoardJob, gateSession: GateSession, state: JobState): Promise<GateFailure | null> {
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
        const perGate = Math.max(1024, Math.floor(16 * 1024 / gateSession.declared.length));
        for (const gate of gateSession.declared) {
            // The lease can be reclaimed mid-gates. Everything after that is dead work on a
            // checkout another attempt owns, and the verdict will be refused anyway.
            if (state.lost) return null;
            results.push({ name: gate.name, status: 'running', exitCode: null, output: null });
            await report();
            const outcome = await gates.manager
                .runGate(gateSession.key, gate.name, gate.command)
                .catch((e: Error) => ({ exitCode: 125, output: e.message }));
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

    async function runJob(job: BoardJob): Promise<void> {
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
            config.cli === 'opencode'
                ? job.resumeSessionId
                    ? { id: job.resumeSessionId, resume: true }
                    : null
                : job.resumeSessionId
                  ? { id: job.resumeSessionId, resume: true }
                  : { id: randomUUID(), resume: false };

        // Only under Remote Control: a headless run registers no bridge, so looking for one would
        // be forty `docker exec`s that can never find anything. (Remote Control is claude-code
        // only — the config refuses the combination — and a claude-code job always has a session.)
        const watching = config.remoteControl && session ? watchRemote(job, session, state) : Promise.resolve();

        const settle = async () => {
            state.finished = true;
            state.wake();
            await Promise.all([beating, watching]);
        };

        try {
            log(
                `job ${job.id}: attempt ${job.attempts} ` +
                    (session
                        ? `${session.resume ? 'resuming' : 'starting as'} session ${session.id}`
                        : 'starting (headless opencode run: no session id)'),
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
             * The gate environment comes up BEFORE the agent does, because the agent's ad-hoc
             * gate calls land mid-run — "partially run tests" happens while the session is
             * working, not after it. A failure here is the author's problem (an image the daemon
             * cannot fetch, an env value no env file can carry), not the command's: the job is
             * FAILED with that reason rather than left to a lease that would retry a typo
             * forever.
             */
            let gateSession: GateSession | null = null;
            try {
                gateSession = await beginGates(job);
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
                const outcome = await runner.run(job, session, onOutput);

                if (state.lost) {
                    await settle();
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
                            : `job ${job.id}: idle for ${config.idleMs}ms, parked on standby`,
                    );
                    return;
                }

                // The session the run actually used, when the runner could only learn it after the
                // fact (opencode scrapes it at close). Reported while the lease is still live, BEFORE
                // the verdict — a follow-up can only be asked for once the task is finished, and it
                // resumes exactly this. A 'lost' verdict is not acted on: the heartbeat is what kills
                // a superseded run, and losing the link is not losing the job.
                if (outcome.sessionId) {
                    try {
                        await board.session(job, outcome.sessionId, null);
                        log(`job ${job.id}: session ${outcome.sessionId}`);
                    } catch (e) {
                        log(`job ${job.id}: could not report the session, continuing: ${(e as Error).message}`);
                    }
                } else if (config.cli === 'opencode') {
                    // An opencode run ALWAYS leaves a session, so an empty scrape is the readout
                    // having failed every try — said out loud, because the cost is a task that can
                    // never take a follow-up, and a verdict without its finish reason or context.
                    // The reason says which failure it was: the runner carries the readout's own
                    // error line, the docker rejection, or its absence.
                    log(
                        `job ${job.id}: the session readout came up empty (${outcome.readoutError ?? 'no session in the database'}) — ` +
                            'no session to follow up, finish reason and context stats unread',
                    );
                }

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
                const premature =
                    typeof finish === 'string' && finish !== 'stop' && !outcome.cacheLost;

                /*
                 * The deterministic end of a task. A run that succeeded — clean exit, no timeout,
                 * no premature stop, gates passed — may not report success while its work exists
                 * only in a local checkout: published here, AFTER the gates, so nothing is ever
                 * pushed past a failing check and no author was ever asked. The executor's
                 * AGENTS.md tells the agent this is the shape of a finished task; this call is
                 * what makes it enforcement rather than hope. A publish failure fails the
                 * verdict — a green badge over work that landed nowhere is the exact lie this
                 * exists to prevent — and the reason rides the output the author reads.
                 */
                let published: PublishResult | null = null;
                if (
                    outcome.exitCode === 0 &&
                    !outcome.timedOut &&
                    !premature &&
                    !failure &&
                    runner.publishGit
                ) {
                    published = await runner.publishGit(job);
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
                    output = `${output}\n[driver] the agent's run ended before it finished (opencode finish reason: "${finish}") — exit 0, but no completed final message. Re-queue the task, or follow up to continue the session.`;
                }
                if (failure) {
                    output = `${output}\n[driver] gate "${failure.name}" failed (exit ${failure.exitCode})\n${failure.output}`;
                }

                const verdict = await board.complete(job, {
                    status,
                    exitCode,
                    output,
                    contextTokens: outcome.contextTokens ?? null,
                    contextCostUsd: outcome.costUsd ?? null,
                });
                log(
                    verdict === 'lost'
                        ? `job ${job.id}: finished ${status}, but the board had already reclaimed it`
                        : `job ${job.id}: ${status} (exit ${exitCode}${failure ? ', gates' : ''})`,
                );
            } finally {
                // Either way the environment goes back to its cooldown, and the token dies with the
                // attempt: a follow-up's claim registers its own.
                if (gateSession) {
                    gates?.server.unregister(gateSession.token);
                    gates?.manager.release(gateSession.key);
                }
            }
        } catch (e) {
            // The container never ran — docker is missing, or the daemon refused. Deliberately NOT
            // reported as a failed job: that would blame the command for the driver's problem. The
            // lease simply expires and the job is offered again, which is visible in `attempts`.
            await settle();
            log(`job ${job.id}: could not run, leaving it to the lease: ${(e as Error).message}`);
        }
    }

    function track(job: BoardJob): void {
        const promise = runJob(job).finally(() => active.delete(promise));
        active.add(promise);
    }

    return {
        stop() {
            running = false;
        },

        async start() {
            log(
                `polling ${config.boardUrl} every ${config.pollMs}ms as "${config.worker}", ` +
                    `${config.concurrency} at a time, image ${config.image}`,
            );

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
                    await board
                        .complete(job, {
                            status: 'failed',
                            exitCode: null,
                            output:
                                'This job has no workspace. It was queued by an account this board cannot resolve a checkout directory for, or the board has no workspace root configured.',
                        })
                        .catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
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
                    await board
                        .complete(job, {
                            status: 'failed',
                            exitCode: null,
                            output: `This job names repository ${job.repo}, but its workspace and thread do not resolve to a task worktree directory this driver can run it in.`,
                        })
                        .catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                    continue;
                }

                /*
                 * A job's session cannot follow it across a RUNNER_CLI flip — with one carve-out:
                 * a FOLLOW-UP under opencode runs, because its session is opencode's own and the
                 * runner restores it with `--session`. What is still refused is a resume claim
                 * carrying nothing to deliver: standby is a Remote Control feature and opencode
                 * refuses Remote Control at startup, so a parked claim under opencode means the
                 * operator changed the CLI while something was parked. Restoring a claude-code
                 * session is impossible — opencode has none in its database — and resuming it
                 * without a command would idle a headless run to its deadline.
                 */
                if (config.cli === 'opencode' && job.resumeSessionId && !job.followUp) {
                    log(`job ${job.id}: carries a session this opencode driver cannot restore, failing`);
                    await board
                        .complete(job, {
                            status: 'failed',
                            exitCode: null,
                            output:
                                'This job was parked with an agent session by a claude-code driver, and this driver runs opencode, whose runner cannot restore that session. Re-queue the job to run it fresh.',
                        })
                        .catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                    continue;
                }

                /*
                 * Before anything reads the tree — the gates refusal just below, the agent this
                 * run — the task worktree is brought up to the remote default: fetch, create the
                 * worktree branched off origin/<default> or rebase the existing one onto it,
                 * autostashing uncommitted edits. Clones are created once and otherwise left
                 * untouched by the workspace reconcile, so without this every task after a main
                 * update starts from stale code and a stale gates file. A sync failure fails the
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
                 */
                let synced: SyncResult;
                try {
                    synced = await runner.syncCheckout(job);
                } catch (e) {
                    log(`job ${job.id}: checkout sync threw, leaving it to the lease: ${(e as Error).message}`);
                    continue;
                }
                if (!synced.ok) {
                    log(`job ${job.id}: checkout sync failed: ${synced.reason}`);
                    await board
                        .complete(job, {
                            status: 'failed',
                            exitCode: null,
                            output: `The checkout could not be synced with the remote before the run: ${synced.reason}`,
                        })
                        .catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                    continue;
                }

                /*
                 * The claim's gates decision was read from the tree BEFORE the sync freshened
                 * it — a repository whose `.bellows.yaml` just arrived would run ungated for its
                 * whole first task if the stale answer stood. Re-read now that the tree is
                 * current, and let the refusals below act on what the tree actually holds. Null
                 * (a refused or lost answer) keeps the claim's decision; nothing here is worth a
                 * second writer on the verdict.
                 */
                const fresh = await board.rereadGates(job);
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
                    log(`job ${job.id}: its gates file could not be read, failing`);
                    await board
                        .complete(job, {
                            status: 'failed',
                            exitCode: null,
                            output: `This job's .bellows.yaml could not be read as a gate declaration: ${job.gateError}`,
                        })
                        .catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                    continue;
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
                    const why = 'this driver was started with no gate environment configured';
                    log(`job ${job.id}: declares gates this driver cannot run, failing`);
                    await board
                        .complete(job, {
                            status: 'failed',
                            exitCode: null,
                            output: `This job declares verification gates in .bellows.yaml, and ${why}. Re-queue it against a driver built with the GATE_* configuration set.`,
                        })
                        .catch((e: Error) => log(`job ${job.id}: could not report the failure: ${e.message}`));
                    continue;
                }

                track(job);
            }

            // Claiming has stopped; let what is already running finish rather than orphaning
            // containers that are mid-edit in a checkout.
            if (active.size) log(`draining ${active.size} running job(s)`);
            await Promise.all(active);
        },
    };
}
