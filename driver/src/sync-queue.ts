/**
 * Orders startup syncs of one base clone (issue #559). Every sync of a clone takes the clone's
 * on-disk `factory-sync.lock` (scripts/git-worktree.cjs), so siblings would otherwise wait on that
 * file inside their sync scripts and give up at its wait bound. Queued here, a sibling waits in the
 * attempt instead — beating, and answering Stop, Remove and a lost lease through the attempt's
 * signal. Only the sync is ordered: the run that follows is not.
 *
 * `SyncQueue` is the seam: `syncQueue()` below orders ONE driver's syncs in process; an
 * implementation backed by shared state (the board, a Kubernetes Lease) can be handed to
 * `createLoop` to order every driver's behind the same contract — the on-disk lock stays the
 * guard either way.
 */
import type { AttemptCtx, SetupConclusion } from './loop-types.js';
import { STOOD_DOWN } from './loop-types.js';
import { repoPath, SYNC_DEADLINE_MS } from './publish.js';

/**
 * How long an attempt waits for its turn before handing its claim back (the loop's `requeue`):
 * a whole bounded sync ahead of it and as long again. A longer queue requeues its tail rather
 * than hold leases and driver slots behind a holder that may be wedged — no attempt is spent.
 */
export const SYNC_QUEUE_WAIT_MS = 2 * SYNC_DEADLINE_MS;

/** A held turn of one clone's queue. */
export interface SyncTurn {
    /**
     * Gives the turn up once `syncing` settles, however it settles — at once when no sync was
     * started. Called exactly once, and never throws: a backend that cannot reach its store must
     * let the turn expire instead.
     */
    release(syncing?: Promise<unknown>): void;
}

/**
 * The contract every implementation keeps:
 *
 * - `acquire` answers a turn once every earlier holder of `clone` has released, in arrival order.
 * - It answers null when `signal` aborts or `waitMs` runs out first, and a null never leaves a
 *   turn held behind it.
 * - It rejects only when the queue itself cannot be read; the loop treats that like contention.
 * - A turn whose holder died must not block the clone forever. In process, holders die with the
 *   queue. A shared implementation keys each turn to its `holder` attempt and gives it an expiry
 *   it renews until `release` — never a fixed one: a turn may outlast `SYNC_DEADLINE_MS` by its
 *   teardown — and may drop a turn whose holder's lease the board no longer knows as live.
 */
export interface SyncQueue {
    acquire(clone: string, options: SyncWait): Promise<SyncTurn | null>;
}

/** What one acquire waits with: the attempt's stand-down signal, its bound, and who is asking. */
export interface SyncWait {
    signal: AbortSignal;
    waitMs: number;
    /** The attempt the turn belongs to — unused in process, the fencing identity of a shared queue. */
    holder: { jobId: string; leaseToken: string };
}

/** One driver's queue: a promise chain per clone, dropped once its last turn is released. */
export function syncQueue(): SyncQueue {
    const tails = new Map<string, Promise<void>>();
    return {
        acquire(clone, { signal, waitMs }) {
            if (signal.aborted) return Promise.resolve(null);
            const ahead = tails.get(clone) ?? Promise.resolve();
            let release: SyncTurn['release'] = () => {};
            const mine = new Promise<void>((resolve) => {
                release = (syncing) =>
                    void (syncing ?? Promise.resolve()).then(
                        () => resolve(),
                        () => resolve()
                    );
            });
            // A place is held until both the one before it and its own sync have landed, so a
            // waiter that gave up hands its successor straight to its predecessor.
            const tail = ahead.then(() => mine);
            tails.set(clone, tail);
            void tail.then(() => {
                if (tails.get(clone) === tail) tails.delete(clone);
            });
            return new Promise((answer) => {
                let settled = false;
                const settle = (turn: SyncTurn | null) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    signal.removeEventListener('abort', giveUp);
                    if (!turn) release();
                    answer(turn);
                };
                const giveUp = () => settle(null);
                const timer = setTimeout(giveUp, waitMs);
                signal.addEventListener('abort', giveUp, { once: true });
                void ahead.then(() => settle({ release }));
            });
        },
    };
}

/** A job with no clone syncs nothing shared, so it queues behind nothing. */
const NO_TURN: SyncTurn = { release: () => {} };

/**
 * Waits for this attempt's turn at its clone's sync (issue #559). Not raced with `raceStep`: the
 * queue takes the signal itself, so a stand-down can never strand a turn it granted. A wait that
 * runs out, or a queue that cannot be read, hands the claim back like the script's contention.
 */
export async function awaitSyncTurn(ctx: AttemptCtx): Promise<SyncTurn | SetupConclusion> {
    const { rt, job, state } = ctx;
    const clone = repoPath(rt.config, job);
    if (clone === null) return NO_TURN;
    const waitMs = rt.syncWaitMs ?? SYNC_QUEUE_WAIT_MS;
    let turn: SyncTurn | null;
    try {
        const holder = { jobId: job.id, leaseToken: job.leaseToken };
        turn = await rt.syncs.acquire(clone, { signal: state.signal, waitMs, holder });
    } catch (e) {
        return { halt: 'requeue', log: `the sync queue could not be read, requeueing: ${(e as Error).message}` };
    }
    if (turn) return turn;
    if (state.signal.aborted) return STOOD_DOWN;
    return { halt: 'requeue', log: `waited ${waitMs}ms for an earlier sync of its clone, requeueing` };
}
