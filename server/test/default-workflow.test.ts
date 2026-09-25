import { describe, expect, it } from 'vitest';
import {
    DEFAULT_ENTRY_NODE,
    DEFAULT_WORKFLOW_NAME,
    MERGE_BLOCK_NODE,
    REVIEW_BLOCK_NODE,
    authorDefaultWorkflow,
    compileDefaultWorkflow,
    type DefaultWorkflowSelection,
} from '../src/db/default-workflow.js';
import { compileDefinition } from '../src/db/workflow-blocks/index.js';
import { REVIEW_MARKERS } from '../src/db/workflow-blocks/github-review-reconcile.js';
import { interpolate } from '../src/db/workflow-schema.js';
import { nextTransition, type EngineRow } from '../src/db/workflow-engine.js';

/**
 * The code-owned default workflow (issue #209): the four selectable pairs compile to the shapes
 * the launch contract promises, and walk through the real transition engine the way a live thread
 * would. `routes.jobs.default-workflow.test.ts` covers the HTTP contract; this file covers the
 * assembler in isolation.
 */

const PAIRS: DefaultWorkflowSelection[] = [
    { reviewReconciliation: false, mergeConflictAutofix: false },
    { reviewReconciliation: true, mergeConflictAutofix: false },
    { reviewReconciliation: false, mergeConflictAutofix: true },
    { reviewReconciliation: true, mergeConflictAutofix: true },
];

describe('default workflow — compilation', () => {
    it('has the reserved name "default"', () => {
        expect(DEFAULT_WORKFLOW_NAME).toBe('default');
    });

    it.each(PAIRS)('compiles every selectable pair %o', (selection) => {
        expect(() => compileDefaultWorkflow(selection)).not.toThrow();
    });

    it('compileDefaultWorkflow deep-equals compiling the authored graph directly', () => {
        for (const selection of PAIRS) {
            const authored = authorDefaultWorkflow(selection);
            const compiled = compileDefinition(authored);
            if (!compiled.ok) throw new Error('expected compile to succeed');
            expect(compileDefaultWorkflow(selection)).toEqual(compiled.definition);
        }
    });

    it('the mandatory spine is exactly one node: {{command}}, resuming, publishing', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false });
        expect(definition.entry).toBe(DEFAULT_ENTRY_NODE);
        expect(definition.nodes).toEqual([
            { name: DEFAULT_ENTRY_NODE, kind: 'agent', session: 'resume', publish: true, prompt: '{{command}}' },
        ]);
        expect(definition.edges).toEqual([]);
    });

    it('both excluded: no helper nodes, no runtime nodes — the plain prompt/skill -> gates -> publish shape', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false });
        expect(definition.nodes.every((n) => n.helperPlans === undefined)).toBe(true);
        expect(definition.nodes.every((n) => n.runtime === undefined)).toBe(true);
    });

    it('review only: task feeds the review-reconciliation block, entered on succeeded', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: false });
        const names = definition.nodes.map((n) => n.name).sort();
        expect(names).toEqual(
            [
                DEFAULT_ENTRY_NODE,
                `${REVIEW_BLOCK_NODE}--collect`,
                `${REVIEW_BLOCK_NODE}--wait`,
                `${REVIEW_BLOCK_NODE}--repair`,
                `${REVIEW_BLOCK_NODE}--reply`,
            ].sort()
        );
        expect(definition.edges).toContainEqual({
            from: DEFAULT_ENTRY_NODE,
            to: `${REVIEW_BLOCK_NODE}--collect`,
            when: 'succeeded',
        });
        // Every edge into the block's own repair node shares maxRounds (3) as its bound.
        const intoRepair = definition.edges.filter((e) => e.to === `${REVIEW_BLOCK_NODE}--repair`);
        expect(intoRepair.length).toBeGreaterThan(0);
        for (const edge of intoRepair) expect(edge.max).toBe(3);
    });

    it('merge only: task feeds merge-conflict-autofix directly, entered on succeeded', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: true });
        const names = definition.nodes.map((n) => n.name).sort();
        expect(names).toEqual(
            [DEFAULT_ENTRY_NODE, `${MERGE_BLOCK_NODE}--repair`, `${MERGE_BLOCK_NODE}--verify`].sort()
        );
        expect(definition.edges).toContainEqual({
            from: DEFAULT_ENTRY_NODE,
            to: `${MERGE_BLOCK_NODE}--repair`,
            when: 'succeeded',
        });
    });

    it('both selected: review-reconciliation feeds merge-conflict-autofix on REVIEW-CLEAN, after its own internal edges', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true });
        const names = definition.nodes.map((n) => n.name).sort();
        expect(names).toEqual(
            [
                DEFAULT_ENTRY_NODE,
                `${REVIEW_BLOCK_NODE}--collect`,
                `${REVIEW_BLOCK_NODE}--wait`,
                `${REVIEW_BLOCK_NODE}--repair`,
                `${REVIEW_BLOCK_NODE}--reply`,
                `${MERGE_BLOCK_NODE}--repair`,
                `${MERGE_BLOCK_NODE}--verify`,
            ].sort()
        );
        const fromCollect = definition.edges.filter((e) => e.from === `${REVIEW_BLOCK_NODE}--collect`);
        // The block's own internal edges (ACTIONABLE -> repair, WAIT -> wait, failed -> collect)
        // still evaluate first — the outer CLEAN edge is simply one more rule in the same list,
        // never a bypass of them (first-match-wins, docs/workflows.md).
        const outer = fromCollect.find(
            (e) =>
                typeof e.when === 'object' &&
                e.when.marker === REVIEW_MARKERS.CLEAN &&
                e.to === `${MERGE_BLOCK_NODE}--repair`
        );
        expect(outer).toBeDefined();
        expect(fromCollect.length).toBeGreaterThan(1);
    });

    it('interpolating the entry leaves an arbitrary prompt untouched', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false });
        const entry = definition.nodes.find((n) => n.name === definition.entry)!;
        const command = 'Please refactor the widget loader to stream results instead of buffering.';
        expect(
            interpolate(entry.prompt, { nodeOutput: () => '', gateName: '', gateOutput: '', param: () => '', command })
        ).toBe(command);
    });

    it('interpolating the entry leaves a skill invocation untouched', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false });
        const entry = definition.nodes.find((n) => n.name === definition.entry)!;
        const command = '/fix 209';
        expect(
            interpolate(entry.prompt, { nodeOutput: () => '', gateName: '', gateOutput: '', param: () => '', command })
        ).toBe(command);
    });

    it("interpolating the entry leaves a literal {{x}} in the member's words untouched", () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false });
        const entry = definition.nodes.find((n) => n.name === definition.entry)!;
        const command = 'rename the {{x}} placeholder to {{y}}';
        expect(
            interpolate(entry.prompt, { nodeOutput: () => '', gateName: '', gateOutput: '', param: () => '', command })
        ).toBe(command);
    });
});

describe('default workflow — pure orchestration walk (real nextTransition)', () => {
    it('both excluded: task succeeded has no outgoing edge — rests no_edge', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false });
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'done', gates: null, sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'done', gates: null },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'no_edge' });
    });

    it('task failed rests — no edge matches a failed verdict', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true });
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'failed', output: null, gates: null, sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'failed', output: null, gates: null },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'no_edge' });
    });

    it('task gate-failed rests — no gate-failed edge is declared for the mandatory spine', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true });
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'failed', output: null, gates: null, sessionId: 's' },
        ];
        // The driver always reports `status: 'failed'` alongside a gate failure (loop-run.ts's
        // `reportFinish`) — never `succeeded` with a failed gate report — so this is the real shape
        // a gate failure on `task` produces.
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: {
                id: 'a',
                node: DEFAULT_ENTRY_NODE,
                status: 'failed',
                output: null,
                gates: [{ name: 'test', status: 'failed', exitCode: 1, output: null }],
            },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'no_edge' });
    });

    it("task succeeded inserts the first selected block's entry (review-reconciliation)", () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: false });
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'done', gates: null, sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'done', gates: null },
        });
        expect(transition).toMatchObject({ action: 'insert', node: { name: `${REVIEW_BLOCK_NODE}--collect` } });
    });

    it('task succeeded inserts merge-conflict-autofix directly when review is excluded', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: true });
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'done', gates: null, sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'done', gates: null },
        });
        expect(transition).toMatchObject({ action: 'insert', node: { name: `${MERGE_BLOCK_NODE}--repair` } });
    });

    it('collect REVIEW-CLEAN inserts merge repair when both are selected', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true });
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'done', gates: null, sessionId: 's' },
            {
                id: 'b',
                node: `${REVIEW_BLOCK_NODE}--collect`,
                status: 'succeeded',
                output: null,
                gates: null,
                sessionId: 's',
            },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: {
                id: 'b',
                node: `${REVIEW_BLOCK_NODE}--collect`,
                status: 'succeeded',
                output: REVIEW_MARKERS.CLEAN,
                gates: null,
            },
        });
        expect(transition).toMatchObject({ action: 'insert', node: { name: `${MERGE_BLOCK_NODE}--repair` } });
    });

    it('collect REVIEW-CLEAN rests when merge-conflict-autofix is excluded — no outer edge to intercept it', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: false });
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'done', gates: null, sessionId: 's' },
            {
                id: 'b',
                node: `${REVIEW_BLOCK_NODE}--collect`,
                status: 'succeeded',
                output: null,
                gates: null,
                sessionId: 's',
            },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: {
                id: 'b',
                node: `${REVIEW_BLOCK_NODE}--collect`,
                status: 'succeeded',
                output: REVIEW_MARKERS.CLEAN,
                gates: null,
            },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'no_edge' });
    });

    it("merge verify succeeded rests — the block's own exit has no outer edge", () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: true });
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'done', gates: null, sessionId: 's' },
            {
                id: 'b',
                node: `${MERGE_BLOCK_NODE}--verify`,
                status: 'succeeded',
                output: 'ok',
                gates: null,
                sessionId: 's',
            },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: {
                id: 'b',
                node: `${MERGE_BLOCK_NODE}--verify`,
                status: 'succeeded',
                output: 'ok',
                gates: null,
            },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'no_edge' });
    });
});
