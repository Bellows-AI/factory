import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UserRepoStore } from '../db/user-repo-store.js';
import type { FactsCache } from './facts.js';
import { workspaceDir } from './reconcile.js';

/**
 * The manual purge (issue #92): one member deletes ONE orphaned checkout, deliberately.
 *
 * The sequence is the issue's serialization contract, in order:
 *
 * 1. `stampPurge` — one transaction, row locked, every refusal (selected, cloning, duplicate,
 *    unfinished tasks) decided under the lock, and the row stamped `purging`.
 * 2. The directory removal — a bounded child process, OUTSIDE any database transaction.
 * 3. Only once the child's exit is observed: the second transaction deletes the row (only if it is
 *    still deselected and still `purging`), which is also what releases the stamp. An error lands
 *    the row back on `failed` with the reason — deselected, visible, retryable — so the row
 *    outlives any partial directory, including after a crash (boot recovery finishes those).
 *
 * No DB compare-and-delete here is protection against a still-running filesystem deletion: the
 * row is never touched until the child has exited, which is the stronger guarantee the issue asks
 * for. There is no in-process watchdog — a crash orphans the stamp, and boot recovery is what
 * finishes it, under the same single-process assumption the clone queue's `cloning` rows already
 * carry (011's header).
 */

/**
 * How long the removal child may run before it is killed and reaped.
 *
 * The facts cache bounds its `du` at 20s, but a read is not a delete: a checkout with its
 * dependencies installed is hundreds of thousands of files, and unlinking is slower than sizing,
 * especially on a cold network volume. Generous on purpose — the member is watching a spinner,
 * and a false timeout would leave a half-deleted tree and a failed row for a retry to finish.
 */
export const PURGE_TIMEOUT_MS = 60_000;

/** Captured so a failing child's own words can travel on the row. */
const STDERR_KEEP = 2000;
const MS_PER_SECOND = 1000;

/**
 * `rm -rf` in a bounded child process, argv-array (never a shell string), observing the child's
 * EXIT — not spawning it and walking away. A timeout kills with SIGKILL and then waits for the
 * exit event, so no caller can release a stamp while the child still runs.
 */
export function removeTree(
    dir: string,
    timeoutMs: number = PURGE_TIMEOUT_MS,
    spawnImpl: typeof spawn = spawn
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawnImpl('rm', ['-rf', '--', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-STDERR_KEEP);
        });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) return resolve();
            const detail = stderr.trim();
            if (timedOut) {
                return reject(new Error(`purge of ${dir} timed out after ${Math.round(timeoutMs / MS_PER_SECOND)}s`));
            }
            reject(new Error(detail || `rm -rf exited with code ${code ?? signal}`));
        });
    });
}

/** What a purge decided. The refusals are the store's, untouched; the results drive the status codes. */
export type PurgeOutcome =
    | 'missing'
    | { refused: 'selected' }
    | { refused: 'cloning' }
    | { refused: 'purging' }
    | { refused: 'tasks'; count: number }
    /** 202: the row is stamped and the removal child is running. */
    | { result: 'started' }
    /** 204: nothing to remove — the row was stale, and it is gone now. */
    | { result: 'cleaned' };

export interface Purger {
    purge(userId: string, repo: { owner: string; name: string }): Promise<PurgeOutcome>;
    /** Finishes every `purging` row a crash orphaned. Runs once at boot, before the routes serve. */
    recoverInterrupted(): Promise<void>;
    /** Awaits every in-flight finish. The tests use it instead of waiting on a real child. */
    settle(): Promise<void>;
}

const firstLine = (error: unknown): string => (error as Error).message.split('\n')[0] ?? 'purge failed';

export function createPurger(deps: {
    store: UserRepoStore;
    root: string;
    orgId: string;
    facts: FactsCache;
    log?: (message: string) => void;
    /** Test seam over removeTree, so faults can be injected without a real child. */
    remove?: (dir: string) => Promise<void>;
}): Purger {
    const { store, root, orgId, facts, log = () => {}, remove = (dir) => removeTree(dir) } = deps;
    const inFlight = new Set<Promise<void>>();

    const dirOf = (userId: string, name: string): string =>
        // The path is built from the authenticated caller and the stored row, never from a
        // client-supplied segment — workspaceDir asserts the uuid, and the name arrives from the
        // route's parameter validation and the row's own constraint. The sibling `.worktrees/`
        // directory is one level up and never traversed: only this exact path is handed to rm.
        join(workspaceDir(root, orgId, userId), name);

    /** Runs after the child has exited — the only place the row may be deleted or un-stamped. */
    const finishPurge = async (userId: string, repo: { owner: string; name: string }, dir: string) => {
        try {
            await remove(dir);
            const deleted = await store.deletePurged(userId, repo);
            if (!deleted) {
                // A selection committed between the stamp and this moment and re-queued the row:
                // the tree is gone but the row stays, and the queue re-clones it. Say so rather
                // than swallow it.
                log(`purge of ${repo.name}: the row moved behind the deletion; the checkout will re-clone`);
            }
            // In both branches the tree at this path is gone or about to be re-cloned: the old
            // measurements must not answer for the next tree.
            facts.invalidate(dir);
        } catch (error) {
            const message = firstLine(error);
            log(`purge of ${repo.name} failed: ${message}`);
            // The failure record is best-effort for exactly the reason it exists: if the database
            // just failed, this write fails too, and letting it throw would reject a promise this
            // detached chain nobody else handles — an unhandled rejection that kills the process.
            // The row stays `purging`, which boot recovery finishes; the log line says why.
            try {
                await store.markPurgeFailed(userId, repo, message);
            } catch (e) {
                log(`purge of ${repo.name}: could not record the failure: ${(e as Error).message}`);
            }
        }
    };

    return {
        async purge(userId, repo) {
            const stamped = await store.stampPurge(userId, repo);
            if (stamped === 'missing') return 'missing';
            if ('refused' in stamped) return stamped;

            const dir = dirOf(userId, repo.name);
            if (!existsSync(dir)) {
                // A missing directory is a successful cleanup of a stale row — the member asked
                // for the disk back, and there is no disk to take back. No child, no second
                // transaction later: the row goes now, under the same contract deletePurged
                // enforces (still deselected, still purging).
                const deleted = await store.deletePurged(userId, repo);
                if (!deleted) log(`purge of ${repo.name}: the row moved behind the stamp; leaving it alone`);
                facts.invalidate(dir);
                return { result: 'cleaned' };
            }

            // Started, not awaited — the route answers 202 and the SPA polls the row through
            // `purging` to `failed` or disappearance. Tracked so `settle()` can await it. The
            // `.catch` on the DERIVED chain is the last line of defense: finishPurge handles its
            // own errors, but a bug in this module must surface as a log line, never as an
            // unhandled rejection — Node's default for one of those is to terminate the process,
            // and one detached purge must not outlive the server it was asked on.
            const finish = finishPurge(userId, repo, dir);
            inFlight.add(finish);
            void finish
                .finally(() => inFlight.delete(finish))
                .catch((e: Error) => log(`purge of ${repo.name} finished unrecorded: ${e.message}`));
            return { result: 'started' };
        },

        async recoverInterrupted() {
            for (const row of await store.listPurging()) {
                const dir = dirOf(row.userId, row.name);
                try {
                    // Residue first, then the row — the same order as a live purge, and `rm -rf`
                    // answers a missing directory with success, which is exactly what a crash
                    // between the child's exit and the row delete leaves behind.
                    await remove(dir);
                    await store.deletePurged(row.userId, row);
                    facts.invalidate(dir);
                    log(`finished interrupted purge of ${row.userId}/${row.name}`);
                } catch (error) {
                    const message = firstLine(error);
                    log(`purge of ${row.name} failed: ${message}`);
                    // Best-effort, like finishPurge's: a database that fails this write must not
                    // abort the whole sweep — the org's remaining purging rows would stay stuck
                    // behind a stamp nothing would release until the next boot.
                    try {
                        await store.markPurgeFailed(row.userId, row, message);
                    } catch (e) {
                        log(`purge of ${row.name}: could not record the failure: ${(e as Error).message}`);
                    }
                }
            }
        },

        async settle() {
            await Promise.all([...inFlight]);
        },
    };
}
