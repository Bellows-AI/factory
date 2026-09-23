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

const BAND_FRACTION = 0.7;
const BAR_WIDTH_FLOOR_PX = 56;
const SHORT_RANGE_BUCKET_COUNT = 7;
const DENSE_BUCKET_COUNT = 100;
const MAX_BAR_WIDTH_DIVISOR = 8;

describe('BarChart bar width', () => {
    it('fills near-full bands on a short range instead of capping at 56px', () => {
        const labels = Array.from({ length: SHORT_RANGE_BUCKET_COUNT }, (_, i) => `0${i + 1}`);
        const V3 = 3;
        const V4 = 4;
        const V5 = 5;
        const V6 = 6;
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="bar width"
                labels={labels}
                bucketLabels={labels}
                partial={labels.map(() => false)}
                series={bars([1, 2, V3, V4, V5, V6, SHORT_RANGE_BUCKET_COUNT])}
                width={WIDTH}
            />
        );
        const widths = barWidths(svg);
        expect(widths).toHaveLength(SHORT_RANGE_BUCKET_COUNT);
        // The band is ~115px; the old fixed 56px cap left wide gaps. The bars now fill the
        // band-limited width (band * 0.7 ≈ 80px here) — past the old cap, never the whole band.
        expect(widths[0]).toBeGreaterThan(BAR_WIDTH_FLOOR_PX);
        expect(widths[0]).toBeCloseTo((innerWidth / SHORT_RANGE_BUCKET_COUNT) * BAND_FRACTION, 1);
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
        expect(width).toBeLessThanOrEqual(innerWidth / MAX_BAR_WIDTH_DIVISOR);
        expect(width).toBeGreaterThan(BAR_WIDTH_FLOOR_PX);
    });

    it('leaves dense (all-time weekly) ranges unchanged', () => {
        const labels = Array.from({ length: DENSE_BUCKET_COUNT }, (_, i) => String(i));
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
        expect(widths).toHaveLength(DENSE_BUCKET_COUNT);
        expect(widths[0]).toBeCloseTo((innerWidth / DENSE_BUCKET_COUNT) * BAND_FRACTION, 1);
    });
});

describe('rovingIndex', () => {
    it('steps one bucket per Left/Right and never wraps', () => {
        const MIDDLE = 3;
        const AFTER_MIDDLE = 4;
        const LAST = 9;
        const COUNT = 10;
        expect(rovingIndex(MIDDLE, COUNT, 'ArrowLeft')).toBe(2);
        expect(rovingIndex(MIDDLE, COUNT, 'ArrowRight')).toBe(AFTER_MIDDLE);
        expect(rovingIndex(0, COUNT, 'ArrowLeft')).toBe(0);
        expect(rovingIndex(LAST, COUNT, 'ArrowRight')).toBe(LAST);
    });

    it('jumps to the bounds on Home/End', () => {
        const MIDDLE = 4;
        const LAST = 9;
        const COUNT = 10;
        expect(rovingIndex(MIDDLE, COUNT, 'Home')).toBe(0);
        expect(rovingIndex(MIDDLE, COUNT, 'End')).toBe(LAST);
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
        const V3 = 3;
        const V4 = 4;
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="ids"
                labels={['a', 'b']}
                bucketLabels={['a', 'b']}
                partial={[false, false]}
                series={[
                    { id: 'input', label: 'Input', values: [1, 2], className: 'bar-primary' },
                    { id: 'output', label: 'Output', values: [V3, V4], className: 'bar-ok' },
                ]}
            />
        );
        expect(svg).toContain('data-series="input"');
        expect(svg).toContain('data-series="output"');
    });

    it('hides a series and recomputes the visible left-axis scale, raw values intact', () => {
        const INPUT_VALUE = 3000;
        const OUTPUT_VALUE = 1000;
        const props = {
            ariaLabel: 'hidden',
            labels: ['a'],
            bucketLabels: ['2026-08-01'],
            partial: [false],
            series: [
                { id: 'input', label: 'Input', values: [INPUT_VALUE], className: 'bar-primary' },
                { id: 'output', label: 'Output', values: [OUTPUT_VALUE], className: 'bar-ok' },
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
        const INPUT_VALUE = 12345;
        const OUTPUT_VALUE = 6789;
        const SESSIONS_VALUE = 3;
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="detail"
                labels={['08-21']}
                bucketLabels={['2026-08-21']}
                partial={[true]}
                series={[
                    { id: 'input', label: 'Input', values: [INPUT_VALUE], className: 'bar-primary' },
                    { id: 'output', label: 'Output', values: [OUTPUT_VALUE], className: 'bar-ok' },
                ]}
                line={{ id: 'sessions', label: 'Sessions', values: [SESSIONS_VALUE] }}
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

    it('keeps one roving tab stop whose every target references its own tooltip', () => {
        const labels = ['a', 'b', 'c'];
        const BUCKET_COUNT = 3;
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="roving"
                labels={labels}
                bucketLabels={labels}
                partial={[false, false, false]}
                series={bars([1, 2, BUCKET_COUNT])}
            />
        );
        const hits = rectTags(svg).filter((t) => attr(t, 'class') === 'bucket-hit');
        expect(hits).toHaveLength(BUCKET_COUNT);
        expect(hits.filter((t) => attr(t, 'tabindex') === '0')).toHaveLength(1);
        expect(hits.filter((t) => attr(t, 'tabindex') === '-1')).toHaveLength(2);
        // Every target references the tooltip id, so the active one always does.
        const refs = hits.map((t) => attr(t, 'aria-describedby'));
        expect(refs.every((r) => r !== undefined && r !== '')).toBe(true);
        expect(new Set(refs).size).toBe(1);
    });

    it('derives the tooltip id per instance, so two charts never share one', () => {
        const props = {
            ariaLabel: 'two',
            labels: ['a'],
            bucketLabels: ['a'],
            partial: [false],
            series: bars([1]),
        };
        const svg = renderToStaticMarkup(
            <>
                <BarChart {...props} />
                <BarChart {...props} />
            </>
        );
        const refs = [...svg.matchAll(/aria-describedby="([^"]*)"/g)].map((m) => m[1]);
        expect(refs.length).toBe(2);
        expect(new Set(refs).size).toBe(2);
    });

    it('keeps the full raw precision in the exact readout', () => {
        const INPUT_VALUE = 1.23456;
        const SESSIONS_VALUE = 0.123456;
        const svg = renderToStaticMarkup(
            <BarChart
                ariaLabel="precision"
                labels={['a']}
                bucketLabels={['2026-08-01']}
                partial={[false]}
                series={[{ id: 'input', label: 'Input', values: [INPUT_VALUE], className: 'bar-primary' }]}
                line={{ id: 'sessions', label: 'Sessions', values: [SESSIONS_VALUE] }}
            />
        );
        const hit = rectTags(svg).find((t) => attr(t, 'class') === 'bucket-hit');
        expect(attr(hit!, 'aria-label')).toContain('Input 1.23456');
        expect(attr(hit!, 'aria-label')).toContain('Sessions 0.123456');
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
