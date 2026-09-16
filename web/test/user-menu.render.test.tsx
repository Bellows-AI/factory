import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import { UserMenu } from '../src/components/UserMenu.js';

/**
 * `MemoryRouter` rather than a browser router: this suite has no DOM, and the menu's Settings link
 * is a `NavLink`, which needs a router context to render at all.
 */

const session: Session = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        login: 'octocat',
        name: 'The Octocat',
        githubUserId: 4242,
        avatarUrl: 'https://avatars.githubusercontent.com/u/4242.png',
    },
    role: 'member',
    membership: { invitedAt: '2026-01-15T09:30:00.000Z', claimedAt: '2026-01-16T10:00:00.000Z' },
    account: { createdAt: '2026-01-15T09:30:00.000Z', lastLoginAt: '2026-08-21T12:00:00.000Z' },
    organization: { id: 'bellows', name: 'Bellows AI' },
    workspacePath: '/workspaces/bellows/00000000-0000-4000-8000-000000000001',
    mode: 'github',
};

const render = (forSession: Session) =>
    renderToStaticMarkup(
        <MemoryRouter>
            <UserMenu session={forSession} />
        </MemoryRouter>
    );

describe('UserMenu', () => {
    it('names the login and links to the settings page', () => {
        const html = render(session);
        expect(html).toContain('octocat');
        expect(html).toContain('href="/settings"');
    });

    it('renders the avatar image when GitHub reports one', () => {
        const html = render(session);
        expect(html).toContain('<img');
        expect(html).toContain('https://avatars.githubusercontent.com/u/4242.png');
    });

    it('falls back to an initial chip when there is no avatar, and never emits an empty src', () => {
        // AUTH_MODE=none has no avatar and GitHub can omit one too; a broken image icon is not a
        // sensible rendering of "no picture".
        const html = render({ ...session, user: { ...session.user, avatarUrl: null } });
        expect(html).not.toContain('<img');
        expect(html).toContain('avatar-fallback');
        expect(html).not.toContain('src=""');
    });

    it('offers sign out when there is a session to end', () => {
        const html = render(session);
        expect(html).toContain('Sign out');
    });

    it('offers no sign out under AUTH_MODE=none — there is no session to end', () => {
        // The mode ignores every credential, so a button here could never work. Not disabled —
        // absent, like the settings page's token sections under the same mode.
        const html = render({ ...session, mode: 'none' });
        expect(html).not.toContain('Sign out');
    });
});
