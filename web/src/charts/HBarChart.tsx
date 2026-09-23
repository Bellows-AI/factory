import { ChartRoot } from './Axes.js';
import { PAD, linearScale, niceMax } from './scale.js';

export interface HBarRow {
    label: string;
    value: number;
    display?: string;
}

const LABEL_WIDTH = 160;
/** Chart height's bottom margin, beneath the last bar. */
const CHART_BOTTOM_MARGIN_PX = 8;
/** The chart's right margin, so the widest bar's value label has room. */
const CHART_RIGHT_MARGIN_PX = 16;
/** A row label's and value label's vertical baseline offset within its bar's row. */
const LABEL_BASELINE_OFFSET_PX = 14;
/** The bar rect's inset from its row's top. */
const BAR_TOP_INSET_PX = 4;
/** The gap between a bar's end and its value label. */
const VALUE_LABEL_GAP_PX = 6;

export function HBarChart({
    rows,
    width = 340,
    barHeight = 22,
}: {
    rows: HBarRow[];
    width?: number;
    barHeight?: number;
}) {
    const height = rows.length * barHeight + PAD.top + CHART_BOTTOM_MARGIN_PX;
    const max = niceMax(Math.max(...rows.map((r) => r.value), 0));
    const x = linearScale([0, max], [LABEL_WIDTH, width - CHART_RIGHT_MARGIN_PX]);

    return (
        <ChartRoot width={width} height={height}>
            {rows.map((r, i) => {
                const y = PAD.top + i * barHeight;
                return (
                    <g key={r.label}>
                        <text x={0} y={y + LABEL_BASELINE_OFFSET_PX} className="tick" textAnchor="start">
                            {r.label}
                        </text>
                        <rect
                            x={LABEL_WIDTH}
                            y={y + BAR_TOP_INSET_PX}
                            width={Math.max(x(r.value) - LABEL_WIDTH, 1)}
                            height={barHeight - 10}
                            className="bar bar-primary"
                        />
                        <text x={x(r.value) + VALUE_LABEL_GAP_PX} y={y + LABEL_BASELINE_OFFSET_PX} className="tick">
                            {r.display ?? r.value}
                        </text>
                    </g>
                );
            })}
        </ChartRoot>
    );
}
