import { describe, expect, it } from 'vitest';
import { ALL_TIME, filterTelemetryInput, isAllTime, resolveRange } from '../src/range.js';
import type { DateRange } from '../src/range.js';
import type { SessionRollup, TelemetryInput } from '../src/types.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');

function session(over: Partial<SessionRollup>): SessionRollup {
    return {
        sessionId: 's',
        agent: 'claude-code',
        repo: 'o/r',
        firstSeen: '2026-08-11T00:00:00.000Z',
        lastSeen: '2026-08-11T01:00:00.000Z',
        tokens: { input: 10, output: 5, cacheRead: null, cacheCreation: null },
        linesAdded: 1,
        linesRemoved: 0,
        editsAccepted: 1,
        editsRejected: 0,
        activeSeconds: 60,
        commits: 0,
        ...over,
    };
}

const august: DateRange = {
    preset: 'custom',
    from: '2026-08-10T00:00:00.000Z',
    to: '2026-08-20T00:00:00.000Z',
};

describe('resolveRange', () => {
    it('makes presets a rolling lookback from now, not a calendar period', () => {
        expect(resolveRange('day', NOW)).toEqual({
            preset: 'day',
            from: '2026-08-20T12:00:00.000Z',
            to: '2026-08-21T12:00:00.000Z',
        });
        expect(resolveRange('2w', NOW).from).toBe('2026-08-07T12:00:00.000Z');
        expect(resolveRange('month', NOW).from).toBe('2026-07-22T12:00:00.000Z');
    });

    it('leaves all-time unbounded on both ends', () => {
        expect(resolveRange('all', NOW)).toEqual(ALL_TIME);
        expect(isAllTime(resolveRange('all', NOW))).toBe(true);
    });

    it('keeps a half-open custom range half-open', () => {
        expect(resolveRange('custom', NOW, { from: '2026-08-01T00:00:00.000Z' })).toEqual({
            preset: 'custom',
            from: '2026-08-01T00:00:00.000Z',
            to: null,
        });
    });
});

describe('filterTelemetryInput', () => {
    const input: TelemetryInput = {
        sessions: [
            session({ sessionId: 'inside' }),
            session({
                sessionId: 'straddles',
                firstSeen: '2026-08-09T00:00:00.000Z',
                lastSeen: '2026-08-10T06:00:00.000Z',
                tokens: { input: 1, output: 1, cacheRead: null, cacheCreation: null },
                activeSeconds: 1,
            }),
            session({
                sessionId: 'before',
                firstSeen: '2026-07-01T00:00:00.000Z',
                lastSeen: '2026-07-01T01:00:00.000Z',
                tokens: { input: 99, output: 99, cacheRead: null, cacheCreation: null },
                activeSeconds: 1,
            }),
        ],
        coverage: { from: '2026-07-01T00:00:00.000Z', to: '2026-08-21T00:00:00.000Z' },
    };

    it('keeps a session that overlaps the range, not only one contained by it', () => {
        const out = filterTelemetryInput(input, august);
        expect(out.sessions.map((s) => s.sessionId)).toEqual(['inside', 'straddles']);
    });

    it('treats the bounds as inclusive from, exclusive to', () => {
        const edge = filterTelemetryInput(
            {
                sessions: [
                    session({ sessionId: 'on-from', firstSeen: august.from as string, lastSeen: august.from as string }),
                    session({ sessionId: 'on-to', firstSeen: august.to as string, lastSeen: august.to as string }),
                ],
                coverage: input.coverage,
            },
            august,
        );
        expect(edge.sessions.map((s) => s.sessionId)).toEqual(['on-from']);
    });

    it('leaves coverage alone, so "no usage in range" stays distinct from "no data that far back"', () => {
        expect(filterTelemetryInput(input, august).coverage).toEqual(input.coverage);
    });
});
