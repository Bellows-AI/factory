import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { telemetryStats } from '@factory-ai/core';
import { readFileSync } from 'node:fs';
import type { TelemetryInput, TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../src/api/useStats.js';
import type { StatsPayload } from '../src/api/useStats.js';
import { UsageSummaryPanel } from '../src/panels/UsageSummaryPanel.js';
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

const telemetryMeta = (over: Partial<TelemetryMeta> = {}): TelemetryMeta => ({
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

/** Full payload meta: the summary speaks for the rendered selection, so it needs range and scope. */
const meta = (over: Partial<TelemetryMeta> = {}, metaOver: Partial<StatsPayload['meta']> = {}): StatsPayload['meta'] =>
    ({
        fetchedAt: NOW.toISOString(),
        ageSeconds: 0,
        stale: false,
        organization: { mode: 'config', current: { id: 'bellows', name: 'Bellows AI' }, available: [] },
        repos: [{ owner: 'Bellows-AI', name: 'bellows.ai' }],
        range: { preset: 'custom', from: '2026-08-14T12:00:00Z', to: NOW.toISOString() },
        scope: 'org',
        scopeLogin: null,
        telemetry: telemetryMeta(over),
        ...metaOver,
    }) as StatsPayload['meta'];

/** A stats payload with hand-built per-user rows, so the view model's rules are deterministic. */
const withByUser = (byUser: TelemetryStats['byUser']): TelemetryStats => ({ ...empty, byUser });

const render = (t: TelemetryStats, m: StatsPayload['meta']) =>
    [
        renderToStaticMarkup(<UsageSummaryPanel telemetry={t} meta={m} />),
        renderToStaticMarkup(<TokenUsagePanel telemetry={t} meta={m.telemetry} />),
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
        const html = renderToStaticMarkup(<ByUserPanel telemetry={telemetry} meta={telemetryMeta()} />);
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
        const html = renderToStaticMarkup(<ByUserPanel telemetry={empty} meta={telemetryMeta()} />);
        expect(html).toContain('No attributed sessions in the coverage window yet.');
    });

    it('renders four groups and five measures, hierarchy first', () => {
        const html = renderToStaticMarkup(<UsageSummaryPanel telemetry={telemetry} meta={meta()} />);
        // Four visual groups, five measures: Sessions and Token usage lead, then the two
        // supporting effectiveness measures. DOM order IS the reading order at every width.
        for (const label of ['Sessions', 'Token usage', 'Active time', 'Edit acceptance']) {
            expect(html).toContain(label);
        }
        expect(html.indexOf('Sessions')).toBeLessThan(html.indexOf('Token usage'));
        expect(html.indexOf('Token usage')).toBeLessThan(html.indexOf('Active time'));
        expect(html.indexOf('Active time')).toBeLessThan(html.indexOf('Edit acceptance'));
    });

    it('renders Input and Output as separate measures with their own values', () => {
        const html = renderToStaticMarkup(<UsageSummaryPanel telemetry={telemetry} meta={meta()} />);
        expect(html).toContain('>Input</');
        expect(html).toContain('>Output</');
        // Each carries its OWN figure from the payload, never input + output.
        expect(html).toContain(`>${tokens(telemetry.totals.tokens.input)}<`);
        expect(html).toContain(`>${tokens(telemetry.totals.tokens.output)}<`);
        // Cache rides the supporting line, separate from the measure it belongs to.
        expect(html).toContain('read from cache');
        expect(html).toContain('written to cache');
    });

    it('carries the required supporting copy for every group', () => {
        const html = renderToStaticMarkup(<UsageSummaryPanel telemetry={telemetry} meta={meta()} />);
        // Sessions: the rendered selection, no repository names repeated here.
        expect(html).toContain('Aug 14–21 · Organization');
        expect(html).not.toContain(REPO);
        // Active time: across how many sessions, idle excluded.
        expect(html).toContain('Across 13 sessions · idle time excluded');
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

describe('edit acceptance rendering', () => {
    const withEdits = (accepted: number | null, rejected: number | null) =>
        telemetryStats(
            {
                sessions: [
                    {
                        ...input.sessions.find((s) => s.sessionId === 's01-token-heavy')!,
                        repo: REPO,
                        editsAccepted: accepted,
                        editsRejected: rejected,
                    },
                ],
                coverage: { from: null, to: null },
            },
            { repos: [REPO], now: NOW }
        );
    const summary = (accepted: number | null, rejected: number | null) =>
        renderToStaticMarkup(<UsageSummaryPanel telemetry={withEdits(accepted, rejected)} meta={meta()} />);

    it('shows the measured denominator: A of D measured edit decisions accepted', () => {
        const html = summary(2, 1);
        expect(html).toContain('67%');
        expect(html).toContain('2 of 3 measured edit decisions accepted');
    });

    it('says Not measured instead of a ratio when no decision was recorded', () => {
        const html = summary(null, null);
        expect(html).toContain('Not measured');
        expect(html).not.toContain('NaN');
    });

    it('names the partial measurement instead of fabricating an acceptance count', () => {
        // Rejections measured, acceptances not: a denominator exists but the ratio must not
        // pretend to one.
        const html = summary(null, 3);
        expect(html).toContain('3 edit decisions measured');
        expect(html).toContain('not recorded');
        expect(html).not.toContain('of 3 measured');
    });

    it('renders a measured zero-out-of-zero as the real zero it is', () => {
        const html = summary(0, 0);
        expect(html).toContain('0 measured edit decisions');
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
        expect(renderToStaticMarkup(<TaskUsagePanel tasks={null} meta={telemetryMeta()} />)).toBe('');
    });

    it('carries the unmeasured-run caveat in a disclosure below the table', () => {
        // Remote Control runs and failed close-time reads store null; a task holding one is
        // excluded. The panel says so instead of rendering a quietly small number.
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={populated} meta={telemetryMeta()} />);
        expect(html).toContain('a task with any unmeasured run is left out, never counted as zero');
    });

    it('formats the wall clock distribution as a duration, not a raw millisecond count', () => {
        // avg 4_212_000ms renders as "1.2h" — a millisecond figure beside tokens would be noise.
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={populated} meta={telemetryMeta()} />);
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
    it('renders daily buckets with a daily blurb', () => {
        expect(telemetry.series.granularity).toBe('week');
        const weeklyHtml = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={telemetryMeta()} />);
        expect(weeklyHtml).toContain('per ISO week');
        expect(weeklyHtml).toContain('the range is too long for daily bars');

        // The month preset spans 30 days: day buckets, named as days.
        const daily = telemetryStats(input, {
            repos: [REPO],
            now: NOW,
            range: { preset: 'custom', from: '2026-07-22T12:00:00Z', to: '2026-08-21T12:00:00Z' },
        });
        expect(daily.series.granularity).toBe('day');
        const dailyHtml = renderToStaticMarkup(<TokenUsagePanel telemetry={daily} meta={telemetryMeta()} />);
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
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={wide} meta={telemetryMeta()} />);
        const every = Math.ceil(points / 12);
        // X ticks: every `every`-th point plus the last. The bars' left axis and the line's
        // right axis render 5 ticks each, so ten of the rendered ticks are never x labels.
        const xTicks = Math.floor((points - 1) / every) + 1 + (points % every === 0 ? 0 : 1);
        const ticks = html.match(/class="tick"/g)?.length ?? 0;
        expect(ticks).toBe(xTicks + 10);
    });
});
