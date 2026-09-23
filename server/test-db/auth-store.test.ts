import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore, type AuthStore } from '../src/auth/store.js';
import { LOCAL_ORG_ID } from '../src/config.js';
import { trackedRepos } from '../src/db/tracked-repos.js';
import { LOCAL_LOGIN, migrate, reapPendingSignIns, reapSessions } from '../src/db/migrate.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: AuthStore;

// Numeric strings: an org id IS an installation id now, and signIn casts it into
// organization.installation_id (bigint). Names that are not numbers stopped being org ids.
const ORG = '911001';
const SECOND_ORG = '911002';
/** An org planted with no installation id — a shape that can exist (the none-mode local row). */
const UNREPORTED_ORG = '911003';
/** Every account this file creates is numbered from here, so the cleanup can be precise. */
const ID_BASE = 90000;

// The two orgs are re-planted before every test, because the token tests write rows that need an
// org to point at without signing in first. signIn materializes every other org itself (#99).
const db = useTestDb({ orgs: [ORG, SECOND_ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createAuthStore({ sql });
});

const identity = (n: number, login: string) => ({
    githubUserId: ID_BASE + n,
    login,
    displayName: login,
    avatarUrl: null,
});

const SESSION_LIFETIME_MS = 3600_000;
const live = () => new Date(Date.now() + SESSION_LIFETIME_MS);

/** However far in the past, this is already expired — every "expired row" fixture backdates by it. */
const EXPIRED_OFFSET_MS = 1000;

/** Signs in as this identity, with ORG as the only installation GitHub reports. */
const member = (n = 0, login = 'octocat', installations = [{ id: ORG, name: ORG }]) =>
    store.signIn(identity(n, login), installations[0]!.id, installations);

const sessionCount = async (userId: string): Promise<number> => {
    const [row] = await sql<{ count: number }[]>`
        select count(*)::int as count from session where user_id = ${userId}
    `;
    return row!.count;
};

describe.skipIf(!enabled)('sign-in materializes the installations (#99)', () => {
    it('creates the organization row from the installation: id = installation id, name = account login', async () => {
        await member(0, 'octocat', [{ id: '424242', name: 'acme' }]);

        const [org] = await sql<{ id: string; name: string; installation_id: string | null }[]>`
            select id, name, installation_id::text as installation_id from organization where id = '424242'
        `;
        expect(org).toMatchObject({ id: '424242', name: 'acme', installation_id: '424242' });
    });

    it('creates a membership for EVERY reported installation, bound to the account', async () => {
        const caller = await member(1, 'octocat', [
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);

        expect(await store.membershipsOf(caller.user.id)).toEqual([
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);
    });

    it('is idempotent: a second sign-in updates labels instead of duplicating rows', async () => {
        const caller = await member(2, 'octocat');

        // Same account, renamed on GitHub, and the installation renamed with it.
        await store.signIn(identity(2, 'octocat-renamed'), ORG, [{ id: ORG, name: 'acme-renamed' }]);

        const memberships = await store.membershipsOf(caller.user.id);
        expect(memberships).toEqual([{ id: ORG, name: 'acme-renamed' }]);
        // Still one account: the numeric id is the identity.
        const [count] = await sql<{ count: number }[]>`
            select count(*)::int as count from app_user where github_user_id = ${ID_BASE + 2}
        `;
        expect(count?.count).toBe(1);
    });

    it('does NOT let a new account inherit a membership by taking the freed login', async () => {
        // The most important case in this file. A rename frees the login; a DIFFERENT numeric id
        // registering it is a different account, and gets its own membership — never the original's.
        const ORIGINAL_ACCOUNT_SEQ = 3;
        const original = await member(ORIGINAL_ACCOUNT_SEQ, 'octocat');

        const IMPOSTOR_ACCOUNT_SEQ = 4;
        const impostor = await member(IMPOSTOR_ACCOUNT_SEQ, 'octocat');

        expect(impostor.user.id).not.toBe(original.user.id);
        const rows = await sql<{ org_id: string; user_id: string }[]>`
            select org_id, user_id from org_membership where org_id = ${ORG} order by user_id
        `;
        expect(rows.map((r) => r.user_id).sort()).toEqual([original.user.id, impostor.user.id].sort());
    });

    it('drops the membership of an installation GitHub no longer reports', async () => {
        // The propagation the security property needs: losing the installation ends the
        // membership at the next sign-in, and the session reads it is joined through die with it.
        const ACCOUNT_SEQ = 5;
        const caller = await member(ACCOUNT_SEQ, 'octocat', [
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);
        await store.createSession(hashToken('sig-x'), caller.user.id, live(), ORG);
        // Planted orgs carry no installation; these two ARE installations, so the propagation
        // rule (installation orgs only) applies to them.
        await sql`update organization set installation_id = id::bigint where id in (${ORG}, ${SECOND_ORG})`;

        await store.signIn(identity(ACCOUNT_SEQ, 'octocat'), SECOND_ORG, [{ id: SECOND_ORG, name: SECOND_ORG }]);

        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: SECOND_ORG, name: SECOND_ORG }]);
        // The session row survives; the join through the membership does not.
        expect(await store.findSession(hashToken('sig-x'))).toBeNull();
    });

    it('sweeps a membership of an org no installation reports at sign-in, so the selector never lists both', async () => {
        // An org row can exist without an installation (the none-mode local row, a husk in an
        // upgraded database). The installation is a NEW row for the same account — nothing
        // matches one back to the other, so the sweep, which matches any unreported org, is
        // what keeps the selector from listing the same account twice.
        const ACCOUNT_SEQ = 14;
        const caller = await member(ACCOUNT_SEQ, 'unreported-member');
        await sql`
            insert into organization (id, name) values (${UNREPORTED_ORG}, 'Unreported')
            on conflict (id) do nothing
        `;
        await sql`
            insert into org_membership (org_id, github_login, user_id, claimed_at)
            values (${UNREPORTED_ORG}, 'unreported-member', ${caller.user.id}, now())
        `;

        await store.signIn(identity(ACCOUNT_SEQ, 'unreported-member'), ORG, [{ id: ORG, name: ORG }]);

        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: ORG, name: ORG }]);
        const [count] = await sql<{ count: number }[]>`
            select count(*)::int as count from org_membership where org_id = ${UNREPORTED_ORG}
        `;
        expect(count?.count).toBe(0);
    });

    it('sweeps a membership of an org GitHub still reports but the selection does not (issue 125)', async () => {
        // Since #125 signIn takes the SELECTION, not the report: an installation the account can
        // still see but no longer tracks is swept exactly like an unreported one — one predicate,
        // two meanings of "this account does not reach here". Deselecting is the opt-out, and a
        // later re-selection restores reach through the same upsert.
        const ACCOUNT_SEQ = 16;
        const caller = await member(ACCOUNT_SEQ, 'deselector', [
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);
        await sql`update organization set installation_id = id::bigint where id in (${ORG}, ${SECOND_ORG})`;

        // GitHub still reports both; the account re-chose ORG only.
        await store.signIn(identity(ACCOUNT_SEQ, 'deselector'), ORG, [{ id: ORG, name: ORG }]);

        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: ORG, name: ORG }]);
        // Re-selecting restores reach exactly as sign-in always has.
        await store.signIn(identity(ACCOUNT_SEQ, 'deselector'), SECOND_ORG, [
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);
        expect(await store.membershipsOf(caller.user.id)).toEqual([
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);
    });

    it('refuses an orgId outside the reported installations', async () => {
        // The route validates; the store asserts rather than silently resolving null.
        const ACCOUNT_SEQ = 6;
        await expect(member(ACCOUNT_SEQ, 'octocat', [{ id: ORG, name: ORG }])).resolves.toBeTruthy();
        await expect(
            store.signIn(identity(ACCOUNT_SEQ, 'octocat'), SECOND_ORG, [{ id: ORG, name: ORG }])
        ).rejects.toThrow(/no membership/);
    });

    it('records the membership the first sign-in reported it', async () => {
        const ACCOUNT_SEQ = 7;
        const caller = await member(ACCOUNT_SEQ, 'first-seen');
        const [row] = await sql<{ claimed_at: Date | null; invited_at: Date | null }[]>`
            select claimed_at, invited_at from org_membership
            where org_id = ${ORG} and user_id = ${caller.user.id}
        `;
        expect(row?.claimed_at).not.toBeNull();
        expect(row?.invited_at).not.toBeNull();
    });
});

describe.skipIf(!enabled)('sessions', () => {
    it('resolves a live session to its caller, in the org the session row names', async () => {
        const caller = await member();
        const hash = hashToken('token-a');
        await store.createSession(hash, caller.user.id, live(), ORG);

        const resolved = await store.findSession(hash);
        expect(resolved?.user.id).toBe(caller.user.id);
        expect(resolved?.org).toEqual({ id: ORG, name: ORG });
    });

    it('refuses an expired session', async () => {
        const caller = await member();
        const hash = hashToken('token-b');
        await store.createSession(hash, caller.user.id, new Date(Date.now() - EXPIRED_OFFSET_MS), ORG);

        expect(await store.findSession(hash)).toBeNull();
    });

    it('refuses an unknown token', async () => {
        await member();
        expect(await store.findSession(hashToken('never-issued'))).toBeNull();
    });

    it('refuses a session with no org — every row predating 028 — rather than guessing one', async () => {
        // The fail-closed upgrade path: a null org joins no membership, so the upgrade signs
        // everybody out instead of mis-scoping anybody.
        const caller = await member();
        await sql`
            insert into session (token_hash, user_id, expires_at, org_id)
            values (${hashToken('token-pre028')}, ${caller.user.id}, ${live()}, null)
        `;

        expect(await store.findSession(hashToken('token-pre028'))).toBeNull();
    });

    it('stops resolving the moment the membership is gone', async () => {
        // The membership is an inner join in findSession, which is what makes removal take effect
        // on the next request rather than at cookie expiry.
        const caller = await member();
        const hash = hashToken('token-c');
        await store.createSession(hash, caller.user.id, live(), ORG);

        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${caller.user.id}`;

        expect(await store.findSession(hash)).toBeNull();
    });

    it('moves a session only to an org its user is a member of', async () => {
        const SWITCHER_ACCOUNT_SEQ = 8;
        const caller = await member(SWITCHER_ACCOUNT_SEQ, 'switcher', [{ id: ORG, name: ORG }]);
        const ELSEWHERE_ACCOUNT_SEQ = 9;
        await member(ELSEWHERE_ACCOUNT_SEQ, 'elsewhere', [{ id: SECOND_ORG, name: SECOND_ORG }]);
        const hash = hashToken('token-swap');
        await store.createSession(hash, caller.user.id, live(), ORG);

        await expect(store.updateSessionOrg(hash, SECOND_ORG)).resolves.toBe(false);
        // Still in the original org — the refusal left no trace.
        expect((await store.findSession(hash))?.org.id).toBe(ORG);

        await member(SWITCHER_ACCOUNT_SEQ, 'switcher', [
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);
        await expect(store.updateSessionOrg(hash, SECOND_ORG)).resolves.toBe(true);
        expect((await store.findSession(hash))?.org.id).toBe(SECOND_ORG);
    });

    it('reports an unknown session token as unmoved', async () => {
        await member();
        await expect(store.updateSessionOrg(hashToken('never-issued'), ORG)).resolves.toBe(false);
    });

    it('deletes on logout', async () => {
        const caller = await member();
        const hash = hashToken('token-e');
        await store.createSession(hash, caller.user.id, live(), ORG);

        await store.deleteSession(hash);

        expect(await sessionCount(caller.user.id)).toBe(0);
    });

    it('takes every session with the account when it is deleted', async () => {
        const caller = await member();
        await store.createSession(hashToken('token-f'), caller.user.id, live(), ORG);
        await store.createSession(hashToken('token-g'), caller.user.id, live(), ORG);

        await sql`delete from app_user where id = ${caller.user.id}`;

        expect(await sessionCount(caller.user.id)).toBe(0);
    });

    it('reaps only what has already expired', async () => {
        const caller = await member();
        await store.createSession(hashToken('token-i'), caller.user.id, new Date(Date.now() - EXPIRED_OFFSET_MS), ORG);
        await store.createSession(hashToken('token-j'), caller.user.id, live(), ORG);

        await reapSessions(sql);

        expect(await sessionCount(caller.user.id)).toBe(1);
    });

    it('finds an organization row and answers null for a typo', async () => {
        await member(10, 'org-looker');
        expect(await store.findOrg(ORG)).toEqual({ id: ORG, name: ORG });
        expect(await store.findOrg('no-such-org')).toBeNull();
    });
});

describe.skipIf(!enabled)('the pending sign-in row (issue 125)', () => {
    it('round-trips identity and report, storing only the hash at rest', async () => {
        // Completing a pending sign-in mints a session, so the row is a bearer credential at
        // rest — the same rule as the session table's.
        const ACCOUNT_SEQ = 20;
        const token = await store.createPendingSignIn({
            identity: identity(ACCOUNT_SEQ, 'pending-user'),
            installations: [
                { id: ORG, name: 'acme' },
                { id: SECOND_ORG, name: 'other' },
            ],
            returnTo: '/dash',
            orgPreference: SECOND_ORG,
            expiresAt: live(),
        });

        const [row] = await sql<{ token_hash: Buffer }[]>`
            select token_hash from pending_sign_in where github_user_id = ${ID_BASE + ACCOUNT_SEQ}
        `;
        expect(row!.token_hash.equals(hashToken(token))).toBe(true);
        expect(row!.token_hash.toString('utf8')).not.toContain(token);

        expect(await store.findPendingSignIn(hashToken(token))).toEqual({
            identity: {
                githubUserId: ID_BASE + ACCOUNT_SEQ,
                login: 'pending-user',
                displayName: 'pending-user',
                avatarUrl: null,
            },
            installations: [
                { id: ORG, name: 'acme' },
                { id: SECOND_ORG, name: 'other' },
            ],
            returnTo: '/dash',
            orgPreference: SECOND_ORG,
        });
    });

    it('answers null for an unknown token, and spends an expired row on sight', async () => {
        const ACCOUNT_SEQ = 21;
        const expired = await store.createPendingSignIn({
            identity: identity(ACCOUNT_SEQ, 'stale'),
            installations: [{ id: ORG, name: ORG }],
            returnTo: '/',
            orgPreference: null,
            expiresAt: new Date(Date.now() - EXPIRED_OFFSET_MS),
        });

        expect(await store.findPendingSignIn(hashToken(expired))).toBeNull();
        // The read is also the reaping: nothing stale survives behind it.
        const [left] = await sql<{ count: number }[]>`
            select count(*)::int as count from pending_sign_in where github_user_id = ${ID_BASE + ACCOUNT_SEQ}
        `;
        expect(left?.count).toBe(0);
    });

    it('deletePendingSignIn spends a live row — the completion route single-use', async () => {
        const ACCOUNT_SEQ = 22;
        const token = await store.createPendingSignIn({
            identity: identity(ACCOUNT_SEQ, 'once-only'),
            installations: [{ id: ORG, name: ORG }],
            returnTo: '/',
            orgPreference: null,
            expiresAt: live(),
        });
        expect(await store.findPendingSignIn(hashToken(token))).not.toBeNull();

        await store.deletePendingSignIn(hashToken(token));

        expect(await store.findPendingSignIn(hashToken(token))).toBeNull();
    });

    it('the boot reaper clears expired rows and keeps live ones', async () => {
        const STALE_ACCOUNT_SEQ = 23;
        const stale = await store.createPendingSignIn({
            identity: identity(STALE_ACCOUNT_SEQ, 'reaped'),
            installations: [{ id: ORG, name: ORG }],
            returnTo: '/',
            orgPreference: null,
            expiresAt: new Date(Date.now() - EXPIRED_OFFSET_MS),
        });
        const fresh = await store.createPendingSignIn({
            identity: identity(24, 'kept'),
            installations: [{ id: ORG, name: ORG }],
            returnTo: '/',
            orgPreference: null,
            expiresAt: live(),
        });

        await reapPendingSignIns(sql);

        expect(await store.findPendingSignIn(hashToken(stale))).toBeNull();
        expect(await store.findPendingSignIn(hashToken(fresh))).not.toBeNull();
    });
});

describe.skipIf(!enabled)('the stored selection (issue 125)', () => {
    it('answers empty for an account that never signed in', async () => {
        const NEVER_SIGNED_IN_ACCOUNT_SEQ = 30;
        expect(await store.storedSelection(ID_BASE + NEVER_SIGNED_IN_ACCOUNT_SEQ)).toEqual([]);
    });

    it('answers the membership orgs — the membership rows ARE the stored choice', async () => {
        const ACCOUNT_SEQ = 31;
        const caller = await store.signIn(identity(ACCOUNT_SEQ, 'chooser'), ORG, [
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);

        expect(await store.storedSelection(caller.user.githubUserId)).toEqual([ORG, SECOND_ORG]);

        // A GitHub-side removal plus a narrowing sign-in prunes the answer with it.
        await store.signIn(identity(ACCOUNT_SEQ, 'chooser'), SECOND_ORG, [{ id: SECOND_ORG, name: SECOND_ORG }]);
        expect(await store.storedSelection(caller.user.githubUserId)).toEqual([SECOND_ORG]);
    });
});

describe.skipIf(!enabled)('the tracked-repo allowlist (issue 125)', () => {
    it('writes, replaces and clears the org allowlist wholesale', async () => {
        await store.replaceTrackedRepos(ORG, ['acme/web', 'acme/other']);
        expect(await trackedRepos({ sql, orgId: ORG })).toEqual(['acme/other', 'acme/web']);

        // Replace, not append: the second narrowing is the whole truth, not a delta.
        await store.replaceTrackedRepos(ORG, ['acme/web']);
        expect(await trackedRepos({ sql, orgId: ORG })).toEqual(['acme/web']);

        // Empty means "track everything": the rows go, the narrowing with them.
        await store.replaceTrackedRepos(ORG, []);
        expect(await trackedRepos({ sql, orgId: ORG })).toEqual([]);
    });

    it('is per-org: one org allowlist never leaks into another', async () => {
        await store.replaceTrackedRepos(ORG, ['acme/web']);
        await store.replaceTrackedRepos(SECOND_ORG, ['other/one']);

        expect(await trackedRepos({ sql, orgId: ORG })).toEqual(['acme/web']);
        expect(await trackedRepos({ sql, orgId: SECOND_ORG })).toEqual(['other/one']);
        expect(await trackedRepos({ sql, orgId: '911999' })).toEqual([]);
    });

    it('takes the rows with the organization, whose repo scope they are', async () => {
        await store.replaceTrackedRepos(ORG, ['acme/web']);
        await sql`delete from organization where id = ${ORG}`;

        expect(await trackedRepos({ sql, orgId: ORG })).toEqual([]);
    });
});

describe.skipIf(!enabled)('removeMember (the webhook)', () => {
    it('deletes the membership by the GitHub numeric id, and says so', async () => {
        // The webhook carries the numeric id — THE identity — while org_membership keys on
        // user_id since 029, so the lookup joins through app_user.
        const caller = await member();
        expect(await store.removeMember(ORG, caller.user.githubUserId)).toBe(true);
        expect(await store.membershipsOf(caller.user.id)).toEqual([]);
    });

    it('answers false once the row is gone, and for a github id that is nobody here', async () => {
        const caller = await member();
        expect(await store.removeMember(ORG, caller.user.githubUserId)).toBe(true);
        expect(await store.removeMember(ORG, caller.user.githubUserId)).toBe(false);
        const NOBODY_HERE_ACCOUNT_SEQ = 777;
        expect(await store.removeMember(ORG, ID_BASE + NOBODY_HERE_ACCOUNT_SEQ)).toBe(false);
    });
});

describe.skipIf(!enabled)('the local org (AUTH_MODE=none)', () => {
    it('resolves the stand-in account the local org seeds', async () => {
        // migrate({localUser}) writes exactly this shape; the plugin resolves it on every request
        // a none-mode deployment serves.
        await sql`
            insert into organization (id, name) values (${LOCAL_ORG_ID}, ${LOCAL_ORG_ID})
            on conflict (id) do nothing
        `;
        const [user] = await sql<{ id: string }[]>`
            insert into app_user (github_user_id, github_login, display_name)
            values (0, ${LOCAL_LOGIN}, 'Local')
            on conflict (github_user_id) do update set last_login_at = now()
            returning id
        `;
        await sql`
            insert into org_membership (org_id, github_login, user_id, claimed_at)
            values (${LOCAL_ORG_ID}, ${LOCAL_LOGIN}, ${user!.id}, now())
            on conflict (org_id, user_id) do update set user_id = excluded.user_id
        `;

        const caller = await store.localCaller(LOCAL_ORG_ID);
        expect(caller?.user.login).toBe(LOCAL_LOGIN);
        expect(caller?.org).toEqual({ id: LOCAL_ORG_ID, name: LOCAL_ORG_ID });
        expect(await store.localCaller('not-the-local-org')).toBeNull();
    });
});

describe.skipIf(!enabled)('the migration runner', () => {
    it('keeps a membership from existing without an account — invites are gone, irrecoverably', async () => {
        // 029 set user_id NOT NULL and re-keyed the table. The row type this suite used to spend
        // most of its time on — an unclaimed invite — can no longer be written at all.
        const ACCOUNT_SEQ = 11;
        await member(ACCOUNT_SEQ, 'constraint-watcher');
        await expect(
            sql`insert into org_membership (org_id, github_login, user_id) values (${ORG}, 'nobody', null)`
        ).rejects.toThrow();
    });

    it('is a localUser boot away from a usable none-mode database', async () => {
        // The offline tooling's boot: org row and stand-in account, all idempotent.
        await migrate(sql, { localUser: true, attempts: 1, log: (m) => console.log('[mig]', m) });

        expect(await store.findOrg(LOCAL_ORG_ID)).toEqual({ id: LOCAL_ORG_ID, name: LOCAL_ORG_ID });
        expect((await store.localCaller(LOCAL_ORG_ID))?.user.login).toBe(LOCAL_LOGIN);
    });
});
