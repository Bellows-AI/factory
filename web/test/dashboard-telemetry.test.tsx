import type { OrganizationMeta, TaskUsageStats, TelemetryStats } from '@factory-ai/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DashboardPage } from '../src/pages/DashboardPage.js';
import { describeRepos } from '../src/format.js';
import type { UseJobs } from '../src/api/useJobs.js';
import { DEFAULT_RANGE, DEFAULT_SCOPE } from '../src/components/RangeSelector.js';
import type { RangeSelection, ScopeSelection } from '../src/components/RangeSelector.js';
import type { FetchState, StatsPayload } from '../src/api/useStats.js';
import type { Session } from '../src/api/useSession.js';

/**
 * The page-level contract: the toolbar and its labeled groups, the rendered-data summary that
 * speaks for the payload, the freshness cluster, and the shared state model decided once above
 * the panels. Static markup only — the pure helpers behind the copy have their own suites.
 */

const CONFIG: OrganizationMeta = {
    mode: 'config',
    current: { id: 'bellows', name: 'Bellows AI' },
    available: [{ id: 'bellows', name: 'Bellows AI' }],
};

const META: StatsPayload['meta'] = {
    fetchedAt: '2026-08-21T12:00:00.000Z',
    ageSeconds: 0,
    stale: false,
    organization: CONFIG,
    repos: [{ owner: 'Bellows-AI', name: 'bellows.ai' }],
    range: { preset: 'custom', from: '2026-08-14T12:00:00.000Z', to: '2026-08-21T12:00:00.000Z' },
    scope: 'org',
    scopeLogin: null,
    telemetry: {
        status: 'ok',
        reason: null,
        source: 'postgres',
        fetchedAt: '2026-08-21T12:00:00.000Z',
        ageSeconds: 0,
        stale: false,
        repoFilter: ['Bellows-AI/bellows.ai'],
        otherRepoSessions: 1,
        sessionsWithoutHook: 1,
        unattributedSessions: 4,
    },
} as StatsPayload['meta'];

/** A minimal "ready" telemetry: two measured sessions with real totals for the summary panel. */
const ACCEPTED_EDITS = 2;
const TOTAL_EDIT_DECISIONS = 3;
const READY_TELEMETRY = {
    totals: {
        sessions: 2,
        tokens: { input: 1200, output: 300, cacheRead: 4000, cacheCreation: 100 },
        activeHours: 1.5,
        linesAdded: 5,
        linesRemoved: 2,
        editAcceptance: {
            accepted: ACCEPTED_EDITS,
            rejected: 1,
            decisions: TOTAL_EDIT_DECISIONS,
            ratio: ACCEPTED_EDITS / TOTAL_EDIT_DECISIONS,
        },
    },
    otherRepoSessions: 1,
    sessionsWithoutHook: 1,
    unattributedSessions: 4,
    byUser: [],
    series: { granularity: 'day', points: [] },
    coverage: { from: null, to: null },
} as unknown as TelemetryStats;

const NO_TELEMETRY = {
    totals: { sessions: 0 },
    otherRepoSessions: 0,
    sessionsWithoutHook: 0,
    unattributedSessions: 0,
    byUser: [],
    series: { granularity: 'day', points: [] },
    coverage: { from: null, to: null },
} as unknown as TelemetryStats;

const dist = (tasks: number) => ({ avg: null, p50: null, p95: null, tasks });
const MEASURED_TASK_COUNT = 7;
const MEASURED_TASKS: TaskUsageStats = {
    tokensPerTask: dist(MEASURED_TASK_COUNT),
    jobTurnsPerTask: dist(MEASURED_TASK_COUNT),
    agentTurnsPerTask: dist(MEASURED_TASK_COUNT),
    wallClockPerTask: dist(MEASURED_TASK_COUNT),
} as unknown as TaskUsageStats;
const UNMEASURED_TASKS: TaskUsageStats = {
    tokensPerTask: dist(0),
    jobTurnsPerTask: dist(0),
    agentTurnsPerTask: dist(0),
    wallClockPerTask: dist(0),
} as unknown as TaskUsageStats;

const READY: StatsPayload = { telemetry: READY_TELEMETRY, tasks: MEASURED_TASKS, meta: META };
const EMPTY: StatsPayload = { telemetry: NO_TELEMETRY, tasks: UNMEASURED_TASKS, meta: META };
const PARTIAL: StatsPayload = { telemetry: NO_TELEMETRY, tasks: MEASURED_TASKS, meta: META };
const DISABLED: StatsPayload = { telemetry: null, tasks: null, meta: META };

const fakeTasks = { jobs: null, error: null } as unknown as UseJobs;

const GITHUB_SESSION = { mode: 'github', user: { login: 'alice' } } as unknown as Session;

interface RenderOpts {
    range?: RangeSelection;
    scope?: ScopeSelection;
    session?: Session | null;
    error?: string | null;
    progress?: FetchState | null;
}

/** The shell context with the dashboard's range/scope wiring handed over. */
function ShellStub({ data, opts = {} }: { data: StatsPayload | null; opts?: RenderOpts }) {
    return (
        <Outlet
            context={{
                data,
                range: opts.range ?? DEFAULT_RANGE,
                setRange: () => {},
                scope: opts.scope ?? DEFAULT_SCOPE,
                setScope: () => {},
                session: opts.session ?? null,
                progress: opts.progress ?? null,
                error: opts.error ?? null,
                tasks: fakeTasks,
            }}
        />
    );
}

const render = (data: StatsPayload | null, opts: RenderOpts = {}) =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={['/']}>
            <Routes>
                <Route element={<ShellStub data={data} opts={opts} />}>
                    <Route path="*" element={<DashboardPage />} />
                </Route>
            </Routes>
        </MemoryRouter>
    );

describe('describeRepos', () => {
    // The comment that came with the function from the topbar: names, not counts — the figures
    // below are only interpretable if you know what went into them.
    it('says so when there is nothing configured', () => {
        expect(describeRepos([])).toBe('no repositories configured');
    });

    it('folds a single owner, and names multiple owners outright', () => {
        expect(
            describeRepos([
                { owner: 'acme', name: 'a' },
                { owner: 'acme', name: 'b' },
            ])
        ).toBe('acme/{a, b}');
        expect(
            describeRepos([
                { owner: 'acme', name: 'a' },
                { owner: 'other', name: 'b' },
            ])
        ).toBe('acme/a, other/b');
    });
});

describe('page header', () => {
    it('renders exactly one h1 from the header primitive, naming the page and its repos', () => {
        const html = render(READY);
        // The page's one h1 is the header's (issue 159); the telemetry chrome rides in its slots.
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('<h1>Usage overview</h1>');
        expect(html).toContain('page-header-description');
        expect(html).toContain('page-header-meta');
        expect(html).not.toContain('page-header-actions');
        expect(html).toContain('bellows.ai');
        expect(html).not.toContain('AI usage telemetry');
        expect(html).not.toContain('Refresh');
    });

    it('keeps the h1 and drops the loading text while the first read is cold', () => {
        const html = render(null);
        expect(html.match(/<h1/g)).toHaveLength(1);
        expect(html).not.toContain('page-header-description');
        expect(html).not.toContain('AI usage telemetry');
        expect(html).not.toContain('loading…');
    });
});

describe('analytics toolbar', () => {
    it('labels the Range, Scope and Repositories groups in one compact row', () => {
        const html = render(READY);
        for (const label of ['Range', 'Scope', 'Repositories']) expect(html).toContain(label);
        // Read-only coverage, exact count: one repo renders as the singular.
        expect(html).toContain('1 repository');
    });

    it('renders a read-only Organization scope in open mode, never a dead Scope dropdown', () => {
        const html = render(READY);
        expect(html).toContain('<span class="toolbar-value">Organization</span>');
        expect(html).not.toContain('id="scope-select"');
    });

    it('renders the Scope dropdown when the session carries a personal scope', () => {
        const html = render(READY, { session: GITHUB_SESSION });
        expect(html).toContain('id="scope-select"');
        expect(html).toContain('>Organization</button>');
    });
});

describe('rendered-data summary', () => {
    it('describes the payload meta as one sentence in a polite live region', () => {
        const html = render(READY);
        expect(html).toContain('Aug 14–21 · Organization · 1 repository');
        expect(html).toContain('aria-live="polite"');
    });

    it('keeps describing the payload and names what it is updating to on a pending change', () => {
        // The requested range (30 days) differs from what rendered (Aug 14–21): the sentence
        // stays about the visible figures and appends the destination.
        const html = render(READY, { range: { preset: 'month', from: '', to: '' } });
        expect(html).toContain('Aug 14–21 · Organization · 1 repository');
        expect(html).toContain('Updating to');
    });
});

describe('last updated', () => {
    it('renders relative copy with the precise stamp exposed through a time element', () => {
        const html = render(READY);
        expect(html).toContain('Updated');
        expect(html).toContain('dateTime="2026-08-21T12:00:00.000Z"');
        // The precise stamp is real text (focus-revealable), not a title-only secret.
        expect(html).toContain('updated-at-full');
    });

    it('says Not updated yet before any successful read', () => {
        expect(render(null)).toContain('Not updated yet');
    });
});

describe('the shared state model', () => {
    it('renders one status line and no metric shells on the initial load', () => {
        const html = render(null, { progress: { state: 'loading', startedAt: null, finishedAt: null, error: null } });
        expect(html).toContain('Preparing telemetry');
        expect(html).not.toContain('usage-summary');
        expect(html).not.toContain('class="card"');
    });

    it('renders one error region and no metric shells when a read fails with no data', () => {
        const html = render(null, { error: 'connection refused' });
        expect(html).toContain('connection refused');
        expect(html).not.toContain('usage-summary');
        expect(html).not.toContain('class="card"');
        // The Refresh control is gone; the error copy must not instruct the reader to use it.
        expect(html).not.toContain('Refresh');
    });

    it('keeps the last good data visible and names it when a later read fails', () => {
        const html = render(READY, { error: 'connection refused' });
        expect(html).toContain('showing the last successful');
        expect(html).toContain('Aug 14–21 · Organization · 1 repository');
        expect(html).toContain('usage-summary');
    });

    it('replaces every telemetry section with one coherent empty state', () => {
        const html = render(EMPTY);
        expect(html.match(/usage-empty/g)).toHaveLength(1);
        expect(html).not.toContain('Usage summary');
        expect(html).not.toContain('AI token usage');
        expect(html).not.toContain('Usage by user');
        expect(html).not.toContain('Per-task usage');
    });

    it('keeps Per-task usage beside the compact empty state when tasks were measured', () => {
        const html = render(PARTIAL);
        expect(html.match(/usage-empty/g)).toHaveLength(1);
        expect(html).toContain('Per-task usage');
        expect(html).not.toContain('AI token usage');
        expect(html).not.toContain('Usage by user');
    });

    it('omits telemetry analytics entirely when the feature is switched off', () => {
        const html = render(DISABLED);
        expect(html).not.toContain('usage-empty');
        expect(html).not.toContain('usage-summary');
        expect(html).not.toContain('Per-task usage');
    });

    it('renders the recent tasks outside the stats branch, in every state', () => {
        // Board data independence: completed jobs poll their own endpoint, so the recent-tasks
        // view renders even while the statistics read is cold or failing.
        expect(render(null)).toContain('Task board');
        expect(render(READY)).toContain('Task board');
        expect(render(EMPTY)).toContain('Task board');
    });

    it('renders the full telemetry page when the selection is ready', () => {
        const html = render(READY);
        expect(html).toContain('Usage summary');
        expect(html).toContain('AI token usage');
        expect(html).toContain('Per-task usage');
        expect(html).toContain('Usage by user');
    });
});
