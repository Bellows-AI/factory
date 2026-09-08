import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import {
    createEnvVarStore,
    stackEnv,
    type EnvVarStore,
} from '../src/db/env-var-store.js';

const url = process.env.DATABASE_URL;

/**
 * This suite TRUNCATES env_var before every test. Requiring a `_test` database name is the guard,
 * because the failure is silent: the tests pass and somebody's configured environment — secrets
 * included — is simply gone.
 */
function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(
            `Refusing to run: this suite truncates its tables, and "${name}" is not a test database.`,
        );
    }
}

const enabled = Boolean(url);
if (url) assertTestDatabase(url);

let sql: Sql;
let store: EnvVarStore;

const ORG = 'test-org';
const ALICE = '00000000-0000-4000-8000-00000000e117';
const REPO = { owner: 'Bellows-AI', name: 'bellows.ai' };

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 4 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
    // The workspace scope is foreign-keyed to a real account, so the suite needs one.
    await sql`
        insert into app_user (id, github_user_id, github_login)
        values (${ALICE}, 90017, 'alice')
        on conflict (github_user_id) do update set id = excluded.id
    `;
    store = createEnvVarStore({ sql, orgId: ORG });
});

afterAll(async () => {
    if (enabled) await sql.end({ timeout: 5 });
});

beforeEach(async () => {
    if (enabled) await sql`truncate env_var`;
});

describe.skipIf(!enabled)('the env var store', () => {
    it('replaces a scope whole, so replaying the same body changes nothing', async () => {
        await store.replaceOrg([{ name: 'FIRST', value: '1', isSecret: false }]);
        await store.replaceOrg([{ name: 'SECOND', value: '2', isSecret: false }]);
        await store.replaceOrg([{ name: 'SECOND', value: '2', isSecret: false }]);

        const rows = await store.listOrg();
        expect(rows.map((row) => row.name)).toEqual(['SECOND']);
    });

    it('keeps a secret whose incoming value is null, and deletes one whose name is omitted', async () => {
        await store.replaceOrg([
            { name: 'SECRET_A', value: 'a', isSecret: true },
            { name: 'SECRET_B', value: 'b', isSecret: true },
            { name: 'PLAIN', value: 'p', isSecret: false },
        ]);

        // SECRET_B is omitted entirely — deleted. SECRET_A is sent back with a null value — kept.
        await store.replaceOrg([
            { name: 'SECRET_A', value: null, isSecret: true },
            { name: 'PLAIN', value: 'p2', isSecret: false },
        ]);

        const rows = await store.listOrg();
        expect(rows.map((row) => row.name).sort()).toEqual(['PLAIN', 'SECRET_A']);
    });

    it('never echoes a secret value from list, but resolveFor returns it', async () => {
        await store.replaceOrg([
            { name: 'SECRET', value: 's3cr3t', isSecret: true },
            { name: 'PLAIN', value: 'visible', isSecret: false },
        ]);

        const rows = await store.listOrg();
        expect(rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'SECRET', value: null, isSecret: true }),
                expect.objectContaining({ name: 'PLAIN', value: 'visible', isSecret: false }),
            ]),
        );

        const resolved = await store.resolveFor({ userId: null, repo: null });
        expect(resolved).toEqual({ SECRET: 's3cr3t', PLAIN: 'visible' });
    });

    it('stacks org under workspace under repo, the more specific winning', async () => {
        await store.replaceOrg([{ name: 'LEVEL', value: 'org', isSecret: false }, { name: 'ONLY_ORG', value: 'o', isSecret: false }]);
        await store.replaceWorkspace(ALICE, [{ name: 'LEVEL', value: 'workspace', isSecret: false }]);
        await store.replaceRepo(REPO.owner, REPO.name, [
            { name: 'LEVEL', value: 'repo', isSecret: false },
            { name: 'ONLY_REPO', value: 'r', isSecret: false },
        ]);

        // All three contribute, repo winning the collision.
        expect(await store.resolveFor({ userId: ALICE, repo: `${REPO.owner}/${REPO.name}` })).toEqual({
            ONLY_ORG: 'o',
            ONLY_REPO: 'r',
            LEVEL: 'repo',
        });

        // A job with no repo label gets org + workspace only.
        expect(await store.resolveFor({ userId: ALICE, repo: null })).toEqual({
            ONLY_ORG: 'o',
            LEVEL: 'workspace',
        });

        // An unattributed job gets the org level alone.
        expect(await store.resolveFor({ userId: null, repo: null })).toEqual({
            ONLY_ORG: 'o',
            LEVEL: 'org',
        });
    });

    it('groups the repo scopes for the page', async () => {
        await store.replaceRepo(REPO.owner, REPO.name, [{ name: 'R', value: '1', isSecret: false }]);
        // Created with its real value, then echoed without it — the write-only contract.
        await store.replaceRepo('Other', 'repo', [{ name: 'S', value: 'hidden', isSecret: true }]);

        const repos = await store.listRepos();
        expect(repos).toEqual([
            { owner: 'Bellows-AI', name: 'bellows.ai', vars: [expect.objectContaining({ name: 'R', value: '1' })] },
            { owner: 'Other', name: 'repo', vars: [expect.objectContaining({ name: 'S', value: null, isSecret: true })] },
        ]);
    });

    it('refuses a row that is both user- and repo-scoped, at the row', async () => {
        await expect(
            sql`
                insert into env_var (org_id, user_id, repo_owner, repo_name, name, value)
                values (${ORG}, ${ALICE}, 'Bellows-AI', 'bellows.ai', 'X', '1')
            `,
        ).rejects.toThrow(/env_var_scope_ck/);
    });

    it('refuses a name that is not a legal environment variable name, at the row', async () => {
        await expect(
            sql`
                insert into env_var (org_id, user_id, repo_owner, repo_name, name, value)
                values (${ORG}, null, null, null, 'not a name', '1')
            `,
        ).rejects.toThrow(/env_var_name_ck/);
    });
});

describe('stackEnv', () => {
    it('merges three scopes, most specific winning on collisions', () => {
        expect(
            stackEnv({ A: 'org', B: 'org' }, { B: 'workspace', C: 'workspace' }, { C: 'repo', D: 'repo' }),
        ).toEqual({ A: 'org', B: 'workspace', C: 'repo', D: 'repo' });
    });
});
