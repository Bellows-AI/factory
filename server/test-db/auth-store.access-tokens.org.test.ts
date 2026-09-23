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

describe.skipIf(!enabled)('access tokens: org-scoped', () => {
    const createPersonal = (caller: { user: { id: string } }, token: string, label: string) =>
        store.createAccessToken({
            kind: 'personal',
            orgId: ORG,
            userId: caller.user.id,
            createdBy: caller.user.id,
            label,
            tokenHash: hashToken(token),
        });

    it('refuses a revoked token, of either kind', async () => {
        const ACCOUNT_SEQ = 3;
        const caller = await member(ACCOUNT_SEQ, 'revoker');
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

    it('answers an org token with its identity AND its org', async () => {
        const ACCOUNT_SEQ = 9;
        const caller = await member(ACCOUNT_SEQ, 'org-minter');
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
        const ACCOUNT_SEQ = 12;
        const minter = await member(ACCOUNT_SEQ, 'org-leaver');
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
        const ACCOUNT_SEQ = 13;
        const minter = await member(ACCOUNT_SEQ, 'org-outsider', [{ id: SECOND_ORG, name: SECOND_ORG }]);
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
});
