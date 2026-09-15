import type { TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { BarChart } from '../charts/BarChart.js';
import { TelemetryFrame } from './TelemetryFrame.js';

/**
 * The usage chart. The bucket size is the server's decision — daily up to 92 days of window,
 * weekly beyond — and the payload NAMES it, so the labels and blurb describe what is actually
 * rendered. A chart that said "per ISO week" over daily bars (or the reverse) would be a lie
 * with correct numbers.
 */
export function TokenUsagePanel({ telemetry, meta }: { telemetry: TelemetryStats; meta: TelemetryMeta }) {
    const { granularity, points } = telemetry.series;
    const daily = granularity === 'day';
    return (
        <TelemetryFrame
            title="AI token usage"
            blurb={
                daily ? (
                    <>
                        Input and output tokens per day (stacked bars) against sessions started (line, right axis).
                        Cache reads are excluded from the bars: they would count the same context repeatedly. Quiet days
                        are kept and today is partial.
                    </>
                ) : (
                    <>
                        Input and output tokens per ISO week (stacked bars) against sessions started (line, right axis).
                        Cache reads are excluded from the bars: they would count the same context repeatedly. Quiet
                        weeks are kept and the last week is partial — the range is too long for daily bars to stay
                        readable.
                    </>
                )
            }
            meta={meta}
        >
            {points.length === 0 ? (
                <p className="muted">
                    No sessions in the coverage window yet. Start a Claude Code session in{' '}
                    <code>{meta.repoFilter}</code>.
                </p>
            ) : (
                <div className="chart-wrap">
                    {/* Two stacked series are indistinguishable without this. */}
                    <p className="legend">
                        <span className="swatch swatch-primary" /> input
                        <span className="swatch swatch-ok" /> output
                    </p>
                    <BarChart
                        labels={points.map((p) => p.start.slice(5))}
                        series={[
                            { values: points.map((p) => p.tokens.input ?? 0), className: 'bar-primary' },
                            { values: points.map((p) => p.tokens.output ?? 0), className: 'bar-ok' },
                        ]}
                        line={{ label: 'sessions', values: points.map((p) => p.sessions) }}
                        width={900}
                        height={280}
                        // 92 daily points ÷ 12 labels ≈ one label every 8 bars: still legible.
                        labelEvery={Math.ceil(points.length / 12)}
                    />
                </div>
            )}
        </TelemetryFrame>
    );
}
