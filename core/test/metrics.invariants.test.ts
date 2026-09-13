import { describe, expect, it } from 'vitest';
import { isoWeekKey, ratio } from '../src/metrics.js';

// Invariants a plausible-but-wrong helper would violate.
describe('pure helpers', () => {
    it('returns null on a zero denominator rather than 0', () => {
        // "0 reverts in 0 commits" reads as a real answer; null is the only way to say
        // unavailable. The entire unavailable-vs-zero contract on the page rests on this.
        expect(ratio(0, 0)).toBeNull();
        expect(ratio(5, 0)).toBeNull();
    });

    it('puts the year boundary in the ISO week that owns the Thursday', () => {
        expect(isoWeekKey('2025-12-29T00:00:00Z')).toBe('2026-W01');
        expect(isoWeekKey('2026-01-04T00:00:00Z')).toBe('2026-W01');
        expect(isoWeekKey('2026-01-05T00:00:00Z')).toBe('2026-W02');
    });
});
