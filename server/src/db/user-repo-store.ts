import type { Sql, TransactionSql } from 'postgres';
import { fullName, type Repo } from '../config.js';

export type CloneStatus = 'queued' | 'cloning' | 'ready' | 'failed' | 'purging';

export interface UserRepo extends Repo {
    readonly status: CloneStatus;
    readonly error: string | null;
    readonly attempts: number;
    readonly selectedAt: string;
    readonly startedAt: string | null;
    readonly readyAt: string | null;
    /** When the deletion of this orphaned checkout was stamped. Null outside a purge. */
    readonly purgeStartedAt: string | null;
}

/**
 * Thrown by `select` when the selection would change a row stamped `purging` — a checkout whose
 * deletion has started cannot be re-selected underneath it. The route answers
 * 409 `PURGE_IN_PROGRESS`; the names are the offending checkouts.
 */
export class PurgeConflictError extends Error {
    readonly names: string[];
    constructor(names: string[]) {
        super(`"${names.join(', ')}" is being deleted from disk — wait for the deletion to finish`);
        this.name = 'PurgeConflictError';
        this.names = names;
    }
}

/** What `stampPurge` decided. Every refusal is the row's state under the lock, in one transaction. */
export type PurgeStampResult =
    | 'missing'
    | { refused: 'selected' }
    | { refused: 'cloning' }
    | { refused: 'purging' }
    | { refused: 'tasks'; count: number }
    | { stamped: true };

/** A row the queue has taken responsibility for, with the user it belongs to. */
export interface PendingClone extends Repo {
    readonly userId: string;
}

export interface UserRepoStore {
    /**
     * Replaces a member's whole selection.
     *
     * The body of `PUT /api/workspace/repos` is the entire list, so this is a replace and replaying
     * it is a no-op — which is what makes the route a PUT. Repos already `ready` keep their status:
     * re-selecting something that is already checked out must not re-clone it, and a clone that is
     * on disk is on disk regardless of what a later request says.
     *
     * Deselected rows are marked, never deleted. The row is the only record that a tree exists on
     * disk; deleting it makes unbounded disk growth invisible.
     */
    select(userId: string, repos: readonly Repo[]): Promise<void>;
    list(userId: string): Promise<UserRepo[]>;
    /** Everything this member deselected but that is still on disk. Nothing prunes them yet. */
    orphaned(userId: string): Promise<UserRepo[]>;

    /**
     * Stamps one deselected row `purging`, deciding every refusal under the row's lock, in one
     * transaction (issue #92). The order matters: lock first, then deselection, clone status,
     * blocking tasks — so a selection that commits first makes the deselection check fail, and a
     * stamp that commits first is visible to every later select and task insert.
     */
    stampPurge(userId: string, repo: { owner: string; name: string }): Promise<PurgeStampResult>;

    /**
     * The purge's second transaction: deletes the row only if it is STILL deselected and STILL
     * `purging` — a selection that slipped in behind the stamp's back re-queues the row, and this
     * must refuse to delete it. False means nothing was deleted.
     */
    deletePurged(userId: string, repo: { owner: string; name: string }): Promise<boolean>;

    /**
     * A purge that could not finish (the removal child failed or timed out) lands the row back on
     * `failed` with the reason: deselected, visible, retryable — the row outlives the directory.
     */
    markPurgeFailed(userId: string, repo: { owner: string; name: string }, error: string): Promise<void>;

    /**
     * Every `purging` row in this org with its member, for boot recovery: a restart orphans a row
     * stamped mid-deletion, and recovery finishes each one before the routes accept anything.
     */
    listPurging(): Promise<(UserRepo & { userId: string })[]>;

    /**
     * Takes up to `limit` queued rows and marks them `cloning`, for this process to work on.
     *
     * `for update skip locked`, like the job board's claim, so the day a second replica exists this
     * query is already correct — see the header of 011 for the one statement that would not be.
     */
    claimPending(limit: number): Promise<PendingClone[]>;
    markReady(userId: string, repo: Repo): Promise<void>;
    markFailed(userId: string, repo: Repo, error: string): Promise<void>;

    /**
     * Returns every row stranded in `cloning` to `queued`. Called once at boot, before the queue
     * starts.
     *
     * Sound because a `cloning` row can only be owned by a live in-process runner, and at boot there
     * are none. The staging directory a killed clone leaves behind is separately safe — it is
     * `<name>.tmp-<pid>` and never `<name>` — but the ROW is not, and without this it stays
     * `cloning` forever while nothing is cloning it.
     */
    requeueStranded(): Promise<number>;
}

/** A clone failure's stored message is capped, matching the column's practical display width. */
const CLONE_ERROR_LIMIT = 2000;

interface Row {
    repo_owner: string;
    repo_name: string;
    status: CloneStatus;
    error: string | null;
    attempts: number;
    selected_at: Date;
    started_at: Date | null;
    ready_at: Date | null;
    purge_started_at: Date | null;
}

const toUserRepo = (row: Row): UserRepo => ({
    owner: row.repo_owner,
    name: row.repo_name,
    status: row.status,
    error: row.error,
    attempts: row.attempts,
    selectedAt: row.selected_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    readyAt: row.ready_at?.toISOString() ?? null,
    purgeStartedAt: row.purge_started_at?.toISOString() ?? null,
});

/** The organization is bound at construction: a constant for the life of the process, never a per-call parameter. */
export function createUserRepoStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
}): UserRepoStore {
    const gate = async () => {
        if (ready) await ready;
    };

    /** The columns every read of this table selects. */
    const COLUMNS = sql`
        repo_owner, repo_name, status, error, attempts, selected_at, started_at, ready_at, purge_started_at
    `;

    /**
     * The tasks that block a purge, counted for one member by the checkout's repo NAME: the
     * directory is keyed by name (`user_repo_dir_uk`), so a task queued against `other/<name>`
     * writes in the same checkout one queued against `<owner>/<name>` would. A thread blocks when
     * it is not over — any member nonterminal, or no member marked done; command-only tasks (repo
     * null) run in no checkout and never block. Threaded by root_job_id, the same key every thread
     * read uses.
     */
    const blockingTaskCount = (tx: TransactionSql, userId: string, name: string) =>
        tx<{ blocking: number }[]>`
            select coalesce(sum(case when thread.moving or not thread.marked_done then thread.tasks else 0 end), 0)::int as blocking
            from (
                select root_job_id,
                       count(*)::int as tasks,
                       bool_or(status not in ('succeeded','failed','dead','stopped')) as moving,
                       bool_or(done_at is not null) as marked_done
                from job
                where org_id = ${orgId}
                  and created_by = ${userId}
                  and repo is not null
                  and split_part(repo, '/', 2) = ${name}
                group by root_job_id
            ) thread
        `;

    /**
     * Every stampPurge refusal, decided about the row AS LOCKED. Null means nothing refused the
     * stamp and the update may run.
     */
    const stampRefusal = async (
        tx: TransactionSql,
        userId: string,
        repo: { owner: string; name: string },
        row: { status: CloneStatus; deselected: boolean } | undefined
    ): Promise<PurgeStampResult | null> => {
        if (!row) return 'missing';
        // A selected row is refused regardless of its clone status: deleting a checkout the
        // member still uses is exactly what the confirmation exists to prevent.
        if (!row.deselected) return { refused: 'selected' };
        if (row.status === 'purging') return { refused: 'purging' };
        if (row.status === 'cloning') return { refused: 'cloning' };
        const [counted] = await blockingTaskCount(tx, userId, repo.name);
        if ((counted?.blocking ?? 0) > 0) return { refused: 'tasks', count: counted?.blocking ?? 0 };
        return null;
    };

    return {
        async select(userId, repos) {
            await gate();
            // "owner/name" as the comparison key. A repo name cannot contain a slash — the check
            // constraint says so — which is what makes the concatenation unambiguous. A row
            // constructor (`(a, b) not in (…)`) would read better and is not something the driver
            // can send.
            const keys = repos.map(fullName);

            await sql.begin(async (tx) => {
                // A checkout stamped `purging` cannot be re-selected underneath its deletion.
                // Lock first, check second — the lock takes EVERY row the selection names, so a
                // stamp that committed while this transaction waited is visible in the re-read
                // (READ COMMITTED re-reads the newest committed row once the lock is granted); a
                // select that commits first makes the stamp's own deselection check fail. Either
                // order, exactly one of the two wins and the loser sees the winner's state. A
                // WHERE status = 'purging' here would be the wrong shape: a row that only becomes
                // purging in the other transaction's uncommitted write matches neither snapshot
                // and slips through.
                const names = repos.map((repo) => repo.name);
                if (names.length) {
                    const locked = await tx<{ repo_name: string; status: CloneStatus }[]>`
                        select repo_name, status from user_repo
                        where org_id = ${orgId} and user_id = ${userId}
                          and repo_name = any(${names})
                        order by repo_name
                        for update
                    `;
                    const purging = locked
                        .filter((row) => row.status === 'purging')
                        .map((row) => row.repo_name)
                        .sort();
                    if (purging.length) throw new PurgeConflictError(purging);
                }
                if (repos.length) {
                    const rows = repos.map((repo) => ({
                        org_id: orgId,
                        user_id: userId,
                        repo_owner: repo.owner,
                        repo_name: repo.name,
                    }));
                    await tx`
                        insert into user_repo ${tx(rows, 'org_id', 'user_id', 'repo_owner', 'repo_name')}
                        on conflict (org_id, user_id, repo_owner, repo_name) do update set
                            -- Re-selecting resurrects a deselected row rather than inserting beside
                            -- it, and re-queues one that failed so the retry is the member's choice.
                            -- A ready row is left alone: a checkout that is on disk is on disk, and
                            -- re-cloning it would throw away work an agent may not have pushed.
                            deselected_at = null,
                            selected_at   = now(),
                            status        = case when user_repo.status = 'ready' then 'ready' else 'queued' end,
                            error         = case when user_repo.status = 'ready' then user_repo.error else null end
                    `;
                }
                // Everything not in the list. Marked, not deleted — the row is the only record that
                // the directory exists.
                await tx`
                    update user_repo set deselected_at = now()
                    where org_id = ${orgId} and user_id = ${userId} and deselected_at is null
                      and (repo_owner || '/' || repo_name) <> all(${keys})
                `;
            });
        },

        async list(userId) {
            await gate();
            const rows = await sql<Row[]>`
                select ${COLUMNS}
                from user_repo
                where org_id = ${orgId} and user_id = ${userId} and deselected_at is null
                order by repo_owner asc, repo_name asc
            `;
            return rows.map(toUserRepo);
        },

        async orphaned(userId) {
            await gate();
            const rows = await sql<Row[]>`
                select ${COLUMNS}
                from user_repo
                where org_id = ${orgId} and user_id = ${userId} and deselected_at is not null
                order by repo_owner asc, repo_name asc
            `;
            return rows.map(toUserRepo);
        },

        async stampPurge(userId, repo) {
            await gate();
            return sql.begin(async (tx) => {
                // Lock first. Everything decided below is decided about the row AS LOCKED, so a
                // concurrent selection, a second purge, or a task insert serializes behind this
                // transaction instead of racing it.
                const [row] = await tx<{ status: CloneStatus; deselected: boolean }[]>`
                    select status, deselected_at is not null as deselected
                    from user_repo
                    where org_id = ${orgId} and user_id = ${userId}
                      and repo_owner = ${repo.owner} and repo_name = ${repo.name}
                    for update
                `;
                const refusal = await stampRefusal(tx, userId, repo, row);
                if (refusal !== null) return refusal;

                await tx`
                    update user_repo set status = 'purging', purge_started_at = now(), error = null
                    where org_id = ${orgId} and user_id = ${userId}
                      and repo_owner = ${repo.owner} and repo_name = ${repo.name}
                `;
                return { stamped: true };
            });
        },

        async deletePurged(userId, repo) {
            await gate();
            const rows = await sql`
                delete from user_repo
                where org_id = ${orgId} and user_id = ${userId}
                  and repo_owner = ${repo.owner} and repo_name = ${repo.name}
                  and deselected_at is not null and status = 'purging'
                returning 1
            `;
            return rows.length > 0;
        },

        async markPurgeFailed(userId, repo, error) {
            await gate();
            await sql`
                update user_repo set status = 'failed', error = ${error.slice(0, CLONE_ERROR_LIMIT)}
                where org_id = ${orgId} and user_id = ${userId}
                  and repo_owner = ${repo.owner} and repo_name = ${repo.name}
                  and status = 'purging'
            `;
        },

        async listPurging() {
            await gate();
            const rows = await sql<(Row & { user_id: string })[]>`
                select user_id, ${COLUMNS}
                from user_repo
                where org_id = ${orgId} and status = 'purging'
                order by purge_started_at asc
            `;
            return rows.map((row) => ({ userId: row.user_id, ...toUserRepo(row) }));
        },

        async claimPending(limit) {
            await gate();
            if (limit <= 0) return [];
            const rows = await sql<{ user_id: string; repo_owner: string; repo_name: string }[]>`
                with claimed as (
                    select org_id, user_id, repo_owner, repo_name
                    from user_repo
                    where org_id = ${orgId} and status = 'queued' and deselected_at is null
                    order by selected_at asc
                    limit ${limit}
                    for update skip locked
                )
                update user_repo r
                set status = 'cloning', started_at = now(), attempts = r.attempts + 1, error = null
                from claimed c
                where r.org_id = c.org_id and r.user_id = c.user_id
                  and r.repo_owner = c.repo_owner and r.repo_name = c.repo_name
                returning r.user_id, r.repo_owner, r.repo_name
            `;
            return rows.map((row) => ({ userId: row.user_id, owner: row.repo_owner, name: row.repo_name }));
        },

        async markReady(userId, repo) {
            await gate();
            await sql`
                update user_repo set status = 'ready', ready_at = now(), error = null
                where org_id = ${orgId} and user_id = ${userId}
                  and repo_owner = ${repo.owner} and repo_name = ${repo.name}
            `;
        },

        async markFailed(userId, repo, error) {
            await gate();
            await sql`
                update user_repo set status = 'failed', error = ${error.slice(0, CLONE_ERROR_LIMIT)}
                where org_id = ${orgId} and user_id = ${userId}
                  and repo_owner = ${repo.owner} and repo_name = ${repo.name}
            `;
        },

        async requeueStranded() {
            await gate();
            const rows = await sql`
                update user_repo set status = 'queued', error = null
                where org_id = ${orgId} and status = 'cloning'
                returning 1
            `;
            return rows.length;
        },
    };
}
