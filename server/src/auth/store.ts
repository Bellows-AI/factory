import type { Sql } from 'postgres';
import type { GitHubIdentity } from './github.js';

export type Role = 'admin' | 'member';

export interface AuthUser {
    id: string;
    /** GitHub's numeric id — the identity. `login` below is only a label. */
    githubUserId: number;
    login: string;
    displayName: string | null;
    avatarUrl: string | null;
    /** ISO 8601. Row facts about the account, for the settings page's read-only identity section. */
    createdAt: string | null;
    lastLoginAt: string | null;
}

/** When the membership was created and when this account claimed it, as ISO 8601. */
export interface Membership {
    invitedAt: string | null;
    claimedAt: string | null;
}

/** An authenticated request's subject: who, and what they may do in the bound organization. */
export interface Caller {
    user: AuthUser;
    membership: Membership;
    role: Role;
}

export interface WorkerIdentity {
    orgId: string;
    id: string;
    name: string;
}

export interface AuthStore {
    /**
     * Binds a GitHub identity to an account and claims whatever invites are waiting for it.
     *
     * Returns null when nobody has invited this login to the given organization — which is a
     * refusal, not an error: an account is created either way, because the identity is a fact, but
     * without a membership there is nothing to sign in to.
     *
     * `autoJoin` creates that missing membership instead of refusing, as an ordinary `member`. It is
     * a parameter rather than a config read because the decision is not this layer's to make: the
     * caller passes it only after GitHub has confirmed the org, and a store that could admit anyone
     * on its own would be one bad default away from an open deployment.
     */
    signIn(identity: GitHubIdentity, orgId: string, options?: { autoJoin?: boolean }): Promise<Caller | null>;
    createSession(tokenHash: Buffer, userId: string, expiresAt: Date): Promise<void>;
    /** The caller behind a live session token, or null if it is unknown, expired, or unmembered. */
    findSession(tokenHash: Buffer, orgId: string): Promise<Caller | null>;
    deleteSession(tokenHash: Buffer): Promise<void>;
    /** The stand-in account AUTH_MODE=none attributes every request to. */
    localCaller(orgId: string): Promise<Caller | null>;
    findWorkerToken(tokenHash: Buffer): Promise<WorkerIdentity | null>;

    // Used by the CLIs. They write through the store rather than their own SQL so that the claim
    // predicate and the session cleanup on removal exist in exactly one place.
    invite(orgId: string, login: string, role: Role): Promise<'created' | 'updated'>;
    removeMember(orgId: string, login: string): Promise<'removed' | 'missing'>;
    listMembers(orgId: string): Promise<{ login: string; role: Role; claimed: boolean }[]>;
    createWorkerToken(orgId: string, name: string, tokenHash: Buffer): Promise<{ id: string }>;
    revokeWorkerToken(orgId: string, name: string): Promise<'revoked' | 'missing'>;
    listWorkerTokens(orgId: string): Promise<{ name: string; createdAt: string; revoked: boolean }[]>;
}

interface CallerRow {
    id: string;
    github_user_id: string | number;
    github_login: string;
    display_name: string | null;
    avatar_url: string | null;
    created_at: Date | null;
    last_login_at: Date | null;
    invited_at: Date | null;
    claimed_at: Date | null;
    role: Role;
}

const toIso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

const toCaller = (row: CallerRow): Caller => ({
    user: {
        id: row.id,
        // bigint arrives as a string from postgres.js, and Number() on it is exact well past any id
        // GitHub will issue this century.
        githubUserId: Number(row.github_user_id),
        login: row.github_login,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        createdAt: toIso(row.created_at),
        lastLoginAt: toIso(row.last_login_at),
    },
    membership: { invitedAt: toIso(row.invited_at), claimedAt: toIso(row.claimed_at) },
    role: row.role,
});

/**
 * The organization is a PARAMETER here, unlike every other store in this directory, which binds it
 * at construction.
 *
 * That is not an oversight to be tidied up later. The other stores are handed an organization and
 * read rows inside it; this one is what decides whether a caller belongs to an organization at all,
 * and its two most important reads — a session token and a worker token — are global by nature, with
 * the worker token being the very thing that *tells* a driver which organization it is working for.
 * Binding an org at construction would mean the object had to already know the answer it exists to
 * produce.
 */
export function createAuthStore({ sql, ready }: { sql: Sql; ready?: Promise<unknown> }): AuthStore {
    const gate = async () => {
        if (ready) await ready;
    };

    const memberOf = async (userId: string, orgId: string): Promise<Caller | null> => {
        const rows = await sql<CallerRow[]>`
            select u.id, u.github_user_id, u.github_login, u.display_name,
                   u.avatar_url, u.created_at, u.last_login_at,
                   m.invited_at, m.claimed_at, m.role
            from org_membership m join app_user u on u.id = m.user_id
            where m.org_id = ${orgId} and m.user_id = ${userId}
        `;
        const row = rows[0];
        return row ? toCaller(row) : null;
    };

    return {
        async signIn(identity, orgId, options) {
            await gate();
            const login = identity.login.toLowerCase();

            // Keyed on the numeric id, so a rename updates the label rather than creating a second
            // account — and so the freed login cannot be used to become somebody else.
            const users = await sql<{ id: string }[]>`
                insert into app_user (github_user_id, github_login, display_name, avatar_url, last_login_at)
                values (${identity.githubUserId}, ${login}, ${identity.displayName},
                        ${identity.avatarUrl}, now())
                on conflict (github_user_id) do update set
                    github_login  = excluded.github_login,
                    display_name  = excluded.display_name,
                    avatar_url    = excluded.avatar_url,
                    last_login_at = now()
                returning id
            `;
            const userId = users[0]!.id;

            await sql`
                update org_membership m set user_id = ${userId}, claimed_at = now()
                where m.github_login = ${login}
                  -- THE SECURITY PROPERTY. Without it: somebody invited as "alice" claims the row,
                  -- later renames, freeing the login; a different account registers "alice", signs
                  -- in, and this statement hands them the original membership and its role. With it
                  -- the row is already claimed, so the impostor matches nothing and is refused.
                  and m.user_id is null
                  -- Skips an organization this account is already a member of. Somebody invited
                  -- under both an old and a new login would otherwise claim both rows and violate
                  -- org_membership_user_uk, turning a legitimate sign-in into a 500.
                  and not exists (
                      select 1 from org_membership x
                      where x.org_id = m.org_id and x.user_id = ${userId}
                  )
            `;

            const claimed = await memberOf(userId, orgId);
            if (claimed || !options?.autoJoin) return claimed;

            // Already bound to this account, so there is no unclaimed row for a freed login to
            // capture and the `user_id is null` guard above has nothing to do here. `do nothing`
            // rather than an update: a login with an *unclaimed* invite reached the branch above and
            // never gets here, so a conflict at this point is a concurrent second sign-in of this
            // same account, and the role it already has must win over a fresh `member`.
            await sql`
                insert into org_membership (org_id, github_login, role, user_id, claimed_at)
                values (${orgId}, ${login}, 'member', ${userId}, now())
                on conflict (org_id, github_login) do nothing
            `;
            return memberOf(userId, orgId);
        },

        async createSession(tokenHash, userId, expiresAt) {
            await gate();
            await sql`
                insert into session (token_hash, user_id, expires_at)
                values (${tokenHash}, ${userId}, ${expiresAt})
            `;
        },

        async findSession(tokenHash, orgId) {
            await gate();
            const rows = await sql<CallerRow[]>`
                select u.id, u.github_user_id, u.github_login, u.display_name,
                       u.avatar_url, u.created_at, u.last_login_at,
                       m.invited_at, m.claimed_at, m.role
                from session s
                join app_user u on u.id = s.user_id
                -- An inner join, so losing the membership ends the session's usefulness on the very
                -- next request rather than when the cookie eventually expires. That immediacy is the
                -- reason sessions are rows at all.
                join org_membership m on m.user_id = u.id and m.org_id = ${orgId}
                where s.token_hash = ${tokenHash} and s.expires_at > now()
            `;
            const row = rows[0];
            return row ? toCaller(row) : null;
        },

        async deleteSession(tokenHash) {
            await gate();
            await sql`delete from session where token_hash = ${tokenHash}`;
        },

        async localCaller(orgId) {
            await gate();
            const rows = await sql<CallerRow[]>`
                select u.id, u.github_user_id, u.github_login, u.display_name,
                       u.avatar_url, u.created_at, u.last_login_at,
                       m.invited_at, m.claimed_at, m.role
                from app_user u join org_membership m on m.user_id = u.id and m.org_id = ${orgId}
                where u.github_user_id = 0
            `;
            const row = rows[0];
            return row ? toCaller(row) : null;
        },

        async findWorkerToken(tokenHash) {
            await gate();
            const rows = await sql<{ org_id: string; id: string; name: string }[]>`
                update worker_token set last_used_at = now()
                where token_hash = ${tokenHash} and revoked_at is null
                returning org_id, id, name
            `;
            const row = rows[0];
            return row ? { orgId: row.org_id, id: row.id, name: row.name } : null;
        },

        async invite(orgId, login, role) {
            await gate();
            const rows = await sql<{ claimed_at: Date | null; inserted: boolean }[]>`
                insert into org_membership (org_id, github_login, role)
                values (${orgId}, ${login.toLowerCase()}, ${role})
                on conflict (org_id, github_login) do update set role = excluded.role
                returning claimed_at, (xmax = 0) as inserted
            `;
            return rows[0]?.inserted ? 'created' : 'updated';
        },

        async removeMember(orgId, login) {
            await gate();
            const rows = await sql<{ user_id: string | null }[]>`
                delete from org_membership
                where org_id = ${orgId} and github_login = ${login.toLowerCase()}
                returning user_id
            `;
            const row = rows[0];
            if (!row) return 'missing';
            // The membership is what findSession joins through, so deleting it already ends access.
            // The sessions go too because a revoked credential should not outlive the decision by
            // even one request if the membership is ever restored.
            if (row.user_id) await sql`delete from session where user_id = ${row.user_id}`;
            return 'removed';
        },

        async listMembers(orgId) {
            await gate();
            const rows = await sql<{ github_login: string; role: Role; claimed_at: Date | null }[]>`
                select github_login, role, claimed_at from org_membership
                where org_id = ${orgId} order by github_login
            `;
            return rows.map((row) => ({
                login: row.github_login,
                role: row.role,
                claimed: row.claimed_at !== null,
            }));
        },

        async createWorkerToken(orgId, name, tokenHash) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                insert into worker_token (org_id, name, token_hash)
                values (${orgId}, ${name}, ${tokenHash})
                returning id
            `;
            return { id: rows[0]!.id };
        },

        async revokeWorkerToken(orgId, name) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                update worker_token set revoked_at = now()
                where org_id = ${orgId} and name = ${name} and revoked_at is null
                returning id
            `;
            return rows[0] ? 'revoked' : 'missing';
        },

        async listWorkerTokens(orgId) {
            await gate();
            const rows = await sql<{ name: string; created_at: Date; revoked_at: Date | null }[]>`
                select name, created_at, revoked_at from worker_token
                where org_id = ${orgId} order by created_at
            `;
            return rows.map((row) => ({
                name: row.name,
                createdAt: row.created_at.toISOString(),
                revoked: row.revoked_at !== null,
            }));
        },
    };
}
