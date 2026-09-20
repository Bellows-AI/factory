import type { OrganizationMeta } from '@factory-ai/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { OrgSelector } from '../src/components/OrgSelector.js';
import { AppBar } from '../src/components/AppBar.js';
import type { Session } from '../src/api/useSession.js';
import type { StatsPayload } from '../src/api/useStats.js';

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
    /*
     * The global bar (issue 160) is chrome only: the organization selector and the user menu, and
     * — on mobile — the navigation trigger and the brand. No h1, no telemetry: the dashboard owns
     * its repo coverage, timestamp and Refresh, and the routed page owns the page's heading.
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

    const html = (meta: StatsPayload['meta'] | null = payload.meta, session: Session | null = null) =>
        renderToStaticMarkup(
            <MemoryRouter>
                {/* The brand is a NavLink and the menu holds one, so the bar needs a router. */}
                <AppBar meta={meta} session={session} navOpen={false} onOpenNav={() => {}} />
            </MemoryRouter>
        );

    it('renders the brand, the drawer trigger, then the actions — and no h1', () => {
        const markup = html();
        expect(markup).not.toContain('<h1');
        expect(markup).toContain('appbar-brand');
        expect(markup).toContain('>Factory</a>');
        expect(markup).toContain('Open navigation');
        expect(markup.indexOf('appbar-trigger')).toBeLessThan(markup.indexOf('appbar-actions'));
    });

    it('exposes the drawer trigger with its state and its target', () => {
        const markup = html();
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('aria-controls="mobile-nav"');
    });

    it('puts the selector in the actions group', () => {
        const markup = html();
        expect(markup.indexOf('org-select')).toBeGreaterThan(markup.indexOf('appbar-actions'));
    });

    it('renders nothing before the first payload rather than an empty control', () => {
        const markup = html(null);
        expect(markup).not.toContain('org-select');
    });

    it('carries no telemetry chrome: no heading, no timestamp, no Refresh, no repo names', () => {
        // The exile (issue 159): telemetry metadata lives in the dashboard's page header — the
        // app bar is identity and navigation only, on every page.
        const markup = html();
        expect(markup).not.toContain('<h1');
        expect(markup).not.toContain('Refresh');
        expect(markup).not.toContain('data as of');
        expect(markup).not.toContain('bellows.ai');
    });

    it('renders the user menu once the session is known, and nothing before it', () => {
        expect(html()).not.toContain('user-menu-button');
        const withSession: Session = {
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
        const markup = html(payload.meta, withSession);
        expect(markup).toContain('user-menu-button');
        expect(markup).toContain('octocat');
    });
});
