import { PAD, formatTick, type Scale } from './scale.js';

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
                            x={side === 'left' ? x - 6 : x + 6}
                            y={y + 4}
                            className="tick"
                            textAnchor={side === 'left' ? 'end' : 'start'}
                        >
                            {formatTick(value)}
                        </text>
                    </g>
                );
            })}
            {label ? (
                <text x={x} y={PAD.top - 4} className="axis-label" textAnchor={side === 'left' ? 'start' : 'end'}>
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
                    <text key={i} x={bandCentre(i)} y={height - PAD.bottom + 16} className="tick" textAnchor="middle">
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
