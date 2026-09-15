import type { Sql } from 'postgres';

/**
 * What each member's GitHub account could reach at its last sign-in, as "owner/name".
 *
 * One row per user. `repos()` answers `null` for an account that has never been computed — the
 * pre-scoping state — and an empty array for one GitHub grants nothing; the two are different
 * answers and the callers treat them differently (null is unscoped, empty is nothing). The
 * installation list intersects the stored set on every read, so a repo removed from the App stops
 * matching without a rewrite here, and the sweep plus the next sign-in converge the rest.
 */
export interface UserRepoAccessStore {
    /** Replaces the user's whole set. The computation is total, so this is a replace, not a merge. */
    setRepos(userId: string, repos: readonly string[]): Promise<void>;
    /** The stored set, or null when it has never been computed for this user. */
    repos(userId: string): Promise<readonly string[] | null>;
}

interface Row {
    repos: string[];
}

/** The organization is bound at construction, like every store except the auth store. */
export function createUserRepoAccessStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
}): UserRepoAccessStore {
    const gate = async () => {
        if (ready) await ready;
    };

    return {
        async setRepos(userId, repos) {
            await gate();
            // Replace-all in one transaction, so a reader never sees the half of an enumeration.
            // computed_at rides along: the row is an answer with a timestamp, not just a list.
            await sql.begin(async (tx) => {
                await tx`
                    insert into user_repo_access (org_id, user_id, repos, computed_at)
                    values (${orgId}, ${userId}, ${repos}, now())
                    on conflict (org_id, user_id) do update set
                        repos = excluded.repos,
                        computed_at = now()
                `;
            });
        },

        async repos(userId) {
            await gate();
            const rows = await sql<Row[]>`
                select repos from user_repo_access
                where org_id = ${orgId} and user_id = ${userId}
            `;
            const row = rows[0];
            return row ? row.repos : null;
        },
    };
}
