/**
 * Orders one driver's startup syncs of the same base clone (issue #559). Every sync of a clone
 * takes the clone's on-disk `factory-sync.lock` (scripts/git-worktree.cjs), so siblings claimed by
 * one driver would otherwise wait on that file inside their sync scripts and give up at its wait
 * bound. Queued here, a sibling waits in the attempt instead — beating, and answering Stop, Remove
 * and a lost lease through the attempt's signal — and the script only ever meets the lock when
 * another driver holds it. Only the sync is ordered: the run that follows is not.
 */

export interface SyncTurn {
    /** Settles once every earlier sync of the clone has landed. */
    ready: Promise<void>;
    /**
     * Gives the place up: once `syncing` settles (however it settles), or at once when no sync was
     * started. Called exactly once.
     */
    release: (syncing?: Promise<unknown>) => void;
}

export interface SyncQueue {
    /** Joins the clone's queue; a null clone (no repo) queues behind nothing. */
    enter(clone: string | null): SyncTurn;
}

export function syncQueue(): SyncQueue {
    const tails = new Map<string, Promise<void>>();
    return {
        enter(clone) {
            if (clone === null) return { ready: Promise.resolve(), release: () => {} };
            const ready = tails.get(clone) ?? Promise.resolve();
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
            const tail = ready.then(() => mine);
            tails.set(clone, tail);
            void tail.then(() => {
                if (tails.get(clone) === tail) tails.delete(clone);
            });
            return { ready, release };
        },
    };
}
