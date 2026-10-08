/**
 * Revision-bound evidence, board side: what a thread's rows say about the review, and whether a
 * verdict's persisted evidence satisfies the repository's policy. Pure. The driver applies the
 * same rules before a publish (`driver/src/evidence-policy.ts`) — a copy, not an import, because
 * that package depends on nothing; `server/test/evidence-policy.test.ts` pins the shared spellings.
 */

import { type WorkflowDefinition, tailMatches } from './workflow-schema.js';
import { REVIEW_BLOCKERS_MARKER, REVIEW_VERDICT_MARKER } from './workflow-templates.js';

export interface EvidencePolicy {
    gates?: boolean;
    review?: boolean;
}

export type GatesOutcome = 'passed' | 'failed' | 'incomplete' | 'none';

/** One attempt's record, as the driver reports it and the row persists it. */
export interface RecordedEvidence {
    treeBefore: string | null;
    treeAfter: string | null;
    gates: GatesOutcome;
}

export const GATES_OUTCOMES: readonly GatesOutcome[] = ['passed', 'failed', 'incomplete', 'none'];

export type ReviewEvidence =
    | { state: 'unavailable' | 'missing' | 'incomplete' | 'rejected' }
    | { state: 'approved'; revision: string };

/** The rows of one thread this derivation reads. */
export interface EvidenceRow {
    node: string | null;
    status: string;
    output: string | null;
    evidence: RecordedEvidence | null;
    /** A named-profile review run (issue #549): a row of its own thread, linked to the caller it assessed. */
    reviewProfile?: boolean;
    /** The tree fingerprint the caller asked this review to assess — the revision its verdict is bound to. */
    reviewRevision?: string | null;
}

const isReviewNode = (snapshot: WorkflowDefinition | null, name: string | null): boolean =>
    snapshot?.nodes.some((node) => node.name === name && node.review === true) ?? false;

/** A graph reviewer node's row, or a named-profile review's. */
const isReviewRow = (snapshot: WorkflowDefinition | null, row: EvidenceRow): boolean =>
    row.reviewProfile === true || isReviewNode(snapshot, row.node);

/** The revision a review row's verdict stands for: what the caller asked about, else the tree the node started from. */
const revisionOf = (row: EvidenceRow): string | null =>
    row.reviewProfile === true ? (row.reviewRevision ?? null) : (row.evidence?.treeBefore ?? null);

/**
 * The review evidence a thread carries. `unavailable` — no node of the graph is a reviewer and no
 * reviewer profile is declared or has run — is distinct from the policy requiring one. The LATEST
 * review row decides, and only a succeeded row ending on the clean verdict marker, with a recorded
 * revision, approves; queued, running, failed, dead, stopped and marker-less rows never do. A graph
 * node's row is bound to the tree it started from, a profile row to the revision its caller asked
 * about. Rows are oldest first.
 */
export function reviewEvidenceOf(
    snapshot: WorkflowDefinition | null,
    rows: readonly EvidenceRow[],
    profilesDeclared = false
): ReviewEvidence {
    const graphReviewer = snapshot?.nodes.some((node) => node.review === true) ?? false;
    const latest = rows.findLast((row) => isReviewRow(snapshot, row));
    if (!graphReviewer && !profilesDeclared && latest === undefined) return { state: 'unavailable' };
    if (latest === undefined) return { state: 'missing' };
    if (latest.status !== 'succeeded') return { state: 'incomplete' };
    if (tailMatches(latest.output, REVIEW_BLOCKERS_MARKER)) return { state: 'rejected' };
    const revision = revisionOf(latest);
    if (!tailMatches(latest.output, REVIEW_VERDICT_MARKER) || revision === null) return { state: 'incomplete' };
    return { state: 'approved', revision };
}

export const REFUSAL_GATES_NONE = 'declared gates are required but none ran over this work';
export const REFUSAL_GATES_NOT_PASSED = 'declared gates are required and did not pass';
export const REFUSAL_GATES_UNMEASURED = 'declared gates passed, but the tree they assessed is unknown';
export const REFUSAL_REVIEW_UNAVAILABLE = 'a review is required but this task has no reviewer';
export const REFUSAL_REVIEW_MISSING = 'a review is required and none has run';
export const REFUSAL_REVIEW_INCOMPLETE =
    'a review is required, and the latest one is unfinished, failed or cancelled — an incomplete review does not approve';
export const REFUSAL_REVIEW_REJECTED = 'a review is required and the latest one found blocking issues';
export const REFUSAL_STALE = 'the required evidence assessed a different revision than the work now being shipped';
export const REFUSAL_NO_EVIDENCE = 'the verdict carries no evidence record';

const REVIEW_REFUSALS = {
    unavailable: REFUSAL_REVIEW_UNAVAILABLE,
    missing: REFUSAL_REVIEW_MISSING,
    incomplete: REFUSAL_REVIEW_INCOMPLETE,
    rejected: REFUSAL_REVIEW_REJECTED,
} as const;

function gatesRefusal(evidence: RecordedEvidence | null): string | null {
    if (evidence === null || evidence.gates === 'none') return REFUSAL_GATES_NONE;
    if (evidence.gates !== 'passed') return REFUSAL_GATES_NOT_PASSED;
    return evidence.treeAfter === null ? REFUSAL_GATES_UNMEASURED : null;
}

/** Why a verdict may not complete the work under `policy`, or null when its evidence suffices. */
export function completionRefusal(
    policy: EvidencePolicy | null,
    evidence: RecordedEvidence | null,
    review: ReviewEvidence
): string | null {
    if (!policy?.gates && !policy?.review) return null;
    if (policy.gates) {
        const reason = gatesRefusal(evidence);
        if (reason !== null) return reason;
    }
    if (policy.review) {
        if (review.state !== 'approved') return REVIEW_REFUSALS[review.state];
        // The tree the work stands in now: what the gates assessed, else what the run started from.
        const current = evidence?.treeAfter ?? evidence?.treeBefore ?? null;
        if (current === null) return REFUSAL_NO_EVIDENCE;
        if (current !== review.revision) return REFUSAL_STALE;
    }
    return null;
}
