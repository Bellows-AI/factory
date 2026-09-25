import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkflowStore } from '../src/db/workflow-store.js';
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

    it('compiles the github-review-reconcile block before storage, storing the EXPANDED graph', async () => {
        // The real, wired registry through workflow-store.ts's create() — beyond
        // workflow-block-compiler.test.ts's pure, dependency-injected coverage of the same
        // compile step. A block never publishes itself, so the downstream `ship` node is what
        // keeps the graph past the NO_PUBLISH_PATH check.
        const created = await store.create({
            name: 'wants-a-block',
            scope: { kind: 'org' },
            definition: {
                entry: 'review',
                params: [],
                nodes: [
                    { name: 'review', kind: 'block', uses: 'builtin/github-review-reconcile' },
                    { name: 'ship', kind: 'agent', session: 'fresh', prompt: 'ship', publish: true },
                ],
                edges: [{ from: 'review', to: 'ship', when: 'succeeded' }],
            },
            createdBy: ALICE,
        });
        expect(created).toHaveProperty('id');

        const record = await store.get((created as { id: string }).id);
        const nodeNames = record?.definition.nodes.map((n) => n.name).sort();
        expect(nodeNames).toEqual(
            ['review--collect', 'review--wait', 'review--repair', 'review--reply', 'ship'].sort()
        );
        const waitNode = record?.definition.nodes.find((n) => n.name === 'review--wait');
        expect(waitNode?.runtime).toMatchObject({
            runtime: 'pr-delivery-wait',
            block: 'builtin/github-review-reconcile',
        });
        // The outer edge, rewritten to originate from the block's own exit node.
        expect(record?.definition.edges).toContainEqual({ from: 'review--collect', to: 'ship', when: 'succeeded' });
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

    it('updates the name and definition, and bumps updated_at', async () => {
        const created = await store.create({ name: 'walk', scope: { kind: 'org' }, definition, createdBy: ALICE });
        if (!('id' in created)) throw new Error('create was refused');
        const before = await store.get(created.id);

        const renamed = {
            ...definition,
            nodes: definition.nodes.map((n) => (n.name === 'first' ? { ...n, prompt: 'do it differently' } : n)),
        };
        const updated = await store.update(created.id, { name: 'walked', definition: renamed });
        expect(updated).toEqual({ id: created.id });

        const after = await store.get(created.id);
        expect(after?.name).toBe('walked');
        expect(after?.definition).toEqual(renamed);
        expect(after?.createdAt).toBe(before?.createdAt);
        // >= , not >: both stamps are millisecond ISO strings and the two `now()` calls are a
        // couple of local round trips apart, close enough to land in the same millisecond — the
        // same precedent `default-workflow-settings-store.test.ts` uses for the same reason.
        expect(new Date(after!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before!.updatedAt).getTime());
    });

    it('refuses a rename into a name already taken in the same scope, leaving the row unchanged', async () => {
        const a = await store.create({ name: 'alpha', scope: { kind: 'org' }, definition, createdBy: ALICE });
        const b = await store.create({ name: 'beta', scope: { kind: 'org' }, definition, createdBy: ALICE });
        if (!('id' in a) || !('id' in b)) throw new Error('create was refused');

        const result = await store.update(b.id, { name: 'alpha', definition });
        expect(result).toMatchObject({ refused: true, code: 'NAME_TAKEN' });
        expect((await store.get(b.id))?.name).toBe('beta');
    });

    it('returns notFound for an id the org does not hold', async () => {
        const result = await store.update('99999999-9999-4999-8999-999999999999', { name: 'x', definition });
        expect(result).toEqual({ notFound: true });
    });

    it('stores the expanded graph when an update carries a block definition', async () => {
        const created = await store.create({ name: 'plain', scope: { kind: 'org' }, definition, createdBy: ALICE });
        if (!('id' in created)) throw new Error('create was refused');

        const updated = await store.update(created.id, {
            name: 'plain',
            definition: {
                entry: 'review',
                params: [],
                nodes: [
                    { name: 'review', kind: 'block', uses: 'builtin/github-review-reconcile' },
                    { name: 'ship', kind: 'agent', session: 'fresh', prompt: 'ship', publish: true },
                ],
                edges: [{ from: 'review', to: 'ship', when: 'succeeded' }],
            },
        });
        expect(updated).toHaveProperty('id');
        const record = await store.get(created.id);
        expect(record?.definition.nodes.map((n) => n.name).sort()).toEqual(
            ['review--collect', 'review--wait', 'review--repair', 'review--reply', 'ship'].sort()
        );
    });

    it('refuses to rename the org-scope base workflow in place, but a rename AWAY frees the reserved name', async () => {
        await store.seedBase();
        const [base] = await store.listVisible({ userId: null, repo: null });

        // Editing the seed while keeping its name hits the same reservation `create` enforces —
        // the row is the board's, and `seedBase` would silently clobber an admin edit at the next
        // boot otherwise (docs/workflows.md).
        const inPlace = await store.update(base!.id, { name: BASE_WORKFLOW.name, definition });
        expect(inPlace).toMatchObject({ refused: true, code: 'NAME_TAKEN' });

        // Renaming it away succeeds and frees the reserved name for the next boot's reseed.
        const renamed = await store.update(base!.id, { name: 'my-fork-of-fix-issue', definition });
        expect(renamed).toEqual({ id: base!.id });
        await store.seedBase();
        const rows = await store.listVisible({ userId: null, repo: null });
        expect(rows.map((r) => r.name).sort()).toEqual([BASE_WORKFLOW.name, 'my-fork-of-fix-issue'].sort());
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
});
