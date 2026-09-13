import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { createUserExecutorStore, type UserExecutorStore } from '../src/db/user-executor-store.js';

const url = process.env.DATABASE_URL;

/**
 * This suite TRUNCATES user_executor before every test. Requiring a `_test` database name is the
 * guard, because the failure is silent: the tests pass and somebody's executors are simply gone.
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
let store: UserExecutorStore;

const ORG = 'test-org';
const ALICE = '00000000-0000-4000-8000-00000000a11c';

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 4 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
    // The row is foreign-keyed to a real account, so the suite needs one.
    await sql`
        insert into app_user (id, github_user_id, github_login)
        values (${ALICE}, 90001, 'alice')
        on conflict (github_user_id) do update set id = excluded.id
    `;
    store = createUserExecutorStore({ sql, orgId: ORG });
});

afterAll(async () => {
    if (enabled) await sql.end({ timeout: 5 });
});

beforeEach(async () => {
    if (enabled) await sql`truncate user_executor`;
});

describe.skipIf(!enabled)('the user executor store', () => {
    it('accepts an opencode executor at the row', async () => {
        // 013 rewrote user_executor_type_ck to add opencode; this is the check at the row, the
        // same way user-repo-store.test.ts asserts its name rules.
        await store.replace(ALICE, [{ name: 'main', type: 'opencode', config: { model: 'x' } }]);

        expect(await store.list(ALICE)).toEqual([expect.objectContaining({ name: 'main', type: 'opencode' })]);
    });

    it('still refuses a type outside the list', async () => {
        await expect(
            sql`
                insert into user_executor (org_id, user_id, name, type, config)
                values (${ORG}, ${ALICE}, 'x', 'codex', '{}'::jsonb)
            `,
        ).rejects.toThrow(/user_executor_type_ck/);
    });

    it('answers the pasted config for a named row, and null when no row matches', async () => {
        const config = { model: 'zai-coding-plan/glm-5.3-flash', provider: { 'zai-coding-plan': {} } };
        await store.replace(ALICE, [{ name: 'main', type: 'opencode', config }]);

        expect(await store.configFor(ALICE, 'main')).toEqual({ type: 'opencode', config });
        expect(await store.configFor(ALICE, 'deleted')).toBeNull();
        // Another member's row is not this member's answer.
        expect(await store.configFor('00000000-0000-4000-8000-00000000b22d', 'main')).toBeNull();
    });
});
