import type { Role } from '@factory-ai/core';
import type { Sql } from 'postgres';
import type { GitHubIdentity } from './github.js';
import { hashToken, mintToken } from './session.js';
import { replaceTrackedRepos as replaceTrackedRepoRows, trackedRepos as trackedRepoRows } from '../db/tracked-repos.js';

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
 * A sign-in parked between the OAuth callback and the selection screen (#125).
 *
 * The OAuth code is single-use, so the identity and the installation report must survive the hop
 * while the person spends time choosing; this is what they survive in. Only its hash is stored —
 * completing one mints a session, so the row is a bearer credential at rest.
 */
export interface PendingSignIn {
    identity: GitHubIdentity;
    installations: InstallationRef[];
    returnTo: string;
    orgPreference: string | null;
}

/**
 * An authenticated request's subject: who, in which organization, and what they may do there.
 *
 * The org is a property of the caller (#99), resolved fresh on every request: a session carries
 * its org in the row, a personal token in its own row — and each is
 * re-checked through the org_membership join, so a GitHub-side removal at the next sign-in ends
 * every credential's reach immediately.
 */
export interface Caller {
    user: AuthUser;
    org: { id: string; name: string };
    membership: Membership;
    role: Role;
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
     * Binds a GitHub identity to an account and materializes the SELECTION (#125): every
     * installation the caller passes becomes an organization row (id = the installation id, name
     * = the account login) and a membership of it. The caller — the route — has already
     * intersected the account's choice with what GitHub reported this sign-in; this layer trusts
     * that and refuses nothing: under installation-access-is-membership there is no invite to be
     * waiting for and no auto-join decision to delegate.
     *
     * Memberships of ANY organization not passed are deleted, and since #125 that covers two
     * cases with one predicate: an installation GitHub stopped reporting (the propagation the
     * security property needs), and an installation the account tracks no longer (the opt-out).
     * Both mean "this account does not reach here any more", and a pre-#99 legacy org is
     * reported by nothing, ever, so it is always in the swept set (#123) — the directory is the
     * installations, and a membership outside the selection is residue, not a switchable org.
     */
    signIn(identity: GitHubIdentity, orgId: string, installations: readonly InstallationRef[]): Promise<Caller>;
    /**
     * The account's stored org selection — its membership org ids, by GitHub numeric id.
     * Read-only: an account that abandons the selection screen must leave no rows behind, so the
     * membership rows ARE the stored choice. Empty means first sign-in (or unknown account).
     */
    storedSelection(githubUserId: number): Promise<string[]>;
    /**
     * Parks an identity and its installation report for the selection screen (#125). Returns the
     * opaque token for the pending cookie; only its sha-256 is stored — completing a pending
     * sign-in mints a session, so the row is a bearer credential at rest.
     */
    createPendingSignIn(input: {
        identity: GitHubIdentity;
        installations: readonly InstallationRef[];
        returnTo: string;
        orgPreference: string | null;
        expiresAt: Date;
    }): Promise<string>;
    /**
     * The parked sign-in behind a token hash, or null when unknown — or expired, which is spent
     * on sight rather than left for the boot reaper to find.
     */
    findPendingSignIn(tokenHash: Buffer): Promise<PendingSignIn | null>;
    /**
     * Spends a pending sign-in — atomically, so only one of two concurrent completions can claim
     * it. True when this call spent the row; false means it was already gone (single-use).
     */
    deletePendingSignIn(tokenHash: Buffer): Promise<boolean>;
    /** The org's tracked-repo allowlist, as "owner/name" strings. Empty when everything is tracked. */
    trackedRepos(orgId: string): Promise<string[]>;
    /**
     * Replaces an org's tracked-repo allowlist with `repos` ("owner/name" strings). Empty means
     * the org tracks everything its installation reports — the completion route runs this only
     * for orgs whose checkbox set was actually narrowed.
     */
    replaceTrackedRepos(orgId: string, repos: readonly string[]): Promise<void>;
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

type Gate = () => Promise<void>;

/**
 * Sign-in, the selection screen's pending hop, and the stored-selection read: everything that
 * turns a GitHub identity into a membership. Split out of `createAuthStore` so that factory stays
 * under the function-length gate — grouped by concern, not by an arbitrary line count.
 */
function buildIdentityMethods(
    sql: Sql,
    gate: Gate
): Pick<AuthStore, 'signIn' | 'storedSelection' | 'createPendingSignIn' | 'findPendingSignIn' | 'deletePendingSignIn'> {
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

        async storedSelection(githubUserId) {
            await gate();
            // The membership rows ARE the stored choice (#125): what the account selected at its
            // last onboarding, already pruned by the sweep to what it may still reach.
            const rows = await sql<{ org_id: string }[]>`
                select m.org_id from org_membership m
                join app_user u on u.id = m.user_id
                where u.github_user_id = ${githubUserId}
            `;
            return rows.map((row) => row.org_id);
        },

        async createPendingSignIn(input) {
            await gate();
            const token = mintToken();
            await sql`
                insert into pending_sign_in
                    (token_hash, github_user_id, login, display_name, avatar_url,
                     installations, return_to, org_preference, expires_at)
                values (${hashToken(token)}, ${input.identity.githubUserId}, ${input.identity.login.toLowerCase()},
                        ${input.identity.displayName}, ${input.identity.avatarUrl},
                        ${sql.json(input.installations.map((install) => ({ ...install })))},
                        ${input.returnTo}, ${input.orgPreference}, ${input.expiresAt})
            `;
            return token;
        },

        async findPendingSignIn(tokenHash) {
            await gate();
            // Expired rows are spent on sight — the same lazy reaping findSession's expiry
            // predicate does, so a stale cookie can never complete even if the boot reaper has
            // not run yet.
            await sql`delete from pending_sign_in where expires_at < now()`;
            const rows = await sql<
                {
                    github_user_id: string | number;
                    login: string;
                    display_name: string | null;
                    avatar_url: string | null;
                    installations: InstallationRef[];
                    return_to: string;
                    org_preference: string | null;
                }[]
            >`
                select github_user_id, login, display_name, avatar_url,
                       installations, return_to, org_preference
                from pending_sign_in
                where token_hash = ${tokenHash}
            `;
            const row = rows[0];
            if (!row) return null;
            return {
                identity: {
                    // bigint arrives as a string from postgres.js; Number() is exact well past any
                    // id GitHub will issue this century — the same read toCaller makes.
                    githubUserId: Number(row.github_user_id),
                    login: row.login,
                    displayName: row.display_name,
                    avatarUrl: row.avatar_url,
                },
                installations: row.installations,
                returnTo: row.return_to,
                orgPreference: row.org_preference,
            };
        },

        async deletePendingSignIn(tokenHash) {
            await gate();
            // Returning, not blind, and only while the row is still live: the completion route
            // claims the row with this delete, so single-use holds against two completions racing
            // each other, and a request that straddled the expiry cannot complete on a read that
            // happened to run while the row was still fresh.
            const rows = await sql<{ token_hash: Buffer }[]>`
                delete from pending_sign_in
                where token_hash = ${tokenHash} and expires_at > now()
                returning token_hash
            `;
            return rows.length > 0;
        },
    };
}

/** The org's tracked-repo allowlist (#125): the onboarding screen's per-org narrowing. */
function buildTrackedRepoMethods(sql: Sql, gate: Gate): Pick<AuthStore, 'trackedRepos' | 'replaceTrackedRepos'> {
    return {
        async trackedRepos(orgId) {
            await gate();
            return trackedRepoRows({ sql, orgId });
        },

        async replaceTrackedRepos(orgId, repos) {
            await gate();
            await replaceTrackedRepoRows({ sql, orgId, repos });
        },
    };
}

/** The session row: mint, resolve, move between organizations, and drop at logout. */
function buildSessionMethods(
    sql: Sql,
    gate: Gate
): Pick<AuthStore, 'createSession' | 'findSession' | 'updateSessionOrg' | 'deleteSession'> {
    return {
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
    };
}

/** Organization lookups and membership management — the switcher and the webhook's revocation. */
function buildOrgMethods(
    sql: Sql,
    gate: Gate
): Pick<AuthStore, 'findOrg' | 'membershipsOf' | 'removeMember' | 'localCaller'> {
    return {
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
    };
}

/**
 * Access tokens (fat_/oat_). Each row carries the org it was minted for, and resolves through the
 * same org_membership join a session does, so removing a member ends their tokens' reach on the
 * very next request.
 */
function buildTokenMethods(
    sql: Sql,
    gate: Gate
): Pick<
    AuthStore,
    | 'createAccessToken'
    | 'findPersonalToken'
    | 'findOrgToken'
    | 'listPersonalTokens'
    | 'listOrgTokens'
    | 'revokePersonalToken'
    | 'revokeOrgToken'
> {
    return {
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
            // A throttled touch: an access token rides the dashboard's two-second poll, and
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
                -- The org comes from the row (no user stands behind it), but
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
    };
}

/**
 * The organization is a PARAMETER here, unlike every other store in this directory, which binds it
 * at construction.
 *
 * That is not an oversight to be tidied up later. The other stores are handed an organization and
 * read rows inside it; this one is what decides whether a caller belongs to an organization at all,
 * and its most important read — a session token — is global by nature: the row *tells* the board
 * which organization the caller is working in. Binding an org at construction would mean the object
 * had to already know the answer it exists to produce. Since #99 that answer is per caller: a
 * session and a personal token each carry their own org in their row, and every read resolves the
 * caller THROUGH it.
 */
export function createAuthStore({ sql, ready }: { sql: Sql; ready?: Promise<unknown> }): AuthStore {
    const gate: Gate = async () => {
        if (ready) await ready;
    };

    return {
        ...buildIdentityMethods(sql, gate),
        ...buildTrackedRepoMethods(sql, gate),
        ...buildSessionMethods(sql, gate),
        ...buildOrgMethods(sql, gate),
        ...buildTokenMethods(sql, gate),
    };
}
