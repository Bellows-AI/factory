import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import { IdentityPanel } from '../src/panels/IdentityPanel.js';

/** The same contract panels.render.test.tsx pins: a null metric never leaks as a value. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

const session: Session = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        login: 'octocat',
        name: 'The Octocat',
        githubUserId: 4242,
        avatarUrl: 'https://avatars.githubusercontent.com/u/4242.png',
    },
    role: 'admin',
    membership: { invitedAt: '2026-01-15T09:30:00.000Z', claimedAt: '2026-01-16T10:00:00.000Z' },
    account: { createdAt: '2026-01-15T09:30:00.000Z', lastLoginAt: '2026-08-21T12:00:00.000Z' },
    organization: { id: 'bellows', name: 'Bellows AI' },
    workspacePath: '/workspaces/bellows/00000000-0000-4000-8000-000000000001',
    mode: 'github',
};

/** The stand-in account AUTH_MODE=none attributes everything to. */
const local: Session = {
    ...session,
    user: {
        ...session.user,
        login: '__local__',
        name: null,
        githubUserId: 0,
        avatarUrl: null,
    },
    role: 'admin',
    membership: { invitedAt: null, claimedAt: null },
    account: { createdAt: null, lastLoginAt: null },
    workspacePath: null,
    mode: 'none',
};

describe('IdentityPanel', () => {
    it('shows the identity facts, linking the login to GitHub', () => {
        const html = renderToStaticMarkup(<IdentityPanel session={session} />);
        expect(html).toContain('href="https://github.com/octocat"');
        expect(html).toContain('The Octocat');
        expect(html).toContain('4242');
        expect(html).toContain('admin');
        expect(html).toContain('2026-01-16 10:00');
        expect(html).toContain('<code>/workspaces/bellows/00000000-0000-4000-8000-000000000001</code>');
    });

    it('never emits a placeholder value for an absent field', () => {
        const html = renderToStaticMarkup(<IdentityPanel session={local} />);
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
        expect(html).toContain('—');
    });

    it('renders the stand-in account as a local stand-in, not as a GitHub identity', () => {
        // Its login is unrepresentable as a real GitHub login and its numeric id is 0 — a value
        // GitHub never issues. Neither may render as if it were GitHub data.
        const html = renderToStaticMarkup(<IdentityPanel session={local} />);
        expect(html).toContain('authentication off');
        expect(html).not.toContain('github.com');
        expect(html).not.toContain('>0<');
    });
});
