import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarChart, rovingIndex } from '../src/charts/BarChart.js';
import { PAD } from '../src/charts/scale.js';

const rectTags = (svg: string): string[] => [...svg.matchAll(/<rect\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** Bar marks only — hit regions, the partial hatch and the tooltip box are rects too. */
const barWidths = (svg: string): number[] =>
    rectTags(svg)
        .filter((t) => /^bar[\s"]/.test(attr(t, 'class') ?? ''))
        .map((t) => Number(attr(t, 'width')));

/** TokenUsagePanel's chart geometry: the width the sparse-range behavior is specified against. */
const WIDTH = 900;
const innerWidth = WIDTH - PAD.left - PAD.right;

const bars = (values: number[]) => [{ id: 'v', label: 'V', values, className: 'bar-primary' as const }];

describe('BarChart bar width', () => {
    it('fills near-full bands on a short range instead of capping at 56px', () => {
        const labels = Array.from({ length: 7 }, (_, i) => `0${i + 1}`);
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="bar width"
                labels={labels}
                bucketLabels={labels}
                partial={labels.map(() => false)}
                series={bars([1, 2, 3, 4, 5, 6, 7])}
                width={WIDTH}
            />
        );
        const widths = barWidths(svg);
        expect(widths).toHaveLength(7);
        // The band is ~115px; the old fixed 56px cap left wide gaps. The bars now fill the
        // band-limited width (band * 0.7 ≈ 80px here) — past the old cap, never the whole band.
        expect(widths[0]).toBeGreaterThan(56);
        expect(widths[0]).toBeCloseTo((innerWidth / 7) * 0.7, 1);
    });

    it('keeps a single bar a bar, never a filled panel', () => {
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="single bar"
                labels={['07']}
                bucketLabels={['07']}
                partial={[false]}
                series={bars([1])}
                width={WIDTH}
            />
        );
        const [width] = barWidths(svg);
        expect(width).toBeLessThanOrEqual(innerWidth / 8);
        expect(width).toBeGreaterThan(56);
    });

    it('leaves dense (all-time weekly) ranges unchanged', () => {
        const labels = Array.from({ length: 100 }, (_, i) => String(i));
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="dense"
                labels={labels}
                bucketLabels={labels}
                partial={labels.map(() => false)}
                series={bars(labels.map(() => 1))}
                width={WIDTH}
            />
        );
        const widths = barWidths(svg);
        expect(widths).toHaveLength(100);
        expect(widths[0]).toBeCloseTo((innerWidth / 100) * 0.7, 1);
    });
});

describe('rovingIndex', () => {
    it('steps one bucket per Left/Right and never wraps', () => {
        expect(rovingIndex(3, 10, 'ArrowLeft')).toBe(2);
        expect(rovingIndex(3, 10, 'ArrowRight')).toBe(4);
        expect(rovingIndex(0, 10, 'ArrowLeft')).toBe(0);
        expect(rovingIndex(9, 10, 'ArrowRight')).toBe(9);
    });

    it('jumps to the bounds on Home/End', () => {
        expect(rovingIndex(4, 10, 'Home')).toBe(0);
        expect(rovingIndex(4, 10, 'End')).toBe(9);
    });

    it('collapses on a single bucket', () => {
        expect(rovingIndex(0, 1, 'ArrowLeft')).toBe(0);
        expect(rovingIndex(0, 1, 'ArrowRight')).toBe(0);
        expect(rovingIndex(0, 1, 'Home')).toBe(0);
        expect(rovingIndex(0, 1, 'End')).toBe(0);
    });
});

describe('BarChart series and bucket metadata', () => {
    it('marks bars with their stable series id, not only a CSS class', () => {
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="ids"
                labels={['a', 'b']}
                bucketLabels={['a', 'b']}
                partial={[false, false]}
                series={[
                    { id: 'input', label: 'Input', values: [1, 2], className: 'bar-primary' },
                    { id: 'output', label: 'Output', values: [3, 4], className: 'bar-ok' },
                ]}
            />
        );
        expect(svg).toContain('data-series="input"');
        expect(svg).toContain('data-series="output"');
    });

    it('hides a series and recomputes the visible left-axis scale, raw values intact', () => {
        const props = {
            ariaLabel: 'hidden',
            labels: ['a'],
            bucketLabels: ['2026-08-01'],
            partial: [false],
            series: [
                { id: 'input', label: 'Input', values: [3000], className: 'bar-primary' },
                { id: 'output', label: 'Output', values: [1000], className: 'bar-ok' },
            ],
        };
        const both = renderToStaticMarkup(<BarChart {...props} />);
        expect(both).toContain('data-series="input"');
        expect(both).toContain('>4k<');
        const hidden = renderToStaticMarkup(<BarChart {...props} hiddenSeries={new Set(['input'])} />);
        expect(hidden).not.toContain('data-series="input"');
        expect(hidden).toContain('data-series="output"');
        // The visible series now owns the scale: 1k, not the stacked 4k.
        expect(hidden).toContain('>1k<');
        expect(hidden).not.toContain('>4k<');
    });

    it('renders All series hidden instead of a broken chart', () => {
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="all hidden"
                labels={['a']}
                bucketLabels={['a']}
                partial={[false]}
                series={[
                    { id: 'input', label: 'Input', values: [1], className: 'bar-primary' },
                    { id: 'output', label: 'Output', values: [2], className: 'bar-ok' },
                ]}
                hiddenSeries={new Set(['input', 'output'])}
            />
        );
        expect(svg).toContain('All series hidden');
        expect(barWidths(svg)).toHaveLength(0);
    });

    it('removes the line and its right axis with the line series hidden', () => {
        const props = {
            ariaLabel: 'line hidden',
            labels: ['a'],
            bucketLabels: ['a'],
            partial: [false],
            series: bars([1]),
            line: { id: 'sessions', label: 'Sessions', values: [2] },
        };
        expect(renderToStaticMarkup(<BarChart {...props} />)).toContain('>Sessions</text>');
        const hidden = renderToStaticMarkup(<BarChart {...props} hiddenSeries={new Set(['sessions'])} />);
        expect(hidden).not.toContain('class="line"');
        expect(hidden).not.toContain('>Sessions</text>');
    });
});

describe('BarChart axes', () => {
    it('names both axes', () => {
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="axes"
                labels={['a']}
                bucketLabels={['a']}
                partial={[false]}
                leftAxisLabel="Tokens"
                series={bars([1])}
                line={{ id: 'sessions', label: 'Sessions', values: [2] }}
            />
        );
        expect(svg).toContain('>Tokens</text>');
        expect(svg).toContain('>Sessions</text>');
    });
});

describe('BarChart partial buckets', () => {
    it('marks the partial bucket with a non-color treatment', () => {
        const props = {
            ariaLabel: 'partial',
            labels: ['a', 'b'],
            bucketLabels: ['a', 'b'],
            series: bars([1, 2]),
        };
        expect(renderToStaticMarkup(<BarChart {...props} partial={[false, true]} />)).toContain('class="bar-partial"');
        expect(renderToStaticMarkup(<BarChart {...props} partial={[false, false]} />)).not.toContain(
            'class="bar-partial"'
        );
    });
});

describe('BarChart exact bucket access', () => {
    it('exposes full bucket detail in the hit-region label, raw values surviving hidden series', () => {
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="detail"
                labels={['08-21']}
                bucketLabels={['2026-08-21']}
                partial={[true]}
                series={[
                    { id: 'input', label: 'Input', values: [12345], className: 'bar-primary' },
                    { id: 'output', label: 'Output', values: [6789], className: 'bar-ok' },
                ]}
                line={{ id: 'sessions', label: 'Sessions', values: [3] }}
                hiddenSeries={new Set(['output'])}
            />
        );
        const hit = rectTags(svg).find((t) => attr(t, 'class') === 'bucket-hit');
        expect(hit).toBeDefined();
        const label = attr(hit!, 'aria-label') ?? '';
        expect(label).toContain('2026-08-21');
        expect(label).toContain('partial period');
        expect(label).toContain('Input 12,345');
        expect(label).toContain('Output 6,789');
        expect(label).toContain('Sessions 3');
        expect(label).toContain('hidden: Output');
    });

    it('keeps one roving tab stop whose every target references the tooltip', () => {
        const labels = ['a', 'b', 'c'];
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="roving"
                labels={labels}
                bucketLabels={labels}
                partial={[false, false, false]}
                series={bars([1, 2, 3])}
            />
        );
        const hits = rectTags(svg).filter((t) => attr(t, 'class') === 'bucket-hit');
        expect(hits).toHaveLength(3);
        expect(hits.filter((t) => attr(t, 'tabindex') === '0')).toHaveLength(1);
        expect(hits.filter((t) => attr(t, 'tabindex') === '-1')).toHaveLength(2);
        // Every target references the tooltip id, so the active one always does — before the
        // first interaction the reference dangles harmlessly.
        expect(hits.every((t) => attr(t, 'aria-describedby') === 'chart-bucket-tooltip')).toBe(true);
    });

    it('reads an unmeasured bucket as a dash, never a fabricated zero', () => {
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="nulls"
                labels={['a']}
                bucketLabels={['2026-08-01']}
                partial={[false]}
                series={[{ id: 'input', label: 'Input', values: [null], className: 'bar-primary' }]}
                line={{ id: 'sessions', label: 'Sessions', values: [0] }}
            />
        );
        const hit = rectTags(svg).find((t) => attr(t, 'class') === 'bucket-hit');
        expect(attr(hit!, 'aria-label')).toContain('Input —');
        expect(attr(hit!, 'aria-label')).toContain('Sessions 0');
    });
});
