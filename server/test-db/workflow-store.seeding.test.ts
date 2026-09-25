import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkflowStore } from '../src/db/workflow-store.js';
import { checkWorkflowParams } from '../src/db/workflow-schema.js';
import { BASE_WORKFLOW } from '../src/db/workflow-templates.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: ReturnType<typeof createWorkflowStore>;

const ORG = 'test-org';
const ALICE = '00000000-0000-4000-8000-00000000e118';

const db = useTestDb({ orgs: [ORG], users: [{ id: ALICE, githubUserId: 90042, login: 'alice' }] });

/** The smallest definition that passes the validator: one publish-reachable loop of two nodes. */
const definition = {
    entry: 'first',
    params: [],
    nodes: [
        { name: 'first', kind: 'agent', session: 'resume', prompt: 'do {{second.output}}' },
        { name: 'second', kind: 'agent', session: 'fresh', prompt: 'check', publish: true },
    ],
    edges: [
        { from: 'first', to: 'second', when: 'succeeded' },
        { from: 'second', to: 'first', when: { marker: 'DONE' }, max: 2 },
    ],
};

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createWorkflowStore({ sql, orgId: ORG });
});

describe.skipIf(!enabled)('the workflow store: legacy shapes and seeding', () => {
    it('normalizes a pre-030 definition — no params key — so the launch check does not throw', async () => {
        // The pre-030 jsonb shape, inserted raw: the grammar's params key does not exist yet.
        // sql.json, not a stringified parameter — postgres.js json-encodes a plain string toward
        // a ::jsonb target, storing quoted text where an object belongs.
        const legacy = sql.json({ entry: 'first', nodes: definition.nodes, edges: definition.edges });
        await sql`
            insert into workflow (org_id, name, definition)
            values (${ORG}, 'legacy', ${legacy}::jsonb)
        `;

        const resolved = await store.findByName('legacy', { userId: null, repo: null });
        expect(resolved?.definition).toEqual({ ...definition, params: [] });
        expect(() => checkWorkflowParams(resolved!.definition, undefined)).not.toThrow();
        expect(checkWorkflowParams(resolved!.definition, undefined)).toEqual({ ok: true, values: {} });
    });

    it('seeds the base workflow org-level, and refreshes a stale board-owned shape', async () => {
        await store.seedBase();
        await store.seedBase();

        const rows = await store.listVisible({ userId: null, repo: null });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: BASE_WORKFLOW.name, scope: 'org' });
        expect((await store.get(rows[0]!.id))?.definition).toEqual(BASE_WORKFLOW.definition);

        // The template is the board's, so its row tracks the board's code: a shape an older boot
        // seeded (the pre-parameter definition, say) refreshes instead of serving a stale process
        // forever.
        await sql`update workflow set definition = '{"entry":"x","nodes":[],"edges":[]}'::jsonb where name = ${BASE_WORKFLOW.name}`;
        await store.seedBase();
        const after = await store.get(rows[0]!.id);
        expect(after?.definition).toEqual(BASE_WORKFLOW.definition);

        // A member's own workflow may share the template's name; the boot never touches it.
        const mine = await store.create({
            name: BASE_WORKFLOW.name,
            scope: { kind: 'user', userId: ALICE },
            definition,
            createdBy: ALICE,
        });
        if ('refused' in mine) throw new Error('the member-scope workflow was refused');
        await sql`update workflow set definition = '{"entry":"x","nodes":[],"edges":[]}'::jsonb where id = ${mine.id}`;
        await store.seedBase();
        // Still the stale shape: the refresh's where clause names the board's own scope, and a
        // member's definition is not the boot's to correct.
        expect((await store.get(mine.id))?.definition).toEqual({ entry: 'x', nodes: [], edges: [], params: [] });
    });

    it('reserves the base workflow name in the org scope for the shipped template', async () => {
        await store.seedBase();
        const [board] = await store.listVisible({ userId: null, repo: null });

        // An admin may delete org-level workflows, and the slot is then free until the next boot:
        // the unique index no longer stands in the way, so nothing but a reservation keeps an
        // admin definition out of the one row seedBase refreshes every boot.
        await store.remove(board!.id);
        const admin = await store.create({
            name: BASE_WORKFLOW.name,
            scope: { kind: 'org' },
            definition,
            createdBy: ALICE,
        });
        expect(admin).toMatchObject({ refused: true, code: 'NAME_TAKEN' });

        // The next boot seeds the board's own template into the freed slot — and overwrites
        // nothing of the admin's, because nothing of the admin's could exist there.
        await store.seedBase();
        const rows = await store.listVisible({ userId: null, repo: null });
        expect(rows).toHaveLength(1);
        expect((await store.get(rows[0]!.id))?.definition).toEqual(BASE_WORKFLOW.definition);
    });
});
