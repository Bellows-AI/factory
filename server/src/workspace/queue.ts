import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { UserRepoStore } from '../db/user-repo-store.js';
import type { TokenProvider } from '../github/token.js';
import { cloneRepo, type CloneOptions } from './reconcile.js';

/**
 * Clones the repositories members have selected, in the background, a couple at a time.
 *
 * Driven off `user_repo` rows rather than off a promise queue held in the route. The row has to
 * exist regardless — it is what the SPA polls for a clone's progress — so driving off it is
 * strictly less machinery than a queue that would also have to be reconciled against it. It also
 * survives a restart, which an in-memory queue does not.
 */

/**
 * How many clones run at once.
 *
 * Low, because each one is minutes of network and unbounded disk, and because a burst of them
 * against one origin is exactly the shape of a request nobody thanks you for. Raising it does not
 * make any single clone finish sooner.
 */
export const DEFAULT_CLONE_CONCURRENCY = 2;

/** How often the queue looks for work when it found none last time. */
const IDLE_POLL_MS = 5_000;

export interface CloneQueue {
    /** Recovers stranded rows, sweeps stale staging directories, then starts polling. */
    start(): Promise<void>;
    stop(): void;
    /** Runs one pass immediately. The route calls this after a selection so it starts at once. */
    kick(): void;
}

export interface CloneQueueDeps {
    readonly store: UserRepoStore;
    readonly root: string;
    readonly orgId: string;
    /** Absent under the code-only `none` arm (the offline tooling), where only public repositories can clone. */
    readonly tokens?: TokenProvider | undefined;
    readonly concurrency?: number;
    readonly log?: (message: string) => void;
    /** Test seams, passed straight through to cloneRepo. */
    readonly cloneUrl?: CloneOptions['cloneUrl'];
    readonly run?: CloneOptions['run'];
    /** Called after each pass. The suite uses it instead of waiting on a timer. */
    readonly onIdle?: () => void;
}

/**
 * Removes `<name>.tmp-<pid>` trees left by a process that died mid-clone.
 *
 * The rename into place is atomic, so a `.tmp-` directory is never a finished clone and is never
 * anything anybody wants. Without this sweep each interrupted clone leaks a full checkout's worth
 * of disk permanently, and nothing would ever look at it again.
 */
export function sweepStaging(root: string, orgId: string, log: (message: string) => void): number {
    let removed = 0;
    const orgDir = join(root, orgId);
    let users: string[];
    try {
        users = readdirSync(orgDir);
    } catch {
        // No workspaces yet. Not an error: nothing has been provisioned.
        return 0;
    }
    for (const user of users) {
        let entries: string[];
        try {
            entries = readdirSync(join(orgDir, user));
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!/\.tmp-\d+$/.test(entry)) continue;
            rmSync(join(orgDir, user, entry), { recursive: true, force: true });
            removed += 1;
            log(`swept ${user}/${entry}`);
        }
    }
    return removed;
}

export function createCloneQueue(deps: CloneQueueDeps): CloneQueue {
    const {
        store,
        root,
        orgId,
        tokens,
        concurrency = DEFAULT_CLONE_CONCURRENCY,
        log = () => {},
        cloneUrl,
        run,
        onIdle,
    } = deps;

    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let inFlight = 0;
    let passing: Promise<void> | null = null;

    const pass = async (): Promise<void> => {
        if (stopped) return;
        const room = concurrency - inFlight;
        if (room <= 0) return;

        const claimed = await store.claimPending(room);
        if (!claimed.length) return;

        /*
         * Started, not awaited as a batch.
         *
         * `await Promise.all(...)` here made concurrency effectively one: a pass could not finish
         * until its slowest clone did, and passes are serialised — so one fifteen-minute clone of a
         * large monorepo idled the other slot and held up every other member's queued repository
         * behind it. Each clone now frees its own slot and immediately re-runs a pass to refill it,
         * which is the pipeline the concurrency setting is supposed to describe.
         */
        for (const job of claimed) {
            inFlight += 1;
            void (async () => {
                try {
                    // A fresh token per repo. An installation token lasts an hour and a batch of
                    // clones can outlive one, so taking it once for the batch would fail the tail.
                    // The provider caches, so this is usually free.
                    const token = tokens ? await tokens.get() : undefined;
                    await cloneRepo({
                        root,
                        orgId,
                        userId: job.userId,
                        repo: { owner: job.owner, name: job.name },
                        token,
                        log: (m) => log(`${job.userId} ${m}`),
                        cloneUrl,
                        run,
                    });
                    await store.markReady(job.userId, job);
                } catch (error) {
                    // Recorded against the row rather than thrown. One member's broken repository
                    // must not stop everyone else's clones, and the page shows this sentence.
                    const message = (error as Error).message.split('\n')[0] ?? 'clone failed';
                    log(`failed ${job.owner}/${job.name}: ${message}`);
                    await store.markFailed(job.userId, job, message).catch(() => {});
                } finally {
                    inFlight -= 1;
                    // Refill the slot this clone just freed, rather than waiting out the poll.
                    if (!stopped) void runPass();
                    else settle();
                }
            })();
        }
    };

    /**
     * Announces that there is nothing left to do — no pass running and no clone in flight.
     *
     * Only the tests listen. It has to account for `inFlight` as well as the pass, because a pass
     * now returns as soon as it has *started* its clones rather than when they finish.
     */
    const settle = () => {
        if (passing === null && inFlight === 0) onIdle?.();
    };

    /**
     * Coalesced rather than queued: a `kick()` arriving during a pass joins that pass instead of
     * starting a second one. A selection saved after this pass has already claimed its rows
     * therefore waits for the next tick — acceptable, because a clone that just finished re-runs a
     * pass from its `finally` anyway.
     */
    const runPass = (): Promise<void> => {
        passing ??= pass()
            .catch((error: Error) => log(`pass failed: ${error.message}`))
            .finally(() => {
                passing = null;
                settle();
            });
        return passing;
    };

    const loop = () => {
        if (stopped) return;
        void runPass().finally(() => {
            if (stopped) return;
            timer = setTimeout(loop, IDLE_POLL_MS);
            // Nothing here should hold the process open.
            timer.unref?.();
        });
    };

    return {
        async start() {
            /*
             * Recovery, before anything else runs.
             *
             * A row left in `cloning` is owned by a process that no longer exists, and nothing else
             * will ever pick it up — the claim only takes `queued`. Sound because a `cloning` row
             * can only be owned by a live in-process runner and at boot there are none, which is
             * the single-process assumption written into 011's header.
             */
            const stranded = await store.requeueStranded();
            if (stranded) log(`requeued ${stranded} clone${stranded === 1 ? '' : 's'} stranded by a restart`);

            const swept = sweepStaging(root, orgId, log);
            if (swept) log(`swept ${swept} partial clone${swept === 1 ? '' : 's'}`);

            loop();
        },

        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        },

        kick() {
            if (stopped) return;
            void runPass();
        },
    };
}
