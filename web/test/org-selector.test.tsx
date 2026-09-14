import type { OrganizationMeta } from '@factory-ai/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { OrgSelector } from '../src/components/OrgSelector.js';
import { TopBar } from '../src/components/TopBar.js';
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
    it('renders the single organization as a disabled native select', () => {
        const html = render(CONFIG);
        expect(html).toContain('<select');
        expect(html).toContain('disabled=""');
        expect(html).toContain('Bellows AI');
        expect(html.match(/<option/g)).toHaveLength(1);
    });

    it('says why it is inactive, not only that it is', () => {
        // A disabled control with no explanation reads as a bug or as a permissions problem.
        const html = render(CONFIG);
        expect(html).toContain('ORG_ID');
        expect(html).toContain('one organization');
    });

    it('marks the current organization as selected', () => {
        expect(render(CONFIG)).toContain('selected=""');
    });

    it('leaves the control live and lists every organization in directory mode', () => {
        // The leave-room case. Costs nothing today, and fails the day someone hard-codes disabled.
        const html = render(DIRECTORY);
        expect(html).not.toContain('disabled');
        expect(html.match(/<option/g)).toHaveLength(2);
        expect(html).toContain('Acme Inc');
    });

    it('does not disable a directory user who currently belongs to one organization', () => {
        // Pins `mode` over `available.length`. A membership can be granted with no deploy, and a
        // control disabled by list length would be inert for the wrong reason.
        const html = render({ ...DIRECTORY, available: [DIRECTORY.current] });
        expect(html).not.toContain('disabled');
    });
});

describe('TopBar', () => {
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

    const html = (session: Session | null = null) =>
        renderToStaticMarkup(
            <MemoryRouter>
                {/* The menu holds a NavLink, so the TopBar needs a router context to render it. */}
                <TopBar data={payload} refreshing={false} onRefresh={() => {}} session={session} />
            </MemoryRouter>
        );

    it('puts the selector in the actions group, ahead of Refresh', () => {
        const markup = html();
        expect(markup.indexOf('org-select')).toBeGreaterThan(markup.indexOf('topbar-actions'));
        expect(markup.indexOf('org-select')).toBeLessThan(markup.indexOf('Refresh'));
    });

    it('keeps naming the repos rather than letting the organization name stand in for them', () => {
        // The figures below are only interpretable if you know what went into them, and an
        // organization name does not tell you that. Stops a later "the org name says it all".
        expect(html()).toContain('bellows.ai');
    });

    it('renders nothing before the first payload rather than an empty control', () => {
        const markup = renderToStaticMarkup(
            <TopBar data={null} refreshing={false} onRefresh={() => {}} session={null} />
        );
        expect(markup).not.toContain('org-select');
        expect(markup).toContain('loading…');
    });

    it('renders the user menu once the session is known, and nothing before it', () => {
        expect(html()).not.toContain('user-menu');
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
            workspacePath: null,
            mode: 'github',
        };
        const markup = html(withSession);
        expect(markup).toContain('user-menu');
        expect(markup).toContain('/settings');
    });
});
