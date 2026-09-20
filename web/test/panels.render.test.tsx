import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { telemetryStats } from '@factory-ai/core';
import { readFileSync } from 'node:fs';
import type { TelemetryInput, TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../src/api/useStats.js';
import { AiUsagePanel } from '../src/panels/AiUsagePanel.js';
import { ByUserPanel } from '../src/panels/ByUserPanel.js';
import { TokenUsagePanel } from '../src/panels/TokenUsagePanel.js';
import { TaskUsagePanel } from '../src/panels/TaskUsagePanel.js';
import { tokens } from '../src/format.js';
import { PAD } from '../src/charts/scale.js';
import type { TaskUsageStats } from '@factory-ai/core';

/**
 * A render smoke test, not a UI test. It exists because the null-not-zero contract is only
 * real if it survives to the markup: everything upstream can be correct and a single `?? 0`
 * in a panel still puts "0 tokens" on the page next to a session nobody measured.
 *
 * react-dom/server needs no DOM, so this stays in the default offline suite.
 */

const REPO = 'Bellows-AI/bellows.ai';

const input = JSON.parse(
    readFileSync(new URL('../../core/test/fixtures/telemetry-sessions.json', import.meta.url), 'utf8')
) as TelemetryInput;

const NOW = new Date('2026-08-21T12:00:00.000Z');
const telemetry = telemetryStats(input, { repos: [REPO], now: NOW });
const empty = telemetryStats({ sessions: [], coverage: { from: null, to: null } }, { repos: [REPO], now: NOW });

const meta = (over: Partial<TelemetryMeta> = {}): TelemetryMeta => ({
    status: 'ok',
    reason: null,
    source: 'fixture',
    fetchedAt: NOW.toISOString(),
    ageSeconds: 0,
    stale: false,
    repoFilter: [REPO],
    otherRepoSessions: 1,
    sessionsWithoutHook: 1,
    unattributedSessions: 4,
    ...over,
});

/** A stats payload with hand-built per-user rows, so the view model's rules are deterministic. */
const withByUser = (byUser: TelemetryStats['byUser']): TelemetryStats => ({ ...empty, byUser });

const render = (t: TelemetryStats, m: TelemetryMeta) =>
    [
        renderToStaticMarkup(<AiUsagePanel telemetry={t} meta={m} />),
        renderToStaticMarkup(<TokenUsagePanel telemetry={t} meta={m} />),
    ].join('\n');

describe('telemetry panels render', () => {
    it('renders real figures on the happy path', () => {
        const html = render(telemetry, meta());
        expect(html).toContain('synthetic fixture');
        expect(html).not.toContain('NaN');
        expect(html).not.toContain('Infinity');
        expect(html).not.toContain('undefined');
    });

    it('renders the by-user table with the attributed users', () => {
        const html = renderToStaticMarkup(<ByUserPanel telemetry={telemetry} meta={meta()} />);
        expect(html).toContain('Usage by user');
        expect(html).toContain('alice');
        expect(html).toContain('Alice Doe');
        expect(html).toContain('bob');
        // The avatar renders only when the account carries one; bob's has none.
        expect(html).toContain('https://example.com/alice.png');
        // The per-user split: sortable headers, the four token figures as four columns, never
        // summed into one — and New tokens is its own measured column, not cache-inclusive.
        for (const label of ['Sessions', 'New tokens', 'Input', 'Output', 'Cache read', 'Cache write']) {
            expect(html).toContain(`>${label}</button>`);
        }
        // Off-board usage is not surfaced at all (#109): the payload keeps the count, the page
        // does not speak it.
        expect(html).not.toContain('no matching board task');
        expect(html).not.toContain('NaN');
    });

    it('shows a proportional New tokens bar whose accessible name is the exact total', () => {
        const stats = withByUser([
            {
                user: { id: 'u1', login: 'carol', name: 'Carol', avatarUrl: null },
                sessions: 2,
                tokens: { input: 3_000, output: 1_000, cacheRead: null, cacheCreation: null },
            },
            {
                user: { id: 'u2', login: 'dave', name: null, avatarUrl: null },
                sessions: 1,
                tokens: { input: 1_000, output: null, cacheRead: null, cacheCreation: null },
            },
        ]);
        const html = renderToStaticMarkup(<ByUserPanel telemetry={stats} meta={meta()} />);
        // A partially measured group still has a New tokens total (core's null-aware sum),
        // never a null dragged to zero and never a null erasing a measured input.
        expect(html).toContain('4k');
        expect(html).toContain('1k');
        // The bar's width is decorative (aria-hidden); the exact figure is the cell's name.
        expect(html).toContain('<span class="usage-track" aria-hidden="true">');
        expect(html).toContain('width:100%');
        expect(html).toContain('width:25%');
        expect(html).toContain('aria-label="4,000 new tokens"');
        expect(html).toContain('aria-label="1,000 new tokens"');
    });

    it('sorts by raw New tokens descending and sinks the unmeasured last', () => {
        const stats = withByUser([
            {
                user: { id: 'u1', login: 'small', name: null, avatarUrl: null },
                sessions: 1,
                tokens: { input: 1_000, output: null, cacheRead: null, cacheCreation: null },
            },
            {
                user: { id: 'u2', login: 'big', name: null, avatarUrl: null },
                sessions: 1,
                tokens: { input: 400_000, output: null, cacheRead: null, cacheCreation: null },
            },
            {
                user: { id: 'u3', login: 'unmeasured', name: null, avatarUrl: null },
                sessions: 1,
                tokens: { input: null, output: null, cacheRead: null, cacheCreation: null },
            },
        ]);
        const html = renderToStaticMarkup(<ByUserPanel telemetry={stats} meta={meta()} />);
        expect(html.indexOf('big')).toBeLessThan(html.indexOf('small'));
        expect(html.indexOf('small')).toBeLessThan(html.indexOf('unmeasured'));
        expect(html).toMatch(/aria-sort="descending"/);
    });

    it('keeps cache tokens out of New tokens', () => {
        const stats = withByUser([
            {
                user: { id: 'u1', login: 'carol', name: null, avatarUrl: null },
                sessions: 1,
                tokens: { input: 500, output: 500, cacheRead: 4_500_000_000, cacheCreation: 1_000 },
            },
        ]);
        const html = renderToStaticMarkup(<ByUserPanel telemetry={stats} meta={meta()} />);
        // New tokens is 1k, not 4.5B: the bar is proportional to the measured NEW figure.
        expect(html).toContain('1k');
        expect(html).toContain('width:100%');
        expect(html).toContain('aria-label="1,000 new tokens"');
        // The cache figures render in their own columns.
        expect(html).toContain('4.5B');
    });

    it('renders an all-null token group as an em dash, never a fabricated zero', () => {
        const unmeasured = telemetryStats(
            {
                sessions: [
                    {
                        ...input.sessions.find((s) => s.sessionId === 's01-token-heavy')!,
                        tokens: { input: null, output: null, cacheRead: null, cacheCreation: null },
                    },
                ],
                coverage: { from: null, to: null },
            },
            { repos: [REPO], now: NOW }
        );
        const html = renderToStaticMarkup(<ByUserPanel telemetry={unmeasured} meta={meta()} />);
        expect(html).toMatch(/<td[^>]*>—<\/td>/);
        expect(html).not.toContain('<td>0</td>');
    });

    it('says so when nothing can be attributed', () => {
        // 'attributed', not just 'sessions': the by-user rollup carries only attributed
        // sessions, while unattributed ones are counted separately — the window can hold
        // sessions and still render this empty state.
        const html = renderToStaticMarkup(<ByUserPanel telemetry={empty} meta={meta()} />);
        expect(html).toContain('No attributed sessions in the coverage window yet.');
    });

    it('renders five usage cards', () => {
        const html = renderToStaticMarkup(<AiUsagePanel telemetry={telemetry} meta={meta()} />);
        // Counted in the rendered markup rather than hard-coded: the card row is the page's
        // whole above-the-fold, and a dropped card would otherwise pass silently.
        expect(html.match(/class="card"/g)).toHaveLength(5);
    });

    it('renders em dashes, never zeros, on an empty store', () => {
        const html = render(empty, meta({ status: 'empty' }));
        expect(html).toContain('—');
        expect(html).not.toContain('NaN');
        expect(html).not.toContain('0 tokens');
        expect(html).toContain('No sessions in the coverage window yet');
    });

    it('renders billions as B rather than thousands of M', () => {
        // A real run reported 4.5e9 cache-read tokens, which rendered as "4543.89M".
        expect(tokens(4_543_894_453)).toBe('4.54B');
        expect(tokens(20_300_494)).toBe('20.3M');
        expect(tokens(null)).toBe('—');
    });

    it('renders a reason and no numbers when unreachable', () => {
        const html = render(empty, meta({ status: 'unreachable', reason: 'connection refused' }));
        expect(html).toContain('panel bad');
        expect(html).toContain('connection refused');
        expect(html).not.toContain('NaN');
    });

    it('renders no PR vocabulary anywhere', () => {
        const html = render(telemetry, meta());
        expect(html).not.toMatch(/pull request/i);
        expect(html).not.toContain('merged');
    });
});

describe('per-task usage panel', () => {
    const dist = (avg: number, p50: number, p95: number, tasks: number) => ({ avg, p50, p95, tasks });
    const populated: TaskUsageStats = {
        tokensPerTask: dist(51_200, 43_000, 96_000, 7),
        jobTurnsPerTask: dist(1.9, 1, 4, 7),
        agentTurnsPerTask: dist(18.3, 12, 44, 7),
        wallClockPerTask: dist(4_212_000, 3_600_000, 10_800_000, 7),
    };
    const emptyStats: TaskUsageStats = {
        tokensPerTask: dist(0, 0, 0, 0),
        jobTurnsPerTask: dist(0, 0, 0, 0),
        agentTurnsPerTask: dist(0, 0, 0, 0),
        wallClockPerTask: dist(0, 0, 0, 0),
    };

    it('renders the four distributions as one table with percentile headers', () => {
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={populated} meta={meta()} />);
        // Four rows, each named — the terminology rule: never a bare "turns".
        expect(html).toContain('Tokens per task');
        expect(html).toContain('Runs per task');
        expect(html).toContain('Agent turns per task');
        expect(html).toContain('Wall clock per task');
        expect(html).not.toMatch(/>\s*turns\s*</);
        // Percentile headers: Median is the UI word, even though the field is p50.
        for (const header of ['Average', 'Median', 'P95', 'Measured tasks']) {
            expect(html).toContain(`>${header}</button>`);
        }
        expect(html).not.toContain('p50');
        // Every distribution renders beside its N — seven in each row here.
        expect(html.match(/>7</g)?.length).toBe(4);
        // Nulls and averages format, never NaN.
        expect(html).not.toContain('NaN');
        expect(html).toContain('51.2k');
        // Sorting is available but not pre-applied: no column starts active.
        expect(html).not.toContain('aria-sort');
    });

    it('renders an explicit empty state, never zero figures, when no task is in range', () => {
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={emptyStats} meta={meta({ status: 'empty' })} />);
        // ONE table-region empty state, not four zero/dash rows.
        expect(html).toContain('No attributed tasks in this range yet.');
        expect(html).not.toContain('<table');
        expect(html).not.toContain('NaN');
        // And it renders nothing at all when there is no snapshot yet.
        expect(renderToStaticMarkup(<TaskUsagePanel tasks={null} meta={meta()} />)).toBe('');
    });

    it('carries the unmeasured-run caveat in a disclosure below the table', () => {
        // Remote Control runs and failed close-time reads store null; a task holding one is
        // excluded. The panel says so instead of rendering a quietly small number.
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={populated} meta={meta()} />);
        expect(html).toContain('a task with any unmeasured run is left out, never counted as zero');
    });

    it('formats the wall clock distribution as a duration, not a raw millisecond count', () => {
        // avg 4_212_000ms renders as "1.2h" — a millisecond figure beside tokens would be noise.
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={populated} meta={meta()} />);
        expect(html).toContain('1.2h');
        expect(html).not.toContain('4212000');
    });

    it('keeps each measured count even when the distributions have different denominators', () => {
        const mixed: TaskUsageStats = {
            ...populated,
            agentTurnsPerTask: dist(18.3, 12, 44, 5),
        };
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={mixed} meta={meta()} />);
        // Seven rows carry tokens, runs and wall clock; only five measured agent turns.
        expect(html.match(/>7</g)?.length).toBe(3);
        expect(html).toContain('>5<');
    });
});

describe('token usage series granularity', () => {
    it('renders a caption naming the buckets, chart first, no leading paragraph', () => {
        expect(telemetry.series.granularity).toBe('week');
        const weeklyHtml = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={meta()} />);
        expect(weeklyHtml).toContain('Input and output tokens by ISO week; sessions use the right axis.');
        // The chart precedes its caption and explanation; nothing narrates before the marks.
        expect(weeklyHtml.indexOf('<svg')).toBeGreaterThan(-1);
        expect(weeklyHtml.indexOf('<svg')).toBeLessThan(weeklyHtml.indexOf('Input and output tokens by ISO week;'));

        // The month preset spans 30 days: day buckets, named as days.
        const daily = telemetryStats(input, {
            repos: [REPO],
            now: NOW,
            range: { preset: 'custom', from: '2026-07-22T12:00:00Z', to: '2026-08-21T12:00:00Z' },
        });
        expect(daily.series.granularity).toBe('day');
        const dailyHtml = renderToStaticMarkup(<TokenUsagePanel telemetry={daily} meta={meta()} />);
        expect(dailyHtml).toContain('Input and output tokens by day; sessions use the right axis.');
        expect(dailyHtml).toContain('The hatched bucket is a partial period.');
        expect(dailyHtml).not.toContain('NaN');
    });

    it('toggles series from accessible legend buttons', () => {
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={meta()} />);
        expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
        for (const name of ['Input', 'Output', 'Sessions']) {
            expect(html).toContain(`>${name}</button>`);
        }
    });

    it('explains the calculation after the chart', () => {
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={meta()} />);
        expect(html).toContain('<details');
        expect(html).toContain('<summary>How this is calculated</summary>');
        expect(html).toContain('Cache reads and writes are excluded from the bars');
        expect(html).toContain('92');
        expect(html).toContain('Quiet buckets are kept');
        expect(html.indexOf('<svg')).toBeLessThan(html.indexOf('How this is calculated'));
    });

    it('exposes full bucket dates and exact un-abbreviated values in the bucket labels', () => {
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={meta()} />);
        // Weekly buckets carry the full "Week of YYYY-MM-DD", not the axis's abbreviated MM-DD.
        expect(html).toMatch(/aria-label="[^"]*Week of \d{4}-\d{2}-\d{2}/);
        // Exact numbers with thousands separators — the abbreviated axis form is not the tooltip form.
        expect(html).toMatch(/aria-label="[^"]*\d,\d{3}/);
        expect(html).toMatch(/aria-label="[^"]*partial period/);
    });

    it('renders a one-bucket range as a compact chart with exact detail', () => {
        const pointTokens = { input: 12345, output: 6789, cacheRead: null, cacheCreation: null };
        const one: TelemetryStats = {
            totals: {
                sessions: 3,
                tokens: pointTokens,
                activeHours: null,
                linesAdded: null,
                linesRemoved: null,
                acceptRatio: null,
            },
            otherRepoSessions: 0,
            sessionsWithoutHook: 0,
            byUser: [],
            unattributedSessions: 0,
            series: {
                granularity: 'day',
                points: [
                    {
                        start: '2026-08-21',
                        sessions: 3,
                        tokens: pointTokens,
                        linesAdded: 0,
                        linesRemoved: 0,
                        partial: true,
                    },
                ],
            },
            coverage: { from: null, to: null },
        };
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={one} meta={meta()} />);
        const [, width, height] = html.match(/viewBox="0 0 (\d+) (\d+)"/)!.map(Number);
        expect(width).toBeLessThan(900);
        expect(height).toBeLessThan(280);
        // A real bar, never a filled panel: no bar mark exceeds a quarter of the compact plot
        // (the old behavior stretched one bar across the whole band). The hatch is a band-wide
        // rect by design, so only `bar <series-class>` marks count here.
        const widths = [...html.matchAll(/<rect\b[^>]*>/g)]
            .map((m) => m[0])
            .filter((t) => /^bar[\s"]/.test(t.match(/\bclass="([^"]*)"/)?.[1] ?? ''))
            .map((t) => Number(t.match(/\bwidth="([\d.]+)"/)?.[1]));
        expect(widths.length).toBeGreaterThan(0);
        expect(Math.max(...widths)).toBeLessThanOrEqual((width - PAD.left - PAD.right) / 4);
        expect(html).toMatch(/aria-label="[^"]*Input 12,345/);
        expect(html).toContain('The hatched bucket is a partial period.');
    });

    it('keeps the x-axis legible at 92 daily points', () => {
        // A 92-day window is the widest range that still renders daily bars: 92 points with
        // labels every ceil(92/12) bars. Counting the rendered ticks pins the label thinning —
        // a regression to labelEvery=1 renders 92 tick texts and a hairline wall of numbers.
        const from = new Date(NOW.getTime() - 92 * 86_400_000).toISOString();
        const wide = telemetryStats(input, {
            repos: [REPO],
            now: NOW,
            range: { preset: 'custom', from, to: NOW.toISOString() },
        });
        const points = wide.series.points.length;
        expect(points).toBeGreaterThan(80);
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={wide} meta={meta()} />);
        const every = Math.ceil(points / 12);
        // X ticks: every `every`-th point plus the last. The bars' left axis and the line's
        // right axis render 5 ticks each, so ten of the rendered ticks are never x labels.
        const xTicks = Math.floor((points - 1) / every) + 1 + (points % every === 0 ? 0 : 1);
        const ticks = html.match(/class="tick"/g)?.length ?? 0;
        expect(ticks).toBe(xTicks + 10);
    });
});
