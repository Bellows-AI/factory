/**
 * The store halves of revision-bound evidence: the thread's review evidence read off its rows (the
 * claim carries it to the driver), and the completion check run inside a verdict's transaction.
 * The rules themselves are pure and live in `evidence-policy.ts`.
 */

import type { TransactionSql } from 'postgres';
import {
    completionRefusal,
    type EvidencePolicy,
    type EvidenceRow,
    type RecordedEvidence,
    type ReviewEvidence,
    reviewEvidenceOf,
} from './evidence-policy.js';
import type { FailureKind, JobOutcome } from './job-store-types.js';
import { isPublishNode, type WorkflowDefinition } from './workflow-schema.js';

/** The thread's review evidence; a thread with no graph (objective mode) has no reviewer. */
export async function readReviewEvidence(
    tx: TransactionSql,
    ctx: { orgId: string; rootJobId: string },
    snapshot: WorkflowDefinition | null
): Promise<ReviewEvidence> {
    if (snapshot === null) return reviewEvidenceOf(null, []);
    const rows = await tx<EvidenceRow[]>`
        select workflow_node as node, status, output, evidence from job
        where org_id = ${ctx.orgId} and root_job_id = ${ctx.rootJobId}
        order by created_at, id
    `;
    return reviewEvidenceOf(snapshot, rows);
}

/** What `refuseCompletion` needs of the verdict row. */
export interface CompletionCheck {
    node: string | null;
    /** The thread's frozen graph; absent or null on an objective thread. */
    snapshot?: WorkflowDefinition | null | undefined;
    policy: EvidencePolicy | null;
    /** The verdict's evidence record; absent when the attempt reported none. */
    evidence?: RecordedEvidence | null | undefined;
}

/**
 * Whether a succeeded verdict may stand as completed work. Only the rows that END work are held to
 * the policy: an objective or off-graph row, and a graph's publish node. A mid-loop node (the
 * implement that precedes its review) completes without it. Returns the refusal, or null.
 */
async function refuseCompletion(
    tx: TransactionSql,
    row: { orgId: string; rootJobId: string },
    check: CompletionCheck
): Promise<string | null> {
    const { policy, node } = check;
    const snapshot = check.snapshot ?? null;
    if (!policy?.gates && !policy?.review) return null;
    const endsWork = node === null || (snapshot !== null && isPublishNode(snapshot, node));
    if (!endsWork) return null;
    const review = policy.review ? await readReviewEvidence(tx, row, snapshot) : ({ state: 'unavailable' } as const);
    return completionRefusal(policy, check.evidence ?? null, review);
}

/** The verdict as the thread will see it: what the workflow transition walks from. */
export interface SettledVerdict {
    status: JobOutcome;
    output: string | null;
    failureKind: FailureKind | null;
}

/**
 * The policy gate on completion, run inside the verdict's transaction: a succeeded verdict that
 * refuses is rewritten to a failed `policy` one — on the row and in the returned verdict — so the
 * thread never walks on from a success the evidence does not support. Anything else passes through.
 */
export async function enforceCompletionPolicy(
    tx: TransactionSql,
    row: { orgId: string; rootJobId: string; id: string },
    check: CompletionCheck,
    verdict: SettledVerdict
): Promise<SettledVerdict> {
    const refusal = verdict.status === 'succeeded' ? await refuseCompletion(tx, row, check) : null;
    if (refusal === null) return verdict;
    const refused: SettledVerdict = {
        status: 'failed',
        output: `${verdict.output ?? ''}\n[board] completion refused — ${refusal}`,
        failureKind: 'policy',
    };
    await tx`
        update job set status = ${refused.status}, failure_kind = ${refused.failureKind}, output = ${refused.output}
        where org_id = ${row.orgId} and id = ${row.id}
    `;
    return refused;
}
