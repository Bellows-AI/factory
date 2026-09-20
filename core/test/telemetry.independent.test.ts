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

    it('matches on the edit acceptance', () => {
        const accepted = mine.reduce((s, x) => s + (x.editsAccepted ?? 0), 0);
        const rejected = mine.reduce((s, x) => s + (x.editsRejected ?? 0), 0);
        expect(stats.totals.editAcceptance.accepted).toBe(accepted);
        expect(stats.totals.editAcceptance.rejected).toBe(rejected);
        expect(stats.totals.editAcceptance.decisions).toBe(accepted + rejected);
        expect(stats.totals.editAcceptance.ratio).toBeCloseTo(accepted / (accepted + rejected), 12);
    });
});

describe('caller scope, recomputed by hand', () => {
    // Same fixture, scoped to alice: the hand restatement below filters the raw sessions the
    // same way the scope option claims to, so a wrong filter shows as a mismatch.
    const ALICE_ID = 'u-alice';
    const mine = telemetryStats(telemetry, { repos: [FIXTURE_REPO], now: FIXTURE_NOW, user: { id: ALICE_ID } });
    const aliceSessions = mine0();

    function mine0() {
        return telemetry.sessions.filter((s) => s.repo === FIXTURE_REPO && s.user?.id === ALICE_ID);
    }

    it("totals exactly the caller's attributed sessions", () => {
        expect(mine.totals.sessions).toBe(aliceSessions.length);
        expect(mine.totals.tokens.input).toBe(aliceSessions.reduce((sum, s) => sum + (s.tokens.input ?? 0), 0));
        expect(mine.totals.tokens.output).toBe(aliceSessions.reduce((sum, s) => sum + (s.tokens.output ?? 0), 0));
        expect(mine.totals.sessions).toBe(5);
    });

    it('still names the unattributed sessions the scope dropped', () => {
        const unattributed = telemetry.sessions.filter((s) => s.repo === FIXTURE_REPO && s.user === null).length;
        expect(mine.unattributedSessions).toBe(unattributed);
        expect(unattributed).toBe(4);
    });

    it('leaves coverage untouched', () => {
        expect(mine.coverage).toEqual(telemetry.coverage);
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
        // No range passed: the coverage span (about four months) picks weekly buckets.
        expect(stats.series.granularity).toBe('week');
        const gaps = stats.series.points
            .map((w) => new Date(w.start).getTime())
            .map((t, i, all) => (i === 0 ? 7 : (t - (all[i - 1] as number)) / 86_400_000));
        expect(gaps.every((g) => g === 7)).toBe(true);
        expect(stats.series.points.length).toBeGreaterThan(15);
    });
});
