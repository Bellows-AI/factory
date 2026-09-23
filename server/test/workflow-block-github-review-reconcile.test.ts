import { describe, expect, it } from 'vitest';
import { BLOCK_REGISTRY, compileDefinition } from '../src/db/workflow-blocks/index.js';
import { REVIEW_MARKERS } from '../src/db/workflow-blocks/github-review-reconcile.js';
import { nextTransition, type EngineRow } from '../src/db/workflow-engine.js';
import type { AuthoredWorkflowDefinition, WorkflowDefinition } from '../src/db/workflow-schema.js';

/**
 * The `builtin/github-review-reconcile` block's own expansion (issue #133) — what
 * `workflow-block-compiler.test.ts` covers generically with fake descriptors, pinned here against
 * the real one: node/edge shape, namespacing, the `maxRounds` bound, the durable wait boundary, and
 * a pure orchestration walk of the expanded graph through the real transition engine.
 */

const graphUsing = (name: string, withConfig?: Record<string, unknown>): AuthoredWorkflowDefinition => ({
    entry: name,
    params: [],
    nodes: [
        { name, kind: 'block', uses: 'builtin/github-review-reconcile', ...(withConfig ? { with: withConfig } : {}) },
    ],
    edges: [],
});

function compiled(withConfig?: Record<string, unknown>): WorkflowDefinition {
    const result = compileDefinition(graphUsing('review', withConfig), BLOCK_REGISTRY);
    if (!result.ok) throw new Error(`expected compile to succeed, refused: ${JSON.stringify(result.refusal)}`);
    return result.definition;
}

describe('builtin/github-review-reconcile — compilation', () => {
    it('is available and compiles on its own, independent of any other workflow', () => {
        const result = compileDefinition(graphUsing('review'), BLOCK_REGISTRY);
        expect(result.ok).toBe(true);
    });

    it('expands to collect/wait/repair/reply, namespaced under the block node name', () => {
        const definition = compiled();
        const names = definition.nodes.map((n) => n.name).sort();
        expect(names).toEqual(['review--collect', 'review--repair', 'review--reply', 'review--wait'].sort());
        expect(definition.entry).toBe('review--collect');
    });

    it('resumes the thread session on every node — the repair/reply worktree must not race a fetch/rebase', () => {
        const definition = compiled();
        for (const node of definition.nodes) expect(node.session).toBe('resume');
    });

    it('the entry (collect) is never the runtime-carrying node — a park there would never be reached', () => {
        const definition = compiled();
        const entry = definition.nodes.find((n) => n.name === definition.entry);
        expect(entry?.runtime).toBeUndefined();
    });

    it('attaches the pr-delivery-wait runtime to wait, and only to wait', () => {
        const definition = compiled();
        const withRuntime = definition.nodes.filter((n) => n.runtime !== undefined);
        expect(withRuntime.map((n) => n.name)).toEqual(['review--wait']);
        expect(withRuntime[0]?.runtime).toMatchObject({
            runtime: 'pr-delivery-wait',
            block: 'builtin/github-review-reconcile',
            params: {},
        });
    });

    it('declares collect and wait a pre helper of review-collect-probe, github-writing', () => {
        const definition = compiled();
        const collect = definition.nodes.find((n) => n.name === 'review--collect');
        const wait = definition.nodes.find((n) => n.name === 'review--wait');
        const plan = [{ helperId: 'review-collect-probe', phase: 'pre', githubWriting: true }];
        expect(collect?.helperPlans).toEqual(plan);
        expect(wait?.helperPlans).toEqual(plan);
        expect(collect?.gates).toBe(false);
        expect(wait?.gates).toBe(false);
    });

    it('declares reply a pre helper of review-reply-probe, github-writing, gates off', () => {
        const definition = compiled();
        const reply = definition.nodes.find((n) => n.name === 'review--reply');
        expect(reply?.helperPlans).toEqual([{ helperId: 'review-reply-probe', phase: 'pre', githubWriting: true }]);
        expect(reply?.gates).toBe(false);
        expect(reply?.publish).toBeUndefined();
    });

    it('repair is the only node that publishes, with default (on) gates', () => {
        const definition = compiled();
        const repair = definition.nodes.find((n) => n.name === 'review--repair');
        expect(repair?.publish).toBe(true);
        expect(repair?.gates).toBeUndefined(); // default on, unset means "default"
        expect(repair?.helperPlans).toBeUndefined();
    });

    it('routes REVIEW-ACTIONABLE from both collect and wait into repair, sharing maxRounds (default 3)', () => {
        const definition = compiled();
        const intoRepair = definition.edges.filter((e) => e.to === 'review--repair');
        expect(intoRepair).toContainEqual({
            from: 'review--collect',
            to: 'review--repair',
            when: { marker: REVIEW_MARKERS.ACTIONABLE },
            max: 3,
        });
        expect(intoRepair).toContainEqual({
            from: 'review--wait',
            to: 'review--repair',
            when: { marker: REVIEW_MARKERS.ACTIONABLE },
            max: 3,
        });
        // Every edge into one target shares the loop-bound rule (docs/workflows.md).
        for (const edge of intoRepair) expect(edge.max).toBe(3);
    });

    it('retries repair on gate-failed and failed, sharing the same maxRounds bound', () => {
        const definition = compiled();
        expect(definition.edges).toContainEqual({
            from: 'review--repair',
            to: 'review--repair',
            when: 'gate-failed',
            max: 3,
        });
        expect(definition.edges).toContainEqual({
            from: 'review--repair',
            to: 'review--repair',
            when: 'failed',
            max: 3,
        });
    });

    it('threads a declared maxRounds through to every bound on repair', () => {
        const definition = compiled({ maxRounds: 5 });
        const intoRepair = definition.edges.filter((e) => e.to === 'review--repair');
        for (const edge of intoRepair) expect(edge.max).toBe(5);
    });

    it('refuses a maxRounds outside the declared 1..10 bound, naming it, without expanding', () => {
        const result = compileDefinition(graphUsing('review', { maxRounds: 99 }), BLOCK_REGISTRY);
        expect(result).toMatchObject({ ok: false, refusal: { code: 'BAD_BLOCK_CONFIG' } });
    });

    it('routes repair -> reply on succeeded only, never on a marker — publish output must not corrupt routing', () => {
        const definition = compiled();
        const fromRepair = definition.edges.filter((e) => e.from === 'review--repair' && e.to === 'review--reply');
        expect(fromRepair).toEqual([{ from: 'review--repair', to: 'review--reply', when: 'succeeded', max: 6 }]);
    });

    it('routes REVIEW-REPLIED from reply back to collect, and retries reply on failure', () => {
        const definition = compiled();
        expect(definition.edges).toContainEqual({
            from: 'review--reply',
            to: 'review--collect',
            when: { marker: REVIEW_MARKERS.REPLIED },
            max: 6,
        });
        expect(definition.edges).toContainEqual({ from: 'review--reply', to: 'review--reply', when: 'failed', max: 6 });
    });

    it('collect has no internal edge for its own REVIEW-CLEAN — an outer edge (or a rest) takes over', () => {
        const definition = compiled();
        const markersOf = (from: string) =>
            definition.edges
                .filter((e) => e.from === from)
                .map((e) => (typeof e.when === 'object' ? e.when.marker : e.when));
        expect(markersOf('review--collect')).not.toContain(REVIEW_MARKERS.CLEAN);
    });

    it("wait's own REVIEW-CLEAN routes back through collect — only collect (the block's exit) can ever reach an outer edge", () => {
        const definition = compiled();
        expect(definition.edges).toContainEqual({
            from: 'review--wait',
            to: 'review--collect',
            when: { marker: REVIEW_MARKERS.CLEAN },
            max: 6,
        });
    });

    it("the repair prompt forbids replying, resolving threads, and gh pr create — that's the driver's job", () => {
        const definition = compiled();
        const repair = definition.nodes.find((n) => n.name === 'review--repair');
        expect(repair?.prompt).toMatch(/may NOT comment|not.*comment/i);
        expect(repair?.prompt).toContain('gh pr create');
    });

    it('a second, independently-named use of the block in one graph does not collide', () => {
        const authored: AuthoredWorkflowDefinition = {
            entry: 'first',
            params: [],
            nodes: [
                { name: 'first', kind: 'block', uses: 'builtin/github-review-reconcile' },
                { name: 'second', kind: 'block', uses: 'builtin/github-review-reconcile' },
            ],
            edges: [{ from: 'first', to: 'second', when: 'succeeded' }],
        };
        const result = compileDefinition(authored, BLOCK_REGISTRY);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected compile to succeed');
        const names = result.definition.nodes.map((n) => n.name).sort();
        expect(names).toEqual(
            [
                'first--collect',
                'first--repair',
                'first--reply',
                'first--wait',
                'second--collect',
                'second--repair',
                'second--reply',
                'second--wait',
            ].sort()
        );
        // The outer edge from the first block's exit (collect) into the second block's entry.
        expect(result.definition.edges).toContainEqual({
            from: 'first--collect',
            to: 'second--collect',
            when: 'succeeded',
        });
    });

    it('a custom graph can reference the block independently of any default workflow', () => {
        const authored: AuthoredWorkflowDefinition = {
            entry: 'implement',
            params: [],
            nodes: [
                { name: 'implement', kind: 'agent', session: 'fresh', prompt: 'implement {{command}}' },
                { name: 'review', kind: 'block', uses: 'builtin/github-review-reconcile' },
            ],
            edges: [{ from: 'implement', to: 'review', when: 'succeeded' }],
        };
        const result = compileDefinition(authored, BLOCK_REGISTRY);
        expect(result.ok).toBe(true);
    });
});

describe('builtin/github-review-reconcile — pure orchestration walk (real nextTransition)', () => {
    const definition = compiled();
    const rowsUpTo = (rows: EngineRow[]): EngineRow[] => rows;

    it('an initial REVIEW-CLEAN conclude has no internal edge to follow — rests as no_edge (standalone use)', () => {
        const rows: EngineRow[] = [
            { id: 'a', node: 'review--collect', status: 'succeeded', output: null, gates: null, sessionId: null },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'fix #1',
            rows: rowsUpTo(rows),
            completed: {
                id: 'a',
                node: 'review--collect',
                status: 'succeeded',
                output: REVIEW_MARKERS.CLEAN,
                gates: null,
            },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'no_edge' });
    });

    it('REVIEW-WAIT parks the thread via the wait node (a runtime insert, not a rest)', () => {
        const rows: EngineRow[] = [
            { id: 'a', node: 'review--collect', status: 'succeeded', output: null, gates: null, sessionId: null },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'fix #1',
            rows,
            completed: {
                id: 'a',
                node: 'review--collect',
                status: 'succeeded',
                output: REVIEW_MARKERS.WAIT,
                gates: null,
            },
        });
        expect(transition).toMatchObject({ action: 'insert', node: { name: 'review--wait' } });
    });

    it('a woken wait finding REVIEW-CLEAN routes back through collect, never a bare rest', () => {
        const rows: EngineRow[] = [
            { id: 'a', node: 'review--collect', status: 'succeeded', output: null, gates: null, sessionId: null },
            { id: 'w', node: 'review--wait', status: 'succeeded', output: null, gates: null, sessionId: null },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'fix #1',
            rows,
            completed: {
                id: 'w',
                node: 'review--wait',
                status: 'succeeded',
                output: REVIEW_MARKERS.CLEAN,
                gates: null,
            },
        });
        expect(transition).toMatchObject({ action: 'insert', node: { name: 'review--collect' } });
    });

    it('REVIEW-ACTIONABLE inserts repair', () => {
        const rows: EngineRow[] = [
            { id: 'a', node: 'review--collect', status: 'succeeded', output: null, gates: null, sessionId: null },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'fix #1',
            rows,
            completed: {
                id: 'a',
                node: 'review--collect',
                status: 'succeeded',
                output: REVIEW_MARKERS.ACTIONABLE,
                gates: null,
            },
        });
        expect(transition).toMatchObject({ action: 'insert', node: { name: 'review--repair' } });
    });

    it('repair succeeded routes to reply; reply REVIEW-REPLIED loops back to collect', () => {
        const rows: EngineRow[] = [
            { id: 'r', node: 'review--repair', status: 'succeeded', output: null, gates: null, sessionId: null },
        ];
        const toReply = nextTransition({
            snapshot: definition,
            params: {},
            command: 'fix #1',
            rows,
            completed: {
                id: 'r',
                node: 'review--repair',
                status: 'succeeded',
                output: 'anything the agent said',
                gates: null,
            },
        });
        expect(toReply).toMatchObject({ action: 'insert', node: { name: 'review--reply' } });

        const rows2: EngineRow[] = [
            ...rows,
            { id: 'y', node: 'review--reply', status: 'succeeded', output: null, gates: null, sessionId: null },
        ];
        const toCollect = nextTransition({
            snapshot: definition,
            params: {},
            command: 'fix #1',
            rows: rows2,
            completed: {
                id: 'y',
                node: 'review--reply',
                status: 'succeeded',
                output: REVIEW_MARKERS.REPLIED,
                gates: null,
            },
        });
        expect(toCollect).toMatchObject({ action: 'insert', node: { name: 'review--collect' } });
    });

    it('a fourth required repair round rests as loop_bound — exhaustion is visible, never silent', () => {
        // Three prior repair rows already on the thread (the default maxRounds).
        const rows: EngineRow[] = [
            { id: 'r1', node: 'review--repair', status: 'succeeded', output: null, gates: null, sessionId: null },
            { id: 'r2', node: 'review--repair', status: 'succeeded', output: null, gates: null, sessionId: null },
            { id: 'r3', node: 'review--repair', status: 'succeeded', output: null, gates: null, sessionId: null },
            { id: 'c', node: 'review--collect', status: 'succeeded', output: null, gates: null, sessionId: null },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'fix #1',
            rows,
            completed: {
                id: 'c',
                node: 'review--collect',
                status: 'succeeded',
                output: REVIEW_MARKERS.ACTIONABLE,
                gates: null,
            },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'loop_bound' });
    });

    it('a gate failure on repair retries repair itself, counted toward the same round bound', () => {
        const rows: EngineRow[] = [
            {
                id: 'r',
                node: 'review--repair',
                status: 'failed',
                output: null,
                gates: [{ name: 'test', status: 'failed', output: 'boom' }],
                sessionId: null,
            },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'fix #1',
            rows,
            completed: {
                id: 'r',
                node: 'review--repair',
                status: 'failed',
                output: null,
                gates: [{ name: 'test', status: 'failed', output: 'boom' }],
            },
        });
        expect(transition).toMatchObject({ action: 'insert', node: { name: 'review--repair' } });
    });
});
