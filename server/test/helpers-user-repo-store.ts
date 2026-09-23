import type { CloneStatus, UserRepo, UserRepoStore } from '../src/db/user-repo-store.js';

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
 */
export function memoryUserRepoStore(): MemoryUserRepoStore {
    const rows: Row[] = [];
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
            for (const repo of repos) applySelection(rows, at, userId, repo);
            markDropped(rows, at, userId, repos);
        },

        async list(userId) {
            return rows.filter((r) => r.userId === userId && r.deselectedAt === null).map(view);
        },

        async orphaned(userId) {
            return rows.filter((r) => r.userId === userId && r.deselectedAt !== null).map(view);
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
