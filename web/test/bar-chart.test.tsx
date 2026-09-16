import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarChart } from '../src/charts/BarChart.js';
import { PAD } from '../src/charts/scale.js';

const rectWidths = (svg: string): number[] =>
    [...svg.matchAll(/<rect [^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));

/** TokenUsagePanel's chart geometry: the width the sparse-range behavior is specified against. */
const WIDTH = 900;
const innerWidth = WIDTH - PAD.left - PAD.right;

describe('BarChart bar width', () => {
    it('fills near-full bands on a short range instead of capping at 56px', () => {
        const labels = Array.from({ length: 7 }, (_, i) => `0${i + 1}`);
        const svg = renderToStaticMarkup(
            <BarChart labels={labels} series={[{ values: [1, 2, 3, 4, 5, 6, 7] }]} width={WIDTH} />
        );
        const widths = rectWidths(svg);
        expect(widths).toHaveLength(7);
        // The band is ~115px; the old fixed 56px cap left wide gaps. The bars now fill the
        // band-limited width (band * 0.7 ≈ 80px here) — past the old cap, never the whole band.
        expect(widths[0]).toBeGreaterThan(56);
        expect(widths[0]).toBeCloseTo((innerWidth / 7) * 0.7, 1);
    });

    it('keeps a single bar a bar, never a filled panel', () => {
        const svg = renderToStaticMarkup(<BarChart labels={['07']} series={[{ values: [1] }]} width={WIDTH} />);
        const [width] = rectWidths(svg);
        expect(width).toBeLessThanOrEqual(innerWidth / 8);
        expect(width).toBeGreaterThan(56);
    });

    it('leaves dense (all-time weekly) ranges unchanged', () => {
        const labels = Array.from({ length: 100 }, (_, i) => String(i));
        const svg = renderToStaticMarkup(
            <BarChart labels={labels} series={[{ values: labels.map(() => 1) }]} width={WIDTH} />
        );
        const widths = rectWidths(svg);
        expect(widths).toHaveLength(100);
        expect(widths[0]).toBeCloseTo((innerWidth / 100) * 0.7, 1);
    });
});
