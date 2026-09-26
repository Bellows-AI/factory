import { describe, expect, it } from 'vitest';
import { HIDDEN_REFRESH_MS, nextStatsPollDelay, POLL_MS, VISIBLE_REFRESH_MS } from '../src/api/useStats.js';

/**
 * The stats poll's cadence. The regression it pins: a 200 used to end the chain, so a dashboard
 * opened before a run's telemetry landed kept rendering the empty snapshot indefinitely.
 */
describe('nextStatsPollDelay', () => {
    it('keeps refreshing a fresh snapshot while the dashboard is open', () => {
        expect(nextStatsPollDelay('fresh', true, false)).toBe(VISIBLE_REFRESH_MS);
        expect(nextStatsPollDelay('fresh', true, true)).toBe(HIDDEN_REFRESH_MS);
    });

    it('asks again at the progress pace for a stale snapshot in a visible dashboard', () => {
        expect(nextStatsPollDelay('stale', true, false)).toBe(POLL_MS);
        expect(nextStatsPollDelay('stale', true, true)).toBe(HIDDEN_REFRESH_MS);
    });

    it('does not end the chain on a failed read while the dashboard is open', () => {
        expect(nextStatsPollDelay('error', true, false)).toBe(VISIBLE_REFRESH_MS);
        expect(nextStatsPollDelay('error', true, true)).toBe(HIDDEN_REFRESH_MS);
    });

    it('polls a cold read on every page', () => {
        expect(nextStatsPollDelay('progress', true, false)).toBe(POLL_MS);
        expect(nextStatsPollDelay('progress', false, true)).toBe(POLL_MS);
    });

    it('stops after a completed read off the dashboard', () => {
        for (const outcome of ['fresh', 'stale', 'error'] as const) {
            expect(nextStatsPollDelay(outcome, false, false)).toBeNull();
        }
    });
});
