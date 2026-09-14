import type { TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { BarChart } from '../charts/BarChart.js';
import { TelemetryFrame } from './TelemetryFrame.js';

export function TokenUsagePanel({ telemetry, meta }: { telemetry: TelemetryStats; meta: TelemetryMeta }) {
    const weeks = telemetry.weekly;
    return (
        <TelemetryFrame
            title="AI token usage"
            blurb={
                <>
                    Input and output tokens per ISO week (stacked bars) against sessions started (line, right axis).
                    Cache reads are excluded from the bars: they would count the same context repeatedly. Quiet weeks
                    are kept and the last week is partial.
                </>
            }
            meta={meta}
        >
            {weeks.length === 0 ? (
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
                        labels={weeks.map((w) => w.start.slice(5))}
                        series={[
                            { values: weeks.map((w) => w.tokens.input ?? 0), className: 'bar-primary' },
                            { values: weeks.map((w) => w.tokens.output ?? 0), className: 'bar-ok' },
                        ]}
                        line={{ label: 'sessions', values: weeks.map((w) => w.sessions) }}
                        width={900}
                        height={280}
                        labelEvery={Math.ceil(weeks.length / 12)}
                    />
                </div>
            )}
        </TelemetryFrame>
    );
}
