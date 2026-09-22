import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
    BOTH_ENABLED,
    createDefaultWorkflowSettingsStore,
    type DefaultWorkflowSettingsStore,
} from '../src/db/default-workflow-settings-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: DefaultWorkflowSettingsStore;
let otherOrgStore: DefaultWorkflowSettingsStore;

const ORG = 'test-org';
const OTHER_ORG = 'other-org';
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-00000000b0b0';

const db = useTestDb({
    orgs: [ORG, OTHER_ORG],
    users: [
        { id: ALICE, githubUserId: 90001, login: 'alice' },
        { id: BOB, githubUserId: 90002, login: 'bob' },
    ],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createDefaultWorkflowSettingsStore({ sql, orgId: ORG });
    otherOrgStore = createDefaultWorkflowSettingsStore({ sql, orgId: OTHER_ORG });
});

describe.skipIf(!enabled)('the default workflow settings store', () => {
    it('answers both switches on, with a null updatedAt, for a member with no row — and inserts nothing', async () => {
        // Asserted against a literal, not the `BOTH_ENABLED` constant the store itself returns —
        // otherwise flipping that constant in the store would not fail this test.
        expect(await store.get(ALICE)).toEqual({
            reviewReconciliation: true,
            mergeConflictAutofix: true,
            updatedAt: null,
        });

        const rows = await sql<{ count: number }[]>`select count(*)::int as count from user_workflow_default`;
        expect(rows[0]!.count).toBe(0);
    });

    it.each([
        [true, true],
        [true, false],
        [false, true],
        [false, false],
    ])(
        'upserts { reviewReconciliation: %s, mergeConflictAutofix: %s } atomically and round-trips it',
        async (rr, mca) => {
            const saved = await store.put(ALICE, { reviewReconciliation: rr, mergeConflictAutofix: mca });
            expect(saved.reviewReconciliation).toBe(rr);
            expect(saved.mergeConflictAutofix).toBe(mca);
            expect(saved.updatedAt).not.toBeNull();
            expect(new Date(saved.updatedAt!).toString()).not.toBe('Invalid Date');

            expect(await store.get(ALICE)).toEqual(saved);
        }
    );

    it('replaces the row on a second write, keeping exactly one row for the member', async () => {
        const first = await store.put(ALICE, { reviewReconciliation: true, mergeConflictAutofix: true });
        const second = await store.put(ALICE, { reviewReconciliation: false, mergeConflictAutofix: true });

        expect(second).toEqual({
            reviewReconciliation: false,
            mergeConflictAutofix: true,
            updatedAt: expect.any(String),
        });
        expect(Date.parse(second.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt!));

        const rows = await sql`select * from user_workflow_default where org_id = ${ORG} and user_id = ${ALICE}`;
        expect(rows).toHaveLength(1);
    });

    it('keeps two members, and two organizations, isolated', async () => {
        await store.put(ALICE, { reviewReconciliation: false, mergeConflictAutofix: false });

        // Bob's own row in the same org is untouched.
        expect(await store.get(BOB)).toEqual(BOTH_ENABLED);

        // Alice's preference in a different organization is untouched too.
        expect(await otherOrgStore.get(ALICE)).toEqual(BOTH_ENABLED);
    });

    it('drops the row when the organization is removed', async () => {
        await store.put(ALICE, { reviewReconciliation: false, mergeConflictAutofix: false });
        await sql`delete from organization where id = ${ORG}`;

        const rows = await sql`select * from user_workflow_default where org_id = ${ORG}`;
        expect(rows).toHaveLength(0);
    });

    it('drops the row when the account is removed', async () => {
        await store.put(ALICE, { reviewReconciliation: false, mergeConflictAutofix: false });
        await sql`delete from app_user where id = ${ALICE}`;

        const rows = await sql`select * from user_workflow_default where user_id = ${ALICE}`;
        expect(rows).toHaveLength(0);
    });
});
