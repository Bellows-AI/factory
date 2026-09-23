import type { Sql } from 'postgres';
import { fullName, type Repo } from '../config.js';

export type CloneStatus = 'queued' | 'cloning' | 'ready' | 'failed';

export interface UserRepo extends Repo {
    readonly status: CloneStatus;
    readonly error: string | null;
    readonly attempts: number;
    readonly selectedAt: string;
    readonly startedAt: string | null;
    readonly readyAt: string | null;
}

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

    return {
        async select(userId, repos) {
            await gate();
            // "owner/name" as the comparison key. A repo name cannot contain a slash — the check
            // constraint says so — which is what makes the concatenation unambiguous. A row
            // constructor (`(a, b) not in (…)`) would read better and is not something the driver
            // can send.
            const keys = repos.map(fullName);

            await sql.begin(async (tx) => {
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
                select repo_owner, repo_name, status, error, attempts, selected_at, started_at, ready_at
                from user_repo
                where org_id = ${orgId} and user_id = ${userId} and deselected_at is null
                order by repo_owner asc, repo_name asc
            `;
            return rows.map(toUserRepo);
        },

        async orphaned(userId) {
            await gate();
            const rows = await sql<Row[]>`
                select repo_owner, repo_name, status, error, attempts, selected_at, started_at, ready_at
                from user_repo
                where org_id = ${orgId} and user_id = ${userId} and deselected_at is not null
                order by repo_owner asc, repo_name asc
            `;
            return rows.map(toUserRepo);
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
