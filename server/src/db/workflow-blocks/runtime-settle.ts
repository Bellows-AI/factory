/**
 * The generic counterpart to `runtime.ts`'s park (issue #231, `enterRuntimeBoundary`): closes a
 * durable block wait once the transition it parked for is truly LEAVING the block that opened it —
 * never on every internal step a multi-node block takes while the wait stays legitimately open
 * (docs/workflows.md, "Durable block waits": "the wait itself stays OPEN across a wake... only a
 * block's own future `finishWait` call ends it"). Block-agnostic, exactly like `runtime.ts` itself:
 * this module knows no block's own review-repair or merge-conflict policy, only the namespacing
 * `workflow-blocks/index.ts`'s compiler already gives every block use (`${blockNodeName}--
 * ${internalName}`, never colliding with a bare node name since `--` appears only as that
 * separator — docs/workflows.md, "Built-in blocks").
 *
 * Called from `job-store-worker.ts`'s `runWorkflowTransition`, after the transition itself is
 * decided, inside the SAME verdict transaction and per-root advisory lock — no additional locking
 * is needed here, exactly like the park it closes.
 */
import type { TransactionSql } from 'postgres';
import type { JobStorePrs } from '../job-store-types.js';
import type { Transition } from '../workflow-engine.js';
import type { WorkflowDefinition } from '../workflow-schema.js';
import { BLOCK_NAMESPACE_SEPARATOR } from './types.js';

/** The namespace a compiled node name belongs to, or null for a bare (non-block) node name. */
function scopeOf(nodeName: string): string | null {
    const separator = nodeName.indexOf(BLOCK_NAMESPACE_SEPARATOR);
    return separator === -1 ? null : nodeName.slice(0, separator);
}

export interface SettleBlockWaitsInput {
    rootJobId: string;
    /** The snapshot's own definition — where every node's `runtime` (if any) is read from. */
    snapshot: WorkflowDefinition;
    /** The node the just-completed transition evaluated its edges FROM (the halted node). */
    from: string;
    /** What `nextTransition` decided for this completion. */
    transition: Transition;
}

/**
 * Finishes every open wait a block's own internal nodes hold, the moment a transition takes the
 * thread OUT of that block's namespace — either by resting (an exhausted loop, an unmatched
 * marker, an oversized command) or by inserting a successor outside the block's own scope. An
 * insert that stays INSIDE the same block (its own internal round-trip: collect -> repair ->
 * reply -> collect, or a re-park into its own wait node) is not a departure and settles nothing —
 * the wait for a still-cycling block must stay open.
 *
 * `prs` absent (a workflow-less store, or a test harness that predates this seam) is a no-op, the
 * same defensive posture `enterRuntimeBoundary` takes.
 */
export async function settleBlockWaits(
    tx: TransactionSql,
    prs: JobStorePrs | undefined,
    input: SettleBlockWaitsInput
): Promise<void> {
    if (!prs) return;
    const scope = scopeOf(input.from);
    if (scope === null) return;
    if (input.transition.action === 'insert' && scopeOf(input.transition.node.name) === scope) return;

    const terminalReason =
        input.transition.action === 'insert' ? 'block exited' : `rested (${input.transition.reason})`;
    for (const node of input.snapshot.nodes) {
        if (node.runtime !== undefined && scopeOf(node.name) === scope) {
            await prs.finishWait(input.rootJobId, node.name, terminalReason, tx);
        }
    }
}
