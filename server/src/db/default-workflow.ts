/**
 * The code-owned default workflow (issue #209): the process every unnamed task walks, assembled
 * IN-PROCESS at launch time from the two reserved blocks — never stored in `workflow`, never
 * editable/deletable through generic CRUD, and outside the repo -> user -> org name/scope
 * precedence a member-authored workflow resolves through (docs/workflows.md, "Scoping, defaults,
 * and the snapshot"). `routes/jobs.ts` is the one caller: it picks the boolean pair (an explicit
 * per-task override, else the caller's saved settings, else both on) and compiles fresh for every
 * launch — cheap, and it keeps this module free of any cache to invalidate.
 *
 * The mandatory spine is a single `agent` node whose prompt is exactly `{{command}}`, publishing
 * after its own gated run — the same "prompt/skill -> gates -> publish" shape an unnamed task
 * always ran, byte-identical when both optional blocks are excluded. Selected blocks are chained
 * onto it in the issue's declared order (review reconciliation, then merge-conflict autofix),
 * referencing the two descriptors `workflow-blocks/index.ts` already registers — this file copies
 * neither block's prompt nor script into itself.
 */
import type { AuthoredWorkflowDefinition, WorkflowDefinition } from './workflow-schema.js';
import { validateDefinition } from './workflow-schema-validate.js';
import { BLOCK_REGISTRY, compileDefinition } from './workflow-blocks/index.js';
import { REVIEW_MARKERS } from './workflow-blocks/github-review-reconcile.js';
import type { BlockRegistry } from './workflow-blocks/types.js';
import { gateFixPrompt } from './workflow-templates.js';

/** The frozen `workflow_name` every default-workflow root row carries (never a member's name). */
export const DEFAULT_WORKFLOW_NAME = 'default';

/** The mandatory spine's one node: `{{command}}`, gated, publishing — the graph's entry. */
export const DEFAULT_ENTRY_NODE = 'task';

/** The gate-repair node a failed gate routes to (issue #49); bounded by the launch-time round limit. */
export const DEFAULT_GATE_FIX_NODE = 'gate-fix';

/** The outer node names the two optional blocks are chained under, in the issue's declared order. */
export const REVIEW_BLOCK_NODE = 'review-reconciliation';
export const MERGE_BLOCK_NODE = 'merge-conflict-autofix';

/** The issue's fixed config for the review-reconciliation block — not a member's choice to make. */
const DEFAULT_REVIEW_MAX_ROUNDS = 3;

/** The caller's selected optional pair — an explicit override, saved settings, or both-on default. */
export interface DefaultWorkflowSelection {
    reviewReconciliation: boolean;
    mergeConflictAutofix: boolean;
}

const SELECTION_FIELDS = ['reviewReconciliation', 'mergeConflictAutofix'] as const;

/**
 * The one shape validator for a `DefaultWorkflowSelection` body — EXACTLY the complete boolean
 * pair, no partial update, no unknown key. Shared by the two independent bodies that carry this
 * same pair: `PUT /api/workflows/default-settings` (`routes/workflow-settings.ts`, #203's saved
 * preference) and `POST /api/jobs`'s per-task `defaultWorkflow` override
 * (`routes/job-workflow-resolution.ts`, issue #209) — one shape, checked once, so the two bodies
 * can never quietly drift apart.
 */
export function parseDefaultWorkflowSelection(
    raw: unknown
): { ok: true; value: DefaultWorkflowSelection } | { ok: false; message: string } {
    const fields = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const keys = Object.keys(fields);
    if (
        keys.length !== SELECTION_FIELDS.length ||
        keys.some((key) => !(SELECTION_FIELDS as readonly string[]).includes(key))
    ) {
        return { ok: false, message: `body must be exactly { ${SELECTION_FIELDS.join(', ')} }` };
    }
    for (const field of SELECTION_FIELDS) {
        if (typeof fields[field] !== 'boolean') return { ok: false, message: `${field} must be a boolean` };
    }
    return {
        ok: true,
        value: {
            reviewReconciliation: fields.reviewReconciliation as boolean,
            mergeConflictAutofix: fields.mergeConflictAutofix as boolean,
        },
    };
}

/**
 * The AUTHORED graph for a selected pair and a gate-repair round limit: the mandatory spine, the
 * gate-fix node when repair is on (issue #49), then only the selected blocks, chained in order.
 * With both excluded and zero rounds this is `nodes: [task], edges: []` — exactly the unnamed path
 * as it was before #49 once compiled (a single node, no block expansion to run).
 *
 * The repair loop (issue #49): `gate-fix` is an ordinary agent node — resuming the thread's
 * primary session (the implementation conversation), gated, and publishing, because the task's
 * own publish never ran when its gates failed. Every edge INTO it — `task`'s and its own
 * retry edge — carries the same `max`, so per "give EVERY edge into X the same max"
 * (docs/workflows.md, "Loops") the bound counts REPAIR ROUNDS (rows for the node, dead rows
 * included), never worker attempts on one row. The limit is a launch-time argument: the route
 * reads the selected executor's configured value and the frozen snapshot fixes it for the
 * thread, so later settings edits change later tasks, never a running one. `0` omits the node
 * and both edges entirely — today's no-repair shape.
 */
export function authorDefaultWorkflow(
    selection: DefaultWorkflowSelection,
    gateFixRounds: number
): AuthoredWorkflowDefinition {
    const nodes: AuthoredWorkflowDefinition['nodes'] = [
        { name: DEFAULT_ENTRY_NODE, kind: 'agent', session: 'resume', publish: true, prompt: '{{command}}' },
    ];
    const edges: AuthoredWorkflowDefinition['edges'] = [];

    // The chain of outer node names the spine feeds into, in declared order — each hop only added
    // for a selected block, so exclusion truly removes the node rather than leaving a bypassed one.
    let previous = DEFAULT_ENTRY_NODE;
    // The first block the spine's succeeded path enters, if any — a repaired task (issue #49)
    // re-enters the same hop: its gates now pass and its publish ran, so the walk continues
    // exactly where an ordinarily successful task would have picked up.
    let firstHop: (typeof REVIEW_BLOCK_NODE | typeof MERGE_BLOCK_NODE) | null = null;

    if (selection.reviewReconciliation) {
        nodes.push({
            name: REVIEW_BLOCK_NODE,
            kind: 'block',
            uses: 'builtin/github-review-reconcile',
            with: { maxRounds: DEFAULT_REVIEW_MAX_ROUNDS },
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
        if (firstHop === null) firstHop = MERGE_BLOCK_NODE;
    }

    // The gate-repair loop, appended after the chain edges — the first-match order still gives
    // every source its succeeded rule before its gate-failed rule, the base workflow's shape.
    if (gateFixRounds > 0) {
        nodes.push({
            name: DEFAULT_GATE_FIX_NODE,
            kind: 'agent',
            session: 'resume',
            publish: true,
            prompt: gateFixPrompt,
        });
        if (firstHop !== null) {
            edges.push({ from: DEFAULT_GATE_FIX_NODE, to: firstHop, when: 'succeeded' });
        }
        edges.push({ from: DEFAULT_ENTRY_NODE, to: DEFAULT_GATE_FIX_NODE, when: 'gate-failed', max: gateFixRounds });
        edges.push({ from: DEFAULT_GATE_FIX_NODE, to: DEFAULT_GATE_FIX_NODE, when: 'gate-failed', max: gateFixRounds });
        // The merge block's exit (`--verify`) runs the gates and publishes; compile rewrites an
        // edge from the block to that exit, so a post-rebase gate break is repaired too.
        if (selection.mergeConflictAutofix) {
            edges.push({ from: MERGE_BLOCK_NODE, to: DEFAULT_GATE_FIX_NODE, when: 'gate-failed', max: gateFixRounds });
        }
    }

    return { entry: DEFAULT_ENTRY_NODE, nodes, edges, params: [] };
}

/**
 * Validates and compiles the authored default graph through the same pipeline
 * `workflow-store.ts`'s `create()` runs a member's own definition through — a refusal here is a
 * bug in THIS module (the four pairs are fixed and unit-tested), never a launch-time possibility,
 * so it throws rather than surfacing a refusal shape callers would have to handle.
 */
export function compileDefaultWorkflow(
    selection: DefaultWorkflowSelection,
    gateFixRounds: number,
    registry: BlockRegistry = BLOCK_REGISTRY
): WorkflowDefinition {
    const authored = authorDefaultWorkflow(selection, gateFixRounds);
    const validated = validateDefinition(authored);
    if (!validated.ok) {
        throw new Error(`default workflow failed to validate: ${validated.refusal.code} ${validated.refusal.message}`);
    }
    const compiled = compileDefinition(validated.definition, registry);
    if (!compiled.ok) {
        throw new Error(`default workflow failed to compile: ${compiled.refusal.code} ${compiled.refusal.message}`);
    }
    return compiled.definition;
}
