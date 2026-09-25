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

    it('resolves each token into its OWN org, whatever else the account belongs to', async () => {
        // Since #99 the lookup is by the globally-unique hash and the org comes FROM the row —
        // the mint-time binding. A token minted into one org acts there and nowhere else.
        const ACCOUNT_SEQ = 4;
        const caller = await member(ACCOUNT_SEQ, 'everywhere', [
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

    it('stores the hash of the token, never the token', async () => {
        const ACCOUNT_SEQ = 7;
        const caller = await member(ACCOUNT_SEQ, 'at-rest');
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
                // The route's types forbid an ownerless token; the row must refuse it anyway, so
                // the shape is produced past the types on purpose.
                createdBy: null as unknown as string,
                label: 'ownerless',
                tokenHash: hashToken('fat_ownerless'),
            })
        ).rejects.toThrow();
    });
});
