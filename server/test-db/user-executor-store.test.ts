import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createUserExecutorStore, type UserExecutorStore } from '../src/db/user-executor-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: UserExecutorStore;

const ORG = 'test-org';
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-00000000b0b0';

const db = useTestDb({
    orgs: [ORG],
    users: [
        { id: ALICE, githubUserId: 90001, login: 'alice' },
        { id: BOB, githubUserId: 90002, login: 'bob' },
    ],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createUserExecutorStore({ sql, orgId: ORG });
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
            `
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

    it('stores and lists isDefault', async () => {
        await store.replace(ALICE, [
            { name: 'main', type: 'claude-code', config: {} },
            { name: 'heavy', type: 'claude-code', config: {}, isDefault: true },
        ]);

        expect(await store.list(ALICE)).toEqual([
            expect.objectContaining({ name: 'main', isDefault: false }),
            expect.objectContaining({ name: 'heavy', isDefault: true }),
        ]);
    });

    it('refuses a second default for one member — the partial unique index', async () => {
        await sql`
            insert into user_executor (org_id, user_id, name, type, config, is_default)
            values (${ORG}, ${ALICE}, 'main', 'claude-code', '{}'::jsonb, true)
        `;
        await expect(
            sql`
                insert into user_executor (org_id, user_id, name, type, config, is_default)
                values (${ORG}, ${ALICE}, 'heavy', 'claude-code', '{}'::jsonb, true)
            `
        ).rejects.toThrow(/user_executor_one_default_uk/);
    });

    it('lets two members each hold their own default', async () => {
        await store.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {}, isDefault: true }]);
        await store.replace(BOB, [{ name: 'main', type: 'claude-code', config: {}, isDefault: true }]);

        expect(await store.list(ALICE)).toEqual([expect.objectContaining({ name: 'main', isDefault: true })]);
        expect(await store.list(BOB)).toEqual([expect.objectContaining({ name: 'main', isDefault: true })]);
    });
});
