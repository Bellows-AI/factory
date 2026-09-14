import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore, type AuthStore } from '../src/auth/store.js';
import { LOCAL_LOGIN, migrate, reapSessions } from '../src/db/migrate.js';

const url = process.env.DATABASE_URL;

/**
 * This suite deletes rows before every test. Requiring a `_test` database name is the guard, for
 * the same reason the job suite has one: the failure is silent — the tests pass and the accounts
 * are simply gone.
 */
function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(
            `Refusing to run: this suite deletes from the account tables, and "${name}" is not a test database.`
        );
    }
}

const enabled = Boolean(url);
if (url) assertTestDatabase(url);

let sql: Sql;
let store: AuthStore;

/**
 * Its own organization, and its own slice of the app_user key space.
 *
 * The db files share a database and vitest runs them in parallel, so this suite must not truncate
 * anything another one is using — `job` in particular references `app_user`, so a blanket
 * `truncate app_user cascade` would silently empty the job suite's table mid-run.
 */
const ORG = 'auth-test-org';
const OTHER_ORG = 'auth-test-other';
/** Every account this file creates is numbered from here, so the cleanup can be precise. */
const ID_BASE = 90000;

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 4 });
    await migrate(sql, { orgId: 'test-org', attempts: 3 });
    for (const id of [ORG, OTHER_ORG]) {
        await sql`insert into organization (id, name) values (${id}, ${id}) on conflict (id) do nothing`;
    }
    store = createAuthStore({ sql });
});

afterAll(async () => {
    if (enabled) await sql.end();
});

beforeEach(async () => {
    if (!enabled) return;
    await sql`delete from org_membership where org_id in (${ORG}, ${OTHER_ORG})`;
    await sql`delete from worker_token where org_id in (${ORG}, ${OTHER_ORG})`;
    // Sessions go with their account, through `on delete cascade`.
    await sql`delete from app_user where github_user_id >= ${ID_BASE}`;
});

const identity = (n: number, login: string) => ({
    githubUserId: ID_BASE + n,
    login,
    displayName: login,
    avatarUrl: null,
});

const sessionCount = async (userId: string): Promise<number> => {
    const [row] = await sql<{ count: number }[]>`
        select count(*)::int as count from session where user_id = ${userId}
    `;
    return row!.count;
};

describe.skipIf(!enabled)('invite and claim', () => {
    it('creates an invite for a login that has no account yet', async () => {
        // The whole reason the primary key is the login: at invite time there is nobody to point at.
        expect(await store.invite(ORG, 'octocat', 'member')).toBe('created');
        expect(await store.listMembers(ORG)).toEqual([{ login: 'octocat', role: 'member', claimed: false }]);
    });

    it('normalises the login, because GitHub is case-insensitive about them', async () => {
        await store.invite(ORG, 'OctoCat', 'member');
        const caller = await store.signIn(identity(1, 'octocat'), ORG);
        expect(caller?.role).toBe('member');
    });

    it('binds the account on first sign-in and keeps the invited role', async () => {
        await store.invite(ORG, 'octocat', 'admin');

        const caller = await store.signIn(identity(1, 'octocat'), ORG);

        expect(caller?.user.login).toBe('octocat');
        expect(caller?.role).toBe('admin');
        expect(await store.listMembers(ORG)).toEqual([{ login: 'octocat', role: 'admin', claimed: true }]);
    });

    it('refuses a login nobody invited, while still recording the identity', async () => {
        expect(await store.signIn(identity(2, 'stranger'), ORG)).toBeNull();
        const [row] = await sql<{ id: string }[]>`
            select id from app_user where github_user_id = ${ID_BASE + 2}
        `;
        // The account exists — the identity is a fact — but there is no membership and no session.
        expect(row).toBeDefined();
    });

    it('is idempotent across repeated sign-ins', async () => {
        await store.invite(ORG, 'octocat', 'member');
        const first = await store.signIn(identity(1, 'octocat'), ORG);
        const second = await store.signIn(identity(1, 'octocat'), ORG);
        expect(second?.user.id).toBe(first?.user.id);
    });

    it('creates one account per numeric id, not one per login it has used', async () => {
        await store.invite(ORG, 'octocat', 'admin');
        const before = await store.signIn(identity(1, 'octocat'), ORG);

        // The same GitHub account, renamed.
        const after = await store.signIn(identity(1, 'octocat-renamed'), ORG);

        expect(after?.user.id).toBe(before?.user.id);
        expect(after?.user.login).toBe('octocat-renamed');
        expect(after?.role).toBe('admin');
    });

    it('does NOT let a new account claim a membership by taking a freed login', async () => {
        /*
         * The predicate `and user_id is null` on the claim, tested end to end against the database.
         *
         * GitHub frees a login when its owner renames. Without that predicate this sequence hands
         * the impostor the original member's row, admin role included.
         */
        await store.invite(ORG, 'octocat', 'admin');
        const original = await store.signIn(identity(1, 'octocat'), ORG);
        await store.signIn(identity(1, 'octocat-renamed'), ORG);

        const impostor = await store.signIn(identity(2, 'octocat'), ORG);

        expect(impostor).toBeNull();
        expect((await store.listMembers(ORG))[0]).toMatchObject({ claimed: true });
        // The membership is still the original account's.
        const rebound = await store.signIn(identity(1, 'octocat-renamed'), ORG);
        expect(rebound?.user.id).toBe(original?.user.id);
    });

    it('does not give one account two memberships in one organization', async () => {
        /*
         * Somebody invited under both an old and a new login. Without the `not exists` guard on the
         * claim this violates org_membership_user_uk and turns a legitimate sign-in into a 500.
         */
        await store.invite(ORG, 'octocat', 'member');
        await store.signIn(identity(1, 'octocat'), ORG);
        await store.invite(ORG, 'octocat-renamed', 'admin');

        const caller = await store.signIn(identity(1, 'octocat-renamed'), ORG);

        expect(caller).not.toBeNull();
        const claimed = (await store.listMembers(ORG)).filter((m) => m.claimed);
        expect(claimed).toHaveLength(1);
    });

    it('claims memberships in every organization at once', async () => {
        await store.invite(ORG, 'octocat', 'member');
        await store.invite(OTHER_ORG, 'octocat', 'admin');

        await store.signIn(identity(1, 'octocat'), ORG);

        // One sign-in, both rows claimed — the update is not scoped to the org being signed in to.
        expect((await store.listMembers(OTHER_ORG))[0]).toMatchObject({ claimed: true, role: 'admin' });
    });

    it('keeps organizations apart', async () => {
        await store.invite(OTHER_ORG, 'octocat', 'member');
        expect(await store.signIn(identity(1, 'octocat'), ORG)).toBeNull();
    });

    it('updates the role on a re-invite rather than failing', async () => {
        await store.invite(ORG, 'octocat', 'member');
        expect(await store.invite(ORG, 'octocat', 'admin')).toBe('updated');
        expect((await store.listMembers(ORG))[0]?.role).toBe('admin');
    });
});

describe.skipIf(!enabled)('auto-join', () => {
    it('creates the missing membership instead of refusing', async () => {
        const caller = await store.signIn(identity(20, 'stranger'), ORG, { autoJoin: true });

        expect(caller?.user.login).toBe('stranger');
        // `member`, never `admin`: being let in is not the same as being trusted to let others in.
        expect(caller?.role).toBe('member');
        expect(await store.listMembers(ORG)).toEqual([{ login: 'stranger', role: 'member', claimed: true }]);
    });

    it('does nothing when the account is already a member, keeping its role', async () => {
        await store.invite(ORG, 'octocat', 'admin');

        const caller = await store.signIn(identity(21, 'octocat'), ORG, { autoJoin: true });

        expect(caller?.role).toBe('admin');
        expect(await store.listMembers(ORG)).toHaveLength(1);
    });

    it('is idempotent, so a second sign-in does not collide with the row it created', async () => {
        const first = await store.signIn(identity(22, 'stranger'), ORG, { autoJoin: true });
        const second = await store.signIn(identity(22, 'stranger'), ORG, { autoJoin: true });

        expect(second?.user.id).toBe(first?.user.id);
        expect(await store.listMembers(ORG)).toHaveLength(1);
    });

    it('joins only the organization it was asked about', async () => {
        await store.signIn(identity(23, 'stranger'), ORG, { autoJoin: true });
        expect(await store.listMembers(OTHER_ORG)).toEqual([]);
    });

    it('still refuses without the flag, which is what keeps the decision in the callback', async () => {
        expect(await store.signIn(identity(24, 'stranger'), ORG)).toBeNull();
        expect(await store.listMembers(ORG)).toEqual([]);
    });
});

describe.skipIf(!enabled)('sessions', () => {
    const live = () => new Date(Date.now() + 3600_000);

    const member = async () => {
        await store.invite(ORG, 'octocat', 'member');
        return (await store.signIn(identity(1, 'octocat'), ORG))!;
    };

    it('resolves a live session to its caller', async () => {
        const caller = await member();
        const hash = hashToken('token-a');
        await store.createSession(hash, caller.user.id, live());

        expect((await store.findSession(hash, ORG))?.user.id).toBe(caller.user.id);
    });

    it('refuses an expired session', async () => {
        const caller = await member();
        const hash = hashToken('token-b');
        await store.createSession(hash, caller.user.id, new Date(Date.now() - 1000));

        expect(await store.findSession(hash, ORG)).toBeNull();
    });

    it('refuses an unknown token', async () => {
        await member();
        expect(await store.findSession(hashToken('never-issued'), ORG)).toBeNull();
    });

    it('stops resolving the moment the membership is gone', async () => {
        // The membership is an inner join in findSession, which is what makes removal take effect on
        // the next request rather than at cookie expiry.
        const caller = await member();
        const hash = hashToken('token-c');
        await store.createSession(hash, caller.user.id, live());

        await sql`delete from org_membership where org_id = ${ORG} and github_login = 'octocat'`;

        expect(await store.findSession(hash, ORG)).toBeNull();
    });

    it('deletes on logout', async () => {
        const caller = await member();
        const hash = hashToken('token-e');
        await store.createSession(hash, caller.user.id, live());

        await store.deleteSession(hash);

        expect(await sessionCount(caller.user.id)).toBe(0);
    });

    it('takes every session with the account when it is deleted', async () => {
        const caller = await member();
        await store.createSession(hashToken('token-f'), caller.user.id, live());
        await store.createSession(hashToken('token-g'), caller.user.id, live());

        await sql`delete from app_user where id = ${caller.user.id}`;

        expect(await sessionCount(caller.user.id)).toBe(0);
    });

    it('ends a removed member\u2019s sessions immediately', async () => {
        // Otherwise removal takes effect whenever the cookie happens to expire, which on a board
        // that runs shell commands is not soon enough.
        const caller = await member();
        await store.createSession(hashToken('token-h'), caller.user.id, live());

        expect(await store.removeMember(ORG, 'octocat')).toBe('removed');

        expect(await sessionCount(caller.user.id)).toBe(0);
    });

    it('reports removing somebody who is not a member', async () => {
        expect(await store.removeMember(ORG, 'nobody')).toBe('missing');
    });

    it('reaps only what has already expired', async () => {
        const caller = await member();
        await store.createSession(hashToken('token-i'), caller.user.id, new Date(Date.now() - 1000));
        await store.createSession(hashToken('token-j'), caller.user.id, live());

        await reapSessions(sql);

        expect(await sessionCount(caller.user.id)).toBe(1);
    });
});

describe.skipIf(!enabled)('worker tokens', () => {
    it('resolves a token to the organization it was minted for', async () => {
        // This lookup IS the driver's org binding: it is how a process with no session says which
        // organization it is working for.
        await store.createWorkerToken(ORG, 'driver-1', hashToken('fwt_a'));

        expect(await store.findWorkerToken(hashToken('fwt_a'))).toMatchObject({
            orgId: ORG,
            name: 'driver-1',
        });
    });

    it('refuses an unknown token', async () => {
        expect(await store.findWorkerToken(hashToken('fwt_never-minted'))).toBeNull();
    });

    it('refuses a revoked one', async () => {
        await store.createWorkerToken(ORG, 'driver-1', hashToken('fwt_b'));
        expect(await store.revokeWorkerToken(ORG, 'driver-1')).toBe('revoked');

        expect(await store.findWorkerToken(hashToken('fwt_b'))).toBeNull();
    });

    it('reports revoking a name that has no live token', async () => {
        expect(await store.revokeWorkerToken(ORG, 'driver-1')).toBe('missing');
    });

    it('stamps last_used_at, so an unused token is visible as one', async () => {
        await store.createWorkerToken(ORG, 'driver-1', hashToken('fwt_c'));
        const [before] = await sql<{ last_used_at: Date | null }[]>`
            select last_used_at from worker_token where org_id = ${ORG} and name = 'driver-1'
        `;
        expect(before?.last_used_at).toBeNull();

        await store.findWorkerToken(hashToken('fwt_c'));

        const [after] = await sql<{ last_used_at: Date | null }[]>`
            select last_used_at from worker_token where org_id = ${ORG} and name = 'driver-1'
        `;
        expect(after?.last_used_at).not.toBeNull();
    });

    it('lists live and revoked tokens together', async () => {
        await store.createWorkerToken(ORG, 'driver-1', hashToken('fwt_d'));
        await store.createWorkerToken(ORG, 'driver-2', hashToken('fwt_e'));
        await store.revokeWorkerToken(ORG, 'driver-2');

        expect(await store.listWorkerTokens(ORG)).toMatchObject([
            { name: 'driver-1', revoked: false },
            { name: 'driver-2', revoked: true },
        ]);
    });
});

describe.skipIf(!enabled)('boot-time seeding', () => {
    /** Its own organization per case: bootstrapping is defined by an org having no members yet. */
    const freshOrg = () => `auth-boot-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`.slice(0, 39);

    it('bootstraps an admin into an organization that has nobody in it', async () => {
        // Without this an upgrade is a lockout: rows, no users, no memberships, and every route
        // 401ing with nothing in the log to say why.
        const orgId = freshOrg();
        await migrate(sql, { orgId, attempts: 1, bootstrapAdmin: 'FirstAdmin' });

        expect(await store.listMembers(orgId)).toEqual([{ login: 'firstadmin', role: 'admin', claimed: false }]);
    });

    it('does not reinstate an admin who removed themselves', async () => {
        // One-shot ignition, not a standing grant.
        const orgId = freshOrg();
        await migrate(sql, { orgId, attempts: 1, bootstrapAdmin: 'firstadmin' });
        await store.invite(orgId, 'someone-else', 'member');
        await store.removeMember(orgId, 'firstadmin');

        await migrate(sql, { orgId, attempts: 1, bootstrapAdmin: 'firstadmin' });

        expect((await store.listMembers(orgId)).map((m) => m.login)).toEqual(['someone-else']);
    });

    it('still bootstraps when the only member is the AUTH_MODE=none stand-in', async () => {
        /*
         * A deployment that booted once without auth has a `__local__` membership. If that counted
         * as a member, turning auth on afterwards would silently skip the bootstrap and lock
         * everybody out — the exact failure this whole mechanism exists to prevent.
         */
        const orgId = freshOrg();
        await migrate(sql, { orgId, attempts: 1, localUser: true });

        await migrate(sql, { orgId, attempts: 1, bootstrapAdmin: 'firstadmin' });

        const logins = (await store.listMembers(orgId)).map((m) => m.login).sort();
        expect(logins).toEqual([LOCAL_LOGIN, 'firstadmin'].sort());
    });

    it('seeds the stand-in account and resolves it as a caller', async () => {
        const orgId = freshOrg();
        await migrate(sql, { orgId, attempts: 1, localUser: true });

        const caller = await store.localCaller(orgId);

        expect(caller?.user.githubUserId).toBe(0);
        expect(caller?.role).toBe('admin');
    });

    it('has no stand-in when it was not asked for one', async () => {
        const orgId = freshOrg();
        await migrate(sql, { orgId, attempts: 1 });
        expect(await store.localCaller(orgId)).toBeNull();
    });

    it('records the organization so memberships have something to reference', async () => {
        const orgId = freshOrg();
        await migrate(sql, { orgId, orgName: 'A Display Name', attempts: 1 });

        const [row] = await sql<{ name: string }[]>`select name from organization where id = ${orgId}`;
        expect(row?.name).toBe('A Display Name');
    });

    it('does not rewrite a name on a later boot', async () => {
        // Config plants the row; the database owns the name afterwards. Otherwise a stale ORG_NAME
        // in one operator's shell silently renames the organization for everybody.
        const orgId = freshOrg();
        await migrate(sql, { orgId, orgName: 'Original', attempts: 1 });
        await migrate(sql, { orgId, orgName: 'Overwritten', attempts: 1 });

        const [row] = await sql<{ name: string }[]>`select name from organization where id = ${orgId}`;
        expect(row?.name).toBe('Original');
    });
});
