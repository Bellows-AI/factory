import { randomUUID } from 'node:crypto';
import type { Board, BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { workspacePathOf } from './docker.js';
import type { RunSession, Runner } from './docker.js';

export interface Loop {
    /** Resolves once `stop()` has been called and every in-flight job has finished. */
    start(): Promise<void>;
    stop(): void;
}

export interface LoopDeps {
    board: Board;
    runner: Runner;
    config: DriverConfig;
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The bridge connects a few seconds in; two minutes of looking is generous and bounded. */
const REMOTE_POLL_MS = 3_000;
const REMOTE_LOOKUPS = 40;

interface JobState {
    finished: boolean;
    lost: boolean;
    /** Resolves the moment the run ends, so the heartbeat can stop waiting out its period. */
    woken: Promise<void>;
    wake: () => void;
}

function newJobState(): JobState {
    let wake = () => {};
    const woken = new Promise<void>((resolve) => {
        wake = resolve;
    });
    return { finished: false, lost: false, woken, wake };
}

export function createLoop({ board, runner, config, log = () => {}, sleep = wait }: LoopDeps): Loop {
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

    async function runJob(job: BoardJob): Promise<void> {
        const state = newJobState();
        const beating = heartbeat(job, state);
        // A resumed job already has its session, and the board already knows it. A fresh one gets
        // one minted here rather than read back from the runner, and reported before the container
        // exists: the whole point is that the board holds the session for the attempt even if the
        // run dies before it produces a line of output.
        //
        // Except under opencode, which gets null: it mints its own session ids and cannot adopt
        // one, so there is nothing to mint, give or report — minting a uuid anyway would put a
        // session on the board that the runner never used.
        const session: RunSession | null =
            config.cli === 'opencode'
                ? null
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
            const outcome = await runner.run(job, session);
            await settle();

            if (state.lost) return;

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
                log(`job ${job.id}: the runner reports the container never started, leaving it to the lease`);
                return;
            }

            // Parked, not finished: the container is gone, the session is kept, and the job goes
            // back on the board for somebody to pick up from the Claude UI. Reporting an exit code
            // here would make an idle session indistinguishable from a run that ended.
            if (outcome.idled) {
                const verdict = await board.suspend(job);
                log(
                    verdict === 'lost'
                        ? `job ${job.id}: idle, but the board had already reclaimed it`
                        : `job ${job.id}: idle for ${config.idleMs}ms, parked on standby`,
                );
                return;
            }

            const status = outcome.exitCode === 0 && !outcome.timedOut ? 'succeeded' : 'failed';
            const output = outcome.timedOut
                ? `${outcome.output}\n[driver] killed after ${config.jobTimeoutMs}ms`
                : outcome.output;

            const verdict = await board.complete(job, { status, exitCode: outcome.exitCode, output });
            log(
                verdict === 'lost'
                    ? `job ${job.id}: finished ${status}, but the board had already reclaimed it`
                    : `job ${job.id}: ${status} (exit ${outcome.exitCode})`,
            );
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
                 * A job's session cannot follow it across a RUNNER_CLI flip.
                 *
                 * Standby is a Remote Control feature and opencode refuses Remote Control at
                 * startup, so a claim carrying resumeSessionId under opencode means the operator
                 * changed the CLI while a job was parked — or while a follow-up was waiting.
                 * Restoring it is impossible — opencode cannot adopt a session id — and re-running
                 * the command would re-enter a transcript somebody may have been driving by hand.
                 * Failed with a reason, so the job reaches a terminal state somebody can act on.
                 */
                if (config.cli === 'opencode' && job.resumeSessionId) {
                    log(`job ${job.id}: carries a session this opencode driver cannot restore, failing`);
                    await board
                        .complete(job, {
                            status: 'failed',
                            exitCode: null,
                            output: job.followUp
                                ? 'This job continues an agent session, and this driver runs opencode, whose runner cannot restore a session it did not start. Follow up on the task again once a claude-code driver is serving this queue.'
                                : 'This job was parked with an agent session by a claude-code driver, and this driver runs opencode, whose runner cannot restore that session. Re-queue the job to run it fresh.',
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
