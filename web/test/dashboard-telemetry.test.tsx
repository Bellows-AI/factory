import type { OrganizationMeta } from '@factory-ai/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { describeRepos, DashboardPage } from '../src/pages/DashboardPage.js';
import type { UseJobs } from '../src/api/useJobs.js';
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

const META: StatsPayload['meta'] = {
    fetchedAt: '2026-08-21T12:00:00.000Z',
    ageSeconds: 0,
    stale: false,
    organization: CONFIG,
    repos: [{ owner: 'Bellows-AI', name: 'bellows.ai' }],
    baseBranch: 'dev',
};

const PAYLOAD = { telemetry: null, tasks: null, meta: META } as unknown as StatsPayload;

const fakeTasks = { jobs: null, error: null } as unknown as UseJobs;

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
    it('renders the repo coverage, the freshness timestamp and Refresh', () => {
        const html = render(PAYLOAD);
        expect(html).toContain('bellows.ai');
        expect(html).toContain('AI usage telemetry');
        expect(html).toContain('data as of');
        expect(html).toContain('Refresh');
    });

    it('answers the cold read with loading, and the refresh action with its in-flight state', () => {
        expect(render(null)).toContain('loading…');
        expect(render(PAYLOAD, true)).toContain('Refreshing…');
        expect(render(PAYLOAD, true)).toContain('disabled=""');
    });
});
