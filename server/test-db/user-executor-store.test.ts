import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
    createUserExecutorStore,
    type ExecutorDefault,
    type UserExecutorStore,
} from '../src/db/user-executor-store.js';
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
                insert into executor_profile (org_id, user_id, name, type, config)
                values (${ORG}, ${ALICE}, 'x', 'codex', '{}'::jsonb)
            `
        ).rejects.toThrow(/user_executor_type_ck/);
    });

    it('answers the pasted config for a named row, and null when no row matches', async () => {
        const config = { model: 'zai-coding-plan/glm-5.3-flash', provider: { 'zai-coding-plan': {} } };
        await store.replace(ALICE, [{ name: 'main', type: 'opencode', config }]);

        expect(await store.configFor(ALICE, 'main')).toEqual({
            type: 'opencode',
            config,
            gateFixRounds: 3,
        });
        expect(await store.configFor(ALICE, 'deleted')).toBeNull();
        // Another member's row is not this member's answer.
        expect(await store.configFor('00000000-0000-4000-8000-00000000b22d', 'main')).toBeNull();
    });

    it('stores and lists gateFixRounds, the column default filling an omitted value', async () => {
        await store.replace(ALICE, [
            { name: 'main', type: 'claude-code', config: {} },
            { name: 'heavy', type: 'claude-code', config: {}, gateFixRounds: 7 },
        ]);

        expect(await store.list(ALICE)).toEqual([
            expect.objectContaining({ name: 'main', gateFixRounds: 3 }),
            expect.objectContaining({ name: 'heavy', gateFixRounds: 7 }),
        ]);
        expect(await store.listWithConfigs(ALICE)).toEqual([
            expect.objectContaining({ name: 'main', gateFixRounds: 3 }),
            expect.objectContaining({ name: 'heavy', gateFixRounds: 7 }),
        ]);
        // The claim-time read carries it too, though the claim itself ignores it — the default
        // workflow's round limit freezes onto the thread at launch, never at claim.
        expect(await store.configFor(ALICE, 'heavy')).toEqual({
            type: 'claude-code',
            config: {},
            gateFixRounds: 7,
        });
    });

    it('refuses a gate_fix_rounds outside 0..10 at the row', async () => {
        for (const rounds of [-1, 11]) {
            await expect(
                sql`
                    insert into executor_profile (org_id, user_id, name, type, config, gate_fix_rounds)
                    values (${ORG}, ${ALICE}, 'main', 'claude-code', '{}'::jsonb, ${rounds})
                `
            ).rejects.toThrow(/user_executor_gate_fix_rounds_ck/);
        }
    });

    /**
     * The list comes back in the order it was saved, and that is a stored `position` (041), not an
     * inference. It used to be inferred from `created_at asc, name asc`, which could never work:
     * `replace` is one transaction, postgres' `now()` is the transaction's start time, so every row
     * of a save carries the same created_at and the name tiebreak always decides. The list was
     * alphabetical whatever the member arranged — and the composer autoselects the resolved
     * default's first fallback, so the alphabetically-first row was the one new tasks silently ran
     * with.
     *
     * Saved deliberately in reverse alphabetical order: under the old ORDER BY this case comes back
     * exactly backwards, so it fails loudly rather than passing by coincidence.
     */
    it('lists in the order the member saved, not alphabetically', async () => {
        await store.replace(ALICE, [
            { name: 'zulu', type: 'claude-code', config: {} },
            { name: 'mike', type: 'claude-code', config: {} },
            { name: 'alpha', type: 'claude-code', config: {} },
        ]);

        expect((await store.list(ALICE)).map((executor) => executor.name)).toEqual(['zulu', 'mike', 'alpha']);
        // The edit dialog's read is the same list, so it must agree — it had its own copy of the
        // ORDER BY, and a fix to one that missed the other would reorder the dialog alone.
        expect((await store.listWithConfigs(ALICE)).map((executor) => executor.name)).toEqual([
            'zulu',
            'mike',
            'alpha',
        ]);
    });

    it('keys every personal row with a surrogate id that survives until the next replace', async () => {
        await store.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);

        const rows = await store.list(ALICE);
        expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe.skipIf(!enabled)('organization-scoped executor profiles (issue 391)', () => {
    it('stores an org-scope row and lists it apart from any member’s personal rows', async () => {
        const created = await store.createOrg({
            name: 'team-runner',
            type: 'claude-code',
            config: { model: 'claude-sonnet-4-5' },
            createdBy: ALICE,
        });
        expect(created).toEqual(
            expect.objectContaining({ name: 'team-runner', type: 'claude-code', createdBy: ALICE })
        );
        expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

        const orgRows = await store.listOrg();
        expect(orgRows.map((row) => row.name)).toEqual(['team-runner']);
        // The org row belongs to the organization, not to its creator: it appears in no member's
        // personal list.
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual([]);
        expect((await store.list(BOB)).map((row) => row.name)).toEqual([]);
        // The creator is an audit fact, not an ownership: another admin may edit or delete it.
        expect((await store.listOrgWithConfigs())[0]).toEqual(
            expect.objectContaining({ name: 'team-runner', createdBy: ALICE, config: { model: 'claude-sonnet-4-5' } })
        );
    });

    it('allows the same name in both scopes and refuses a duplicate within one scope', async () => {
        await store.createOrg({ name: 'main', type: 'claude-code', config: {}, createdBy: ALICE });
        // The personal scope is a different ownership: the same name coexists.
        await store.replace(ALICE, [{ name: 'main', type: 'opencode', config: { model: 'personal' } }]);

        await expect(
            store.createOrg({ name: 'main', type: 'claude-code', config: {}, createdBy: ALICE })
        ).rejects.toThrow(/executor_profile_name_uk/);
        // Within the personal scope the owner is the uniqueness: ALICE cannot hold 'main' twice,
        // while BOB's own 'main' is a different ownership and stays legal.
        await expect(
            sql`
                insert into executor_profile (org_id, user_id, name, type, config)
                values (${ORG}, ${ALICE}, 'main', 'claude-code', '{}'::jsonb)
            `
        ).rejects.toThrow(/executor_profile_name_uk/);
        await store.replace(BOB, [{ name: 'main', type: 'claude-code', config: {} }]);
    });

    it('resolves configFor in the stamped scope only — same name, two rows, no silent switch', async () => {
        await store.replace(ALICE, [{ name: 'main', type: 'opencode', config: { model: 'personal' } }]);
        await store.createOrg({ name: 'main', type: 'claude-code', config: { model: 'shared' }, createdBy: ALICE });

        expect((await store.configFor(ALICE, 'main', 'user'))?.config).toEqual({ model: 'personal' });
        expect((await store.configFor(ALICE, 'main', 'org'))?.config).toEqual({ model: 'shared' });
        // The org row resolves for ANY member of the organization — that is the feature.
        expect((await store.configFor(BOB, 'main', 'org'))?.config).toEqual({ model: 'shared' });
        // A personal row never resolves for another member, whatever its name.
        expect(await store.configFor(BOB, 'main', 'user')).toBeNull();
    });

    it('replaces only the caller’s personal rows; org rows survive a personal PUT', async () => {
        await store.createOrg({ name: 'shared', type: 'claude-code', config: { model: 'shared' }, createdBy: ALICE });
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);

        await store.replace(ALICE, [{ name: 'other', type: 'claude-code', config: {} }]);

        expect((await store.list(ALICE)).map((row) => row.name)).toEqual(['other']);
        expect((await store.listOrg()).map((row) => row.name)).toEqual(['shared']);
    });

    it('edits, renames and deletes an org row by id, and counts them for the cap', async () => {
        const created = await store.createOrg({
            name: 'team',
            type: 'claude-code',
            config: {},
            createdBy: ALICE,
        });

        const renamed = await store.updateOrg(created.id, { name: 'team-runner', config: { model: 'm' } });
        expect(renamed).toEqual(expect.objectContaining({ name: 'team-runner', config: { model: 'm' } }));

        const rows = await store.listOrg();
        expect(rows.map((row) => row.name)).toEqual(['team-runner']);
        expect(await store.orgCount()).toBe(1);

        expect(await store.deleteOrg(created.id)).toBe(true);
        expect(await store.orgCount()).toBe(0);
        expect(await store.deleteOrg(created.id)).toBe(false);
    });

    it('updateOrg answers null for an id that is not an org row of this organization', async () => {
        await store.replace(ALICE, [{ name: 'personal', type: 'claude-code', config: {} }]);
        const personal = (await store.listWithConfigs(ALICE))[0]!;
        // A personal row is not addressable through the org CRUD surface — the scopes are
        // different ownerships, and the route layer only ever sends org ids here.
        expect(await store.updateOrg(personal.id, { name: 'hijack' })).toBeNull();
        expect(await store.deleteOrg(personal.id)).toBe(false);
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual(['personal']);
    });

    it('promotes the caller’s own personal row to org scope and demotes back', async () => {
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: { model: 'm' } }]);
        const personal = (await store.list(ALICE))[0]!;

        const promoted = await store.changeScope(personal.id, 'org', ALICE);
        expect(promoted).toEqual(expect.objectContaining({ name: 'mine', createdBy: ALICE }));
        expect((await store.listOrg()).map((row) => row.name)).toEqual(['mine']);
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual([]);

        const orgRow = (await store.listOrg())[0]!;
        const demoted = await store.changeScope(orgRow.id, 'user', ALICE);
        expect(demoted).toEqual(expect.objectContaining({ name: 'mine' }));
        expect((await store.listOrg()).map((row) => row.name)).toEqual([]);
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual(['mine']);
    });

    it('changeScope only moves the caller’s own personal row up', async () => {
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);
        await store.replace(BOB, [{ name: 'theirs', type: 'claude-code', config: {} }]);
        const aliceRow = (await store.list(ALICE))[0]!;
        const bobRow = (await store.list(BOB))[0]!;

        // Alice cannot promote Bob's row through the scope route — and Bob's row is untouched.
        expect(await store.changeScope(bobRow.id, 'org', ALICE)).toBeNull();
        expect((await store.list(BOB)).map((row) => row.name)).toEqual(['theirs']);
        expect(await store.changeScope(aliceRow.id, 'org', ALICE)).not.toBeNull();
    });

    it('refuses a scope change whose target name is taken in that scope', async () => {
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);
        await store.createOrg({ name: 'mine', type: 'claude-code', config: {}, createdBy: ALICE });
        const personal = (await store.list(ALICE))[0]!;

        // The org scope already holds "mine" — promoting would collide with the name index.
        await expect(store.changeScope(personal.id, 'org', ALICE)).rejects.toThrow(/executor_profile_name_uk/);
        // Nothing moved.
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual(['mine']);
    });
});

describe.skipIf(!enabled)('the per-user default preference (issue 391)', () => {
    const pref = (scope: ExecutorDefault['scope'], name: string): ExecutorDefault => ({ scope, name });

    it('stores one preference per member and reads it back', async () => {
        await store.createOrg({ name: 'shared', type: 'claude-code', config: {}, createdBy: ALICE });
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);

        await store.setDefault(ALICE, pref('org', 'shared'));
        expect(await store.defaultOf(ALICE)).toEqual(pref('org', 'shared'));
        // Per-user: Alice's preference never becomes Bob's.
        expect(await store.defaultOf(BOB)).toBeNull();

        await store.setDefault(ALICE, pref('user', 'mine'));
        expect(await store.defaultOf(ALICE)).toEqual(pref('user', 'mine'));
    });

    it('refuses a preference naming no accessible profile in that scope', async () => {
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);
        await expect(store.setDefault(ALICE, pref('user', 'ghost'))).rejects.toThrow();
        await expect(store.setDefault(ALICE, pref('org', 'ghost'))).rejects.toThrow();
        // The preference row was not written by either refusal.
        expect(await store.defaultOf(ALICE)).toBeNull();
    });

    it('falls back deterministically: stored preference, first personal row, first org row, null', async () => {
        await store.createOrg({ name: 'org-a', type: 'claude-code', config: {}, createdBy: ALICE });
        await store.createOrg({ name: 'org-b', type: 'claude-code', config: {}, createdBy: ALICE });
        await store.replace(ALICE, [
            { name: 'zulu', type: 'claude-code', config: {} },
            { name: 'alpha', type: 'claude-code', config: {} },
        ]);

        // No preference: first personal row by position, then first org row by position.
        expect(await store.resolvedDefault(ALICE)).toEqual(pref('user', 'zulu'));
        expect(await store.resolvedDefault(BOB)).toEqual(pref('org', 'org-a'));

        // A stored preference wins while it still resolves — either scope.
        await store.setDefault(ALICE, pref('org', 'org-b'));
        expect(await store.resolvedDefault(ALICE)).toEqual(pref('org', 'org-b'));

        // The preferred profile is removed: the chain answers from what remains.
        const orgB = (await store.listOrg()).find((row) => row.name === 'org-b')!;
        await store.deleteOrg(orgB.id);
        expect(await store.resolvedDefault(ALICE)).toEqual(pref('user', 'zulu'));

        await store.replace(ALICE, []);
        expect(await store.resolvedDefault(ALICE)).toEqual(pref('org', 'org-a'));

        const orgA = (await store.listOrg()).find((row) => row.name === 'org-a')!;
        await store.deleteOrg(orgA.id);
        expect(await store.resolvedDefault(ALICE)).toBeNull();
    });

    it('keeps the old personal default shape working: replace() no longer takes a flag', async () => {
        // 040's is_default column is gone; the preference is the whole mechanism now.
        const columns = await sql<{ column_name: string }[]>`
            select column_name from information_schema.columns
            where table_name = 'executor_profile'
        `;
        expect(columns.map((c) => c.column_name)).not.toContain('is_default');
    });
});
