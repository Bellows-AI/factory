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

/** One installation-reported organization, as the store sees it: the id and its login label. */
export interface InstallationRef {
    id: string;
    name: string;
}

/**
 * An authenticated request's subject: who, in which organization, and what they may do there.
 *
 * The org is a property of the caller (#99), resolved fresh on every request: a session carries
 * its org in the row, a personal token in its own row, a worker token in its own — and each is
 * re-checked through the org_membership join, so a GitHub-side removal at the next sign-in ends
 * every credential's reach immediately.
 */
export interface Caller {
    user: AuthUser;
    org: { id: string; name: string };
    membership: Membership;
    role: Role;
}

export interface WorkerIdentity {
    orgId: string;
    id: string;
    name: string;
}

export type AccessTokenKind = 'personal' | 'org';

/** A list-row view of an access token. The token and its hash are never in it. */
export interface AccessTokenView {
    id: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
}

/** What the board learns about the organization token a request arrived with. */
export interface OrgTokenIdentity {
    orgId: string;
    id: string;
    label: string;
}

export interface AuthStore {
    /**
     * Binds a GitHub identity to an account and materializes what GitHub reported: every
     * installation the signing-in account can see becomes an organization row (id = the
     * installation id, name = the account login) and a membership of it.
     *
     * Returns the caller bound to `orgId`, which the caller of this method has validated against
     * `installations` — this layer trusts that, and refuses nothing: under installation-access-
     * is-membership there is no invite to be waiting for and no auto-join decision to delegate.
     * Memberships of ANY organization not in the reported list are deleted: a GitHub-side removal
     * bites at the next sign-in (the propagation the security property needs), and so does a
     * pre-#99 membership of a legacy org no installation will ever report (#123) — the directory
     * is the installations, and a membership outside it is upgrade residue, not a switchable org.
     */
    signIn(identity: GitHubIdentity, orgId: string, installations: readonly InstallationRef[]): Promise<Caller>;
    createSession(tokenHash: Buffer, userId: string, expiresAt: Date, orgId: string): Promise<void>;
    /**
     * The caller behind a live session token, or null when unknown, expired, unmembered — or
     * bound to no organization, which is what every row predating 028 is: the join fails, so the
     * upgrade signs everybody out rather than guessing an org for anybody.
     */
    findSession(tokenHash: Buffer): Promise<Caller | null>;
    /**
     * Moves a session to `orgId`, and only when that session's user is a member of it — the
     * membership predicate is the whole security property, since the org decides which data the
     * session reads from here on. False when the session is unknown or the move is not allowed.
     */
    updateSessionOrg(tokenHash: Buffer, orgId: string): Promise<boolean>;
    deleteSession(tokenHash: Buffer): Promise<void>;
    /** The organization row, or null — the ?org= and POST /api/auth/org validators' first question. */
    findOrg(orgId: string): Promise<{ id: string; name: string } | null>;
    /** Every organization the account is a member of — the selector's available[] and the switch check. */
    membershipsOf(userId: string): Promise<{ id: string; name: string }[]>;
    /**
     * The database's pre-upgrade organizations — rows with no installation id (028 added the
     * column with no backfill) that no sign-in can ever materialize or sweep away. They are
     * adoption territory, not the directory: `/api/auth/me` reports them so the dashboard can
     * surface `npm run adopt` instead of leaving their stranded rows invisible.
     */
    legacyOrgs(): Promise<{ id: string; name: string }[]>;
    /**
     * The one installation org, when exactly one exists — the only target a legacy org can be
     * paired with in a surfaced `adopt --from` command without guessing. Null when zero or
     * several installations exist: which legacy org belongs to which installation is the
     * operator's decision, and the deployment must not fill it in for them.
     */
    adoptTarget(): Promise<{ id: string } | null>;
    /**
     * Deletes one membership by the GitHub numeric id — THE identity; the membership keys on
     * user_id since 029, so the lookup joins through app_user — and reports whether a row was
     * deleted. The webhook's whole act of revocation: findSession and findPersonalToken
     * inner-join through org_membership, so the removed account's every credential dies on its
     * next request. What this buys over the sign-in sweep is the timing — GitHub's report, not
     * the account's next sign-in.
     */
    removeMember(orgId: string, githubUserId: number): Promise<boolean>;
    /** The stand-in account AUTH_MODE=none attributes every request to. */
    localCaller(orgId: string): Promise<Caller | null>;
    findWorkerToken(tokenHash: Buffer): Promise<WorkerIdentity | null>;

    // Access tokens (fat_/oat_). Each row carries the org it was minted for, and resolves through
    // the same org_membership join a session does, so removing a member ends their tokens' reach
    // on the very next request — the property that lets them be minted over HTTP.
    createAccessToken(input: {
        kind: AccessTokenKind;
        orgId: string;
        userId: string | null;
        createdBy: string;
        label: string;
        tokenHash: Buffer;
    }): Promise<{ id: string }>;
    /** The caller behind a live personal token, through the same join findSession uses. */
    findPersonalToken(tokenHash: Buffer): Promise<Caller | null>;
    /**
     * The organization token behind a hash, or null when unknown, revoked — or its issuer's
     * membership is gone, which is the join that bounds a mintable-by-any-member credential.
     */
    findOrgToken(tokenHash: Buffer): Promise<OrgTokenIdentity | null>;
    listPersonalTokens(orgId: string, userId: string): Promise<AccessTokenView[]>;
    listOrgTokens(orgId: string): Promise<AccessTokenView[]>;
    revokePersonalToken(orgId: string, userId: string, id: string): Promise<'revoked' | 'missing'>;
    revokeOrgToken(orgId: string, id: string): Promise<'revoked' | 'missing'>;

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
    org_id: string;
    org_name: string;
}

interface TokenRow {
    id: string;
    label: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
}

const toIso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

const toTokenView = (row: TokenRow): AccessTokenView => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: toIso(row.last_used_at),
    revokedAt: toIso(row.revoked_at),
});

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
    org: { id: row.org_id, name: row.org_name },
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
 * produce. Since #99 that answer is per caller: a session and a personal token each carry their own
 * org in their row, and every read resolves the caller THROUGH it.
 */
export function createAuthStore({ sql, ready }: { sql: Sql; ready?: Promise<unknown> }): AuthStore {
    const gate = async () => {
        if (ready) await ready;
    };

    const memberOf = async (userId: string, orgId: string): Promise<Caller | null> => {
        const rows = await sql<CallerRow[]>`
            select u.id, u.github_user_id, u.github_login, u.display_name,
                       u.avatar_url, u.created_at, u.last_login_at,
                       m.invited_at, m.claimed_at, m.role,
                       o.id as org_id, o.name as org_name
            from org_membership m join app_user u on u.id = m.user_id
            join organization o on o.id = m.org_id
            where m.org_id = ${orgId} and m.user_id = ${userId}
        `;
        const row = rows[0];
        return row ? toCaller(row) : null;
    };

    return {
        async signIn(identity, orgId, installations) {
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

            // One installation = one organization (#99). The id IS the installation id, so the row
            // is stable across account renames; the name is a label, re-derived on every sign-in.
            // adoptOrg() may have created the row first (the legacy-data CLI), so this is an
            // upsert, never an insert.
            for (const org of installations) {
                await sql`
                    insert into organization (id, name, installation_id)
                    values (${org.id}, ${org.name}, ${org.id}::bigint)
                    on conflict (id) do update set
                        name = excluded.name,
                        installation_id = excluded.installation_id
                `;
                await sql`
                    insert into org_membership (org_id, github_login, user_id, claimed_at)
                    values (${org.id}, ${login}, ${userId}, now())
                    on conflict (org_id, user_id) do update set github_login = excluded.github_login
                `;
            }

            // The materialized fact, re-synced at every sign-in: a membership of an organization
            // GitHub does not report is gone, and with it — through the joins the reads run —
            // this account's sessions' and tokens' reach into that org. Any org, not only known
            // installations: a legacy (pre-#99) org is reported by nothing, ever, so leaving it
            // out of the sweep would list the same account under both ids forever (#123).
            await sql`
                delete from org_membership
                where user_id = ${userId}
                  and org_id <> all(${installations.map((i) => i.id)})
            `;

            const caller = await memberOf(userId, orgId);
            if (!caller) throw new Error(`sign-in resolved no membership of "${orgId}" for this account`);
            return caller;
        },

        async createSession(tokenHash, userId, expiresAt, orgId) {
            await gate();
            await sql`
                insert into session (token_hash, user_id, expires_at, org_id)
                values (${tokenHash}, ${userId}, ${expiresAt}, ${orgId})
            `;
        },

        async findSession(tokenHash) {
            await gate();
            const rows = await sql<CallerRow[]>`
                select u.id, u.github_user_id, u.github_login, u.display_name,
                       u.avatar_url, u.created_at, u.last_login_at,
                       m.invited_at, m.claimed_at, m.role,
                       o.id as org_id, o.name as org_name
                from session s
                join app_user u on u.id = s.user_id
                -- The org is the session row's, never the process's: this is what the caller sees.
                join organization o on o.id = s.org_id
                -- An inner join, so losing the membership ends the session's usefulness on the very
                -- next request rather than when the cookie eventually expires. That immediacy is the
                -- reason sessions are rows at all — and a pre-028 row (org_id null) joins nothing,
                -- which is the fail-closed upgrade path.
                join org_membership m on m.user_id = u.id and m.org_id = s.org_id
                where s.token_hash = ${tokenHash} and s.expires_at > now()
            `;
            const row = rows[0];
            return row ? toCaller(row) : null;
        },

        async updateSessionOrg(tokenHash, orgId) {
            await gate();
            const rows = await sql<{ user_id: string }[]>`
                update session s set org_id = ${orgId}
                where s.token_hash = ${tokenHash}
                  and exists (
                      select 1 from org_membership m
                      where m.org_id = ${orgId} and m.user_id = s.user_id
                  )
                returning user_id
            `;
            return rows.length > 0;
        },

        async deleteSession(tokenHash) {
            await gate();
            await sql`delete from session where token_hash = ${tokenHash}`;
        },

        async findOrg(orgId) {
            await gate();
            const rows = await sql<{ id: string; name: string }[]>`
                select id, name from organization where id = ${orgId}
            `;
            return rows[0] ?? null;
        },

        async membershipsOf(userId) {
            await gate();
            const rows = await sql<{ id: string; name: string }[]>`
                select o.id, o.name from org_membership m join organization o on o.id = m.org_id
                where m.user_id = ${userId} order by o.name
            `;
            return rows;
        },

        async legacyOrgs() {
            await gate();
            const rows = await sql<{ id: string; name: string }[]>`
                select id, name from organization where installation_id is null order by id
            `;
            return rows;
        },

        async adoptTarget() {
            await gate();
            const rows = await sql<{ id: string }[]>`
                select id from organization where installation_id is not null
            `;
            return rows.length === 1 ? { id: rows[0]!.id } : null;
        },

        async removeMember(orgId, githubUserId) {
            await gate();
            const rows = await sql<{ user_id: string }[]>`
                delete from org_membership
                where org_id = ${orgId}
                  and user_id in (select id from app_user where github_user_id = ${githubUserId})
                returning user_id
            `;
            return rows.length > 0;
        },

        async localCaller(orgId) {
            await gate();
            const rows = await sql<CallerRow[]>`
                select u.id, u.github_user_id, u.github_login, u.display_name,
                       u.avatar_url, u.created_at, u.last_login_at,
                       m.invited_at, m.claimed_at, m.role,
                       o.id as org_id, o.name as org_name
                from app_user u join org_membership m on m.user_id = u.id and m.org_id = ${orgId}
                join organization o on o.id = m.org_id
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

        async createAccessToken(input) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                insert into access_token (org_id, kind, user_id, created_by, label, token_hash)
                values (${input.orgId}, ${input.kind}, ${input.userId}, ${input.createdBy},
                        ${input.label}, ${input.tokenHash})
                returning id
            `;
            return { id: rows[0]!.id };
        },

        async findPersonalToken(tokenHash) {
            await gate();
            // A throttled touch, not findWorkerToken's unconditional one: worker routes are one
            // driver's heartbeat, while an access token rides the dashboard's two-second poll, and
            // a write on every one of those reads is exactly what the session's write-free read
            // path exists to avoid. The stale-row predicate keeps it to one rewrite a minute.
            // token_hash is globally unique, so the org is not in this predicate — it comes back
            // FROM the row, which is the mint-time binding.
            await sql`
                update access_token set last_used_at = now()
                where token_hash = ${tokenHash} and kind = 'personal'
                  and revoked_at is null
                  and (last_used_at is null or last_used_at < now() - interval '60 seconds')
            `;
            const rows = await sql<CallerRow[]>`
                select u.id, u.github_user_id, u.github_login, u.display_name,
                       u.avatar_url, u.created_at, u.last_login_at,
                       m.invited_at, m.claimed_at, m.role,
                       o.id as org_id, o.name as org_name
                from access_token t
                join app_user u on u.id = t.user_id
                -- The token's OWN org: it acts as its user there and nowhere else, whatever other
                -- orgs the account can see.
                join organization o on o.id = t.org_id
                -- The same join findSession runs, so losing the membership ends the token's reach
                -- on the very next request — the property that makes it safe to have minted it.
                join org_membership m on m.user_id = u.id and m.org_id = t.org_id
                where t.token_hash = ${tokenHash} and t.kind = 'personal'
                  and t.revoked_at is null
            `;
            const row = rows[0];
            return row ? toCaller(row) : null;
        },

        async findOrgToken(tokenHash) {
            await gate();
            // The same throttled touch findPersonalToken runs — and the same membership
            // predicate, so a token whose authority is gone never looks used.
            await sql`
                update access_token t set last_used_at = now()
                where t.token_hash = ${tokenHash} and t.kind = 'org'
                  and t.revoked_at is null
                  and (t.last_used_at is null or t.last_used_at < now() - interval '60 seconds')
                  and exists (
                      select 1 from org_membership m
                      where m.org_id = t.org_id and m.user_id = t.created_by
                  )
            `;
            const rows = await sql<{ org_id: string; id: string; label: string }[]>`
                select t.org_id, t.id, t.label from access_token t
                -- The org comes from the row (worker-token-shaped: no user stands behind it), but
                -- the ISSUER's live membership is the token's authority: this inner join is what
                -- makes sign-in propagation end an org token's reach on the very next request,
                -- the same immediacy a session and a personal token have. A row with no creator
                -- (on delete set null) joins nothing and resolves null.
                join org_membership m on m.org_id = t.org_id and m.user_id = t.created_by
                where t.token_hash = ${tokenHash} and t.kind = 'org'
                  and t.revoked_at is null
            `;
            const row = rows[0];
            return row ? { orgId: row.org_id, id: row.id, label: row.label } : null;
        },

        async listPersonalTokens(orgId, userId) {
            await gate();
            // Never the hash: the list answers "what tokens exist", not "who can use them".
            const rows = await sql<TokenRow[]>`
                select id, label, created_at, last_used_at, revoked_at from access_token
                where org_id = ${orgId} and kind = 'personal' and user_id = ${userId}
                order by created_at
            `;
            return rows.map(toTokenView);
        },

        async listOrgTokens(orgId) {
            await gate();
            const rows = await sql<TokenRow[]>`
                select id, label, created_at, last_used_at, revoked_at from access_token
                where org_id = ${orgId} and kind = 'org'
                order by created_at
            `;
            return rows.map(toTokenView);
        },

        async revokePersonalToken(orgId, userId, id) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                update access_token set revoked_at = now()
                where org_id = ${orgId} and user_id = ${userId} and id = ${id}
                  and kind = 'personal' and revoked_at is null
                returning id
            `;
            return rows[0] ? 'revoked' : 'missing';
        },

        async revokeOrgToken(orgId, id) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                update access_token set revoked_at = now()
                where org_id = ${orgId} and id = ${id}
                  and kind = 'org' and revoked_at is null
                returning id
            `;
            return rows[0] ? 'revoked' : 'missing';
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
