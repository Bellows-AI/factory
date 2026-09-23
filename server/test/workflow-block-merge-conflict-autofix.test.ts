import { describe, expect, it } from 'vitest';
import { BLOCK_REGISTRY, compileDefinition } from '../src/db/workflow-blocks/index.js';
import type { AuthoredWorkflowDefinition } from '../src/db/workflow-schema.js';

/**
 * The `builtin/merge-conflict-autofix` block's own expansion (issue #122) — what
 * `workflow-block-compiler.test.ts` covers generically with fake descriptors, pinned here
 * against the real one: node/edge shape, namespacing, the `maxAttempts` retry bound, and that a
 * custom graph can reference the block on its own, independent of the seeded default workflow.
 */

const graphUsing = (name: string, withConfig?: Record<string, unknown>): AuthoredWorkflowDefinition => ({
    entry: name,
    params: [],
    nodes: [
        { name, kind: 'block', uses: 'builtin/merge-conflict-autofix', ...(withConfig ? { with: withConfig } : {}) },
    ],
    edges: [],
});

describe('builtin/merge-conflict-autofix', () => {
    it('is available and compiles on its own, independent of any other workflow', () => {
        const result = compileDefinition(graphUsing('reconcile'), BLOCK_REGISTRY);
        expect(result.ok).toBe(true);
    });

    it('expands to a repair -> verify subgraph, namespaced under the block node name', () => {
        const result = compileDefinition(graphUsing('reconcile'), BLOCK_REGISTRY);
        if (!result.ok) throw new Error('expected compile to succeed');
        const names = result.definition.nodes.map((n) => n.name).sort();
        expect(names).toEqual(['reconcile--repair', 'reconcile--verify']);
        expect(result.definition.entry).toBe('reconcile--repair');
    });

    it('resumes the thread session on both nodes — restore mode requires it', () => {
        const result = compileDefinition(graphUsing('reconcile'), BLOCK_REGISTRY);
        if (!result.ok) throw new Error('expected compile to succeed');
        for (const node of result.definition.nodes) {
            expect(node.session).toBe('resume');
        }
    });

    it('declares the repair node a pre block-helper of the merge-conflict-probe, github-writing', () => {
        const result = compileDefinition(graphUsing('reconcile'), BLOCK_REGISTRY);
        if (!result.ok) throw new Error('expected compile to succeed');
        const repair = result.definition.nodes.find((n) => n.name === 'reconcile--repair');
        expect(repair?.helperPlans).toEqual([{ helperId: 'merge-conflict-probe', phase: 'pre', githubWriting: true }]);
    });

    it('skips gates on the repair node and publishes only from verify', () => {
        const result = compileDefinition(graphUsing('reconcile'), BLOCK_REGISTRY);
        if (!result.ok) throw new Error('expected compile to succeed');
        const repair = result.definition.nodes.find((n) => n.name === 'reconcile--repair');
        const verify = result.definition.nodes.find((n) => n.name === 'reconcile--verify');
        expect(repair?.gates).toBe(false);
        expect(repair?.publish).toBeUndefined();
        expect(verify?.publish).toBe(true);
        expect(verify?.gates).toBeUndefined(); // default on, unset means "default"
    });

    it('routes a clean rebase or a resolved conflict to verify, by marker', () => {
        const result = compileDefinition(graphUsing('reconcile'), BLOCK_REGISTRY);
        if (!result.ok) throw new Error('expected compile to succeed');
        expect(result.definition.edges).toContainEqual({
            from: 'reconcile--repair',
            to: 'reconcile--verify',
            when: { marker: 'MERGE-REBASED' },
        });
        expect(result.definition.edges).toContainEqual({
            from: 'reconcile--repair',
            to: 'reconcile--verify',
            when: { marker: 'MERGE-RESOLVED' },
        });
    });

    it('leaves up-to-date and needs-review markers with no outgoing edge — the thread rests', () => {
        const result = compileDefinition(graphUsing('reconcile'), BLOCK_REGISTRY);
        if (!result.ok) throw new Error('expected compile to succeed');
        const fromRepair = result.definition.edges.filter((e) => e.from === 'reconcile--repair');
        const markers = fromRepair.map((e) => (typeof e.when === 'object' ? e.when.marker : e.when));
        expect(markers).not.toContain('MERGE-UP-TO-DATE');
        expect(markers).not.toContain('MERGE-NEEDS-REVIEW');
    });

    it('retries the repair node on its own run failing, bounded by maxAttempts (default 2)', () => {
        const result = compileDefinition(graphUsing('reconcile'), BLOCK_REGISTRY);
        if (!result.ok) throw new Error('expected compile to succeed');
        expect(result.definition.edges).toContainEqual({
            from: 'reconcile--repair',
            to: 'reconcile--repair',
            when: 'failed',
            max: 2,
        });
    });

    it('threads a declared maxAttempts through to the retry edge bound', () => {
        const result = compileDefinition(graphUsing('reconcile', { maxAttempts: 5 }), BLOCK_REGISTRY);
        if (!result.ok) throw new Error('expected compile to succeed');
        expect(result.definition.edges).toContainEqual({
            from: 'reconcile--repair',
            to: 'reconcile--repair',
            when: 'failed',
            max: 5,
        });
    });

    it('refuses a maxAttempts outside the declared 1..5 bound, naming it, without expanding', () => {
        const result = compileDefinition(graphUsing('reconcile', { maxAttempts: 99 }), BLOCK_REGISTRY);
        expect(result).toMatchObject({ ok: false, refusal: { code: 'BAD_BLOCK_CONFIG' } });
    });

    it('instructs the agent to never create a PR or start a new rebase/merge — only continue/abort', () => {
        // Not a guard-hook test (that lives in driver/test/executor-images.test.ts) — this pins
        // that the block's OWN authored prompt text steers the agent toward exactly what the
        // guard allows for a tree an interrupted rebase left mid-flight (`--continue`/`--abort`),
        // and explicitly away from what it denies (an initiating `git rebase`/`git merge`,
        // `git switch`/`checkout` of a branch, `gh pr create`) — so a prompt change here cannot
        // silently reintroduce job 43379d3a's stranded-thread failure mode.
        const result = compileDefinition(graphUsing('reconcile'), BLOCK_REGISTRY);
        if (!result.ok) throw new Error('expected compile to succeed');
        const repair = result.definition.nodes.find((n) => n.name === 'reconcile--repair');
        expect(repair?.prompt).toMatch(/never run `gh pr create`/);
        expect(repair?.prompt).toContain('git rebase --continue');
        expect(repair?.prompt).toContain('git rebase --abort');
    });

    it('a second, independently-named use of the block in one graph does not collide', () => {
        const authored: AuthoredWorkflowDefinition = {
            entry: 'first',
            params: [],
            nodes: [
                { name: 'first', kind: 'block', uses: 'builtin/merge-conflict-autofix' },
                { name: 'second', kind: 'block', uses: 'builtin/merge-conflict-autofix' },
            ],
            edges: [{ from: 'first', to: 'second', when: 'succeeded' }],
        };
        const result = compileDefinition(authored, BLOCK_REGISTRY);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected compile to succeed');
        const names = result.definition.nodes.map((n) => n.name).sort();
        expect(names).toEqual(['first--repair', 'first--verify', 'second--repair', 'second--verify'].sort());
        // The outer edge from the first block's exit (verify) into the second block's entry (repair).
        expect(result.definition.edges).toContainEqual({
            from: 'first--verify',
            to: 'second--repair',
            when: 'succeeded',
        });
    });
});
