import { describe, expect, it } from 'vitest';
import {
    evidenceDecision,
    REFUSAL_GATES_NONE,
    REFUSAL_GATES_NOT_PASSED,
    REFUSAL_GATES_UNMEASURED,
    REFUSAL_REVIEW_INCOMPLETE,
    REFUSAL_REVIEW_MISSING,
    REFUSAL_REVIEW_REJECTED,
    REFUSAL_REVIEW_UNAVAILABLE,
    REFUSAL_STALE,
} from '../src/evidence-policy.js';

const passed = (revision: string | null) => ({ outcome: 'passed' as const, revision });

describe('evidenceDecision', () => {
    it('authorises with no binding when nothing is configured', () => {
        expect(evidenceDecision(null, null, null)).toEqual({ ok: true, revision: null });
        expect(evidenceDecision({}, null, null)).toEqual({ ok: true, revision: null });
    });

    it.each([
        ['none ran', { outcome: 'none' as const, revision: null }, REFUSAL_GATES_NONE],
        ['no record', null, REFUSAL_GATES_NONE],
        ['failed', { outcome: 'failed' as const, revision: 'r1' }, REFUSAL_GATES_NOT_PASSED],
        ['incomplete', { outcome: 'incomplete' as const, revision: 'r1' }, REFUSAL_GATES_NOT_PASSED],
        ['passed on an unknown tree', passed(null), REFUSAL_GATES_UNMEASURED],
    ])('refuses required gates when %s', (_name, gates, reason) => {
        expect(evidenceDecision({ gates: true }, gates, null)).toEqual({ ok: false, reason });
    });

    it('binds the gates revision when the gates passed', () => {
        expect(evidenceDecision({ gates: true }, passed('r1'), null)).toEqual({ ok: true, revision: 'r1' });
    });

    it.each([
        ['unavailable', { state: 'unavailable' as const }, REFUSAL_REVIEW_UNAVAILABLE],
        ['missing', { state: 'missing' as const }, REFUSAL_REVIEW_MISSING],
        ['incomplete', { state: 'incomplete' as const }, REFUSAL_REVIEW_INCOMPLETE],
        ['rejected', { state: 'rejected' as const }, REFUSAL_REVIEW_REJECTED],
        ['absent', null, REFUSAL_REVIEW_UNAVAILABLE],
    ])('refuses a required review that is %s, each with its own reason', (_name, review, reason) => {
        expect(evidenceDecision({ review: true }, null, review)).toEqual({ ok: false, reason });
    });

    it('binds the review revision when only a review is required', () => {
        expect(evidenceDecision({ review: true }, null, { state: 'approved', revision: 'r2' })).toEqual({
            ok: true,
            revision: 'r2',
        });
    });

    it('refuses evidence that assessed different revisions', () => {
        expect(
            evidenceDecision({ gates: true, review: true }, passed('r1'), { state: 'approved', revision: 'r2' })
        ).toEqual({
            ok: false,
            reason: REFUSAL_STALE,
        });
    });

    it('authorises gates and review over the same revision', () => {
        expect(
            evidenceDecision({ gates: true, review: true }, passed('r1'), { state: 'approved', revision: 'r1' })
        ).toEqual({
            ok: true,
            revision: 'r1',
        });
    });
});
