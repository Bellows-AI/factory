import { describe, expect, it } from 'vitest';
import { telemetryStats } from '../src/telemetry.js';
import { FIXTURE_NOW, FIXTURE_REPO, sampleTelemetry } from './fixtures/load.js';

/**
 * Recomputes the headline telemetry figures from the raw fixture without importing anything
 * from telemetry.ts, so a mistake on either side shows up as a mismatch rather than as two
 * agreeing wrong numbers.
 *
 * The aggregation is restated by hand below, deliberately. Importing the helpers would make a
 * wrong number invisible, which is the whole point of this file.
 */

const telemetry = sampleTelemetry();
const stats = telemetryStats(telemetry, { repos: [FIXTURE_REPO], now: FIXTURE_NOW });

const mine = telemetry.sessions.filter((s) => s.repo === FIXTURE_REPO);

describe('totals, recomputed by hand', () => {
    it('matches on each token type', () => {
        const add = (pick: (t: (typeof mine)[number]['tokens']) => number | null) =>
            mine.reduce((sum, s) => sum + (pick(s.tokens) ?? 0), 0);
        expect(stats.totals.tokens.input).toBe(add((t) => t.input));
        expect(stats.totals.tokens.output).toBe(add((t) => t.output));
        expect(stats.totals.tokens.cacheRead).toBe(add((t) => t.cacheRead));
        expect(stats.totals.tokens.cacheCreation).toBe(add((t) => t.cacheCreation));
    });

    it('matches on session count, lines, and active hours', () => {
        expect(stats.totals.sessions).toBe(mine.length);
        expect(stats.totals.linesAdded).toBe(mine.reduce((s, x) => s + (x.linesAdded ?? 0), 0));
        expect(stats.totals.linesRemoved).toBe(mine.reduce((s, x) => s + (x.linesRemoved ?? 0), 0));
        const seconds = mine.reduce((s, x) => s + (x.activeSeconds ?? 0), 0);
        expect(stats.totals.activeHours).toBeCloseTo(seconds / 3600, 9);
    });

    it('matches on the edit accept ratio', () => {
        const accepted = mine.reduce((s, x) => s + (x.editsAccepted ?? 0), 0);
        const rejected = mine.reduce((s, x) => s + (x.editsRejected ?? 0), 0);
        expect(stats.totals.acceptRatio).toBeCloseTo(accepted / (accepted + rejected), 12);
    });
});

describe('landmarks pinned against the fixture', () => {
    it('pins the fixture shape, so a silent regeneration is caught', () => {
        expect(telemetry.sessions).toHaveLength(15);
        expect(mine).toHaveLength(13);
        expect(telemetry.coverage.from).toBe('2026-04-15T12:00:00Z');
        expect(telemetry.coverage.to).toBe('2026-08-21T06:45:00Z');
    });

    it('emits a contiguous week series over the whole window', () => {
        const gaps = stats.weekly
            .map((w) => new Date(w.start).getTime())
            .map((t, i, all) => (i === 0 ? 7 : (t - (all[i - 1] as number)) / 86_400_000));
        expect(gaps.every((g) => g === 7)).toBe(true);
        expect(stats.weekly.length).toBeGreaterThan(15);
    });
});
