import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkflowStore } from '../src/db/workflow-store.js';
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

    it('compiles a block node before storage, and refuses one that is not yet available, storing nothing', async () => {
        // Both reserved ids ship `available: false` until their own implementation issues land
        // (issue #204) — a block-referencing definition can never be stored, so it can never be
        // launched. This exercises the real, wired registry through workflow-store.ts's create(),
        // beyond workflow-block-compiler.test.ts's pure, dependency-injected coverage of the same
        // refusal.
        const created = await store.create({
            name: 'wants-a-block',
            scope: { kind: 'org' },
            definition: {
                entry: 'review',
                params: [],
                // A block never publishes itself, so a downstream publishing agent keeps the graph
                // past the NO_PUBLISH_PATH check and on to the block refusal this test is about.
                nodes: [
                    { name: 'review', kind: 'block', uses: 'builtin/github-review-reconcile' },
                    { name: 'ship', kind: 'agent', session: 'fresh', prompt: 'ship', publish: true },
                ],
                edges: [{ from: 'review', to: 'ship', when: 'succeeded' }],
            },
            createdBy: ALICE,
        });
        expect(created).toMatchObject({ refused: true, code: 'BLOCK_UNAVAILABLE' });
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
});
