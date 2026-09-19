import { beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
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
const REPO = { owner: 'Bellows-AI', name: 'bellows.ai' };

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

describe.skipIf(!enabled)('the workflow store', () => {
    it('stores a well-formed definition and serves it back verbatim', async () => {
        const created = await store.create({
            name: 'walk',
            scope: { kind: 'org' },
            definition,
            createdBy: ALICE,
        });
        expect(created).toHaveProperty('id');

        const record = await store.get((created as { id: string }).id);
        expect(record?.name).toBe('walk');
        expect(record?.scope).toBe('org');
        expect(record?.definition).toEqual(definition);
    });

    it('refuses an unknown key, naming it, and stores nothing', async () => {
        const created = await store.create({
            name: 'foreign',
            scope: { kind: 'org' },
            definition: { ...definition, trigger: 'on-push' },
            createdBy: ALICE,
        });
        expect(created).toMatchObject({ refused: true, code: 'UNKNOWN_KEY' });
        expect(await store.listVisible({ userId: null, repo: null })).toEqual([]);
    });

    it('refuses an edge naming an undeclared node, and a template referencing one', async () => {
        const badEdge = await store.create({
            name: 'dangling',
            scope: { kind: 'org' },
            definition: { ...definition, edges: [{ from: 'first', to: 'ghost', when: 'succeeded' }] },
            createdBy: ALICE,
        });
        expect(badEdge).toMatchObject({ refused: true, code: 'UNKNOWN_NODE' });

        const badPlaceholder = await store.create({
            name: 'ghosted',
            scope: { kind: 'org' },
            definition: {
                ...definition,
                nodes: definition.nodes.map((node) =>
                    node.name === 'first' ? { ...node, prompt: 'see {{ghost.output}}' } : node
                ),
            },
            createdBy: ALICE,
        });
        expect(badPlaceholder).toMatchObject({ refused: true, code: 'UNKNOWN_PLACEHOLDER' });
    });

    it('refuses a graph with no reachable publish node', async () => {
        const created = await store.create({
            name: 'exitless',
            scope: { kind: 'org' },
            definition: { ...definition, nodes: definition.nodes.map((n) => ({ ...n, publish: false })) },
            createdBy: ALICE,
        });
        expect(created).toMatchObject({ refused: true, code: 'NO_PUBLISH_PATH' });
    });

    it('keeps names unique per scope, and free again in a sibling scope', async () => {
        const first = await store.create({ name: 'walk', scope: { kind: 'org' }, definition, createdBy: ALICE });
        expect(first).toHaveProperty('id');

        const clash = await store.create({ name: 'walk', scope: { kind: 'org' }, definition, createdBy: ALICE });
        expect(clash).toMatchObject({ refused: true, code: 'NAME_TAKEN' });

        const userScope = await store.create({
            name: 'walk',
            scope: { kind: 'user', userId: ALICE },
            definition,
            createdBy: ALICE,
        });
        expect(userScope).toHaveProperty('id');
        const repoScope = await store.create({
            name: 'walk',
            scope: { kind: 'repo', ...REPO },
            definition,
            createdBy: ALICE,
        });
        expect(repoScope).toHaveProperty('id');
    });

    it('lists only what the caller can see: org, own user level, and the requested repo', async () => {
        await store.create({ name: 'org-wf', scope: { kind: 'org' }, definition, createdBy: ALICE });
        await store.create({ name: 'user-wf', scope: { kind: 'user', userId: ALICE }, definition, createdBy: ALICE });
        await store.create({ name: 'repo-wf', scope: { kind: 'repo', ...REPO }, definition, createdBy: ALICE });
        await store.create({
            name: 'other-repo-wf',
            scope: { kind: 'repo', owner: 'Other', name: 'repo' },
            definition,
            createdBy: ALICE,
        });

        const alice = await store.listVisible({ userId: ALICE, repo: `${REPO.owner}/${REPO.name}` });
        expect(alice.map((row) => row.name).sort()).toEqual(['org-wf', 'repo-wf', 'user-wf']);

        const someoneElse = await store.listVisible({ userId: '00000000-0000-4000-8000-00000000e999', repo: null });
        expect(someoneElse.map((row) => row.name)).toEqual(['org-wf']);
    });

    it('carries the declared params on the list summaries, for the composer to render inputs', async () => {
        await store.create({
            name: 'parammed',
            scope: { kind: 'org' },
            definition: { ...definition, params: [{ name: 'issue', pattern: '#\\d+' }] },
            createdBy: ALICE,
        });
        await store.create({ name: 'paramless', scope: { kind: 'org' }, definition, createdBy: ALICE });

        const listed = await store.listVisible({ userId: null, repo: null });
        expect(listed).toHaveLength(2);
        expect(listed.find((row) => row.name === 'parammed')).toMatchObject({
            params: [{ name: 'issue', pattern: '#\\d+' }],
        });
        expect(listed.find((row) => row.name === 'paramless')).toMatchObject({ params: [] });
    });

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
