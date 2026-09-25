import { describe, expect, it } from 'vitest';
import { isDirty } from '../src/panels/default-workflow-draft.js';

/**
 * The default-workflow settings panel's one comparison: the draft against the baseline it was
 * seeded from. All four saved/default combinations round-trip through this (the issue's
 * acceptance line), pinned pure because the suite has no DOM.
 */
describe('isDirty', () => {
    it('is clean when the draft matches the baseline, whatever the values are', () => {
        for (const reviewReconciliation of [true, false]) {
            for (const mergeConflictAutofix of [true, false]) {
                const pair = { reviewReconciliation, mergeConflictAutofix };
                expect(isDirty(pair, { ...pair })).toBe(false);
            }
        }
    });

    it('is dirty the moment either field diverges from the baseline', () => {
        const baseline = { reviewReconciliation: true, mergeConflictAutofix: true };
        expect(isDirty(baseline, { reviewReconciliation: false, mergeConflictAutofix: true })).toBe(true);
        expect(isDirty(baseline, { reviewReconciliation: true, mergeConflictAutofix: false })).toBe(true);
        expect(isDirty(baseline, { reviewReconciliation: false, mergeConflictAutofix: false })).toBe(true);
    });
});
