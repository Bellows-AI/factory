import type { OrganizationMeta } from '@factory-ai/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppBar } from '../src/components/AppBar.js';
import { OrgSelector } from '../src/components/OrgSelector.js';
import type { Session } from '../src/api/useSession.js';
import type { StatsPayload } from '../src/api/useStats.js';
import { DashboardPage } from '../src/pages/DashboardPage.js';

const CONFIG: OrganizationMeta = {
    mode: 'config',
    current: { id: 'bellows', name: 'Bellows AI' },
    available: [{ id: 'bellows', name: 'Bellows AI' }],
};

const DIRECTORY: OrganizationMeta = {
    mode: 'directory',
    current: { id: 'bellows', name: 'Bellows AI' },
    available: [
        { id: 'bellows', name: 'Bellows AI' },
        { id: 'acme', name: 'Acme Inc' },
    ],
};

const SESSION: Session = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        login: 'octocat',
        name: 'The Octocat',
        githubUserId: 4242,
        avatarUrl: null,
    },
    role: 'member',
    membership: { invitedAt: null, claimedAt: null },
    account: { createdAt: null, lastLoginAt: null },
    organization: { id: 'bellows', name: 'Bellows AI' },
    organizations: [
        { id: 'bellows', name: 'Bellows AI' },
        { id: 'acme', name: 'Acme Inc' },
    ],
    workspacePath: null,
    mode: 'github',
};

const render = (organization: OrganizationMeta) => renderToStaticMarkup(<OrgSelector organization={organization} />);

describe('OrgSelector', () => {
    it('renders the single organization as a disabled Listbox trigger', () => {
        // The Listbox server-renders the trigger only; the options are client-side, so the
        // trigger's text is the current organization and its aria-label names the control.
        const html = render(CONFIG);
        expect(html).toContain('<button');
        expect(html).toContain('disabled=""');
        expect(html).toContain('aria-label="Organization: Bellows AI"');
        expect(html).toContain('Bellows AI');
        expect(html).not.toContain('<option');
    });

    it('says why it is inactive, not only that it is', () => {
        // A disabled control with no explanation reads as a bug or as a permissions problem.
        const html = render(CONFIG);
        expect(html).toContain('one organization');
        // The ORG_ID phrasing is gone with the variable itself (#99).
        expect(html).not.toContain('ORG_ID');
    });

    it('shows the current organization on the trigger', () => {
        // Selection display is the trigger's text now; the options themselves are client-side.
        expect(render(CONFIG)).toContain('>Bellows AI</button>');
    });

    it('leaves the control live in directory mode', () => {
        // The leave-room case. Costs nothing today, and fails the day someone hard-codes disabled.
        // Coverage note: the old suite also counted the rendered `<option>`s, but `available`
        // reaching the option list is now client-side markup no offline render can see, and no
        // board here runs directory mode — that half is hand-verified; this keeps the disabled
        // half.
        const html = render(DIRECTORY);
        expect(html).not.toContain('disabled');
        expect(html).toContain('aria-label="Organization: Bellows AI"');
    });

    it('does not disable a directory user who currently belongs to one organization', () => {
        // Pins `mode` over `available.length`. A membership can be granted with no deploy, and a
        // control disabled by list length would be inert for the wrong reason.
        const html = render({ ...DIRECTORY, available: [DIRECTORY.current] });
        expect(html).not.toContain('disabled');
    });
});

describe('AppBar', () => {
    const html = (session: Session | null = null, organization: OrganizationMeta | null = CONFIG) =>
        renderToStaticMarkup(
            <MemoryRouter>
                {/* The menu holds a NavLink, so the AppBar needs a router context to render it. */}
                <AppBar session={session} organization={organization} />
            </MemoryRouter>
        );

    it('renders the selector and the menu, in that order', () => {
        const markup = html(SESSION);
        expect(markup).toContain('class="app-bar"');
        expect(markup.indexOf('org-select')).toBeGreaterThan(-1);
        expect(markup.indexOf('org-select')).toBeLessThan(markup.indexOf('user-menu-button'));
    });

    it('carries no telemetry chrome: no heading, no timestamp, no Refresh, no repo names', () => {
        // The exile, pinned: telemetry metadata lives in the dashboard's page header now — the
        // app bar is identity and navigation only, on every page.
        const markup = html(SESSION);
        expect(markup).not.toContain('<h1');
        expect(markup).not.toContain('Refresh');
        expect(markup).not.toContain('data as of');
        expect(markup).not.toContain('bellows.ai');
    });

    it('renders nothing before the first payload rather than an empty control', () => {
        const markup = html(null, null);
        expect(markup).not.toContain('org-select');
        expect(markup).not.toContain('user-menu-button');
    });

    it('renders the user menu once the session is known, and nothing before it', () => {
        expect(html(null)).not.toContain('user-menu-button');
        const markup = html(SESSION);
        expect(markup).toContain('user-menu-button');
        expect(markup).toContain('octocat');
    });
});

describe('dashboard page header', () => {
    /**
     * The dashboard page, through a real route tree so the layout's outlet context exists. The
     * context is a stub cast to the shell's shape — the pages read only what they destructure,
     * and the poll hooks' effects never fire under `renderToStaticMarkup`. `telemetry` is left
     * off the payload so no chart panel renders; the header is the subject here.
     */
    const payload = {
        meta: {
            fetchedAt: '2026-08-21T12:00:00.000Z',
            stale: false,
            source: 'live',
            organization: CONFIG,
            repos: [{ owner: 'Bellows-AI', name: 'bellows.ai' }],
            baseBranch: 'dev',
        },
    } as unknown as StatsPayload;

    const renderDashboard = (data: StatsPayload | null, refreshing = false) =>
        renderToStaticMarkup(
            <MemoryRouter initialEntries={['/']}>
                <Routes>
                    <Route
                        element={
                            <Outlet
                                context={
                                    {
                                        data,
                                        range: { preset: '30d' },
                                        setRange: () => {},
                                        scope: 'org',
                                        setScope: () => {},
                                        session: null,
                                        refreshing,
                                        progress: null,
                                        error: null,
                                        refresh: () => {},
                                        tasks: {},
                                    } as unknown as Record<string, unknown>
                                }
                            />
                        }
                    >
                        <Route path="/" element={<DashboardPage />} />
                    </Route>
                </Routes>
            </MemoryRouter>
        );

    it('carries the page title, the exact repo coverage, the timestamp and the Refresh action', () => {
        const markup = renderDashboard(payload);
        expect(markup.match(/<h1/g)?.length).toBe(1);
        expect(markup).toContain('<h1>Usage overview</h1>');
        // Repo coverage names every repo rather than a count, and the telemetry tag rides it.
        expect(markup).toContain('Bellows-AI/bellows.ai');
        expect(markup).toContain('AI usage telemetry');
        expect(markup).toContain('data as of');
        expect(markup).toContain('>Refresh</button>');
        for (const token of ['NaN', 'undefined'] as const) expect(markup, token).not.toContain(token);
    });

    it('shows loading, and no timestamp, before the first payload', () => {
        const markup = renderDashboard(null);
        expect(markup).toContain('<h1>Usage overview</h1>');
        expect(markup).toContain('loading…');
        expect(markup).not.toContain('data as of');
    });

    it('disables Refresh while a refresh is in flight', () => {
        const markup = renderDashboard(payload, true);
        expect(markup).toContain('>Refreshing…</button>');
        expect(markup).toContain('disabled=""');
    });
});
