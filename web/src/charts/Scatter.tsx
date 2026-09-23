import { ChartRoot, YAxis } from './Axes.js';
import { PAD, linearScale, logScale, niceMax } from './scale.js';

/** The X-axis label's gap above the chart's bottom edge. */
const X_LABEL_GAP_PX = 6;

export interface ScatterPoint {
    x: number;
    y: number;
    title?: string;
    className?: string;
}

export function Scatter({
    points,
    width = 340,
    height = 220,
    xLabel = '',
    yLabel = '',
}: {
    points: ScatterPoint[];
    width?: number;
    height?: number;
    xLabel?: string;
    yLabel?: string;
}) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x = logScale([Math.min(...xs, 1), Math.max(...xs, 10)], [PAD.left, width - PAD.right]);
    const yMax = niceMax(Math.max(...ys, 1));
    const y = linearScale([0, yMax], [height - PAD.bottom, PAD.top]);

    return (
        <ChartRoot width={width} height={height}>
            <YAxis scale={y} max={yMax} width={width} side="left" label={yLabel} />
            {points.map((point, i) => (
                <circle key={i} cx={x(point.x)} cy={y(point.y)} r={3} className={point.className ?? 'dot'}>
                    {point.title ? <title>{point.title}</title> : null}
                </circle>
            ))}
            <text x={width - PAD.right} y={height - X_LABEL_GAP_PX} className="axis-label" textAnchor="end">
                {xLabel}
            </text>
        </ChartRoot>
    );
}
