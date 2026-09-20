import { describe, expect, it } from 'vitest';
import type { DateRange, TaskUsageStats, TelemetryStats } from '@factory-ai/core';
import type { RangeSelection, ScopeSelection } from '../src/components/RangeSelector.js';
import type { StatsPayload } from '../src/api/useStats.js';
import {
    analyticsState,
    countRepos,
    emptyStateCopy,
    rangeText,
    renderedSelection,
    requestedRange,
    scopeWord,
    selectionMismatch,
    selectionText,
} from '../src/dashboardSummary.js';

/**
 * The rendered-data summary describes the PAYLOAD, never the request state alone: the server's
 * custom `to` is exclusive while people read calendar days, presets resolve to instants the
 * user never typed, and a pending or failed re-poll must leave the last good figures labeled
 * as exactly that. Every helper here is pure so frozen instants pin the copy.
 */

const META = (over: Partial<StatsPayload['meta']> = {}): StatsPayload['meta'] =>
    ({
        fetchedAt: '2026-09-20T12:00:00.000Z',
        ageSeconds: 0,
        stale: false,
        repos: [{ owner: 'acme', name: 'widget' }],
        range: { preset: 'custom', from: '2026-09-13T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' },
        scope: 'org',
        telemetry: { status: 'ok', repoFilter: ['acme/widget'] },
        ...over,
    }) as unknown as StatsPayload['meta'];

describe('rangeText', () => {
    it('presents a rolling preset window by its touched calendar days', () => {
        // resolveRange puts `to` at now — mid-day — so the inclusive end is that day itself.
        expect(rangeText({ preset: 'week', from: '2026-09-12T12:00:00.000Z', to: '2026-09-19T12:00:00.000Z' })).toBe(
            'Sep 12–19'
        );
    });

    it('presents the exclusive custom `to` as the inclusive calendar end', () => {
        // The date input submits Sep 19; the server widens it to Sep 20T00:00Z. The sentence
        // must read Sep 19 again — the day the user chose, not the widened bound.
        expect(rangeText({ preset: 'custom', from: '2026-09-13T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' })).toBe(
            'Sep 13–19'
        );
    });

    it('keeps a mid-day exclusive `to` on its own day', () => {
        // Sep 20 noon excludes only Sep 20 afternoon — the window still touches Sep 20.
        expect(rangeText({ preset: 'custom', from: '2026-09-13T00:00:00.000Z', to: '2026-09-20T12:00:00.000Z' })).toBe(
            'Sep 13–20'
        );
    });

    it('names one-sided custom bounds as since and through', () => {
        expect(rangeText({ preset: 'custom', from: '2026-09-13T00:00:00.000Z', to: null })).toBe('Since Sep 13');
        expect(rangeText({ preset: 'custom', from: null, to: '2026-09-20T00:00:00.000Z' })).toBe('Through Sep 19');
    });

    it('says all time only when neither bound exists', () => {
        expect(rangeText({ preset: 'all', from: null, to: null })).toBe('All time');
    });

    it('collapses a single-day window to one day', () => {
        expect(rangeText({ preset: 'custom', from: '2026-09-19T08:00:00.000Z', to: '2026-09-20T00:00:00.000Z' })).toBe(
            'Sep 19'
        );
    });

    it('keeps both month names when the window crosses one', () => {
        expect(rangeText({ preset: 'custom', from: '2026-09-28T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' })).toBe(
            'Sep 28 – Oct 4'
        );
    });
});

describe('scopeWord and selectionText', () => {
    it('names the scope in words', () => {
        expect(scopeWord('org')).toBe('Organization');
        expect(scopeWord('mine')).toBe('Personal');
    });

    it('joins the window and the scope, never the repositories', () => {
        // Repository names ride the page header; repeating them here is noise.
        expect(selectionText(META().range as DateRange, 'org')).toBe('Sep 13–19 · Organization');
        expect(selectionText(META().range as DateRange, 'mine')).toBe('Sep 13–19 · Personal');
    });
});

describe('countRepos', () => {
    it('speaks singular and plural, and says so when nothing is configured', () => {
        expect(countRepos([])).toBe('No repositories configured');
        expect(countRepos(['acme/widget'])).toBe('1 repository');
        expect(countRepos(['acme/widget', 'acme/anvil', 'acme/sprocket'])).toBe('3 tracked repositories');
    });
});

describe('renderedSelection', () => {
    it('builds the one-line summary from payload meta', () => {
        expect(renderedSelection(META())).toBe('Sep 13–19 · Organization · 1 repository');
        expect(renderedSelection(META({ telemetry: { status: 'ok', repoFilter: [] } } as never))).toBe(
            'Sep 13–19 · Organization · No repositories configured'
        );
    });
});

describe('selectionMismatch', () => {
    it('matches the request the wire actually carried, bounds normalized to days', () => {
        // The user applied from=Sep 13 to=Sep 19; the payload echoes from=Sep 13T00:00Z,
        // to=Sep 20T00:00Z (exclusive). Same selection — no mismatch.
        const request: RangeSelection = { preset: 'custom', from: '2026-09-13', to: '2026-09-19' };
        expect(selectionMismatch(request, 'org', META())).toBe(false);
    });

    it('flags a preset or scope difference', () => {
        expect(selectionMismatch({ preset: 'month', from: '', to: '' }, 'org', META())).toBe(true);
        expect(selectionMismatch({ preset: 'custom', from: '2026-09-13', to: '2026-09-19' }, 'mine', META())).toBe(
            true
        );
    });

    it('treats an empty custom draft as the all-time request it becomes on the wire', () => {
        const all: StatsPayload['meta'] = META({ range: { preset: 'all', from: null, to: null } } as DateRange);
        expect(selectionMismatch({ preset: 'custom', from: '', to: '' }, 'org', all)).toBe(false);
        expect(selectionMismatch({ preset: 'all', from: '', to: '' }, 'org', META())).toBe(true);
    });

    it('matches half-open requests bound by bound', () => {
        const halfOpen: StatsPayload['meta'] = META({
            range: { preset: 'custom', from: '2026-09-13T00:00:00.000Z', to: null },
        } as DateRange);
        expect(selectionMismatch({ preset: 'custom', from: '2026-09-13', to: '' }, 'org', halfOpen)).toBe(false);
        expect(selectionMismatch({ preset: 'custom', from: '2026-09-14', to: '' }, 'org', halfOpen)).toBe(true);
    });
});

describe('analyticsState', () => {
    const telemetry = (sessions: number) => ({ totals: { sessions } }) as TelemetryStats;
    const tasks = (measured: number): TaskUsageStats =>
        ({
            tokensPerTask: { avg: null, p50: null, p95: null, tasks: measured },
            jobTurnsPerTask: { avg: null, p50: null, p95: null, tasks: measured },
            agentTurnsPerTask: { avg: null, p50: null, p95: null, tasks: measured },
            wallClockPerTask: { avg: null, p50: null, p95: null, tasks: measured },
        }) as TaskUsageStats;

    it('is ready when sessions exist', () => {
        expect(analyticsState(telemetry(2), tasks(0))).toBe('ready');
    });

    it('keeps per-task usage visible when tasks were measured but telemetry is quiet', () => {
        expect(analyticsState(telemetry(0), tasks(7))).toBe('partial');
    });

    it('is empty when neither side measured anything', () => {
        expect(analyticsState(telemetry(0), tasks(0))).toBe('empty');
        expect(analyticsState(telemetry(0), null)).toBe('empty');
    });
});

describe('requestedRange', () => {
    const NOW = new Date('2026-09-20T12:00:00.000Z');

    it('widens a typed calendar `to` the way the server does, so the pending copy is inclusive', () => {
        // The user applied Sep 13 to Sep 19. rangeText reads EXCLUSIVE instants, so the raw
        // typed day would present as "Sep 13–18" — the server widens to Sep 20T00:00Z, and
        // the pending sentence must mirror that, or the destination disagrees with where the
        // read actually lands.
        const range = requestedRange({ preset: 'custom', from: '2026-09-13', to: '2026-09-19' }, NOW);
        expect(rangeText(range)).toBe('Sep 13–19');
    });

    it('presents a one-sided typed `to` through its inclusive calendar end', () => {
        expect(rangeText(requestedRange({ preset: 'custom', from: '', to: '2026-09-19' }, NOW))).toBe('Through Sep 19');
    });

    it('resolves a preset against now, like the wire request will be', () => {
        expect(requestedRange({ preset: 'week', from: '', to: '' }, NOW).from).toBe('2026-09-13T12:00:00.000Z');
    });
});

describe('emptyStateCopy', () => {
    it('sends the reader to broaden the range when the store holds data outside the window', () => {
        const meta = META({ range: { preset: 'custom', from: '2026-09-13T00:00:00.000Z', to: null } } as DateRange);
        const copy = emptyStateCopy(
            { coverage: { from: '2026-04-15T12:00:00Z', to: '2026-09-21T00:00:00Z' } } as never,
            meta
        );
        expect(copy).toContain('Sep 13');
        expect(copy).toContain('Broaden the range');
    });

    it('says an empty store needs its first agent session', () => {
        const meta = META({ range: { preset: 'all', from: null, to: null } } as DateRange);
        const copy = emptyStateCopy({ coverage: { from: null, to: null } } as never, meta);
        expect(copy).toContain('All time');
        expect(copy).toContain('Run an agent session');
    });

    it('compares coverage boundaries as instants, not strings of mixed precision', () => {
        // '…T00:00:00.000Z' and '…T00:00:00Z' are the same instant; a string compare reads the
        // first as earlier and serves "broaden the range" for coverage that is exactly at the
        // window's edge.
        const meta = META({
            range: { preset: 'custom', from: '2026-09-13T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' },
        } as DateRange);
        const copy = emptyStateCopy(
            { coverage: { from: '2026-09-13T00:00:00Z', to: '2026-09-19T00:00:00Z' } } as never,
            meta
        );
        expect(copy).toContain('Run an agent session');
    });
});

describe('scope selection type', () => {
    it('keeps the scope vocabulary the shell publishes', () => {
        const scope: ScopeSelection = 'mine';
        expect(scopeWord(scope)).toBe('Personal');
    });
});
