import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore, type AuthStore } from '../src/auth/store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: AuthStore;

const ORG = '911001';
const SECOND_ORG = '911002';
/** Every account this file creates is numbered from here, so the cleanup can be precise. */
const ID_BASE = 90000;

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

/** Signs in as this identity, with ORG as the only installation GitHub reports. */
const member = (n = 0, login = 'octocat', installations = [{ id: ORG, name: ORG }]) =>
    store.signIn(identity(n, login), installations[0]!.id, installations);

describe.skipIf(!enabled)('access tokens: lifecycle', () => {
    const createPersonal = (caller: { user: { id: string } }, token: string, label: string) =>
        store.createAccessToken({
            kind: 'personal',
            orgId: ORG,
            userId: caller.user.id,
            createdBy: caller.user.id,
            label,
            tokenHash: hashToken(token),
        });

    it('stamps last_used_at, then holds it within the throttle window', async () => {
        // The dashboard polls every two seconds, so the touch is throttled to one rewrite a
        // minute — minute-granular "last used" in exchange for a read path that is not a write.
        const ACCOUNT_SEQ = 5;
        const caller = await member(ACCOUNT_SEQ, 'throttle');
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
        const ACCOUNT_SEQ = 6;
        const caller = await member(ACCOUNT_SEQ, 'removed');
        await createPersonal(caller, 'fat_f', 'laptop');
        await sql`update organization set installation_id = id::bigint where id in (${ORG}, ${SECOND_ORG})`;

        await store.signIn(identity(ACCOUNT_SEQ, 'removed'), SECOND_ORG, [{ id: SECOND_ORG, name: SECOND_ORG }]);

        const [row] = await sql<{ revoked_at: Date | null }[]>`
            select revoked_at from access_token where org_id = ${ORG} and label = 'laptop'
        `;
        expect(row?.revoked_at).toBeNull();
        expect(await store.findPersonalToken(hashToken('fat_f'))).toBeNull();
    });

    it('lists each scope without ever selecting a hash', async () => {
        const ACCOUNT_SEQ = 8;
        const caller = await member(ACCOUNT_SEQ, 'lister');
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
