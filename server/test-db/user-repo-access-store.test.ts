import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { createUserRepoAccessStore } from '../src/db/user-repo-access-store.js';

const url = process.env.DATABASE_URL;

/**
 * Same guard as the other db suites: this file truncates `user_repo_access`, and the name is the
 * only thing standing between the tests and a real database.
 */
function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(`Refusing to run: this suite truncates its tables, and "${name}" is not a test database.`);
    }
}

const enabled = Boolean(url);
if (url) assertTestDatabase(url);

let sql: Sql;
let store: ReturnType<typeof createUserRepoAccessStore>;

const ORG = 'access-test-org';
const ALICE = '00000000-0000-4000-8000-00000000c01a';
const BOB = '00000000-0000-4000-8000-00000000b0b2';

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 4 });
    await migrate(sql, { orgId: 'test-org', attempts: 3 });
    await sql`insert into organization (id, name) values (${ORG}, ${ORG}) on conflict (id) do nothing`;
    for (const [id, login, githubId] of [
        [ALICE, 'alice', 91001],
        [BOB, 'bob', 91002],
    ] as const) {
        await sql`
            insert into app_user (id, github_user_id, github_login)
            values (${id}, ${githubId}, ${login})
            on conflict (github_user_id) do update set id = excluded.id
        `;
    }
    store = createUserRepoAccessStore({ sql, orgId: ORG });
});

afterAll(async () => {
    if (enabled) await sql.end({ timeout: 5 });
});

beforeEach(async () => {
    if (enabled) await sql`truncate user_repo_access`;
});

describe.skipIf(!enabled)('the user repo access store', () => {
    it('answers null before the first computation, and an array after', async () => {
        // The distinction the whole scoping contract rides on: never-computed is unscoped, an
        // empty set is a real "nothing".
        expect(await store.repos(ALICE)).toBeNull();

        await store.setRepos(ALICE, []);
        expect(await store.repos(ALICE)).toEqual([]);
    });

    it('replaces the whole set, because the computation is total', async () => {
        await store.setRepos(ALICE, ['acme/api', 'acme/web']);
        await store.setRepos(ALICE, ['acme/api']);

        expect(await store.repos(ALICE)).toEqual(['acme/api']);
    });

    it('keeps users apart', async () => {
        await store.setRepos(ALICE, ['acme/api']);
        await store.setRepos(BOB, ['acme/web']);

        expect(await store.repos(ALICE)).toEqual(['acme/api']);
        expect(await store.repos(BOB)).toEqual(['acme/web']);
    });

    it('rows die with the account, the way every derived table here does', async () => {
        await store.setRepos(ALICE, ['acme/api']);
        await sql`delete from app_user where id = ${ALICE}`;

        expect(await store.repos(ALICE)).toBeNull();
    });
});
