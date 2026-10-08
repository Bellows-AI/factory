/**
 * A member-authored task -> gate-fix graph for the tests that exercise the workflow engine's gate
 * repair loop: `task` (agent, gated, publishing) with a bounded `gate-fix` retry loop on a failed
 * gate, optionally chained into the review-reconciliation and merge-conflict-autofix blocks.
 * Authored here, in the test tree — the board no longer ships a code-owned default workflow.
 */
import { randomUUID } from 'node:crypto';
import { validateDefinition } from '../src/db/workflow-schema-validate.js';
import type { AuthoredWorkflowDefinition, WorkflowDefinition } from '../src/db/workflow-schema.js';
import { BLOCK_REGISTRY, compileDefinition } from '../src/db/workflow-blocks/index.js';
import { REVIEW_MARKERS } from '../src/db/workflow-blocks/github-review-reconcile.js';
import { gateFixPrompt } from '../test/fix-issue-workflow.js';

export const GATE_FIX_WORKFLOW_NAME = 'gate-fix-loop';
export const GATE_FIX_ENTRY_NODE = 'task';
export const GATE_FIX_NODE = 'gate-fix';
const REVIEW_BLOCK_NODE = 'review-reconciliation';
const MERGE_BLOCK_NODE = 'merge-conflict-autofix';

export interface BlockSelection {
    reviewReconciliation: boolean;
    mergeConflictAutofix: boolean;
}

export const NO_BLOCKS: BlockSelection = { reviewReconciliation: false, mergeConflictAutofix: false };
export const BOTH_BLOCKS: BlockSelection = { reviewReconciliation: true, mergeConflictAutofix: true };

export function authorGateFixWorkflow(
    rounds: number,
    selection: BlockSelection = NO_BLOCKS
): AuthoredWorkflowDefinition {
    const nodes: AuthoredWorkflowDefinition['nodes'] = [
        { name: GATE_FIX_ENTRY_NODE, kind: 'agent', session: 'resume', publish: true, prompt: '{{command}}' },
    ];
    const edges: AuthoredWorkflowDefinition['edges'] = [];
    let previous = GATE_FIX_ENTRY_NODE;
    let firstHop: string | null = null;

    if (selection.reviewReconciliation) {
        nodes.push({
            name: REVIEW_BLOCK_NODE,
            kind: 'block',
            uses: 'builtin/github-review-reconcile',
            with: { maxRounds: 3 },
        });
        edges.push({ from: previous, to: REVIEW_BLOCK_NODE, when: 'succeeded' });
        previous = REVIEW_BLOCK_NODE;
        firstHop = REVIEW_BLOCK_NODE;
    }
    if (selection.mergeConflictAutofix) {
        nodes.push({ name: MERGE_BLOCK_NODE, kind: 'block', uses: 'builtin/merge-conflict-autofix' });
        edges.push(
            previous === REVIEW_BLOCK_NODE
                ? { from: previous, to: MERGE_BLOCK_NODE, when: { marker: REVIEW_MARKERS.CLEAN } }
                : { from: previous, to: MERGE_BLOCK_NODE, when: 'succeeded' }
        );
        firstHop ??= MERGE_BLOCK_NODE;
    }
    if (rounds > 0) {
        nodes.push({ name: GATE_FIX_NODE, kind: 'agent', session: 'resume', publish: true, prompt: gateFixPrompt });
        if (firstHop !== null) edges.push({ from: GATE_FIX_NODE, to: firstHop, when: 'succeeded' });
        edges.push({ from: GATE_FIX_ENTRY_NODE, to: GATE_FIX_NODE, when: 'gate-failed', max: rounds });
        edges.push({ from: GATE_FIX_NODE, to: GATE_FIX_NODE, when: 'gate-failed', max: rounds });
        if (selection.mergeConflictAutofix) {
            edges.push({ from: MERGE_BLOCK_NODE, to: GATE_FIX_NODE, when: 'gate-failed', max: rounds });
        }
    }
    return { entry: GATE_FIX_ENTRY_NODE, nodes, edges, params: [] };
}

/** The `workflow` a `store.create` target carries to launch the gate-fix graph as a workflow-mode task. */
export function gateFixTarget(rounds: number, selection: BlockSelection = NO_BLOCKS) {
    return {
        id: randomUUID(),
        name: GATE_FIX_WORKFLOW_NAME,
        node: GATE_FIX_ENTRY_NODE,
        snapshot: compileGateFixWorkflow(rounds, selection),
        params: {},
    };
}

export function compileGateFixWorkflow(rounds: number, selection: BlockSelection = NO_BLOCKS): WorkflowDefinition {
    const validated = validateDefinition(authorGateFixWorkflow(rounds, selection));
    if (!validated.ok) throw new Error(`${validated.refusal.code} ${validated.refusal.message}`);
    const compiled = compileDefinition(validated.definition, BLOCK_REGISTRY);
    if (!compiled.ok) throw new Error(`${compiled.refusal.code} ${compiled.refusal.message}`);
    return compiled.definition;
}
