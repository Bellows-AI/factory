import { type CloneStatus, PurgeConflictError, type UserRepo, type UserRepoStore } from '../src/db/user-repo-store.js';

/** How the memory double counts tasks blocking a purge. The SQL store reads the job table; this has none. */
export type BlockingTasks = (userId: string, name: string) => number;

export interface MemoryUserRepoStore extends UserRepoStore {
    /** Every row, deselected ones included, so a test can assert nothing was deleted. */
    rows(): { userId: string; owner: string; name: string; status: CloneStatus; deselected: boolean }[];
    /** Puts a row into `cloning` without a queue, to stand in for a process that then died. */
    strand(userId: string, repo: { owner: string; name: string }): void;
}

interface Row {
    userId: string;
    owner: string;
    name: string;
    status: CloneStatus;
    error: string | null;
    attempts: number;
    selectedAt: string;
    startedAt: string | null;
    readyAt: string | null;
    purgeStartedAt: string | null;
    deselectedAt: string | null;
}

/** Applies one selection request: holds an existing row (re-queuing unless already ready) or adds a new one. */
function applySelection(rows: Row[], at: () => string, userId: string, repo: { owner: string; name: string }): void {
    const held = rows.find((r) => r.userId === userId && r.owner === repo.owner && r.name === repo.name);
    if (held) {
        held.deselectedAt = null;
        held.selectedAt = at();
        // A checkout that is on disk is on disk, whatever a later request says.
        if (held.status !== 'ready') {
            held.status = 'queued';
            held.error = null;
        }
        return;
    }
    rows.push({
        userId,
        owner: repo.owner,
        name: repo.name,
        status: 'queued',
        error: null,
        attempts: 0,
        selectedAt: at(),
        startedAt: null,
        readyAt: null,
        purgeStartedAt: null,
        deselectedAt: null,
    });
}

/** Marks every held row for this user NOT named in `repos` as deselected. */
function markDropped(
    rows: Row[],
    at: () => string,
    userId: string,
    repos: readonly { owner: string; name: string }[]
): void {
    const keep = new Set(repos.map((r) => `${r.owner}/${r.name}`));
    for (const row of rows) {
        if (row.userId !== userId || row.deselectedAt !== null) continue;
        if (!keep.has(`${row.owner}/${row.name}`)) row.deselectedAt = at();
    }
}

/**
 * An in-memory UserRepoStore: it keeps the offline suite a no-database suite while still
 * exercising the selection rules, the claim and the restart recovery. The SQL behind it is covered
 * by server/test-db, which needs a container.
 *
 * `blockingTasks` stands in for the job-table count behind `stampPurge`'s `tasks` refusal; the
 * default counts nothing, which is what a member with no tasks is.
 */
export function memoryUserRepoStore(options?: { blockingTasks?: BlockingTasks }): MemoryUserRepoStore {
    const rows: Row[] = [];
    const blockingTasks = options?.blockingTasks ?? (() => 0);
    const at = () => new Date().toISOString();
    const find = (userId: string, repo: { owner: string; name: string }) =>
        rows.find((r) => r.userId === userId && r.owner === repo.owner && r.name === repo.name);
    const view = (row: Row): UserRepo => ({
        owner: row.owner,
        name: row.name,
        status: row.status,
        error: row.error,
        attempts: row.attempts,
        selectedAt: row.selectedAt,
        startedAt: row.startedAt,
        readyAt: row.readyAt,
        purgeStartedAt: row.purgeStartedAt,
    });

    return {
        rows: () =>
            rows.map((r) => ({
                userId: r.userId,
                owner: r.owner,
                name: r.name,
                status: r.status,
                deselected: r.deselectedAt !== null,
            })),

        strand(userId, repo) {
            const row = find(userId, repo);
            if (row) row.status = 'cloning';
        },

        async select(userId, repos) {
            // Same refusal the SQL store decides under its lock: a checkout stamped `purging`
            // cannot be re-selected underneath its deletion.
            // By NAME, like the SQL lock: the checkout directory is keyed by name.
            const names = new Set(repos.map((repo) => repo.name));
            const purging = rows
                .filter((r) => r.userId === userId && names.has(r.name) && r.status === 'purging')
                .map((r) => r.name)
                .sort();
            if (purging.length) throw new PurgeConflictError(purging);
            for (const repo of repos) applySelection(rows, at, userId, repo);
            markDropped(rows, at, userId, repos);
        },

        async list(userId) {
            return rows.filter((r) => r.userId === userId && r.deselectedAt === null).map(view);
        },

        async orphaned(userId) {
            return rows.filter((r) => r.userId === userId && r.deselectedAt !== null).map(view);
        },

        async stampPurge(userId, repo) {
            const row = find(userId, repo);
            if (!row) return 'missing';
            if (row.deselectedAt === null) return { refused: 'selected' };
            if (row.status === 'purging') return { refused: 'purging' };
            if (row.status === 'cloning') return { refused: 'cloning' };
            const count = blockingTasks(userId, repo.name);
            if (count > 0) return { refused: 'tasks', count };
            row.status = 'purging';
            row.purgeStartedAt = at();
            row.error = null;
            return { stamped: true };
        },

        async deletePurged(userId, repo) {
            const row = find(userId, repo);
            if (!row || row.deselectedAt === null || row.status !== 'purging') return false;
            rows.splice(rows.indexOf(row), 1);
            return true;
        },

        async markPurgeFailed(userId, repo, error) {
            const row = find(userId, repo);
            if (!row || row.status !== 'purging') return;
            row.status = 'failed';
            row.error = error;
        },

        async listPurging() {
            return rows
                .filter((r) => r.status === 'purging')
                .sort((a, b) => (a.purgeStartedAt ?? '').localeCompare(b.purgeStartedAt ?? ''))
                .map((row) => ({ userId: row.userId, ...view(row) }));
        },

        async claimPending(limit) {
            const claimed = rows
                .filter((r) => r.status === 'queued' && r.deselectedAt === null)
                .sort((a, b) => a.selectedAt.localeCompare(b.selectedAt))
                .slice(0, Math.max(0, limit));
            for (const row of claimed) {
                row.status = 'cloning';
                row.startedAt = at();
                row.attempts += 1;
                row.error = null;
            }
            return claimed.map((r) => ({ userId: r.userId, owner: r.owner, name: r.name }));
        },

        async markReady(userId, repo) {
            const row = find(userId, repo);
            if (!row) return;
            row.status = 'ready';
            row.readyAt = at();
            row.error = null;
        },

        async markFailed(userId, repo, error) {
            const row = find(userId, repo);
            if (!row) return;
            row.status = 'failed';
            row.error = error;
        },

        async requeueStranded() {
            const stranded = rows.filter((r) => r.status === 'cloning');
            for (const row of stranded) {
                row.status = 'queued';
                row.error = null;
            }
            return stranded.length;
        },
    };
}
