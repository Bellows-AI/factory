import { describe, expect, it } from 'vitest';
import { flattenMetrics } from '../src/telemetry/otlp.js';

/** Builds a minimal OTLP/JSON export around one metric. */
function body(metric: Record<string, unknown>, resourceAttrs: Record<string, string> = {}) {
    return {
        resourceMetrics: [
            {
                resource: {
                    attributes: Object.entries(resourceAttrs).map(([key, value]) => ({
                        key,
                        value: { stringValue: value },
                    })),
                },
                scopeMetrics: [{ metrics: [metric] }],
            },
        ],
    };
}

const NANOS = '1787308800000000000'; // 2026-08-21T10:40:00Z
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });

/** `temporality` is spread, not defaulted, so a test can genuinely omit the field. */
function sum(
    name: string,
    points: Record<string, unknown>[],
    ...temporality: unknown[]
): Record<string, unknown> {
    const agg = temporality.length ? { aggregationTemporality: temporality[0] } : {};
    return { name, sum: { ...agg, dataPoints: points } };
}

describe('the OTLP wire format', () => {
    it('reads asInt, which is a string-encoded int64', () => {
        const { rows } = flattenMetrics(
            body(sum('claude_code.token.usage', [
                { asInt: '4210', timeUnixNano: NANOS, attributes: [attr('type', 'input')] },
            ])),
        );
        expect(rows[0]?.value).toBe(4210);
        expect(typeof rows[0]?.value).toBe('number');
        expect(Number.isNaN(rows[0]?.value)).toBe(false);
    });

    it('reads asDouble and a gauge', () => {
        const { rows } = flattenMetrics(
            body(sum('claude_code.active_time.total', [{ asDouble: 12.5, timeUnixNano: NANOS }])),
        );
        expect(rows[0]?.value).toBe(12.5);

        const gauge = flattenMetrics(
            body({ name: 'claude_code.session.count', gauge: { dataPoints: [{ asInt: '1', timeUnixNano: NANOS }] } }),
        );
        // A gauge has no temporality, and calling it a delta would make it summable.
        expect(gauge.rows[0]?.temporality).toBe('unspecified');
    });

    it('converts nanoseconds using 1e6, not 1e9', () => {
        // The 1e9 mistake puts every point in 1970, so the branch join silently returns
        // nothing and the symptom looks like a broken hook.
        const { rows } = flattenMetrics(
            body(sum('claude_code.commit.count', [{ asInt: '1', timeUnixNano: NANOS, startTimeUnixNano: NANOS }])),
        );
        expect(rows[0]?.time).toBe('2026-08-21T10:40:00.000Z');
        expect(rows[0]?.startTime).toBe('2026-08-21T10:40:00.000Z');
    });

    it('maps aggregation temporality in both encodings', () => {
        const of = (...t: unknown[]) =>
            flattenMetrics(
                body(sum('claude_code.commit.count', [{ asInt: '1', timeUnixNano: NANOS }], ...t)),
            ).rows[0]?.temporality;
        expect(of(1)).toBe('delta');
        expect(of(2)).toBe('cumulative');
        expect(of('AGGREGATION_TEMPORALITY_CUMULATIVE')).toBe('cumulative');
        // Absent, not zero: an unlabelled counter must not become summable by default.
        expect(of()).toBe('unspecified');
    });

    it('handles every attribute value shape without crashing', () => {
        const { rows } = flattenMetrics(
            body({
                name: 'claude_code.token.usage',
                sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                        {
                            asInt: '5',
                            timeUnixNano: NANOS,
                            attributes: [
                                { key: 'type', value: { stringValue: 'input' } },
                                { key: 'app.version', value: { intValue: '42' } },
                                { key: 'effort', value: { doubleValue: 1.5 } },
                                { key: 'speed', value: { boolValue: true } },
                                { key: 'model', value: { arrayValue: { values: [] } } },
                            ],
                        },
                    ],
                },
            }),
        );
        expect(rows[0]?.attrs).toEqual({
            type: 'input',
            'app.version': '42',
            effort: '1.5',
            speed: 'true',
        });
        // arrayValue has no scalar reading, so it is dropped rather than stringified into
        // something nobody can query.
        expect(rows[0]?.attrs['model']).toBeUndefined();
    });

    it('promotes resource attributes onto the datapoint', () => {
        const { rows } = flattenMetrics(
            body(
                sum('claude_code.token.usage', [
                    { asInt: '5', timeUnixNano: NANOS, attributes: [attr('type', 'output')] },
                ]),
                { 'session.id': 'abc123', 'terminal.type': 'iTerm.app' },
            ),
        );
        expect(rows[0]?.sessionId).toBe('abc123');
        expect(rows[0]?.attrs['terminal.type']).toBe('iTerm.app');
    });

    it('accepts an empty export as success', () => {
        const { rows } = flattenMetrics({ resourceMetrics: [] });
        expect(rows).toEqual([]);
    });

    it('skips a histogram without throwing', () => {
        const { rows, skipped } = flattenMetrics(
            body({ name: 'claude_code.whatever', histogram: { dataPoints: [{}] } }),
        );
        expect(rows).toEqual([]);
        expect(skipped.histogram).toBe(1);
    });

    it('produces stable rows for a replayed body, so the dedup index can match', () => {
        const payload = body(
            sum('claude_code.token.usage', [
                { asInt: '7', timeUnixNano: NANOS, attributes: [attr('type', 'input')] },
            ]),
            { 'session.id': 's1' },
        );
        expect(flattenMetrics(payload).rows).toEqual(flattenMetrics(payload).rows);
    });
});

describe('the metric map', () => {
    it('resolves canonical fields from the disambiguating attribute', () => {
        const field = (name: string, attrs: { key: string; value: { stringValue: string } }[]) =>
            flattenMetrics(body(sum(name, [{ asInt: '1', timeUnixNano: NANOS, attributes: attrs }])))
                .rows[0]?.field;

        expect(field('claude_code.token.usage', [attr('type', 'cacheRead')])).toBe('tokens_cacheRead');
        expect(field('claude_code.lines_of_code.count', [attr('type', 'removed')])).toBe('lines_removed');
        expect(field('claude_code.code_edit_tool.decision', [attr('decision', 'reject')])).toBe('edits_reject');
        expect(field('claude_code.commit.count', [])).toBe('commits');
        // The opencode executor mirrors the same surface under its own prefix.
        expect(field('opencode.token.usage', [attr('type', 'cacheCreation')])).toBe('tokens_cacheCreation');
        expect(field('opencode.lines_of_code.count', [attr('type', 'added')])).toBe('lines_added');
        expect(field('opencode.tool.decision', [attr('decision', 'accept')])).toBe('edits_accept');
        expect(field('opencode.active_time.total', [])).toBe('active_seconds');
        expect(field('opencode.session.count', [])).toBe('sessions');
    });

    it('stores an unknown metric with a null field rather than rejecting it', () => {
        // A future tool's data must accumulate before support for it is written.
        const { rows } = flattenMetrics(
            body(sum('future_agent.tokens.total', [{ asInt: '9', timeUnixNano: NANOS }])),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.field).toBeNull();
        expect(rows[0]?.metric).toBe('future_agent.tokens.total');
        expect(rows[0]?.agent).toBe('unknown');
    });

    it('derives the agent from the metric name prefix', () => {
        const agent = (name: string) =>
            flattenMetrics(body(sum(name, [{ asInt: '1', timeUnixNano: NANOS }]))).rows[0]?.agent;
        expect(agent('claude_code.commit.count')).toBe('claude-code');
        expect(agent('opencode.commit.count')).toBe('opencode');
    });
});

describe('the two exclusions', () => {
    it('drops every identity attribute, and anything not on the allowlist', () => {
        const { rows } = flattenMetrics(
            body(
                sum('claude_code.token.usage', [
                    {
                        asInt: '1',
                        timeUnixNano: NANOS,
                        attributes: [
                            attr('type', 'input'),
                            attr('user.email', 'someone@example.com'),
                            attr('user.id', 'anon-123'),
                            attr('user.account_uuid', 'uuid-456'),
                            attr('user.account_id', 'acct-789'),
                            attr('user.groups', 'eng,admin'),
                            attr('organization.id', 'org-1'),
                            attr('workspace.host_paths', '/Users/someone/code'),
                            // The assertion that distinguishes an allowlist from a denylist:
                            // a key nobody has heard of yet is also dropped.
                            attr('some.future.identity', 'leaked'),
                        ],
                    },
                ]),
                { 'user.email': 'resource@example.com' },
            ),
        );

        expect(Object.keys(rows[0]?.attrs ?? {})).toEqual(['type']);
        for (const forbidden of [
            'user.email', 'user.id', 'user.account_uuid', 'user.account_id', 'user.groups',
            'organization.id', 'workspace.host_paths', 'some.future.identity',
        ]) {
            expect(rows[0]?.attrs[forbidden]).toBeUndefined();
        }
        expect(JSON.stringify(rows)).not.toContain('example.com');
        expect(JSON.stringify(rows)).not.toContain('/Users/');
    });

    it('refuses the cost metric while keeping its neighbours', () => {
        const payload = {
            resourceMetrics: [
                {
                    resource: { attributes: [attr('session.id', 's1')] },
                    scopeMetrics: [
                        {
                            metrics: [
                                sum('claude_code.cost.usage', [{ asDouble: 4.1, timeUnixNano: NANOS }]),
                                sum('opencode.cost.usage', [{ asDouble: 9.5, timeUnixNano: NANOS }]),
                                sum('claude_code.token.usage', [
                                    { asInt: '100', timeUnixNano: NANOS, attributes: [attr('type', 'input')] },
                                ]),
                            ],
                        },
                    ],
                },
            ],
        };

        const { rows, skipped } = flattenMetrics(payload);
        expect(skipped.deniedMetric).toBe(2);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.metric).toBe('claude_code.token.usage');
        expect(JSON.stringify(rows)).not.toContain('cost');
        expect(JSON.stringify(rows)).not.toContain('4.1');
        expect(JSON.stringify(rows)).not.toContain('9.5');
    });
});
