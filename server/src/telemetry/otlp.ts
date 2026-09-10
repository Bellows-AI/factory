import { agentOf, canonicalField } from './metric-map.js';
import type { CanonicalField } from './metric-map.js';

/**
 * Flattens an OTLP/JSON export into rows.
 *
 * Pure and separate from the insert on purpose: the wire format is the awkward part, and
 * keeping it here means it can be tested exhaustively with no database and no network.
 */

/**
 * Attributes are ALLOWLISTED, not denylisted. A future Claude Code version can add an
 * identity attribute, and a denylist would silently start storing it. Everything not named
 * here is dropped, which is why `user.email`, `user.id`, `user.account_uuid`,
 * `organization.id` and `workspace.host_paths` never reach the database.
 */
const ATTR_ALLOWLIST = new Set([
    'session.id',
    'agent',
    'type',
    'model',
    'query_source',
    'speed',
    'effort',
    'tool_name',
    'decision',
    'source',
    'terminal.type',
    'app.version',
]);

/**
 * Metric names, by contrast, are DENYLISTED. An unknown metric from a future tool must still
 * be stored so its data accumulates before support is written; only cost is actively refused,
 * because it is out of scope and should never land in the volume at all.
 */
const METRIC_DENYLIST = new Set(['claude_code.cost.usage', 'opencode.cost.usage']);

export interface MetricRow {
    agent: string;
    metric: string;
    field: CanonicalField | null;
    sessionId: string | null;
    value: number;
    temporality: 'delta' | 'cumulative' | 'unspecified';
    startTime: string | null;
    time: string;
    attrs: Record<string, string>;
}

export interface FlattenResult {
    rows: MetricRow[];
    /** Reported rather than thrown: a shape we cannot read must not fail the whole export. */
    skipped: { histogram: number; noValue: number; deniedMetric: number };
}

interface AnyValue {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
    arrayValue?: unknown;
}

function scalar(value: AnyValue | undefined): string | null {
    if (!value) return null;
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.intValue !== undefined) return String(value.intValue);
    if (value.doubleValue !== undefined) return String(value.doubleValue);
    if (value.boolValue !== undefined) return String(value.boolValue);
    // arrayValue and kvlistValue are structured; there is no scalar reading, so drop them
    // rather than stringifying something nobody can query.
    return null;
}

function attributes(list: { key: string; value: AnyValue }[] | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { key, value } of list ?? []) {
        if (!ATTR_ALLOWLIST.has(key)) continue;
        const text = scalar(value);
        if (text !== null) out[key] = text;
    }
    return out;
}

/**
 * OTLP timestamps are nanoseconds. Dividing by 1e9 instead of 1e6 puts every point in 1970,
 * which makes the branch join return nothing — a failure that looks like a broken hook rather
 * than a broken parser.
 */
function isoFromNanos(nanos: string | number | undefined): string | null {
    if (nanos === undefined || nanos === null || nanos === '') return null;
    const ms = Number(BigInt(nanos) / 1_000_000n);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function temporalityOf(raw: unknown): MetricRow['temporality'] {
    if (raw === 1 || raw === 'AGGREGATION_TEMPORALITY_DELTA') return 'delta';
    if (raw === 2 || raw === 'AGGREGATION_TEMPORALITY_CUMULATIVE') return 'cumulative';
    return 'unspecified';
}

/** `asInt` is a string-encoded int64 in OTLP/JSON, so Number() is required, not assumed. */
function numeric(point: { asInt?: string | number; asDouble?: number }): number | null {
    if (point.asDouble !== undefined && point.asDouble !== null) return Number(point.asDouble);
    if (point.asInt !== undefined && point.asInt !== null) return Number(point.asInt);
    return null;
}

export function flattenMetrics(body: unknown): FlattenResult {
    const rows: MetricRow[] = [];
    const skipped = { histogram: 0, noValue: 0, deniedMetric: 0 };

    const resourceMetrics = (body as { resourceMetrics?: unknown[] })?.resourceMetrics ?? [];
    for (const resource of resourceMetrics as Record<string, never>[]) {
        // Resource attributes are promoted onto every datapoint, because that is where
        // OTEL_RESOURCE_ATTRIBUTES keys arrive and datapoint attributes are what we query.
        const resourceAttrs = attributes(
            (resource['resource'] as { attributes?: { key: string; value: AnyValue }[] } | undefined)
                ?.attributes,
        );

        for (const scope of (resource['scopeMetrics'] as unknown as Record<string, never>[] | undefined) ?? []) {
            for (const metric of (scope['metrics'] as unknown as Record<string, never>[] | undefined) ?? []) {
                const name = metric['name'] as unknown as string;
                if (typeof name !== 'string' || !name) continue;
                if (METRIC_DENYLIST.has(name)) {
                    skipped.deniedMetric += 1;
                    continue;
                }
                if (metric['histogram'] || metric['exponentialHistogram'] || metric['summary']) {
                    skipped.histogram += 1;
                    continue;
                }

                const sum = metric['sum'] as
                    | { dataPoints?: unknown[]; aggregationTemporality?: unknown }
                    | undefined;
                const gauge = metric['gauge'] as { dataPoints?: unknown[] } | undefined;
                const container = sum ?? gauge;
                if (!container) continue;

                // A gauge has no temporality; treating it as a delta would make it summable,
                // which it is not.
                const temporality = sum ? temporalityOf(sum.aggregationTemporality) : 'unspecified';

                for (const raw of container.dataPoints ?? []) {
                    const point = raw as {
                        attributes?: { key: string; value: AnyValue }[];
                        timeUnixNano?: string | number;
                        startTimeUnixNano?: string | number;
                        asInt?: string | number;
                        asDouble?: number;
                    };
                    const value = numeric(point);
                    const time = isoFromNanos(point.timeUnixNano);
                    if (value === null || time === null) {
                        skipped.noValue += 1;
                        continue;
                    }

                    const attrs = { ...resourceAttrs, ...attributes(point.attributes) };
                    const sessionId = attrs['session.id'] ?? null;
                    rows.push({
                        agent: attrs['agent'] ?? agentOf(name),
                        metric: name,
                        field: canonicalField(name, attrs),
                        sessionId,
                        value,
                        temporality,
                        startTime: isoFromNanos(point.startTimeUnixNano),
                        time,
                        attrs,
                    });
                }
            }
        }
    }

    return { rows, skipped };
}
