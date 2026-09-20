import { useState } from 'react';
import type { TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { BarChart } from '../charts/BarChart.js';
import { TelemetryFrame } from './TelemetryFrame.js';

/** One bucket: the compact treatment keeps a real bar — never one bar stretched across a 900px plot. */
const COMPACT = { width: 480, height: 200 };

/**
 * The usage chart. The bucket size is the server's decision — daily up to 92 days of window,
 * weekly beyond — and the payload NAMES it, so the caption and disclosure describe what is
 * actually rendered. A chart that said "per ISO week" over daily bars (or the reverse) would
 * be a lie with correct numbers.
 */
export function TokenUsagePanel({ telemetry, meta }: { telemetry: TelemetryStats; meta: TelemetryMeta }) {
    const { granularity, points } = telemetry.series;
    const daily = granularity === 'day';
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const toggle = (id: string) =>
        setHidden((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const caption = daily
        ? 'Input and output tokens by day; sessions use the right axis.'
        : 'Input and output tokens by ISO week; sessions use the right axis.';
    const hasPartial = points.some((p) => p.partial);
    const dims = points.length === 1 ? COMPACT : { width: 900, height: 280 };

    return (
        <TelemetryFrame title="AI token usage" meta={meta}>
            {points.length === 0 ? (
                <p className="muted">
                    No sessions in the coverage window yet. Start a Claude Code session in{' '}
                    <code>{meta.repoFilter}</code>.
                </p>
            ) : (
                <>
                    {/* Toggles, not decoration: pressed state names what is on, the swatch + text
                        keep each series identifiable without color alone. */}
                    <div className="legend">
                        <button
                            type="button"
                            className="legend-button"
                            aria-pressed={!hidden.has('input')}
                            onClick={() => toggle('input')}
                        >
                            <span className="swatch swatch-primary" aria-hidden="true" />
                            Input
                        </button>
                        <button
                            type="button"
                            className="legend-button"
                            aria-pressed={!hidden.has('output')}
                            onClick={() => toggle('output')}
                        >
                            <span className="swatch swatch-ok" aria-hidden="true" />
                            Output
                        </button>
                        <button
                            type="button"
                            className="legend-button"
                            aria-pressed={!hidden.has('sessions')}
                            onClick={() => toggle('sessions')}
                        >
                            <span className="swatch swatch-warn" aria-hidden="true" />
                            Sessions
                        </button>
                    </div>
                    <div className="chart-wrap">
                        <BarChart
                            ariaLabel={daily ? 'Tokens and sessions by day' : 'Tokens and sessions by ISO week'}
                            labels={points.map((p) => p.start.slice(5))}
                            bucketLabels={points.map((p) => (daily ? p.start : `Week of ${p.start}`))}
                            partial={points.map((p) => p.partial)}
                            series={[
                                {
                                    id: 'input',
                                    label: 'Input',
                                    // Raw, uncoerced: an unmeasured bucket reads as a dash in the
                                    // exact readout, never as a fabricated zero. Geometry coerces.
                                    values: points.map((p) => p.tokens.input),
                                    className: 'bar-primary',
                                },
                                {
                                    id: 'output',
                                    label: 'Output',
                                    values: points.map((p) => p.tokens.output),
                                    className: 'bar-ok',
                                },
                            ]}
                            line={{ id: 'sessions', label: 'Sessions', values: points.map((p) => p.sessions) }}
                            hiddenSeries={hidden}
                            leftAxisLabel="Tokens"
                            width={dims.width}
                            height={dims.height}
                            // 92 daily points ÷ 12 labels ≈ one label every 8 bars: still legible.
                            labelEvery={Math.ceil(points.length / 12)}
                        />
                    </div>
                    <p className="chart-caption">
                        {caption}
                        {hasPartial ? ' * Partial period' : null}
                    </p>
                    <details className="chart-disclosure">
                        <summary>How this is calculated</summary>
                        <p>
                            Bars stack Input over Output on the left Tokens axis; the Sessions line reads the right
                            Sessions axis. Cache reads and writes are excluded from the bars — they would count the same
                            context repeatedly. Quiet buckets are kept, never closed. A window through 92 days renders
                            daily buckets; longer windows render ISO weeks. The hatched bucket is the current day or
                            week, still partial.
                        </p>
                    </details>
                </>
            )}
        </TelemetryFrame>
    );
}
