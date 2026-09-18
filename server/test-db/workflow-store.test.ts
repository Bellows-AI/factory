import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { createWorkflowStore } from '../src/db/workflow-store.js';
import { BASE_WORKFLOW } from '../src/db/workflow-templates.js';

const url = process.env.DATABASE_URL;

/**
 * This suite TRUNCATES workflow before every test. Requiring a `_test` database name is the guard,
 * because the failure is silent: the tests pass and every stored definition — the process the
 * board walks — is simply gone.
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
let store: ReturnType<typeof createWorkflowStore>;

const ORG = 'test-org';
const ALICE = '00000000-0000-4000-8000-00000000e118';
const REPO = { owner: 'Bellows-AI', name: 'bellows.ai' };

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
    sql = postgres(url as string, { max: 4 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
    // The user scope is foreign-keyed to a real account, so the suite needs one. Other suites
    // seed the same fixed row under their own github ids, so the insert is idempotent both ways.
    await sql`
        insert into app_user (id, github_user_id, github_login)
        values (${ALICE}, 90042, 'alice')
        on conflict do nothing
    `;
    store = createWorkflowStore({ sql, orgId: ORG });
});

afterAll(async () => {
    if (enabled) await sql.end({ timeout: 5 });
});

beforeEach(async () => {
    if (enabled) await sql`truncate workflow`;
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

    it('moves the default slot within a scope and resolves it repo over user over org', async () => {
        await store.create({ name: 'org-def', scope: { kind: 'org' }, definition, isDefault: true, createdBy: ALICE });
        await store.create({
            name: 'user-def',
            scope: { kind: 'user', userId: ALICE },
            definition,
            isDefault: true,
            createdBy: ALICE,
        });
        await store.create({
            name: 'repo-def',
            scope: { kind: 'repo', ...REPO },
            definition,
            isDefault: true,
            createdBy: ALICE,
        });

        const target = { userId: ALICE, repo: `${REPO.owner}/${REPO.name}` };
        expect((await store.resolveDefault(target))?.name).toBe('repo-def');

        const noRepo = { userId: ALICE, repo: null };
        expect((await store.resolveDefault(noRepo))?.name).toBe('user-def');

        const anonymous = { userId: null, repo: null };
        expect((await store.resolveDefault(anonymous))?.name).toBe('org-def');
    });

    it('seeds the base workflow once, org-level and default, and never overwrites an edit', async () => {
        await store.seedBase();
        await store.seedBase();

        const rows = await store.listVisible({ userId: null, repo: null });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: BASE_WORKFLOW.name, scope: 'org', isDefault: true });
        expect((await store.get(rows[0]!.id))?.definition).toEqual(BASE_WORKFLOW.definition);

        await sql`update workflow set definition = '{"entry":"x","nodes":[],"edges":[]}'::jsonb where name = ${BASE_WORKFLOW.name}`;
        await store.seedBase();
        const after = await store.get(rows[0]!.id);
        expect(after?.definition).toEqual({ entry: 'x', nodes: [], edges: [] });
    });
});
