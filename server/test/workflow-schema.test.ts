import { describe, expect, it } from 'vitest';
import { DEFINITION_LIMIT, EXPANDED_DEFINITION_LIMIT } from '../src/db/workflow-schema.js';
import { validateDefinition } from '../src/db/workflow-schema-validate.js';

/**
 * Grammar-level coverage for the `kind: "block"` node (issue #204): the authored shape a workflow
 * may reference a board-owned, allowlisted block with. Registry lookup, availability and expansion
 * are NOT this module's concern — workflow-schema.ts stays registry-unaware, so these tests only
 * pin the structural grammar. Compiler behavior lives in workflow-block-compiler.test.ts.
 */

const agent = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    kind: 'agent' as const,
    session: 'resume' as const,
    prompt: `do ${name}`,
    ...extra,
});

const block = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    kind: 'block' as const,
    uses: 'builtin/github-review-reconcile',
    ...extra,
});

describe('validateDefinition — block nodes', () => {
    it('accepts a block node with no config', () => {
        const check = validateDefinition({
            entry: 'a',
            nodes: [block('a'), agent('publish', { publish: true })],
            edges: [{ from: 'a', to: 'publish', when: 'succeeded' }],
        });
        expect(check.ok).toBe(true);
        expect(check.ok && check.definition.nodes[0]).toMatchObject({ name: 'a', kind: 'block' });
    });

    it('accepts a block node with bounded scalar config', () => {
        const check = validateDefinition({
            entry: 'a',
            nodes: [block('a', { with: { maxRounds: 3, verbose: true, label: 'x' } }), agent('p', { publish: true })],
            edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
        });
        expect(check.ok).toBe(true);
        expect(check.ok && check.definition.nodes[0]).toMatchObject({
            name: 'a',
            with: { maxRounds: 3, verbose: true, label: 'x' },
        });
    });

    it('refuses an unknown key on a block node', () => {
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [block('a', { prompt: 'not a block field' }), agent('p', { publish: true })],
                edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'UNKNOWN_KEY' } });
    });

    it('refuses `uses` on an agent node — the two node shapes never mix', () => {
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [agent('a', { uses: 'builtin/github-review-reconcile', publish: true })],
                edges: [],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'UNKNOWN_KEY' } });
    });

    it('refuses a missing or malformed `uses`', () => {
        for (const uses of [undefined, '', 'nope', 'builtin/', '/nope', 'Builtin/Nope', 42, 'a'.repeat(200)]) {
            const nodes = uses === undefined ? [{ name: 'a', kind: 'block' as const }] : [block('a', { uses })];
            expect(
                validateDefinition({
                    entry: 'a',
                    nodes: [...nodes, agent('p', { publish: true })],
                    edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
                })
            ).toMatchObject({ ok: false, refusal: { code: 'BAD_NODE' } });
        }
    });

    it('refuses a `with` that is not a plain object', () => {
        for (const withValue of ['x', 1, true, [], null]) {
            expect(
                validateDefinition({
                    entry: 'a',
                    nodes: [block('a', { with: withValue }), agent('p', { publish: true })],
                    edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
                })
            ).toMatchObject({ ok: false, refusal: { code: 'BAD_NODE' } });
        }
    });

    it('refuses too many `with` keys', () => {
        const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]));
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [block('a', { with: many }), agent('p', { publish: true })],
                edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'BAD_NODE' } });
    });

    it('refuses a `with` key that is not a lowercase identifier', () => {
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [block('a', { with: { Bad_Key: 1 } }), agent('p', { publish: true })],
                edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'BAD_NODE' } });
    });

    it('refuses a non-scalar `with` value', () => {
        for (const value of [{ nested: true }, [1, 2], null]) {
            expect(
                validateDefinition({
                    entry: 'a',
                    nodes: [block('a', { with: { field: value } }), agent('p', { publish: true })],
                    edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
                })
            ).toMatchObject({ ok: false, refusal: { code: 'BAD_NODE' } });
        }
    });

    it('refuses an oversized string `with` value', () => {
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [block('a', { with: { label: 'x'.repeat(513) } }), agent('p', { publish: true })],
                edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'BAD_NODE' } });
    });

    it('refuses a non-finite number `with` value', () => {
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [block('a', { with: { n: Number.POSITIVE_INFINITY } }), agent('p', { publish: true })],
                edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'BAD_NODE' } });
    });

    it('treats a block node as an opaque hop for reachability and the publish path', () => {
        // A publish-only chain that ends on a block never satisfies NO_PUBLISH_PATH — a block is
        // never itself a publish node; the graph must route to a downstream agent that publishes.
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [block('a')],
                edges: [],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'NO_PUBLISH_PATH' } });

        expect(
            validateDefinition({
                entry: 'a',
                nodes: [block('a'), agent('p', { publish: true })],
                edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
            })
        ).toMatchObject({ ok: true });
    });

    it('accepts a block node as the entry', () => {
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [block('a'), agent('p', { publish: true })],
                edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
            })
        ).toMatchObject({ ok: true, definition: { entry: 'a' } });
    });

    it('skips the placeholder scan for a block node — it has no prompt to scan', () => {
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [block('a'), agent('p', { publish: true })],
                edges: [{ from: 'a', to: 'p', when: 'succeeded' }],
            })
        ).toMatchObject({ ok: true });
    });

    it('refuses a duplicate name shared between a block and an agent node', () => {
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [block('a'), agent('a', { publish: true })],
                edges: [],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'DUPLICATE_NODE' } });
    });

    it('refuses "param" as a block node name — the parameter namespace stays reserved', () => {
        expect(
            validateDefinition({
                entry: 'param',
                nodes: [block('param'), agent('p', { publish: true })],
                edges: [],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'BAD_NODE' } });
    });
});

describe('validateDefinition — sizeLimit option', () => {
    const small = {
        entry: 'a',
        nodes: [agent('a', { publish: true })],
        edges: [],
    };

    it('defaults to DEFINITION_LIMIT and accepts a small definition', () => {
        expect(validateDefinition(small).ok).toBe(true);
    });

    it('refuses under a caller-supplied sizeLimit smaller than the default', () => {
        expect(validateDefinition(small, { sizeLimit: 10 })).toMatchObject({
            ok: false,
            refusal: { code: 'TOO_LARGE' },
        });
    });

    it('EXPANDED_DEFINITION_LIMIT is a wider bound than the authored DEFINITION_LIMIT', () => {
        expect(EXPANDED_DEFINITION_LIMIT).toBeGreaterThan(DEFINITION_LIMIT);
    });
});
