import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkflowStore } from '../src/db/workflow-store.js';
import { checkWorkflowParams } from '../src/db/workflow-schema.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);
const MIGRATION = new URL('../migrations/057_drop_seeded_fix_issue.sql', import.meta.url);

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

describe.skipIf(!enabled)('the workflow store: legacy shapes and the retired seed', () => {
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

    it('lets an admin create an org-level `fix-issue` — the board seeds and reserves nothing', async () => {
        const admin = await store.create({ name: 'fix-issue', scope: { kind: 'org' }, definition, createdBy: ALICE });
        expect(admin).toHaveProperty('id');
        expect((await store.listVisible({ userId: null, repo: null })).map((r) => r.name)).toEqual(['fix-issue']);
    });

    it('057 deletes the org-level seeded `fix-issue` and leaves a member-scoped one', async () => {
        await sql`insert into workflow (org_id, name, definition) values (${ORG}, 'fix-issue', ${sql.json(definition as never)})`;
        const mine = await store.create({
            name: 'fix-issue',
            scope: { kind: 'user', userId: ALICE },
            definition,
            createdBy: ALICE,
        });
        if ('refused' in mine) throw new Error('the member-scope workflow was refused');

        await sql.unsafe(readFileSync(MIGRATION, 'utf8'));

        const rows = await sql<{ id: string }[]>`select id from workflow where name = 'fix-issue'`;
        expect(rows.map((r) => r.id)).toEqual([mine.id]);
    });
});
