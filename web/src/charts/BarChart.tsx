import { ChartRoot, XLabels, YAxis } from './Axes.js';
import { PAD, linearScale, niceMax } from './scale.js';

export interface BarSeries {
    values: number[];
    className?: string;
}

export interface BarChartProps {
    labels: string[];
    series: BarSeries[];
    /** Overlaid on a second, right-hand axis. Null entries are gaps, not zeros. */
    line?: { label: string; values: (number | null)[] };
    width?: number;
    height?: number;
    labelEvery?: number;
}

/** Vertical bars, stacked when more than one series is given. */
export function BarChart({ labels, series, line, width = 720, height = 260, labelEvery = 1 }: BarChartProps) {
    const innerWidth = width - PAD.left - PAD.right;
    const band = innerWidth / Math.max(labels.length, 1);
    // The chart is fixed-width, so the cap keeps a one-week range's single bar from rendering
    // ~580px wide and reading as a filled panel — but a flat cap starved sparse ranges: seven
    // day-bars of 56px in 800px read as gaps. The cap is a fraction of the plot instead: a bar
    // can never exceed an eighth of it (never a panel), and band-limited ranges fill out.
    const barWidth = Math.min(Math.max(band * 0.7, 1), Math.max(56, innerWidth / 8));
    const bandCentre = (i: number) => PAD.left + band * i + band / 2;

    const stackTotals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
    const max = niceMax(Math.max(...stackTotals, 0));
    const y = linearScale([0, max], [height - PAD.bottom, PAD.top]);

    const bars = labels.flatMap((_, i) => {
        let base = 0;
        return series.flatMap((s, si) => {
            const value = s.values[i] ?? 0;
            if (!value) return [];
            const rect = (
                <rect
                    key={`${i}-${si}`}
                    x={bandCentre(i) - barWidth / 2}
                    y={y(base + value)}
                    width={barWidth}
                    height={Math.max(y(base) - y(base + value), 0.5)}
                    className={`bar ${s.className ?? ''}`.trim()}
                />
            );
            base += value;
            return [rect];
        });
    });

    let overlay: React.ReactNode = null;
    if (line) {
        const present = line.values.filter((v): v is number => v !== null);
        const lineMax = niceMax(Math.max(...present, 0));
        const y2 = linearScale([0, lineMax], [height - PAD.bottom, PAD.top]);
        // Filter out nulls before any geometry: a null reaching a coordinate yields NaN
        // and silently blanks the whole chart.
        const points = line.values
            .map((value, i) => (value === null ? null : `${bandCentre(i)},${y2(value)}`))
            .filter((p): p is string => p !== null)
            .join(' ');
        overlay = (
            <>
                <YAxis scale={y2} max={lineMax} width={width} side="right" label={line.label} />
                <polyline points={points} className="line" />
            </>
        );
    }

    return (
        <ChartRoot width={width} height={height}>
            <YAxis scale={y} max={max} width={width} side="left" />
            {bars}
            {overlay}
            <XLabels labels={labels} bandCentre={bandCentre} height={height} every={labelEvery} />
        </ChartRoot>
    );
}

export function Histogram({
    labels,
    values,
    width = 340,
    height = 220,
}: {
    labels: string[];
    values: number[];
    width?: number;
    height?: number;
}) {
    return <BarChart labels={labels} series={[{ values, className: 'bar-primary' }]} width={width} height={height} />;
}
