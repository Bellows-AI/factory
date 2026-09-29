import { describe, expect, it } from 'vitest';
import { bucketizeActivity, pickBucketMs } from '../src/telemetry/run-activity.js';
import type { ActivityPoint } from '../src/telemetry/run-activity.js';

/**
 * The run-activity bucket reduction (issue #339): metric_point rows for ONE session reduced into
 * per-bucket token and edit figures over the run's wall clock. A flat line means stuck, a steady
 * bar means working — but only if the reduction is honest, which is where the double-count trap
 * lives: a delta counter sums, a cumulative counter must be differenced, and `sum(value)` over a
 * cumulative series produces a plausible, wildly wrong number (docs/metrics.md, 002's header).
 */

const FROM = '2026-09-22T10:00:00.000Z';
const FIFTEEN_MIN = 900_000;

const delta = (over: Partial<ActivityPoint>): ActivityPoint => ({
    field: 'tokens_input',
    temporality: 'delta',
    startTime: null,
    attrs: {},
    metric: 'claude_code.token.usage',
    agent: 'claude-code',
    value: 1,
    time: FROM,
    ...over,
});

describe('pickBucketMs', () => {
    it('picks the smallest bucket width that keeps the chart at 16 bars or fewer', () => {
        // A 2h run → 15-minute buckets, 8 of them — the issue's own example.
        expect(pickBucketMs(7_200_000)).toBe(FIFTEEN_MIN);
        expect(pickBucketMs(30 * 60_000)).toBe(300_000);
        expect(pickBucketMs(5 * 60_000)).toBe(60_000);
    });

    it('caps at the hour width for runs too long for the ladder', () => {
        expect(pickBucketMs(20 * 3_600_000)).toBe(3_600_000);
    });
});

describe('bucketizeActivity', () => {
    it('sums delta points into the bucket that contains them', () => {
        const points: ActivityPoint[] = [
            delta({ field: 'tokens_input', value: 2_000_000, time: '2026-09-22T10:05:00.000Z' }),
            delta({ field: 'tokens_output', value: 500_000, time: '2026-09-22T10:07:00.000Z' }),
            delta({ field: 'edits_accept', value: 3, time: '2026-09-22T10:20:00.000Z' }),
        ];
        const buckets = bucketizeActivity(points, {
            from: FROM,
            to: '2026-09-22T10:45:00.000Z',
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets).toHaveLength(3);
        expect(buckets[0]).toEqual({ start: FROM, tokens: 2_500_000, edits: 0 });
        expect(buckets[1]).toEqual({ start: '2026-09-22T10:15:00.000Z', tokens: 0, edits: 3 });
        expect(buckets[2]).toEqual({ start: '2026-09-22T10:30:00.000Z', tokens: 0, edits: 0 });
    });

    it('differences cumulative series instead of summing them', () => {
        // A cumulative counter reports the running total since start_time: 100 then 150 then 200
        // means 100 in the first bucket and 50 in each of the next two — a naive sum would read
        // 450 tokens in one bucket and invent the rest.
        const points: ActivityPoint[] = [
            delta({
                temporality: 'cumulative',
                startTime: FROM,
                field: 'tokens_input',
                value: 100,
                time: '2026-09-22T10:05:00.000Z',
            }),
            delta({
                temporality: 'cumulative',
                startTime: FROM,
                field: 'tokens_input',
                value: 150,
                time: '2026-09-22T10:20:00.000Z',
            }),
            delta({
                temporality: 'cumulative',
                startTime: FROM,
                field: 'tokens_input',
                value: 200,
                time: '2026-09-22T10:40:00.000Z',
            }),
        ];
        const buckets = bucketizeActivity(points, {
            from: FROM,
            to: '2026-09-22T10:45:00.000Z',
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets.map((b) => b.tokens)).toEqual([100, 50, 50]);
    });

    it('differences each cumulative series separately, so a counter reset starts over', () => {
        // Two start_times are two series: the second process's totals are NOT an increment on
        // the first's — differencing across them would go negative and lie about the shape.
        const points: ActivityPoint[] = [
            delta({
                temporality: 'cumulative',
                startTime: FROM,
                field: 'tokens_output',
                value: 100,
                time: '2026-09-22T10:05:00.000Z',
            }),
            delta({
                temporality: 'cumulative',
                startTime: '2026-09-22T10:30:00.000Z',
                field: 'tokens_output',
                value: 40,
                time: '2026-09-22T10:35:00.000Z',
            }),
        ];
        const buckets = bucketizeActivity(points, {
            from: FROM,
            to: '2026-09-22T10:45:00.000Z',
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets.map((b) => b.tokens)).toEqual([100, 0, 40]);
    });

    it('drops points outside the run window', () => {
        const points: ActivityPoint[] = [
            delta({ value: 5, time: '2026-09-22T09:55:00.000Z' }),
            delta({ value: 7, time: '2026-09-22T10:50:00.000Z' }),
            delta({ value: 3, time: '2026-09-22T10:05:00.000Z' }),
        ];
        const buckets = bucketizeActivity(points, {
            from: FROM,
            to: '2026-09-22T10:30:00.000Z',
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets.map((b) => b.tokens)).toEqual([3, 0]);
    });

    it('seeds every bucket in the window, so a quiet stretch renders as a quiet stretch', () => {
        const buckets = bucketizeActivity([], { from: FROM, to: '2026-09-22T11:00:00.000Z', bucketMs: FIFTEEN_MIN });
        expect(buckets).toHaveLength(4);
        expect(buckets.every((b) => b.tokens === 0 && b.edits === 0)).toBe(true);
    });
});
