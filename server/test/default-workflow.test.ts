import { describe, expect, it } from 'vitest';
import {
    DEFAULT_ENTRY_NODE,
    DEFAULT_GATE_FIX_NODE,
    DEFAULT_WORKFLOW_NAME,
    MERGE_BLOCK_NODE,
    REVIEW_BLOCK_NODE,
    authorDefaultWorkflow,
    compileDefaultWorkflow,
    type DefaultWorkflowSelection,
} from '../src/db/default-workflow.js';
import { compileDefinition } from '../src/db/workflow-blocks/index.js';
import { REVIEW_MARKERS } from '../src/db/workflow-blocks/github-review-reconcile.js';
import { gateFixPrompt } from '../src/db/workflow-templates.js';
import { interpolate } from '../src/db/workflow-schema.js';
import { nextTransition, type EngineRow } from '../src/db/workflow-engine.js';

/**
 * The code-owned default workflow (issue #209): the four selectable pairs compile to the shapes
 * the launch contract promises, and walk through the real transition engine the way a live thread
 * would. `routes.jobs.default-workflow.test.ts` covers the HTTP contract; this file covers the
 * assembler in isolation. The gate-repair round limit (issue #49) is baked into the graph at
 * compile time — every edge into `gate-fix` shares it as its loop bound — and zero omits the node
 * entirely, leaving today's no-repair shape byte-for-byte.
 */

const PAIRS: DefaultWorkflowSelection[] = [
    { reviewReconciliation: false, mergeConflictAutofix: false },
    { reviewReconciliation: true, mergeConflictAutofix: false },
    { reviewReconciliation: false, mergeConflictAutofix: true },
    { reviewReconciliation: true, mergeConflictAutofix: true },
];

const ROUNDS = [0, 1, 3] as const;

describe('default workflow — compilation', () => {
    it('has the reserved name "default"', () => {
        expect(DEFAULT_WORKFLOW_NAME).toBe('default');
    });

    it.each(PAIRS)('compiles every selectable pair %o at rounds 0, 1 and 3', (selection) => {
        for (const rounds of ROUNDS) {
            expect(() => compileDefaultWorkflow(selection, rounds)).not.toThrow();
        }
    });

    it('compileDefaultWorkflow deep-equals compiling the authored graph directly', () => {
        for (const selection of PAIRS) {
            for (const rounds of ROUNDS) {
                const authored = authorDefaultWorkflow(selection, rounds);
                const compiled = compileDefinition(authored);
                if (!compiled.ok) throw new Error('expected compile to succeed');
                expect(compileDefaultWorkflow(selection, rounds)).toEqual(compiled.definition);
            }
        }
    });

    it('zero rounds leaves the plain spine: exactly one node, no edges — the pre-#49 shape', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 0);
        expect(definition.entry).toBe(DEFAULT_ENTRY_NODE);
        expect(definition.nodes).toEqual([
            { name: DEFAULT_ENTRY_NODE, kind: 'agent', session: 'resume', publish: true, prompt: '{{command}}' },
        ]);
        expect(definition.edges).toEqual([]);
    });

    it('zero rounds omits gate-fix from every selectable pair', () => {
        for (const selection of PAIRS) {
            const definition = compileDefaultWorkflow(selection, 0);
            expect(definition.nodes.map((n) => n.name)).not.toContain(DEFAULT_GATE_FIX_NODE);
            expect(
                definition.edges.every((e) => e.from !== DEFAULT_GATE_FIX_NODE && e.to !== DEFAULT_GATE_FIX_NODE)
            ).toBe(true);
        }
    });

    it('both excluded: no helper nodes, no runtime nodes — the plain prompt/skill -> gates -> publish shape', () => {
        for (const rounds of ROUNDS) {
            const definition = compileDefaultWorkflow(
                { reviewReconciliation: false, mergeConflictAutofix: false },
                rounds
            );
            expect(definition.nodes.every((n) => n.helperPlans === undefined)).toBe(true);
            expect(definition.nodes.every((n) => n.runtime === undefined)).toBe(true);
        }
    });

    it('repair rounds add one gate-fix node: resuming, publishing, the shared gate-fix prompt', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 3);
        const node = definition.nodes.find((n) => n.name === DEFAULT_GATE_FIX_NODE);
        expect(node).toEqual({
            name: DEFAULT_GATE_FIX_NODE,
            kind: 'agent',
            session: 'resume',
            publish: true,
            prompt: gateFixPrompt,
        });
    });

    it('the gate-fix prompt interpolates the failed gate name and output and forbids weakening the gate', () => {
        expect(gateFixPrompt).toContain('{{gate.name}}');
        expect(gateFixPrompt).toContain('{{gate.output}}');
        expect(gateFixPrompt.toLowerCase()).toContain('weaken');
    });

    it.each(ROUNDS.filter((r) => r > 0))(
        'rounds %i: every edge into gate-fix carries the round limit as its bound',
        (rounds) => {
            for (const selection of PAIRS) {
                const definition = compileDefaultWorkflow(selection, rounds);
                const into = definition.edges.filter((e) => e.to === DEFAULT_GATE_FIX_NODE);
                // Exactly two: task's gate-failed edge and gate-fix's own retry edge.
                expect(into).toHaveLength(2);
                expect(into.map((e) => e.from).sort()).toEqual([DEFAULT_ENTRY_NODE, DEFAULT_GATE_FIX_NODE].sort());
                for (const edge of into) {
                    expect(edge.when).toBe('gate-failed');
                    expect(edge.max).toBe(rounds);
                }
            }
        }
    );

    it.each(PAIRS)('gate-fix succeeded follows the same hop task succeeded does (%o)', (selection) => {
        for (const rounds of ROUNDS.filter((r) => r > 0)) {
            const definition = compileDefaultWorkflow(selection, rounds);
            const stripFrom = (edges: typeof definition.edges) => edges.map((e) => ({ to: e.to, when: e.when }));
            const fromTask = stripFrom(
                definition.edges.filter((e) => e.from === DEFAULT_ENTRY_NODE && e.when === 'succeeded')
            );
            const fromGateFix = stripFrom(
                definition.edges.filter((e) => e.from === DEFAULT_GATE_FIX_NODE && e.when === 'succeeded')
            );
            expect(fromGateFix).toEqual(fromTask);
        }
    });

    it('review only: task feeds the review-reconciliation block, entered on succeeded', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: false }, 0);
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
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: true }, 0);
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
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true }, 0);
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
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 0);
        const entry = definition.nodes.find((n) => n.name === definition.entry)!;
        const command = 'Please refactor the widget loader to stream results instead of buffering.';
        expect(
            interpolate(entry.prompt, { nodeOutput: () => '', gateName: '', gateOutput: '', param: () => '', command })
        ).toBe(command);
    });

    it('interpolating the entry leaves a skill invocation untouched', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 0);
        const entry = definition.nodes.find((n) => n.name === definition.entry)!;
        const command = '/fix 209';
        expect(
            interpolate(entry.prompt, { nodeOutput: () => '', gateName: '', gateOutput: '', param: () => '', command })
        ).toBe(command);
    });

    it("interpolating the entry leaves a literal {{x}} in the member's words untouched", () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 0);
        const entry = definition.nodes.find((n) => n.name === definition.entry)!;
        const command = 'rename the {{x}} placeholder to {{y}}';
        expect(
            interpolate(entry.prompt, { nodeOutput: () => '', gateName: '', gateOutput: '', param: () => '', command })
        ).toBe(command);
    });
});

describe('default workflow — pure orchestration walk (real nextTransition)', () => {
    /** The gate report a genuine gate failure lands on the row — `failed` verdict beside it. */
    const failedGate = (output: string): EngineRow['gates'] => [
        { name: 'test', status: 'failed', exitCode: 1, output },
    ];

    it('both excluded, zero rounds: task succeeded has no outgoing edge — rests no_edge', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 0);
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

    it('task failed with green gates rests — an agent crash is not a gate failure, repair is never queued', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true }, 3);
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

    it('zero rounds: task gate-failed rests no_edge — automatic repair is disabled', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true }, 0);
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
                gates: failedGate('1 test failed'),
            },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'no_edge' });
    });

    it('task gate-failed inserts a gate-fix repair round whose command names the gate and its output', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true }, 3);
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'failed', output: null, gates: null, sessionId: 's' },
        ];
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
                gates: failedGate('3 tests failed'),
            },
        });
        expect(transition).toMatchObject({
            action: 'insert',
            node: { name: DEFAULT_GATE_FIX_NODE, session: 'resume', publish: true },
        });
        if (transition.action !== 'insert') throw new Error('expected an insert');
        expect(transition.command).toContain('test');
        expect(transition.command).toContain('3 tests failed');
    });

    it('gate-fix succeeded continues into the first selected block — the normal success path resumes', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: false }, 3);
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'failed', output: null, gates: null, sessionId: 's' },
            { id: 'b', node: DEFAULT_GATE_FIX_NODE, status: 'succeeded', output: 'fixed', gates: null, sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: { id: 'b', node: DEFAULT_GATE_FIX_NODE, status: 'succeeded', output: 'fixed', gates: null },
        });
        expect(transition).toMatchObject({ action: 'insert', node: { name: `${REVIEW_BLOCK_NODE}--collect` } });
    });

    it('gate-fix succeeded rests when no block is selected — the pre-#49 success path', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 3);
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'failed', output: null, gates: null, sessionId: 's' },
            { id: 'b', node: DEFAULT_GATE_FIX_NODE, status: 'succeeded', output: 'fixed', gates: null, sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: { id: 'b', node: DEFAULT_GATE_FIX_NODE, status: 'succeeded', output: 'fixed', gates: null },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'no_edge' });
    });

    it('gate-fix gate-failed queues another repair round while budget remains', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 3);
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'failed', output: null, gates: null, sessionId: 's' },
            {
                id: 'b',
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('still red'),
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
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('still red'),
            },
        });
        expect(transition).toMatchObject({ action: 'insert', node: { name: DEFAULT_GATE_FIX_NODE } });
    });

    it('gate-fix exhaustion rests loop_bound — no further round is queued', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 3);
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'failed', output: null, gates: null, sessionId: 's' },
            {
                id: 'b',
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('red 1'),
                sessionId: 's',
            },
            {
                id: 'c',
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('red 2'),
                sessionId: 's',
            },
            {
                id: 'd',
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('red 3'),
                sessionId: 's',
            },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: {
                id: 'd',
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('red 3'),
            },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'loop_bound' });
    });

    it('one round: the second gate failure exhausts the budget', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 1);
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'failed', output: null, gates: null, sessionId: 's' },
            {
                id: 'b',
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('red 1'),
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
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('red 1'),
            },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'loop_bound' });
    });

    it('a dead gate-fix row still counts toward the bound — rounds are rows, not attempts', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: false }, 3);
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'failed', output: null, gates: null, sessionId: 's' },
            { id: 'b', node: DEFAULT_GATE_FIX_NODE, status: 'dead', output: null, gates: null, sessionId: null },
            {
                id: 'c',
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('red 2'),
                sessionId: 's',
            },
            {
                id: 'd',
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('red 3'),
                sessionId: 's',
            },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do the thing',
            rows,
            completed: {
                id: 'd',
                node: DEFAULT_GATE_FIX_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('red 3'),
            },
        });
        expect(transition).toEqual({ action: 'rest', reason: 'loop_bound' });
    });

    it("task succeeded inserts the first selected block's entry (review-reconciliation)", () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: false }, 0);
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
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: true }, 0);
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
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: true }, 0);
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
        const definition = compileDefaultWorkflow({ reviewReconciliation: true, mergeConflictAutofix: false }, 0);
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
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: true }, 0);
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
