/**
 * The review verdict markers: the output contract a review turn ends on, matched exactly by a
 * workflow's marker edges and by the reviewer-profile evidence. The board ships no seeded workflow.
 */

/** The final line a review block must emit. The board's marker edges match exactly this. */
export const REVIEW_VERDICT_MARKER = 'VERDICT: CLEAN';
export const REVIEW_BLOCKERS_MARKER = 'VERDICT: BLOCKERS';
