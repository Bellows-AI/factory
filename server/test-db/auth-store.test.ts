import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore, type AuthStore } from '../src/auth/store.js';
import { LOCAL_ORG_ID } from '../src/config.js';
import { adoptOrg, LOCAL_LOGIN, mergeLegacyOrg, migrate, reapSessions } from '../src/db/migrate.js';

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
// Numeric strings: an org id IS an installation id now, and signIn casts it into
// organization.installation_id (bigint). Names that are not numbers stopped being org ids.
const ORG = '911001';
const SECOND_ORG = '911002';
/** A pre-#99 legacy org: planted with no installation id, the shape 028 left behind. */
const LEGACY_ORG = '911003';
/** Every account this file creates is numbered from here, so the cleanup can be precise. */
const ID_BASE = 90000;

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 4 });
    await migrate(sql, { attempts: 3 });
    store = createAuthStore({ sql });
});

afterAll(async () => {
    if (enabled) await sql.end();
});

beforeEach(async () => {
    if (!enabled) return;
    // The organization rows go too: signIn materializes them from installations now (#99), so
    // every test starts from no orgs at all. The FKs cascade the memberships and sessions —
    // and the plain rows are planted straight back, because the token and adoption tests write
    // rows that need an org to point at without signing in first.
    //
    // `911%` is this suite's whole id namespace (ORG, SECOND_ORG, LEGACY_ORG, the literals the
    // tests plant, and residue an interrupted run may have left) — claimed here rather than
    // listed, because adoptTarget() counts installation orgs across the DATABASE, and a stale
    // row outside the listed ids would read as a second installation forever. That count is
    // honest only while this file stays the only db suite that ever sets installation_id —
    // which holds today; do not plant one elsewhere without revisiting the adoptTarget test.
    await sql`delete from organization where id like '911%' or id = '424242'`;
    await sql`insert into organization (id, name) values (${ORG}, ${ORG}), (${SECOND_ORG}, ${SECOND_ORG})
              on conflict (id) do nothing`;
    await sql`delete from worker_token where org_id like '911%'`;
    await sql`delete from access_token where org_id like '911%'`;
    // job and task_reclaim carry org_id as a plain column (no FK), so the organization delete
    // above cannot cascade to them — the merge tests plant one of each, and the merge moves it
    // into ORG. Only this suite's org ids are touched: the db files share a database and run in
    // parallel, so a blanket delete would empty another suite's table mid-run.
    await sql`delete from job where org_id like '911%'`;
    await sql`delete from task_reclaim where org_id like '911%'`;
    // The adoption test plants session_branch rows, and org_id on that table is a plain column
    // (005 added it without a foreign key), so the organization delete above cannot cascade to
    // them — against the shared database this suite shares with the other db files, one adopted
    // `acme/web` row would survive every cleanup and the count assertions would drift per run.
    await sql`delete from session_branch where org_id like '911%' or session_id like 'adopt-%'`;
    // Sessions whose org is gone would already be; this catches rows of deleted accounts.
    await sql`delete from session where user_id in (select id from app_user where github_user_id >= ${ID_BASE})`;
    await sql`delete from app_user where github_user_id >= ${ID_BASE}`;
});

const identity = (n: number, login: string) => ({
    githubUserId: ID_BASE + n,
    login,
    displayName: login,
    avatarUrl: null,
});

const live = () => new Date(Date.now() + 3600_000);

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
        const original = await member(3, 'octocat');

        const impostor = await member(4, 'octocat');

        expect(impostor.user.id).not.toBe(original.user.id);
        const rows = await sql<{ org_id: string; user_id: string }[]>`
            select org_id, user_id from org_membership where org_id = ${ORG} order by user_id
        `;
        expect(rows.map((r) => r.user_id).sort()).toEqual([original.user.id, impostor.user.id].sort());
    });

    it('drops the membership of an installation GitHub no longer reports', async () => {
        // The propagation the security property needs: losing the installation ends the
        // membership at the next sign-in, and the session reads it is joined through die with it.
        const caller = await member(5, 'octocat', [
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);
        await store.createSession(hashToken('sig-x'), caller.user.id, live(), ORG);
        // Planted orgs carry no installation; these two ARE installations, so the propagation
        // rule (installation orgs only) applies to them.
        await sql`update organization set installation_id = id::bigint where id in (${ORG}, ${SECOND_ORG})`;

        await store.signIn(identity(5, 'octocat'), SECOND_ORG, [{ id: SECOND_ORG, name: SECOND_ORG }]);

        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: SECOND_ORG, name: SECOND_ORG }]);
        // The session row survives; the join through the membership does not.
        expect(await store.findSession(hashToken('sig-x'))).toBeNull();
    });

    it('sweeps a legacy (non-installation) membership at sign-in, so the selector never lists both', async () => {
        // The pre-#99 rows (#123): an org with no installation id (028 added the column, no
        // backfill) and the membership the single-org sign-in wrote. The installation is a NEW
        // row for the same account — nothing matches one back to the other, so the sweep is
        // what keeps the selector from listing the same account twice.
        const caller = await member(14, 'legacy-member');
        await sql`
            insert into organization (id, name) values (${LEGACY_ORG}, 'Legacy')
            on conflict (id) do nothing
        `;
        await sql`
            insert into org_membership (org_id, github_login, user_id, claimed_at)
            values (${LEGACY_ORG}, 'legacy-member', ${caller.user.id}, now())
        `;

        await store.signIn(identity(14, 'legacy-member'), ORG, [{ id: ORG, name: ORG }]);

        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: ORG, name: ORG }]);
        const [count] = await sql<{ count: number }[]>`
            select count(*)::int as count from org_membership where org_id = ${LEGACY_ORG}
        `;
        expect(count?.count).toBe(0);
    });

    it('names the adoption target only when exactly one installation exists', async () => {
        // The adoption notice may fill in `--installation` only when the pairing cannot be a
        // guess: zero installations name nothing, several leave the choice to the operator.
        expect(await store.adoptTarget()).toBeNull();

        await member(17, 'single-target', [{ id: ORG, name: ORG }]);
        expect(await store.adoptTarget()).toEqual({ id: ORG });

        await store.signIn(identity(17, 'single-target'), SECOND_ORG, [
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);
        expect(await store.adoptTarget()).toBeNull();
    });

    it('refuses an orgId outside the reported installations', async () => {
        // The route validates; the store asserts rather than silently resolving null.
        await expect(member(6, 'octocat', [{ id: ORG, name: ORG }])).resolves.toBeTruthy();
        await expect(store.signIn(identity(6, 'octocat'), SECOND_ORG, [{ id: ORG, name: ORG }])).rejects.toThrow(
            /no membership/
        );
    });

    it('records the membership the first sign-in reported it', async () => {
        const caller = await member(7, 'first-seen');
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
        await store.createSession(hash, caller.user.id, new Date(Date.now() - 1000), ORG);

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
        const caller = await member(8, 'switcher', [{ id: ORG, name: ORG }]);
        await member(9, 'elsewhere', [{ id: SECOND_ORG, name: SECOND_ORG }]);
        const hash = hashToken('token-swap');
        await store.createSession(hash, caller.user.id, live(), ORG);

        await expect(store.updateSessionOrg(hash, SECOND_ORG)).resolves.toBe(false);
        // Still in the original org — the refusal left no trace.
        expect((await store.findSession(hash))?.org.id).toBe(ORG);

        await member(8, 'switcher', [
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
        await store.createSession(hashToken('token-i'), caller.user.id, new Date(Date.now() - 1000), ORG);
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

describe.skipIf(!enabled)('worker tokens', () => {
    it('resolves a token to the organization it was minted for', async () => {
        // This lookup IS the driver's org binding: it is how a process with no session says which
        // organization it is working for.
        await store.createWorkerToken(ORG, 'driver-1', hashToken('fwt_a'));

        expect(await store.findWorkerToken(hashToken('fwt_a'))).toMatchObject({ orgId: ORG, name: 'driver-1' });
    });

    it('refuses an unknown token', async () => {
        expect(await store.findWorkerToken(hashToken('fwt_nothing'))).toBeNull();
    });

    it('refuses a revoked one', async () => {
        await store.createWorkerToken(ORG, 'driver-2', hashToken('fwt_b'));

        expect(await store.revokeWorkerToken(ORG, 'driver-2')).toBe('revoked');
        expect(await store.findWorkerToken(hashToken('fwt_b'))).toBeNull();
    });

    it('reports revoking a name that has no live token', async () => {
        expect(await store.revokeWorkerToken(ORG, 'nobody')).toBe('missing');
    });

    it('stamps last_used_at, so an unused token is visible as one', async () => {
        await store.createWorkerToken(ORG, 'driver-3', hashToken('fwt_c'));
        const before = await sql<{ last_used_at: Date | null }[]>`
            select last_used_at from worker_token where org_id = ${ORG} and name = 'driver-3'
        `;
        expect(before[0]?.last_used_at).toBeNull();

        await store.findWorkerToken(hashToken('fwt_c'));
        const after = await sql<{ last_used_at: Date | null }[]>`
            select last_used_at from worker_token where org_id = ${ORG} and name = 'driver-3'
        `;
        expect(after[0]?.last_used_at).not.toBeNull();
    });

    it('lists live and revoked tokens together', async () => {
        await store.createWorkerToken(ORG, 'driver-4', hashToken('fwt_d'));
        await store.createWorkerToken(ORG, 'driver-5', hashToken('fwt_e'));
        await store.revokeWorkerToken(ORG, 'driver-4');

        const list = await store.listWorkerTokens(ORG);
        expect(list).toEqual([
            { name: 'driver-4', createdAt: expect.any(String), revoked: true },
            { name: 'driver-5', createdAt: expect.any(String), revoked: false },
        ]);
    });
});

describe.skipIf(!enabled)('access tokens', () => {
    const createPersonal = (caller: { user: { id: string } }, token: string, label: string) =>
        store.createAccessToken({
            kind: 'personal',
            orgId: ORG,
            userId: caller.user.id,
            createdBy: caller.user.id,
            label,
            tokenHash: hashToken(token),
        });

    it('resolves a personal token to its caller in the org the token was minted for', async () => {
        const caller = await member(1, 'token-user');
        await createPersonal(caller, 'fat_a', 'laptop');

        const resolved = await store.findPersonalToken(hashToken('fat_a'));
        expect(resolved).toMatchObject({
            user: { id: caller.user.id, login: 'token-user' },
            role: 'member',
            org: { id: ORG, name: ORG },
        });
    });

    it('refuses a personal token whose membership is gone', async () => {
        const caller = await member(2, 'leaver');
        await createPersonal(caller, 'fat_b', 'laptop');

        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${caller.user.id}`;

        expect(await store.findPersonalToken(hashToken('fat_b'))).toBeNull();
    });

    it('refuses a revoked token, of either kind', async () => {
        const caller = await member(3, 'revoker');
        const personal = await createPersonal(caller, 'fat_c', 'laptop');
        const org = await store.createAccessToken({
            kind: 'org',
            orgId: ORG,
            userId: null,
            createdBy: caller.user.id,
            label: 'ci',
            tokenHash: hashToken('oat_c'),
        });

        expect(await store.revokePersonalToken(ORG, caller.user.id, personal.id)).toBe('revoked');
        expect(await store.revokeOrgToken(ORG, org.id)).toBe('revoked');
        expect(await store.findPersonalToken(hashToken('fat_c'))).toBeNull();
        expect(await store.findOrgToken(hashToken('oat_c'))).toBeNull();
        // Revoking again changes nothing.
        expect(await store.revokePersonalToken(ORG, caller.user.id, personal.id)).toBe('missing');
        expect(await store.revokeOrgToken(ORG, org.id)).toBe('missing');
    });

    it('resolves each token into its OWN org, whatever else the account belongs to', async () => {
        // Since #99 the lookup is by the globally-unique hash and the org comes FROM the row —
        // the mint-time binding. A token minted into one org acts there and nowhere else.
        const caller = await member(4, 'everywhere', [
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);
        await store.createAccessToken({
            kind: 'personal',
            orgId: SECOND_ORG,
            userId: caller.user.id,
            createdBy: caller.user.id,
            label: 'laptop',
            tokenHash: hashToken('fat_d'),
        });

        const resolved = await store.findPersonalToken(hashToken('fat_d'));
        expect(resolved?.org.id).toBe(SECOND_ORG);
    });

    it('answers an org token with its identity AND its org', async () => {
        const caller = await member(9, 'org-minter');
        const org = await store.createAccessToken({
            kind: 'org',
            orgId: ORG,
            userId: null,
            createdBy: caller.user.id,
            label: 'ci',
            tokenHash: hashToken('oat_h'),
        });

        expect(await store.findOrgToken(hashToken('oat_h'))).toEqual({ orgId: ORG, id: org.id, label: 'ci' });
    });

    it('resolves an org token only while its minter is still a member', async () => {
        // The issuer's membership is the org token's authority, the same join a session and a
        // personal token run: sign-in propagation deleting the membership kills the token's reach
        // on the next request, while the row itself survives unrevoked — history with no reach,
        // the same contract the personal kind states.
        const minter = await member(12, 'org-leaver');
        const org = await store.createAccessToken({
            kind: 'org',
            orgId: ORG,
            userId: null,
            createdBy: minter.user.id,
            label: 'ci',
            tokenHash: hashToken('oat_i'),
        });
        expect(await store.findOrgToken(hashToken('oat_i'))).toEqual({ orgId: ORG, id: org.id, label: 'ci' });

        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${minter.user.id}`;

        expect(await store.findOrgToken(hashToken('oat_i'))).toBeNull();
        const [row] = await sql<{ revoked_at: Date | null }[]>`
            select revoked_at from access_token where org_id = ${ORG} and id = ${org.id}
        `;
        expect(row?.revoked_at).toBeNull();
    });

    it('does not resolve an org token whose minter is a member of a DIFFERENT org', async () => {
        // The join is on (org, creator) together: membership elsewhere is not authority here, so
        // a row minted into ORG by someone whose membership is only in SECOND_ORG is dead.
        const minter = await member(13, 'org-outsider', [{ id: SECOND_ORG, name: SECOND_ORG }]);
        await store.createAccessToken({
            kind: 'org',
            orgId: ORG,
            userId: null,
            createdBy: minter.user.id,
            label: 'ci',
            tokenHash: hashToken('oat_j'),
        });

        expect(await store.findOrgToken(hashToken('oat_j'))).toBeNull();
    });

    it('stamps last_used_at, then holds it within the throttle window', async () => {
        // The dashboard polls every two seconds, so the touch is throttled to one rewrite a
        // minute — minute-granular "last used" in exchange for a read path that is not a write.
        const caller = await member(5, 'throttle');
        await createPersonal(caller, 'fat_e', 'laptop');

        await store.findPersonalToken(hashToken('fat_e'));
        const [first] = await sql<{ last_used_at: Date }[]>`
            select last_used_at from access_token where org_id = ${ORG} and label = 'laptop'
        `;
        expect(first?.last_used_at).not.toBeNull();

        await store.findPersonalToken(hashToken('fat_e'));
        const [second] = await sql<{ last_used_at: Date }[]>`
            select last_used_at from access_token where org_id = ${ORG} and label = 'laptop'
        `;
        expect(second?.last_used_at?.getTime()).toBe(first?.last_used_at?.getTime());
    });

    it('leaves a memberless personal token unrevoked but dead — the join is the enforcement', async () => {
        // The old removeMember marked tokens; the sign-in propagation that replaced it does not.
        // It does not need to: findPersonalToken joins the membership, so the row survives as
        // history with no reach at all.
        const caller = await member(6, 'removed');
        await createPersonal(caller, 'fat_f', 'laptop');
        await sql`update organization set installation_id = id::bigint where id in (${ORG}, ${SECOND_ORG})`;

        await store.signIn(identity(6, 'removed'), SECOND_ORG, [{ id: SECOND_ORG, name: SECOND_ORG }]);

        const [row] = await sql<{ revoked_at: Date | null }[]>`
            select revoked_at from access_token where org_id = ${ORG} and label = 'laptop'
        `;
        expect(row?.revoked_at).toBeNull();
        expect(await store.findPersonalToken(hashToken('fat_f'))).toBeNull();
    });

    it('stores the hash of the token, never the token', async () => {
        const caller = await member(7, 'at-rest');
        const token = 'fat_secret-value-shown-once';
        await createPersonal(caller, token, 'laptop');

        const [row] = await sql<{ token_hash: Buffer }[]>`
            select token_hash from access_token where org_id = ${ORG} and label = 'laptop'
        `;
        expect(row!.token_hash.equals(hashToken(token))).toBe(true);
        expect(row!.token_hash.toString('utf8')).not.toContain(token);
    });

    it('rejects a personal row with no user, at the row', async () => {
        // access_token_owner_ck says what the hook assumes: a personal token has an owner.
        await expect(
            store.createAccessToken({
                kind: 'personal',
                orgId: ORG,
                userId: null,
                createdBy: null,
                label: 'ownerless',
                tokenHash: hashToken('fat_ownerless'),
            })
        ).rejects.toThrow();
    });

    it('lists each scope without ever selecting a hash', async () => {
        const caller = await member(8, 'lister');
        await createPersonal(caller, 'fat_g', 'laptop');
        await store.createAccessToken({
            kind: 'org',
            orgId: ORG,
            userId: null,
            createdBy: caller.user.id,
            label: 'ci',
            tokenHash: hashToken('oat_g'),
        });

        const personal = await store.listPersonalTokens(ORG, caller.user.id);
        expect(personal).toMatchObject([{ label: 'laptop', revokedAt: null }]);
        const org = await store.listOrgTokens(ORG);
        expect(org).toMatchObject([{ label: 'ci' }]);
        for (const view of [...personal, ...org]) {
            expect(JSON.stringify(view)).not.toContain('hash');
        }
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
        expect(await store.removeMember(ORG, ID_BASE + 777)).toBe(false);
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

describe.skipIf(!enabled)('the migration runner and adoption', () => {
    it('claims the pre-organization rows into the org it is given, and is a no-op afterwards', async () => {
        // What adoptOrg exists for, now driven by the adopt CLI instead of every boot (#99):
        // without it a re-homed deployment reads an empty dashboard that looks like data loss.
        await sql`
            insert into session_branch (org_id, agent, session_id, repo, branch, head_sha, first_seen, last_seen, samples)
            values ('__unclaimed__', 'claude-code', ${`adopt-${Date.now()}`}, 'acme/web', 'main', null, now(), now(), 1)
        `;
        let moved = '';
        await adoptOrg(sql, ORG, (m) => {
            moved += m;
        });

        expect(moved).toContain('pre-organization rows');
        // Nothing unclaimed survives, and the row reads from the target org now.
        const [left] = await sql<{ count: number }[]>`
            select count(*)::int as count from session_branch where org_id = '__unclaimed__'
            and agent = 'claude-code'
        `;
        expect(left?.count).toBe(0);
        const [adopted] = await sql<{ count: number }[]>`
            select count(*)::int as count from session_branch
            where org_id = ${ORG} and agent = 'claude-code' and repo = 'acme/web'
        `;
        expect(adopted?.count).toBe(1);

        // Second run: nothing left to claim, no line.
        let again = '';
        await adoptOrg(sql, ORG, (m) => {
            again += m;
        });
        expect(again).toBe('');
    });

    it('keeps a membership from existing without an account — invites are gone, irrecoverably', async () => {
        // 029 set user_id NOT NULL and re-keyed the table. The row type this suite used to spend
        // most of its time on — an unclaimed invite — can no longer be written at all.
        await member(11, 'constraint-watcher');
        await expect(
            sql`insert into org_membership (org_id, github_login, user_id) values (${ORG}, 'nobody', null)`
        ).rejects.toThrow();
    });

    it('merges a legacy org into the installation: every org-owned row re-homed, the husk retired', async () => {
        // The adopt --from arm, grown from session_branch to the whole org-owned set (#123): a
        // husk left behind — the org row itself, or rows the old adopt never touched — keeps
        // the upgrade visible forever. Every table is planted under LEGACY_ORG so a statement
        // missing from the merge strands exactly its own rows.
        const caller = await member(15, 'adopter');
        const stamp = Date.now();
        await sql`
            insert into organization (id, name) values (${LEGACY_ORG}, 'Legacy')
            on conflict (id) do nothing
        `;
        // session_branch: one branch on BOTH sides — its samples must sum — and one legacy-only.
        await sql`
            insert into session_branch (org_id, agent, session_id, repo, branch, head_sha, first_seen, last_seen, samples)
            values
                (${ORG}, 'claude-code', ${`mg-${stamp}-a`}, 'acme/web', 'main', null, now(), now(), 2),
                (${LEGACY_ORG}, 'claude-code', ${`mg-${stamp}-a`}, 'acme/web', 'main', null, now(), now(), 3),
                (${LEGACY_ORG}, 'claude-code', ${`mg-${stamp}-b`}, 'acme/web', 'dev', null, now(), now(), 1)
        `;
        const [jobRow] = await sql<{ id: string }[]>`
            insert into job (org_id, command, root_job_id)
            values (${LEGACY_ORG}, 'echo legacy', gen_random_uuid()) returning id
        `;
        await sql`insert into task_reclaim (org_id, root_job_id) values (${LEGACY_ORG}, ${jobRow!.id})`;
        await sql`
            insert into worker_token (org_id, name, token_hash)
            values (${LEGACY_ORG}, 'mg-driver', ${hashToken('fwt-merge')})
        `;
        await sql`
            insert into access_token (org_id, kind, label, token_hash)
            values (${LEGACY_ORG}, 'org', 'mg-ci', ${hashToken('oat-merge')})
        `;
        await sql`
            insert into session (token_hash, user_id, expires_at, org_id)
            values (${hashToken('sess-merge')}, ${caller.user.id}, ${live()}, ${LEGACY_ORG})
        `;
        await sql`insert into workflow (org_id, name, definition) values (${LEGACY_ORG}, 'mg-flow', '{}')`;
        await sql`insert into env_var (org_id, name, value) values (${LEGACY_ORG}, 'MG_VAR', 'legacy')`;
        // A READY clone under the legacy org: its checkout lives at
        // <workspaceRoot>/<orgId>/<userId>/<name>, keyed by the org id — so a move that kept
        // status would point the row at a directory that has no clone in it.
        await sql`
            insert into user_repo (org_id, user_id, repo_owner, repo_name, status, started_at, ready_at)
            values (${LEGACY_ORG}, ${caller.user.id}, 'acme', 'web', 'ready', now(), now())
        `;
        await sql`
            insert into user_executor (org_id, user_id, name, type, config)
            values (${LEGACY_ORG}, ${caller.user.id}, 'mg-exec', 'claude-code', '{}')
        `;
        await sql`
            insert into org_membership (org_id, github_login, user_id, claimed_at)
            values (${LEGACY_ORG}, 'adopter', ${caller.user.id}, now())
        `;

        const log: string[] = [];
        await mergeLegacyOrg(sql, ORG, LEGACY_ORG, (m) => log.push(m));

        // Nothing is stranded under the legacy id — every org-owned table reads empty there.
        for (const table of [
            'job',
            'task_reclaim',
            'worker_token',
            'access_token',
            'session',
            'workflow',
            'env_var',
            'user_repo',
            'user_executor',
        ]) {
            const [legacy] = await sql<{ count: number }[]>`
                select count(*)::int as count from ${sql(table)} where org_id = ${LEGACY_ORG}
            `;
            expect(legacy?.count, table).toBe(0);
        }
        // The overlapping branch merged (samples summed), the legacy-only one arrived whole.
        const branches = await sql<{ branch: string; samples: number }[]>`
            select branch, samples from session_branch
            where org_id = ${ORG} and session_id like 'mg-%' order by branch
        `;
        expect(branches).toEqual([
            { branch: 'dev', samples: 1 },
            { branch: 'main', samples: 5 },
        ]);
        // The moved session resolves again — the caller's membership of ORG comes from sign-in,
        // so the merge re-homed the row onto a live join.
        expect(await store.findSession(hashToken('sess-merge'))).toMatchObject({ org: { id: ORG, name: ORG } });
        // The moved clone is re-queued, not carried over 'ready': the on-disk checkout is keyed
        // by the org id, so the queue must re-clone at the installation org's path. The
        // selection itself survives — the member picked this repo.
        const [moved] = await sql<{ status: string; ready_at: Date | null; started_at: Date | null }[]>`
            select status, ready_at, started_at from user_repo
            where org_id = ${ORG} and user_id = ${caller.user.id} and repo_name = 'web'
        `;
        expect(moved).toMatchObject({ status: 'queued', ready_at: null, started_at: null });
        // The husk itself is retired: no legacy org row for the selector or the adoption
        // notice to keep naming.
        const [org] = await sql<{ count: number }[]>`
            select count(*)::int as count from organization where id = ${LEGACY_ORG}
        `;
        expect(org?.count).toBe(0);
        expect(log.join('\n')).toContain(`retired legacy organization "${LEGACY_ORG}"`);
    });

    it("keeps the installation org's own row when a natural key collides", async () => {
        // env_var is one of the natural-keyed tables (coalesce unique index): the installation
        // org's value wins, the legacy copy is deleted rather than left behind by do-nothing.
        await sql`
            insert into organization (id, name) values (${LEGACY_ORG}, 'Legacy')
            on conflict (id) do nothing
        `;
        await sql`
            insert into env_var (org_id, name, value)
            values (${ORG}, 'MG_SHARED', 'kept'), (${LEGACY_ORG}, 'MG_SHARED', 'dropped')
        `;

        await mergeLegacyOrg(sql, ORG, LEGACY_ORG, () => {});

        const rows = await sql<{ value: string }[]>`
            select value from env_var where org_id = ${ORG} and name = 'MG_SHARED'
        `;
        expect(rows.map((r) => r.value)).toEqual(['kept']);
    });

    it('refuses a merge whose target is its own source — that pair is a wipe, not an adoption', async () => {
        // The one argument pair that would upsert every row onto itself and then delete the
        // "legacy" half: the org's whole history. Same guard the CLI carries, restated at the
        // database layer because the layer must not trust its caller.
        await expect(mergeLegacyOrg(sql, ORG, ORG, () => {})).rejects.toThrow();
    });

    it('is a localUser boot away from a usable none-mode database', async () => {
        // The offline tooling's boot: org row, stand-in account, adoption — all idempotent.
        await migrate(sql, { localUser: true, attempts: 1, log: (m) => console.log('[mig]', m) });

        expect(await store.findOrg(LOCAL_ORG_ID)).toEqual({ id: LOCAL_ORG_ID, name: LOCAL_ORG_ID });
        expect((await store.localCaller(LOCAL_ORG_ID))?.user.login).toBe(LOCAL_LOGIN);
    });
});
