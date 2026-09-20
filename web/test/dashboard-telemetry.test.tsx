import type { OrganizationMeta } from '@factory-ai/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DashboardPage } from '../src/pages/DashboardPage.js';
import { describeRepos } from '../src/format.js';
import type { UseTasks } from '../src/api/useTasks.js';
import type { RangeSelection, ScopeSelection } from '../src/components/RangeSelector.js';
import type { StatsPayload } from '../src/api/useStats.js';

/**
 * The telemetry that used to live in the global chrome (issue 160) now belongs to the one page
 * whose figures it describes: repo coverage, the freshness timestamp and Refresh render on the
 * dashboard and nowhere else, and the app bar stays chrome-only.
 */

const CONFIG: OrganizationMeta = {
    mode: 'config',
    current: { id: 'bellows', name: 'Bellows AI' },
    available: [{ id: 'bellows', name: 'Bellows AI' }],
};

/** The whole meta shape, typed — the fixture drifts silently the moment a cast papers over it. */
const META: StatsPayload['meta'] = {
    fetchedAt: '2026-08-21T12:00:00.000Z',
    ageSeconds: 0,
    stale: false,
    organization: CONFIG,
    repos: [{ owner: 'Bellows-AI', name: 'bellows.ai' }],
    range: { preset: 'all', from: null, to: null },
    scope: 'org',
    scopeLogin: null,
    telemetry: {
        status: 'ok',
        reason: null,
        source: 'fixture',
        fetchedAt: '2026-08-21T12:00:00.000Z',
        ageSeconds: 0,
        stale: false,
        repoFilter: ['Bellows-AI/bellows.ai'],
        otherRepoSessions: 0,
        sessionsWithoutHook: 0,
        unattributedSessions: 0,
    },
};

const PAYLOAD: StatsPayload = { telemetry: null, tasks: null, meta: META };

const fakeTasks = {
    navigation: null,
    items: null,
    nextCursor: null,
    initial: true,
    filters: { state: 'attention', q: null, repo: null, author: null, sort: 'newest' },
} as unknown as UseTasks;

/** The shell context with the dashboard's range/scope/refresh wiring handed over. */
function ShellStub({ data, refreshing }: { data: StatsPayload | null; refreshing: boolean }) {
    return (
        <Outlet
            context={{
                data,
                range: {} as RangeSelection,
                setRange: () => {},
                scope: {} as ScopeSelection,
                setScope: () => {},
                session: null,
                refreshing,
                progress: null,
                error: null,
                refresh: () => {},
                tasks: fakeTasks,
            }}
        />
    );
}

const render = (data: StatsPayload | null, refreshing = false) =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={['/']}>
            <Routes>
                <Route element={<ShellStub data={data} refreshing={refreshing} />}>
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

describe('dashboard telemetry', () => {
    it('renders the repo coverage, the freshness timestamp and Refresh in the page header', () => {
        const html = render(PAYLOAD);
        // The page's one h1 is the header's (issue 159); the telemetry chrome rides beside it.
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('<h1>Usage overview</h1>');
        expect(html).toContain('page-header-description');
        expect(html).toContain('page-header-meta');
        expect(html).toContain('page-header-actions');
        expect(html).toContain('bellows.ai');
        expect(html).toContain('AI usage telemetry');
        expect(html).toContain('data as of');
        expect(html).toContain('>Refresh</button>');
    });

    it('answers the cold read with loading, and the refresh action with its in-flight state', () => {
        expect(render(null)).toContain('loading…');
        expect(render(PAYLOAD, true)).toContain('Refreshing…');
        expect(render(PAYLOAD, true)).toContain('disabled=""');
    });
});
