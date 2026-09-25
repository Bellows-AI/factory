import { describe, expect, it } from 'vitest';
import { dayKey, dayStart, isoWeekKey, ratio } from '../src/metrics.js';

// Invariants a plausible-but-wrong helper would violate.
describe('pure helpers', () => {
    it('returns null on a zero denominator rather than 0', () => {
        // "0 reverts in 0 commits" reads as a real answer; null is the only way to say
        // unavailable. The entire unavailable-vs-zero contract on the page rests on this.
        const NONZERO_NUMERATOR = 5;
        expect(ratio(0, 0)).toBeNull();
        expect(ratio(NONZERO_NUMERATOR, 0)).toBeNull();
    });

    it('puts the year boundary in the ISO week that owns the Thursday', () => {
        expect(isoWeekKey('2025-12-29T00:00:00Z')).toBe('2026-W01');
        expect(isoWeekKey('2026-01-04T00:00:00Z')).toBe('2026-W01');
        expect(isoWeekKey('2026-01-05T00:00:00Z')).toBe('2026-W02');
    });

    it('splits the UTC midnight, never a local one', () => {
        // The daily series' whole honesty rests on this boundary: 23:30 Monday and 00:15
        // Tuesday are adjacent instants that land in different buckets.
        expect(dayKey('2026-08-17T23:30:00Z')).toBe('2026-08-17');
        expect(dayKey('2026-08-18T00:15:00Z')).toBe('2026-08-18');
        expect(dayStart('2026-08-17T23:30:00Z').toISOString()).toBe('2026-08-17T00:00:00.000Z');
        expect(dayStart('2026-08-18T00:15:00Z').toISOString()).toBe('2026-08-18T00:00:00.000Z');
    });
});
