/** The default-workflow settings panel's editable pair — no `updatedAt`, which the draft never edits. */
export interface DefaultWorkflowDraft {
    reviewReconciliation: boolean;
    mergeConflictAutofix: boolean;
}

/** Whether the draft has moved from the baseline it was seeded from — the panel's one Save gate. */
export function isDirty(baseline: DefaultWorkflowDraft, draft: DefaultWorkflowDraft): boolean {
    return (
        baseline.reviewReconciliation !== draft.reviewReconciliation ||
        baseline.mergeConflictAutofix !== draft.mergeConflictAutofix
    );
}
