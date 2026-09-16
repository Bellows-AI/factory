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
        // The per-user split: the four token figures as four columns, never summed into one.
        expect(html).toContain('<th>Input</th>');
        expect(html).toContain('<th>Output</th>');
        expect(html).toContain('<th>Cache read</th>');
        expect(html).toContain('<th>Cache writes</th>');
        // Off-board usage is not surfaced at all (#109): the payload keeps the count, the page
        // does not speak it.
        expect(html).not.toContain('no matching board task');
        expect(html).not.toContain('NaN');
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
        expect(html).toContain('<td>—</td>');
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

    it('renders the four distributions as distinct, labeled figures with their counts', () => {
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={populated} meta={meta()} />);
        // Four kinds, each named — the terminology rule: never a bare "turns".
        expect(html).toContain('Tokens per task');
        expect(html).toContain('Runs per task');
        expect(html).toContain('Agent turns per task');
        expect(html).toContain('Wall clock per task');
        expect(html).not.toMatch(/>\s*turns\s*</);
        // Every distribution renders beside its N.
        expect(html).toContain('7 tasks measured');
        // Nulls and averages format, never NaN.
        expect(html).not.toContain('NaN');
        expect(html).toContain('51.2k');
        expect(html).toContain('p50');
        expect(html).toContain('p95');
    });

    it('renders an explicit empty state, never zero figures, when no task is in range', () => {
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={emptyStats} meta={meta({ status: 'empty' })} />);
        expect(html).toContain('No attributed tasks in this range yet.');
        expect(html).not.toContain('NaN');
        // And it renders nothing at all when there is no snapshot yet.
        expect(renderToStaticMarkup(<TaskUsagePanel tasks={null} meta={meta()} />)).toBe('');
    });

    it('names the unmeasured-run rule where the agent-turn figure renders', () => {
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
});

describe('token usage series granularity', () => {
    it('renders daily buckets with a daily blurb', () => {
        expect(telemetry.series.granularity).toBe('week');
        const weeklyHtml = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={meta()} />);
        expect(weeklyHtml).toContain('per ISO week');
        expect(weeklyHtml).toContain('the range is too long for daily bars');

        // The month preset spans 30 days: day buckets, named as days.
        const daily = telemetryStats(input, {
            repos: [REPO],
            now: NOW,
            range: { preset: 'custom', from: '2026-07-22T12:00:00Z', to: '2026-08-21T12:00:00Z' },
        });
        expect(daily.series.granularity).toBe('day');
        const dailyHtml = renderToStaticMarkup(<TokenUsagePanel telemetry={daily} meta={meta()} />);
        expect(dailyHtml).toContain('per day');
        expect(dailyHtml).toContain('today is partial');
        expect(dailyHtml).not.toContain('NaN');
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
