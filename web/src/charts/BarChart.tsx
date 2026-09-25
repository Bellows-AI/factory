import { useRef, useState, useId } from 'react';
import { ChartRoot, XLabels, YAxis } from './Axes.js';
import { PAD, linearScale, niceMax, type Scale } from './scale.js';

/**
 * The bucket readout's exact figure, grouped for reading — the same idiom ByUserPanel's
 * accessible names use. The fraction cap is a formality (the raw value in full), not a
 * rounding decision: the default three digits would quietly truncate the value it names.
 */
const exact = (value: number | null | undefined): string =>
    value === null || value === undefined ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 20 });

export interface BarSeries {
    id: string;
    label: string;
    /** Raw values — null is an unmeasured bucket, kept honest in the exact readout. */
    values: readonly (number | null)[];
    className: string;
}

export interface LineSeries {
    id: string;
    label: string;
    values: readonly (number | null)[];
}

export interface BarChartProps {
    ariaLabel: string;
    /** Abbreviated axis labels — dense by design. */
    labels: readonly string[];
    /** The full bucket name for the tooltip and each target's aria-label. */
    bucketLabels: readonly string[];
    partial: readonly boolean[];
    /** Always the full raw values; visibility is `hiddenSeries`'s job, never a sliced array. */
    series: readonly BarSeries[];
    /** Overlaid on a second, right-hand axis. Null entries are gaps, not zeros. */
    line?: LineSeries;
    hiddenSeries?: ReadonlySet<string>;
    /** The left axis's name — the right axis is named by the line's label. */
    leftAxisLabel?: string;
    width?: number;
    height?: number;
    labelEvery?: number;
}

export type BucketNavKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/** One roving tab stop over the buckets: clamped steps, never a wrap. */
export function rovingIndex(current: number, count: number, key: BucketNavKey): number {
    switch (key) {
        case 'ArrowLeft':
            return Math.max(current - 1, 0);
        case 'ArrowRight':
            return Math.min(current + 1, count - 1);
        case 'Home':
            return 0;
        case 'End':
            return count - 1;
    }
}

const TOOLTIP_MIN_WIDTH = 150;
const TOOLTIP_MAX_WIDTH = 320;
const TOOLTIP_LINE = 14;
/** A monospace character's rendered advance, in px — there is no DOM text metric inside an SVG. */
const TOOLTIP_CHAR_WIDTH_PX = 6.6;
/** Extra room the width estimate leaves beyond the widest line's raw character count. */
const TOOLTIP_WIDTH_PADDING_PX = 12;
/** Extra room the box leaves below its last line. */
const TOOLTIP_HEIGHT_PADDING_PX = 8;
/** The gap between the box and the bar it sits above. */
const TOOLTIP_GAP_ABOVE_BAR_PX = 6;
/** The box's left inset for its text lines. */
const TOOLTIP_TEXT_INSET_PX = 6;
/** The first line's baseline offset from the box's top. */
const TOOLTIP_FIRST_LINE_BASELINE_PX = 16;
/** The empty-state label's baseline offset below the plot's top padding. */
const EMPTY_STATE_LABEL_OFFSET_PX = 12;
/** The floor under a bar's rendered height — a real value must always read as a sliver, never a
 * true zero. */
const MIN_BAR_HEIGHT_PX = 0.5;
/** A bar's width, as a fraction of its band. */
const BAR_WIDTH_BAND_FRACTION = 0.7;
/** A bar's rendered width floor, in px, before the eighth-of-plot cap narrows a sparse range. */
const MIN_BAR_WIDTH_PX = 56;
/** A single bar can never exceed this fraction of the plot — never a filled panel. */
const MAX_BAR_WIDTH_PLOT_FRACTION = 8;

/**
 * The bucket's exact readout: full date, partial flag, every raw series value (hidden ones
 * included — hiding a series must not lose it), and which series are hidden. Drives both the
 * visible tooltip lines and the hit target's aria-label.
 */
function bucketParts(
    i: number,
    context: {
        bucketLabels: readonly string[];
        partial: readonly boolean[];
        series: readonly BarSeries[];
        line: LineSeries | undefined;
        hiddenSeries: ReadonlySet<string> | undefined;
    }
): string[] {
    const { bucketLabels, partial, series, line, hiddenSeries } = context;
    const parts: string[] = [bucketLabels[i] ?? ''];
    if (partial[i]) parts.push('partial period');
    for (const s of series) parts.push(`${s.label} ${exact(s.values[i])}`);
    if (line) parts.push(`${line.label} ${exact(line.values[i])}`);
    const hidden = [
        ...series.filter((s) => hiddenSeries?.has(s.id)).map((s) => s.label),
        ...(line && hiddenSeries?.has(line.id) ? [line.label] : []),
    ];
    if (hidden.length > 0) parts.push(`hidden: ${hidden.join(', ')}`);
    return parts;
}

/**
 * The stacked bars themselves — one `<rect>` per non-zero value, stacked bottom to top per
 * bucket. Split out of `BarChart` so its own line count stays under the limit.
 */
function computeBars(input: {
    labels: readonly string[];
    visibleSeries: readonly BarSeries[];
    y: Scale;
    bandCentre: (i: number) => number;
    barWidth: number;
}): React.ReactNode[] {
    const { labels, visibleSeries, y, bandCentre, barWidth } = input;
    return labels.flatMap((_, i) => {
        let base = 0;
        return visibleSeries.flatMap((s, si) => {
            const value = s.values[i] ?? 0;
            if (!value) return [];
            const rect = (
                <rect
                    key={`${i}-${si}`}
                    x={bandCentre(i) - barWidth / 2}
                    y={y(base + value)}
                    width={barWidth}
                    height={Math.max(y(base) - y(base + value), MIN_BAR_HEIGHT_PX)}
                    className={`bar ${s.className}`.trim()}
                    data-series={s.id}
                />
            );
            base += value;
            return [rect];
        });
    });
}

/**
 * The hatch marking a bucket still in progress, behind the bars: a bucket in progress stays
 * marked even while its numbers are zero, and the marks stay readable under the bars on top.
 * A hatch, not a color — the series must read in grayscale too. Split out of `BarChart` so its
 * own line count stays under the limit.
 */
function PartialHatchOverlay({
    labels,
    partial,
    bandCentre,
    band,
    plotTop,
    plotBottom,
}: {
    labels: readonly string[];
    partial: readonly boolean[];
    bandCentre: (i: number) => number;
    band: number;
    plotTop: number;
    plotBottom: number;
}) {
    if (!partial.some(Boolean)) return null;
    return (
        <>
            <defs>
                <pattern
                    id="partial-hatch"
                    patternUnits="userSpaceOnUse"
                    width="6"
                    height="6"
                    patternTransform="rotate(45)"
                >
                    <rect width="6" height="6" className="bar-partial-hatch" />
                </pattern>
            </defs>
            {labels.map((_, i) =>
                partial[i] ? (
                    <rect
                        key={`partial-${i}`}
                        className="bar-partial"
                        x={bandCentre(i) - band / 2}
                        y={plotTop}
                        width={band}
                        height={plotBottom - plotTop}
                    />
                ) : null
            )}
        </>
    );
}

/**
 * The active bucket's exact readout, positioned to stay inside the plot. No DOM text metrics
 * inside an SVG — the box rides the monospace advance instead, so a long hidden-series list
 * still fits inside its own readout. Split out of `BarChart` so its own line count stays under
 * the limit.
 */
function BucketTooltip({
    tooltipId,
    lines,
    anchorX,
    topY,
    plotTop,
    minX,
    maxX,
}: {
    tooltipId: string;
    lines: readonly string[];
    /** The bucket's horizontal centre — the box is centred on it, clamped to the plot. */
    anchorX: number;
    /** The top of the bucket's stacked value — the box sits above it. */
    topY: number;
    plotTop: number;
    minX: number;
    maxX: number;
}) {
    const boxWidth = Math.min(
        Math.max(
            TOOLTIP_MIN_WIDTH,
            Math.ceil(TOOLTIP_CHAR_WIDTH_PX * Math.max(...lines.map((l) => l.length)) + TOOLTIP_WIDTH_PADDING_PX)
        ),
        TOOLTIP_MAX_WIDTH
    );
    const boxHeight = TOOLTIP_LINE * lines.length + TOOLTIP_HEIGHT_PADDING_PX;
    const boxX = Math.max(minX, Math.min(anchorX - boxWidth / 2, maxX - boxWidth));
    const boxY = Math.max(topY - boxHeight - TOOLTIP_GAP_ABOVE_BAR_PX, plotTop);
    return (
        <g id={tooltipId} className="chart-tooltip">
            <rect className="chart-tooltip-box" x={boxX} y={boxY} width={boxWidth} height={boxHeight} rx="3" />
            {lines.map((l, n) => (
                <text
                    key={n}
                    x={boxX + TOOLTIP_TEXT_INSET_PX}
                    y={boxY + TOOLTIP_FIRST_LINE_BASELINE_PX + TOOLTIP_LINE * n}
                >
                    {l}
                </text>
            ))}
        </g>
    );
}

/** Vertical bars, stacked when more than one series is given, over one roving bucket inspector. */
export function BarChart({
    ariaLabel,
    labels,
    bucketLabels,
    partial,
    series,
    line,
    hiddenSeries,
    leftAxisLabel,
    width = 720,
    height = 260,
    labelEvery = 1,
}: BarChartProps) {
    const [active, setActive] = useState<number | null>(null);
    // Two charts on one page must never share a tooltip id — the reference would cross charts.
    const tooltipId = useId();
    // A range switch can shrink the bucket list under a stale index — clamp, never point at a
    // ghost; and an empty list has no bucket to be active at all.
    const activeIdx = active !== null && labels.length > 0 ? Math.max(0, Math.min(active, labels.length - 1)) : null;
    const hitRefs = useRef<(SVGRectElement | null)[]>([]);

    const visibleSeries = series.filter((s) => !hiddenSeries?.has(s.id));
    const visibleLine = line && !hiddenSeries?.has(line.id) ? line : undefined;
    if (visibleSeries.length === 0 && !visibleLine) {
        return (
            <ChartRoot width={width} height={height} role="group" ariaLabel={ariaLabel}>
                <text className="chart-empty" x={PAD.left} y={PAD.top + EMPTY_STATE_LABEL_OFFSET_PX}>
                    All series hidden
                </text>
            </ChartRoot>
        );
    }

    const innerWidth = width - PAD.left - PAD.right;
    const band = innerWidth / Math.max(labels.length, 1);
    // The chart is fixed-width, so the cap keeps a one-week range's single bar from rendering
    // ~580px wide and reading as a filled panel — but a flat cap starved sparse ranges: seven
    // day-bars of 56px in 800px read as gaps. The cap is a fraction of the plot instead: a bar
    // can never exceed an eighth of it (never a panel), and band-limited ranges fill out.
    const barWidth = Math.min(
        Math.max(band * BAR_WIDTH_BAND_FRACTION, 1),
        Math.max(MIN_BAR_WIDTH_PX, innerWidth / MAX_BAR_WIDTH_PLOT_FRACTION)
    );
    const bandCentre = (i: number) => PAD.left + band * i + band / 2;
    const plotBottom = height - PAD.bottom;

    const stackTotals = labels.map((_, i) => visibleSeries.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
    const max = niceMax(Math.max(...stackTotals, 0));
    const y = linearScale([0, max], [plotBottom, PAD.top]);

    const bars = computeBars({ labels, visibleSeries, y, bandCentre, barWidth });

    const partialMark = (
        <PartialHatchOverlay
            labels={labels}
            partial={partial}
            bandCentre={bandCentre}
            band={band}
            plotTop={PAD.top}
            plotBottom={plotBottom}
        />
    );

    let overlay: React.ReactNode = null;
    if (visibleLine) {
        const present = visibleLine.values.filter((v): v is number => v !== null);
        const lineMax = niceMax(Math.max(...present, 0));
        const y2 = linearScale([0, lineMax], [plotBottom, PAD.top]);
        // Filter out nulls before any geometry: a null reaching a coordinate yields NaN
        // and silently blanks the whole chart.
        const points = visibleLine.values
            .map((value, i) => (value === null ? null : `${bandCentre(i)},${y2(value)}`))
            .filter((p): p is string => p !== null)
            .join(' ');
        overlay = (
            <>
                <YAxis scale={y2} max={lineMax} width={width} side="right" label={visibleLine.label} />
                <polyline points={points} className="line" />
            </>
        );
    }

    const parts = (i: number) => bucketParts(i, { bucketLabels, partial, series, line, hiddenSeries });

    // One roving tab stop: pointer movement and keyboard focus feed the same active-bucket
    // state. Keys move BOTH the model and the DOM focus — a stop that moves without its focus
    // splits the ring, the label and the tooltip reference across two buckets. Every target
    // carries aria-describedby, so whichever is active or focused references the tooltip.
    const navigate = (i: number, e: React.KeyboardEvent) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const next = rovingIndex(activeIdx ?? i, labels.length, e.key);
        setActive(next);
        hitRefs.current[next]?.focus();
    };
    const hitRects = labels.map((_, i) => {
        const isStop = i === (activeIdx ?? 0);
        // A chart hotspot is a data mark that surfaces its own readout on focus, not a native
        // button — no SVG element carries button semantics, so the HTML-oriented rules that
        // push toward one do not apply to this hand-rolled SVG interaction.
        return (
            // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: SVG data mark; no native element carries this role
            <rect
                key={`hit-${i}`}
                ref={(el) => {
                    hitRefs.current[i] = el;
                }}
                className="bucket-hit"
                role="graphics-symbol"
                x={bandCentre(i) - band / 2}
                y={PAD.top}
                width={band}
                height={plotBottom - PAD.top}
                tabIndex={isStop ? 0 : -1}
                aria-label={parts(i).join(', ')}
                aria-describedby={tooltipId}
                onFocus={() => setActive(i)}
                onPointerMove={() => setActive(i)}
                onKeyDown={(e) => navigate(i, e)}
            />
        );
    });

    const tooltip =
        activeIdx === null ? null : (
            <BucketTooltip
                tooltipId={tooltipId}
                lines={parts(activeIdx)}
                anchorX={bandCentre(activeIdx)}
                topY={y(stackTotals[activeIdx] ?? 0)}
                plotTop={PAD.top}
                minX={PAD.left}
                maxX={width - PAD.right}
            />
        );

    return (
        <ChartRoot width={width} height={height} role="group" ariaLabel={ariaLabel}>
            {partialMark}
            {visibleSeries.length > 0 ? (
                <YAxis scale={y} max={max} width={width} side="left" label={leftAxisLabel} />
            ) : null}
            {bars}
            {overlay}
            <XLabels labels={labels} bandCentre={bandCentre} height={height} every={labelEvery} />
            {hitRects}
            {tooltip}
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
    return (
        <BarChart
            ariaLabel="Histogram"
            labels={labels}
            bucketLabels={labels}
            partial={labels.map(() => false)}
            series={[{ id: 'count', label: 'Count', values, className: 'bar-primary' }]}
            width={width}
            height={height}
        />
    );
}
