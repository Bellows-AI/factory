import { describe, expect, it } from 'vitest';
import { telemetryStats } from '../src/telemetry.js';
import type { SessionRollup, TelemetryInput } from '../src/types.js';
import { FIXTURE_NOW, FIXTURE_REPO, sampleTelemetry } from './fixtures/load.js';

const input = sampleTelemetry();
const stats = telemetryStats(input, { repos: [FIXTURE_REPO], now: FIXTURE_NOW });

const inScope = input.sessions.filter((s) => s.repo === FIXTURE_REPO);
const billable = (t: { input: number | null; output: number | null }) => (t.input ?? 0) + (t.output ?? 0);

const session = (over: Partial<SessionRollup>): SessionRollup => ({
    sessionId: 's',
    agent: 'claude-code',
    repo: FIXTURE_REPO,
    firstSeen: '2026-08-01T00:00:00.000Z',
    lastSeen: '2026-08-01T01:00:00.000Z',
    tokens: { input: 10, output: 5, cacheRead: null, cacheCreation: null },
    linesAdded: 1,
    linesRemoved: 0,
    editsAccepted: 1,
    editsRejected: 0,
    activeSeconds: 60,
    commits: 0,
    ...over,
});

describe('repo scoping', () => {
    it('separates the three session groups instead of conflating them', () => {
        // The two likeliest setup failures look identical on the page unless these are distinct.
        expect(stats.totals.sessions).toBe(inScope.length);
        expect(stats.otherRepoSessions).toBe(1);
        expect(stats.sessionsWithoutHook).toBe(1);
    });

    it('excludes another repo from the totals entirely', () => {
        // s09-other-repo is the largest session in the fixture, so a broken filter inflates this.
        expect(stats.totals.tokens.input).toBe(inScope.reduce((sum, s) => sum + (s.tokens.input ?? 0), 0));
    });
});

describe('totals, recomputed by hand', () => {
    it('matches on each token type', () => {
        const add = (pick: (t: (typeof mine)[number]['tokens']) => number | null) =>
            mine.reduce((sum, s) => sum + (pick(s.tokens) ?? 0), 0);
        const mine = inScope;
        expect(stats.totals.tokens.input).toBe(add((t) => t.input));
        expect(stats.totals.tokens.output).toBe(add((t) => t.output));
        expect(stats.totals.tokens.cacheRead).toBe(add((t) => t.cacheRead));
        expect(stats.totals.tokens.cacheCreation).toBe(add((t) => t.cacheCreation));
    });

    it('matches on session count, lines, and active hours', () => {
        expect(stats.totals.sessions).toBe(inScope.length);
        expect(stats.totals.linesAdded).toBe(inScope.reduce((s, x) => s + (x.linesAdded ?? 0), 0));
        expect(stats.totals.linesRemoved).toBe(inScope.reduce((s, x) => s + (x.linesRemoved ?? 0), 0));
        const seconds = inScope.reduce((s, x) => s + (x.activeSeconds ?? 0), 0);
        expect(stats.totals.activeHours).toBeCloseTo(seconds / 3600, 9);
    });

    it('matches on the edit accept ratio', () => {
        const accepted = inScope.reduce((s, x) => s + (x.editsAccepted ?? 0), 0);
        const rejected = inScope.reduce((s, x) => s + (x.editsRejected ?? 0), 0);
        expect(stats.totals.acceptRatio).toBeCloseTo(accepted / (accepted + rejected), 12);
    });
});

describe('output invariants', () => {
    it('seeds every week in the window rather than closing the gaps', () => {
        const gaps = stats.weekly
            .map((w) => new Date(w.start).getTime())
            .map((t, i, all) => (i === 0 ? 7 : (t - (all[i - 1] as number)) / 86_400_000));
        expect(gaps.every((g) => g === 7)).toBe(true);
        expect(stats.weekly.reduce((s, w) => s + w.sessions, 0)).toBe(inScope.length);
    });

    it('flags only the current week as partial', () => {
        expect(stats.weekly.filter((w) => w.partial)).toHaveLength(1);
        expect(stats.weekly[stats.weekly.length - 1]?.partial).toBe(true);
    });

    it('keeps every ratio null or within [0,1]', () => {
        if (stats.totals.acceptRatio === null) return;
        expect(stats.totals.acceptRatio).toBeGreaterThanOrEqual(0);
        expect(stats.totals.acceptRatio).toBeLessThanOrEqual(1);
    });

    it('contains no NaN anywhere', () => {
        const bad: string[] = [];
        const walk = (value: unknown, path: string) => {
            if (typeof value === 'number' && Number.isNaN(value)) bad.push(path);
            else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
            else if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
            }
        };
        walk(stats, 'telemetry');
        expect(bad).toEqual([]);
    });

    it('exposes no monetary field anywhere', () => {
        // Cost is deliberately out of scope. This stops it returning via a "small addition".
        const keys: string[] = [];
        const walk = (value: unknown) => {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) {
                    keys.push(k.toLowerCase());
                    walk(v);
                }
            }
        };
        walk(stats);
        for (const forbidden of ['cost', 'usd', 'price', 'costusd', 'dollars']) {
            expect(keys).not.toContain(forbidden);
        }
    });

    it('never sums the four token types into one figure', () => {
        // A long cached conversation would count the same context repeatedly.
        expect(billable(stats.totals.tokens)).toBe(
            (stats.totals.tokens.input ?? 0) + (stats.totals.tokens.output ?? 0)
        );
        expect(Object.keys(stats.totals.tokens).sort()).toEqual(['cacheCreation', 'cacheRead', 'input', 'output']);
    });
});

describe('the null-not-zero contract', () => {
    it('reports an empty store as zero sessions with null tokens, not zeros', () => {
        const empty = telemetryStats(
            { sessions: [], coverage: { from: null, to: null } },
            { repos: [FIXTURE_REPO], now: FIXTURE_NOW }
        );
        expect(empty.totals.sessions).toBe(0);
        expect(empty.totals.tokens.input).toBeNull();
        expect(empty.totals.acceptRatio).toBeNull();
        expect(empty.weekly).toEqual([]);
    });

    it('returns a null accept ratio when nothing was measured, and 1 when everything was accepted', () => {
        const nothing = telemetryStats(
            { sessions: [session({ editsAccepted: null, editsRejected: null })], coverage: { from: null, to: null } },
            { now: FIXTURE_NOW }
        );
        expect(nothing.totals.acceptRatio).toBeNull();

        const all = telemetryStats(
            { sessions: [session({ editsAccepted: 5, editsRejected: 0 })], coverage: { from: null, to: null } },
            { now: FIXTURE_NOW }
        );
        expect(all.totals.acceptRatio).toBe(1);
    });
});

describe('coverage and scope edges', () => {
    it('passes coverage through untouched', () => {
        expect(stats.coverage).toEqual(input.coverage);
    });

    it('counts everything when no repo filter is given', () => {
        const all = telemetryStats(input, { now: FIXTURE_NOW });
        expect(all.otherRepoSessions).toBe(0);
        expect(all.sessionsWithoutHook).toBe(1);
        expect(all.totals.sessions).toBe(input.sessions.length - 1);
    });
});
