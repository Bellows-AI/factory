import { PAD, formatTick, type Scale } from './scale.js';

/** How far a Y-axis tick label sits from the axis line, horizontally. */
const TICK_LABEL_GAP_PX = 6;
/** Nudges a tick label's baseline down so it centers on its gridline rather than sitting above it. */
const TICK_LABEL_BASELINE_NUDGE_PX = 4;
/** The Y-axis label's gap above the chart's top padding. */
const AXIS_LABEL_GAP_PX = 4;
/** The gap between the chart's bottom padding and an X-axis label below it. */
const X_LABEL_GAP_PX = 16;

interface YAxisProps {
    scale: Scale;
    max: number;
    width: number;
    side?: 'left' | 'right';
    label?: string | undefined;
    ticks?: number;
}

export function YAxis({ scale, max, width, side = 'left', label, ticks = 4 }: YAxisProps) {
    const x = side === 'left' ? PAD.left : width - PAD.right;
    return (
        <>
            {Array.from({ length: ticks + 1 }, (_, i) => {
                const value = (max / ticks) * i;
                const y = scale(value);
                return (
                    <g key={i}>
                        <line
                            x1={PAD.left}
                            x2={width - PAD.right}
                            y1={y}
                            y2={y}
                            className={side === 'left' ? 'grid' : 'grid grid-alt'}
                        />
                        <text
                            x={side === 'left' ? x - TICK_LABEL_GAP_PX : x + TICK_LABEL_GAP_PX}
                            y={y + TICK_LABEL_BASELINE_NUDGE_PX}
                            className="tick"
                            textAnchor={side === 'left' ? 'end' : 'start'}
                        >
                            {formatTick(value)}
                        </text>
                    </g>
                );
            })}
            {label ? (
                <text
                    x={x}
                    y={PAD.top - AXIS_LABEL_GAP_PX}
                    className="axis-label"
                    textAnchor={side === 'left' ? 'start' : 'end'}
                >
                    {label}
                </text>
            ) : null}
        </>
    );
}

interface XLabelsProps {
    labels: readonly string[];
    bandCentre: (i: number) => number;
    height: number;
    every?: number;
}

export function XLabels({ labels, bandCentre, height, every = 1 }: XLabelsProps) {
    return (
        <>
            {labels.map((label, i) =>
                i % every !== 0 && i !== labels.length - 1 ? null : (
                    <text
                        key={i}
                        x={bandCentre(i)}
                        y={height - PAD.bottom + X_LABEL_GAP_PX}
                        className="tick"
                        textAnchor="middle"
                    >
                        {label}
                    </text>
                )
            )}
        </>
    );
}

export function ChartRoot({
    width,
    height,
    children,
    role = 'img',
    ariaLabel,
}: {
    width: number;
    height: number;
    children: React.ReactNode;
    /**
     * `img` (default) is the read-only chart; an interactive chart that carries focusable
     * bucket targets must be `group` — `img` makes its descendants presentational and
     * drops the roving tab stop out of the accessibility tree.
     */
    role?: 'img' | 'group';
    ariaLabel?: string;
}) {
    return (
        <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            role={role}
            aria-label={ariaLabel}
            className="chart"
        >
            {children}
        </svg>
    );
}
