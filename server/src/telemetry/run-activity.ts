/**
 * The per-run activity reduction (issue #339): the `metric_point` rows of ONE session, bucketed
 * over the run's wall clock into token and edit figures a small chart can draw. A flat line means
 * stuck; a steady bar means working — the "was the run making progress" answer, read off data the
 * ingest already holds.
 *
 * The reduction lives here rather than in SQL for the same reason the week bucketing lives in
 * core (docs/metrics.md): the temporality-aware rule is the one correctness hazard in the feature,
 * and it is unit-testable only as plain code. A delta counter SUMS into its bucket; a cumulative
 * counter must be differenced per series — `sum(value)` over a cumulative series produces a
 * plausible, wildly wrong number (002_views.repeatable.sql's header, and test-db covers both
 * shapes).
 */

/** One raw `metric_point_used` row, as the SQL read lifts it. */
export interface ActivityPoint {
    field: string;
    temporality: string;
    /** The cumulative counter's series start; null on a delta point. */
    startTime: string | null;
    attrs: Record<string, string>;
    metric: string;
    agent: string;
    value: number;
    time: string;
}

/** One bucket of the run's wall clock: tokens processed and edit decisions made inside it. */
export interface ActivityBucket {
    start: string;
    tokens: number;
    edits: number;
}

/** The bucket-width ladder, narrow to wide. */
const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 300_000;
const FIFTEEN_MINUTES_MS = 900_000;
const THIRTY_MINUTES_MS = 1_800_000;
const HOUR_MS = 3_600_000;
const LADDER_MS = [MINUTE_MS, FIVE_MINUTES_MS, FIFTEEN_MINUTES_MS, THIRTY_MINUTES_MS, HOUR_MS] as const;
/** The chart's bar budget: beyond ~16 bars a run-activity chart renders hairlines, not shapes. */
const MAX_BUCKETS = 16;

/** Smallest ladder width giving at most `MAX_BUCKETS` bars over the run; the hour beyond it. */
export function pickBucketMs(runMs: number): number {
    for (const width of LADDER_MS) {
        if (Math.ceil(runMs / width) <= MAX_BUCKETS) return width;
    }
    return LADDER_MS[LADDER_MS.length - 1]!;
}

/** The fields that read as "tokens processed"; the sum the dashboard's own totals use. */
const TOKEN_FIELDS: ReadonlySet<string> = new Set([
    'tokens_input',
    'tokens_output',
    'tokens_cacheRead',
    'tokens_cacheCreation',
]);

/** The fields that read as "edit decisions made". */
const EDIT_FIELDS: ReadonlySet<string> = new Set(['edits_accept', 'edits_reject']);

/** A cumulative series is keyed by everything that distinguishes one counter from another. */
const seriesKeyOf = (point: ActivityPoint): string =>
    [point.agent, point.metric, point.field, point.startTime ?? '', JSON.stringify(point.attrs)].join('|');

/**
 * Folds one parked cumulative series into the buckets as consecutive differences — the running
 * total's increment within each bucket. A counter reset inside one series would difference
 * negative; clamped to 0, which undercounts rather than inverts a bar.
 */
function foldCumulative(
    series: { isToken: boolean; maxes: (number | null)[] },
    buckets: ActivityBucket[],
    count: number
): void {
    let previous = 0;
    for (let i = 0; i < count; i += 1) {
        const value = series.maxes[i] ?? null;
        if (value === null) continue;
        const increment = Math.max(0, value - previous);
        previous = value;
        if (series.isToken) buckets[i]!.tokens += increment;
        else buckets[i]!.edits += increment;
    }
}

/** One cumulative point's parking slot: which series map, and whether it reads as tokens. */
interface ParkTarget {
    cumulative: Map<string, { isToken: boolean; maxes: (number | null)[] }>;
    point: ActivityPoint;
    isToken: boolean;
    index: number;
    count: number;
}

/**
 * Parks one cumulative point's value as its series' bucket max — the series keyed by everything
 * that distinguishes one counter from another — for pass two's differencing.
 */
function parkCumulative(target: ParkTarget): void {
    const key = seriesKeyOf(target.point);
    const series = target.cumulative.get(key) ?? {
        isToken: target.isToken,
        maxes: Array.from({ length: target.count }, () => null),
    };
    const current = series.maxes[target.index] ?? null;
    series.maxes[target.index] = current === null ? target.point.value : Math.max(current, target.point.value);
    target.cumulative.set(key, series);
}

/**
 * Pass one over the points: deltas sum straight into their bucket; cumulatives park their max
 * per bucket, per series, for pass two's differencing. Out-of-window and unchartable field
 * points fall out here.
 */
function parkPoints(
    points: readonly ActivityPoint[],
    buckets: ActivityBucket[],
    window: { fromMs: number; toMs: number; count: number; bucketMs: number }
): Map<string, { isToken: boolean; maxes: (number | null)[] }> {
    const cumulative = new Map<string, { isToken: boolean; maxes: (number | null)[] }>();
    for (const point of points) {
        const timeMs = Date.parse(point.time);
        if (!Number.isFinite(timeMs) || timeMs < window.fromMs || timeMs > window.toMs) continue;
        const isToken = TOKEN_FIELDS.has(point.field);
        const isEdit = EDIT_FIELDS.has(point.field);
        if (!isToken && !isEdit) continue;
        const index = bucketIndexOf(timeMs, window.fromMs, window.bucketMs, window.count);
        if (point.temporality !== 'cumulative') {
            if (isToken) buckets[index]!.tokens += point.value;
            else buckets[index]!.edits += point.value;
            continue;
        }
        parkCumulative({ cumulative, point, isToken, index, count: window.count });
    }
    return cumulative;
}

/** The bucket a timestamp lands in, clamped into the seeded range. */
function bucketIndexOf(timeMs: number, fromMs: number, bucketMs: number, count: number): number {
    const index = Math.floor((timeMs - fromMs) / bucketMs);
    return Math.min(Math.max(index, 0), count - 1);
}

/**
 * Buckets the points over `[from, to]` at `bucketMs`, seeding every bucket in the window — a
 * quiet stretch renders as a quiet stretch, never a gap. Delta points sum into the bucket that
 * contains them; cumulative points are reduced per series (max per bucket, then consecutive
 * differences against a 0 baseline — a run's counters start at the run's start), with a negative
 * difference clamped to 0 rather than allowed to invert a bar. Points outside the window, and
 * fields this reduction does not chart, fall out.
 */
export function bucketizeActivity(
    points: readonly ActivityPoint[],
    opts: { from: string; to: string; bucketMs: number }
): ActivityBucket[] {
    const fromMs = Date.parse(opts.from);
    const toMs = Date.parse(opts.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || opts.bucketMs <= 0) return [];
    const count = Math.max(1, Math.ceil((toMs - fromMs) / opts.bucketMs));
    const buckets: ActivityBucket[] = Array.from({ length: count }, (_, i) => ({
        start: new Date(fromMs + i * opts.bucketMs).toISOString(),
        tokens: 0,
        edits: 0,
    }));
    const cumulative = parkPoints(points, buckets, { fromMs, toMs, count, bucketMs: opts.bucketMs });
    // Pass two: difference each cumulative series down the buckets and fold that in like a delta.
    for (const series of cumulative.values()) foldCumulative(series, buckets, count);
    return buckets;
}
