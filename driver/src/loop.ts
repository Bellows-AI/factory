import type { Board, BoardJob, LeaseState, Reclaim, ReclaimAck } from './board.js';
import type { DriverConfig } from './config.js';
import { workspacePathOf } from './claim.js';
import type { Runner } from './runner.js';
import type { ReclaimResult } from './publish.js';
import { worktreeRelDir } from './publish.js';
import type { GateStack, LoopRuntime } from './loop-types.js';
import { runJob } from './loop-run.js';
import { CLAUDE_CODE } from './executors.js';

export interface Loop {
    /** Resolves once `stop()` has been called and every in-flight job has finished. */
    start(): Promise<void>;
    stop(): void;
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

/**
 * A claimed job this loop refuses to run as claimed — no workspace, no resolvable task worktree,
 * or a resume claim its selected executor cannot restore — answered as a failure report rather
 * than dropped, so the job reaches a terminal state somebody can see instead of being reclaimed
 * on every lease expiry forever. Null when the claim is runnable.
 */
function claimRefusal(job: BoardJob): { log: string; output: string } | null {
    /*
     * A job whose author has no workspace is FAILED, never run in a fallback location.
     *
     * There is no safe fallback left. Checkouts are per member now, so both `<mount>`
     * and `<mount>/<org>` are the parent of everybody's tree — handing either to a
     * container that may be running --dangerously-skip-permissions would let one
     * member's job read and edit another's working copy.
     */
    if (!workspacePathOf(job)) {
        return {
            log: 'no workspace for its author, failing',
            output: 'This job has no workspace. It was queued by an account this board cannot resolve a checkout directory for, or the board has no workspace root configured.',
        };
    }

    /*
     * A repo job runs in its task worktree (issue #35), so the same rule the null
     * workspacePath above applies extends there: a board-shaped repo label this
     * driver cannot resolve a worktree path for is failed with a reason, never run
     * in a fallback location. The board's own shape validation is not this
     * process's to trust.
     */
    if (job.repo && !worktreeRelDir(job)) {
        return {
            log: 'no resolvable task worktree for its repo label, failing',
            output: `This job names repository ${job.repo}, but its workspace and thread do not resolve to a task worktree directory this driver can run it in.`,
        };
    }

    return null;
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
     * Everything a running attempt needs from this loop: the board and runner, the driver's own
     * config and gate machinery, its logger and sleeper, the reclaim barrier every attempt's
     * startup sync waits on (see `reclaims` above), and the verdict-reporting entry point below.
     * Built once and handed to every `runJob` (moved to loop-run.ts, issue #223's line-count
     * split): none of these change between attempts, only the job each call carries does.
     */
    const rt: LoopRuntime = { board, runner, config, log, sleep, reclaims, report, ...(gates ? { gates } : {}) };

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
        const promise = runJob(rt, job).finally(() => active.delete(promise));
        active.add(promise);
    }

    /**
     * Removes one claimed reclaim row's tree and acks it, so the row stops being offered. The
     * tree is reclaimed with the same runner call a terminal thread's report() uses, fed a job
     * synthesised from the row: the thread's identity — its root id, repo label and workspace
     * path — is all the tree is filed under. The row's own id rides as the lease token, which is
     * exactly what makes the removal hold the checkout against a live attempt's startup sync
     * under kubernetes (the claim ConfigMap is keyed by the job id, and its holder data carries
     * the lease token).
     *
     * A removed thread has no follow-ups — every row was deleted — so there is no reclaim barrier
     * entry to take here: nothing can claim that root again, and this loop's owns each root it is
     * handed once. A refused tree or a throw — in the reclaim or its ack — simply skips the ack,
     * and the row is offered again when its lease expires; a refused tree also stays on the disk,
     * exactly as a refused terminal reclaim leaves it.
     */
    async function processReclaim(reclaim: Reclaim): Promise<void> {
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
            rootCommand: '',
            repo: reclaim.repo,
            // Removed-thread reclamation runs only the bundled git maintenance script. It is
            // not task execution and the deleted rows no longer carry an executor selection.
            executorType: CLAUDE_CODE,
        };
        let outcome: ReclaimResult;
        try {
            outcome = await runner.reclaimWorktree(removed);
        } catch (e) {
            log(`reclaim ${reclaim.id}: the worktree reclaim threw, leaving it to the lease: ${(e as Error).message}`);
            return;
        }
        if (!outcome.ok) {
            log(`reclaim ${reclaim.id}: the task worktree could not be reclaimed: ${outcome.reason}`);
            return;
        }
        let ack: ReclaimAck;
        try {
            ack = await board.ackReclaim(reclaim.id, config.worker);
        } catch (e) {
            log(`reclaim ${reclaim.id}: the ack threw, leaving it to the lease: ${(e as Error).message}`);
            return;
        }
        if (ack === 'lost') {
            log(`reclaim ${reclaim.id}: ack refused, the row is re-leased to another worker`);
        } else if (ack === 'missing') {
            log(`reclaim ${reclaim.id}: already acked elsewhere`);
        }
    }

    /**
     * Drains the board's worktree-reclaim queue (issue #41), one row at a time: a Remove deleted
     * a thread, or a done landed on an already-terminal one, and this loop is the worker half of
     * taking the tree down. Claim a row and hand it to `processReclaim`.
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
            await processReclaim(reclaim);
        }
    }

    /**
     * Claims one job (or waits out the poll interval when there is none, or the claim itself
     * failed), and either refuses it with a reason or hands it to `track`. The attempt then takes
     * it from here — the reclaim barrier, the checkout sync, the gates re-read and refusals, the
     * gate environment and the run are all runJob's (they moved in from this loop so the
     * attempt's heartbeat and abort signal cover the whole setup: a stop issued while the
     * dashboard says "Waiting for the executor…" now stands the attempt down within one
     * heartbeat poll, issue #126).
     */
    async function claimAndTrack(): Promise<void> {
        let job: BoardJob | null;
        try {
            job = await board.claim(config.worker);
        } catch (e) {
            log(`claim failed, retrying: ${(e as Error).message}`);
            await sleep(config.pollMs);
            return;
        }
        if (!job) {
            await sleep(config.pollMs);
            return;
        }

        // Reported with a reason rather than dropped, so a job this loop cannot run as claimed
        // reaches a terminal state somebody can see instead of being reclaimed on every lease
        // expiry forever.
        const refusal = claimRefusal(job);
        if (refusal) {
            log(`job ${job.id}: ${refusal.log}`);
            await report(job, { status: 'failed', exitCode: null, output: refusal.output }).catch((e: Error) =>
                log(`job ${job.id}: could not report the failure: ${e.message}`)
            );
            return;
        }
        track(job);
    }

    return {
        stop() {
            running = false;
        },

        async start() {
            log(
                `polling ${config.boardUrl} every ${config.pollMs}ms as "${config.worker}", ` +
                    `${config.concurrency} at a time, executor images ` +
                    `claude-code=${config.executorImages[CLAUDE_CODE]}, opencode=${config.executorImages.opencode}`
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
                await claimAndTrack();
            }

            // Claiming has stopped; let what is already running finish rather than orphaning
            // containers that are mid-edit in a checkout.
            if (active.size) log(`draining ${active.size} running job(s)`);
            await Promise.all(active);
            await draining;
        },
    };
}
