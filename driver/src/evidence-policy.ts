/**
 * The evidence policy a repository's `.bellows.yaml` configures, applied at the one protected
 * action the driver owns — publication. Pure: nothing here touches the board, a runner or the
 * clock. Evidence is bound to the tree fingerprint it assessed (`git-probe.cjs`'s `HEAD:hash`), so
 * a pass for an earlier tree never authorises a later one. The board's completion check
 * (`server/src/db/evidence-policy.ts`) applies the same rules to the persisted record; the two
 * are copies, never imports — this package depends on nothing.
 */

/** Which evidence the repository requires before work may publish or complete. */
export interface EvidencePolicy {
    readonly gates?: boolean;
    readonly review?: boolean;
}

/** How the declared gates ended for the tree they ran over; `none` = no declared gates ran at all. */
export type GatesOutcome = 'passed' | 'failed' | 'incomplete' | 'none';

/** The gate evidence of one attempt: the outcome and the tree it assessed (null when unmeasured). */
export interface GatesEvidence {
    readonly outcome: GatesOutcome;
    readonly revision: string | null;
}

/**
 * The review evidence the board derives from the thread's rows. Only `approved` authorises, and it
 * names the tree the reviewer assessed; every other state is non-approving. `unavailable` — the
 * task has no reviewer at all — is distinct from a policy that requires one.
 */
export type ReviewEvidence =
    | { readonly state: 'unavailable' | 'missing' | 'incomplete' | 'rejected' }
    | { readonly state: 'approved'; readonly revision: string };

/** Whether the claim carries any requirement at all. */
export const evidencePolicyActive = (job: { policy?: EvidencePolicy }): boolean =>
    job.policy?.gates === true || job.policy?.review === true;

/** The attempt's verdict record read as gate evidence: the outcome and the tree the gates assessed. */
export const gatesEvidenceOf = (
    record: { gates: GatesOutcome; treeAfter: string | null } | null
): GatesEvidence | null => (record ? { outcome: record.gates, revision: record.treeAfter } : null);

export const REFUSAL_GATES_NONE = 'declared gates are required but none ran over this work';
export const REFUSAL_GATES_NOT_PASSED = 'declared gates are required and did not pass';
export const REFUSAL_GATES_UNMEASURED = 'declared gates passed, but the tree they assessed is unknown';
export const REFUSAL_REVIEW_UNAVAILABLE = 'a review is required but this task has no reviewer';
export const REFUSAL_REVIEW_MISSING = 'a review is required and none has run';
export const REFUSAL_REVIEW_INCOMPLETE =
    'a review is required, and the latest one is unfinished, failed or cancelled — an incomplete review does not approve';
export const REFUSAL_REVIEW_REJECTED = 'a review is required and the latest one found blocking issues';
export const REFUSAL_STALE = 'the required evidence assessed a different revision than the work now being shipped';

export type EvidenceDecision =
    | { readonly ok: true; readonly revision: string | null }
    | { readonly ok: false; readonly reason: string };

const REVIEW_REFUSALS = {
    unavailable: REFUSAL_REVIEW_UNAVAILABLE,
    missing: REFUSAL_REVIEW_MISSING,
    incomplete: REFUSAL_REVIEW_INCOMPLETE,
    rejected: REFUSAL_REVIEW_REJECTED,
} as const;

const refuse = (reason: string): EvidenceDecision => ({ ok: false, reason });

function gatesRefusal(gates: GatesEvidence | null): string | null {
    if (gates === null || gates.outcome === 'none') return REFUSAL_GATES_NONE;
    if (gates.outcome !== 'passed') return REFUSAL_GATES_NOT_PASSED;
    return gates.revision === null ? REFUSAL_GATES_UNMEASURED : null;
}

/**
 * Whether the configured requirements are met by the current evidence. No policy authorises with
 * no binding (today's behaviour). Otherwise the decision's `revision` is the tree the evidence
 * assessed, which the publish must still find in the checkout.
 */
export function evidenceDecision(
    policy: EvidencePolicy | null | undefined,
    gates: GatesEvidence | null,
    review: ReviewEvidence | null | undefined
): EvidenceDecision {
    if (!policy?.gates && !policy?.review) return { ok: true, revision: null };
    let revision: string | null = null;
    if (policy.gates) {
        const reason = gatesRefusal(gates);
        if (reason !== null) return refuse(reason);
        revision = gates?.revision ?? null;
    }
    if (policy.review) {
        const evidence = review ?? { state: 'unavailable' as const };
        if (evidence.state !== 'approved') return refuse(REVIEW_REFUSALS[evidence.state]);
        if (revision !== null && revision !== evidence.revision) return refuse(REFUSAL_STALE);
        revision ??= evidence.revision;
    }
    return { ok: true, revision };
}
