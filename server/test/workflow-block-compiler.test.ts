import { describe, expect, it } from 'vitest';
import { EXPANDED_DEFINITION_LIMIT, type AuthoredWorkflowDefinition } from '../src/db/workflow-schema.js';
import { BLOCK_REGISTRY, blockCatalog, compileDefinition } from '../src/db/workflow-blocks/index.js';
import type { BlockDescriptor, BlockRegistry } from '../src/db/workflow-blocks/types.js';

/**
 * The compiler is wholly new logic with no coverage anywhere else (workflow-schema.test.ts stays
 * registry-unaware by design — see its own header comment). Not in the issue's literal Verification
 * list; added under AGENTS.md's "test coverage for the change" discipline.
 */

const registryOf = (...descriptors: BlockDescriptor[]): BlockRegistry => new Map(descriptors.map((d) => [d.id, d]));

/** A fake, available, two-node block: entry -> exit, entry named "work" and exit named "done". */
const fakeBlock = (id: string, overrides: Partial<BlockDescriptor> = {}): BlockDescriptor => ({
    id,
    description: `fake block ${id}`,
    configSchema: [{ name: 'label', type: 'string', description: 'a label', default: 'x' }],
    available: true,
    expand: () => ({
        nodes: [
            { name: 'work', kind: 'agent', session: 'fresh', prompt: 'do the work' },
            { name: 'done', kind: 'agent', session: 'fresh', prompt: 'wrap up {{work.output}}' },
        ],
        edges: [{ from: 'work', to: 'done', when: 'succeeded' }],
        entry: 'work',
        exit: 'done',
    }),
    ...overrides,
});

describe('compileDefinition — expansion, namespacing, edge rewriting', () => {
    it('compiles an all-agent definition to itself (identity) — no blocks, nothing to expand', () => {
        const authored: AuthoredWorkflowDefinition = {
            entry: 'a',
            params: [],
            nodes: [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true }],
            edges: [],
        };
        const result = compileDefinition(authored);
        expect(result).toMatchObject({ ok: true, definition: authored });
    });

    it('expands a block node into its subgraph, namespaced under the block node name', () => {
        const registry = registryOf(fakeBlock('fake/echo'));
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [
                { name: 'step', kind: 'block', uses: 'fake/echo' },
                { name: 'publish', kind: 'agent', session: 'resume', prompt: 'ship', publish: true },
            ],
            edges: [{ from: 'step', to: 'publish', when: 'succeeded' }],
        };
        const result = compileDefinition(authored, registry);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected compile to succeed');
        const names = result.definition.nodes.map((n) => n.name).sort();
        expect(names).toEqual(['publish', 'step--done', 'step--work'].sort());
        expect(result.definition.entry).toBe('step--work');
        // The internal placeholder reference is rewritten too, not just the node names — this is
        // what makes the rewritten edge above resolvable at all.
        expect(result.definition.nodes.find((n) => n.name === 'step--done')?.prompt).toBe(
            'wrap up {{step--work.output}}'
        );
        // The internal edge stays internal, both ends namespaced.
        expect(result.definition.edges).toContainEqual({ from: 'step--work', to: 'step--done', when: 'succeeded' });
        // The outer edge INTO the block now targets its entry; the edge OUT of it (none here) would
        // originate from its exit — proven by the next test.
        expect(result.definition.edges).toContainEqual({ from: 'step--done', to: 'publish', when: 'succeeded' });
    });

    it('rewrites an edge out of a block to originate from its exit node', () => {
        const registry = registryOf(fakeBlock('fake/echo'));
        const authored: AuthoredWorkflowDefinition = {
            entry: 'first',
            params: [],
            nodes: [
                { name: 'first', kind: 'agent', session: 'resume', prompt: 'go', gates: false },
                { name: 'step', kind: 'block', uses: 'fake/echo' },
                { name: 'publish', kind: 'agent', session: 'resume', prompt: 'ship', publish: true },
            ],
            edges: [
                { from: 'first', to: 'step', when: 'succeeded' },
                { from: 'step', to: 'publish', when: 'succeeded' },
            ],
        };
        const result = compileDefinition(authored, registry);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected compile to succeed');
        expect(result.definition.edges).toContainEqual({ from: 'first', to: 'step--work', when: 'succeeded' });
        expect(result.definition.edges).toContainEqual({ from: 'step--done', to: 'publish', when: 'succeeded' });
    });

    it('namespaces two uses of the same block collision-free, each keeping its own internal edge', () => {
        const registry = registryOf(fakeBlock('fake/echo'));
        const authored: AuthoredWorkflowDefinition = {
            entry: 'one',
            params: [],
            nodes: [
                { name: 'one', kind: 'block', uses: 'fake/echo' },
                { name: 'two', kind: 'block', uses: 'fake/echo' },
                { name: 'publish', kind: 'agent', session: 'resume', prompt: 'ship', publish: true },
            ],
            edges: [
                { from: 'one', to: 'two', when: 'succeeded' },
                { from: 'two', to: 'publish', when: 'succeeded' },
            ],
        };
        const result = compileDefinition(authored, registry);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected compile to succeed');
        const names = result.definition.nodes.map((n) => n.name).sort();
        expect(names).toEqual(['one--done', 'one--work', 'publish', 'two--done', 'two--work'].sort());
        expect(result.definition.edges).toContainEqual({ from: 'one--work', to: 'one--done', when: 'succeeded' });
        expect(result.definition.edges).toContainEqual({ from: 'two--work', to: 'two--done', when: 'succeeded' });
        expect(result.definition.edges).toContainEqual({ from: 'one--done', to: 'two--work', when: 'succeeded' });
    });

    it('re-validates the expanded graph: a block whose expansion has no publish-reachable exit refuses NO_PUBLISH_PATH', () => {
        const deadEnd = fakeBlock('fake/dead-end', {
            expand: () => ({
                nodes: [{ name: 'work', kind: 'agent', session: 'fresh', prompt: 'do work' }],
                edges: [],
                entry: 'work',
                exit: 'work',
            }),
        });
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/dead-end' }],
            edges: [],
        };
        const result = compileDefinition(authored, registryOf(deadEnd));
        expect(result).toMatchObject({ ok: false, refusal: { code: 'NO_PUBLISH_PATH' } });
    });

    it('refuses a compiled graph over EXPANDED_DEFINITION_LIMIT, naming it TOO_LARGE', () => {
        const big = fakeBlock('fake/big', {
            expand: () => ({
                nodes: [
                    { name: 'work', kind: 'agent', session: 'fresh', prompt: 'x'.repeat(EXPANDED_DEFINITION_LIMIT) },
                    { name: 'done', kind: 'agent', session: 'fresh', prompt: 'y', publish: true },
                ],
                edges: [{ from: 'work', to: 'done', when: 'succeeded' }],
                entry: 'work',
                exit: 'done',
            }),
        });
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/big' }],
            edges: [],
        };
        expect(compileDefinition(authored, registryOf(big))).toMatchObject({
            ok: false,
            refusal: { code: 'TOO_LARGE' },
        });
    });

    it('passes params through unchanged — global to the graph, referenceable from a block-adjacent prompt', () => {
        const registry = registryOf(fakeBlock('fake/echo'));
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [{ name: 'issue', pattern: '#\\d+' }],
            nodes: [
                { name: 'step', kind: 'block', uses: 'fake/echo' },
                { name: 'publish', kind: 'agent', session: 'resume', prompt: 'ship {{param.issue}}', publish: true },
            ],
            edges: [{ from: 'step', to: 'publish', when: 'succeeded' }],
        };
        const result = compileDefinition(authored, registry);
        expect(result).toMatchObject({ ok: true, definition: { params: [{ name: 'issue', pattern: '#\\d+' }] } });
    });

    it('gives the reserved {{gate.*}}/{{command}}/{{param.*}} specs precedence over a same-named internal node', () => {
        // A block whose own internal node happens to be named "gate" must not hijack the reserved
        // `{{gate.output}}` placeholder — the completed run's first failed gate always wins, the
        // same precedence interpolate() itself gives these specs.
        const withGateNamedNode = fakeBlock('fake/gate-named', {
            expand: () => ({
                nodes: [
                    { name: 'gate', kind: 'agent', session: 'fresh', prompt: 'investigate {{gate.output}}' },
                    { name: 'done', kind: 'agent', session: 'fresh', prompt: 'wrap up', publish: true },
                ],
                edges: [{ from: 'gate', to: 'done', when: 'gate-failed' }],
                entry: 'gate',
                exit: 'done',
            }),
        });
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/gate-named' }],
            edges: [],
        };
        const result = compileDefinition(authored, registryOf(withGateNamedNode));
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected compile to succeed');
        // NOT rewritten to {{step--gate.output}} — the reserved spec passes through untouched.
        expect(result.definition.nodes.find((n) => n.name === 'step--gate')?.prompt).toBe(
            'investigate {{gate.output}}'
        );
    });
});

describe('compileDefinition — block config', () => {
    it('resolves declared config against the descriptor configSchema, applying defaults', () => {
        let seenConfig: unknown;
        const configured = fakeBlock('fake/configured', {
            expand: (_name, config) => {
                seenConfig = config;
                return {
                    nodes: [{ name: 'work', kind: 'agent', session: 'fresh', prompt: 'x', publish: true }],
                    edges: [],
                    entry: 'work',
                    exit: 'work',
                };
            },
        });
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/configured', with: { label: 'custom' } }],
            edges: [],
        };
        const result = compileDefinition(authored, registryOf(configured));
        expect(result.ok).toBe(true);
        expect(seenConfig).toEqual({ label: 'custom' });
    });

    it('applies the configSchema default when a field is not declared in `with`', () => {
        let seenConfig: unknown;
        const configured = fakeBlock('fake/configured', {
            expand: (_name, config) => {
                seenConfig = config;
                return {
                    nodes: [{ name: 'work', kind: 'agent', session: 'fresh', prompt: 'x', publish: true }],
                    edges: [],
                    entry: 'work',
                    exit: 'work',
                };
            },
        });
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/configured' }],
            edges: [],
        };
        compileDefinition(authored, registryOf(configured));
        expect(seenConfig).toEqual({ label: 'x' });
    });

    it('refuses an unknown config key, named, without calling expand', () => {
        let called = false;
        const configured = fakeBlock('fake/configured', {
            expand: () => {
                called = true;
                throw new Error('must not be called');
            },
        });
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/configured', with: { nope: 1 } }],
            edges: [],
        };
        const result = compileDefinition(authored, registryOf(configured));
        expect(result).toMatchObject({ ok: false, refusal: { code: 'BAD_BLOCK_CONFIG' } });
        expect(called).toBe(false);
    });

    it('refuses a config value of the wrong declared type', () => {
        const configured = fakeBlock('fake/configured');
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/configured', with: { label: 42 } }],
            edges: [],
        };
        expect(compileDefinition(authored, registryOf(configured))).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_BLOCK_CONFIG' },
        });
    });

    it('refuses a numeric config value outside the declared min/max', () => {
        const bounded = fakeBlock('fake/bounded', {
            configSchema: [{ name: 'maxRounds', type: 'number', description: 'rounds', default: 3, min: 1, max: 10 }],
        });
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/bounded', with: { maxRounds: 99 } }],
            edges: [],
        };
        expect(compileDefinition(authored, registryOf(bounded))).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_BLOCK_CONFIG' },
        });
    });

    it("refuses a descriptor's own default when it falls outside that same field's declared bounds", () => {
        // A default is resolved through the same check as an authored value — a descriptor bug
        // (a default outside its own min/max) must refuse loudly, not ship unvalidated.
        const buggyDefault = fakeBlock('fake/buggy-default', {
            configSchema: [{ name: 'maxRounds', type: 'number', description: 'rounds', default: 99, min: 1, max: 10 }],
        });
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/buggy-default' }],
            edges: [],
        };
        expect(compileDefinition(authored, registryOf(buggyDefault))).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_BLOCK_CONFIG' },
        });
    });
});

describe('compileDefinition — unknown and unavailable blocks', () => {
    it('refuses an unknown block id, named, without calling expand', () => {
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/does-not-exist' }],
            edges: [],
        };
        expect(compileDefinition(authored, registryOf(fakeBlock('fake/echo')))).toMatchObject({
            ok: false,
            refusal: { code: 'UNKNOWN_BLOCK' },
        });
    });

    it('refuses an unavailable block without ever calling expand', () => {
        let called = false;
        const unavailable = fakeBlock('fake/unavailable', {
            available: false,
            expand: () => {
                called = true;
                throw new Error('must not be called');
            },
        });
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'fake/unavailable' }],
            edges: [],
        };
        const result = compileDefinition(authored, registryOf(unavailable));
        expect(result).toMatchObject({ ok: false, refusal: { code: 'BLOCK_UNAVAILABLE' } });
        expect(called).toBe(false);
    });
});

describe('the real, shipped registry', () => {
    it('lists both reserved ids as unavailable, with a catalog-facing description and configSchema', () => {
        const catalog = blockCatalog();
        expect(catalog.map((b) => b.id).sort()).toEqual(
            ['builtin/github-review-reconcile', 'builtin/merge-conflict-autofix'].sort()
        );
        for (const entry of catalog) {
            expect(entry.available).toBe(false);
            expect(typeof entry.description).toBe('string');
            expect(entry.description.length).toBeGreaterThan(0);
            expect(Array.isArray(entry.configSchema)).toBe(true);
            expect(entry).not.toHaveProperty('expand');
        }
    });

    it('refuses BLOCK_UNAVAILABLE for both reserved ids against the real registry — unavailable blocks cannot launch', () => {
        for (const uses of ['builtin/github-review-reconcile', 'builtin/merge-conflict-autofix']) {
            const authored: AuthoredWorkflowDefinition = {
                entry: 'step',
                params: [],
                nodes: [{ name: 'step', kind: 'block', uses }],
                edges: [],
            };
            expect(compileDefinition(authored, BLOCK_REGISTRY)).toMatchObject({
                ok: false,
                refusal: { code: 'BLOCK_UNAVAILABLE' },
            });
        }
    });

    it('refuses UNKNOWN_BLOCK for an id the registry never reserved', () => {
        const authored: AuthoredWorkflowDefinition = {
            entry: 'step',
            params: [],
            nodes: [{ name: 'step', kind: 'block', uses: 'builtin/does-not-exist' }],
            edges: [],
        };
        expect(compileDefinition(authored, BLOCK_REGISTRY)).toMatchObject({
            ok: false,
            refusal: { code: 'UNKNOWN_BLOCK' },
        });
    });

    it('compiles with the default (real) registry when none is passed explicitly', () => {
        const authored: AuthoredWorkflowDefinition = {
            entry: 'a',
            params: [],
            nodes: [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true }],
            edges: [],
        };
        expect(compileDefinition(authored)).toMatchObject({ ok: true });
    });
});
