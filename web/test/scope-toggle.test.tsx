import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import type { StatsPayload } from '../src/api/useStats.js';
import { DashboardPage } from '../src/pages/DashboardPage.js';

/**
 * The org/my toggle's existence is an auth-state decision, and this is the one render that can
 * see it: signed in, the toggle renders beside the range selector; under AUTH_MODE=none there is
 * no session, and the toggle must not exist at all — not even disabled, because a disabled
 * control advertises a filter the server can never answer.
 */

const session = (mode: 'github' | 'none'): Session => ({
    user: { id: 'u-1', login: 'carol', name: null, githubUserId: 1, avatarUrl: null },
    role: 'member',
    membership: { invitedAt: null, claimedAt: '2026-08-01T00:00:00Z' },
    account: { createdAt: null, lastLoginAt: null },
    organization: { id: 'test-org', name: 'Test Org' },
    workspacePath: null,
    mode,
});

const payload = {
    telemetry: null,
    tasks: null,
    meta: {
        fetchedAt: '2026-08-21T12:00:00.000Z',
        organization: null,
        repos: [{ owner: 'Bellows-AI', name: 'bellows.ai' }],
        range: { preset: 'all', from: null, to: null },
        telemetry: { status: 'empty', reason: null, unattributedSessions: 0 },
    },
} as unknown as StatsPayload;

function ShellStub({ withSession }: { withSession: Session | null }) {
    return (
        <Outlet
            context={{
                data: payload,
                range: { preset: 'all', from: '', to: '' },
                setRange: () => {},
                scope: 'org',
                setScope: () => {},
                session: withSession,
                refreshing: false,
                progress: null,
                error: null,
                refresh: () => {},
                tasks: { jobs: null, error: null },
            }}
        />
    );
}

const renderPage = (withSession: Session | null): string =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={['/']}>
            <Routes>
                <Route element={<ShellStub withSession={withSession} />}>
                    <Route path="/" element={<DashboardPage />} />
                </Route>
            </Routes>
        </MemoryRouter>
    );

describe('dashboard scope toggle', () => {
    it('renders beside the range selector when the session reports a signed-in member', () => {
        const html = renderPage(session('github'));
        expect(html).toContain('range-selector');
        expect(html).toContain('Whose usage'); // the RadioGroup's aria-label
        expect(html).toContain('Me');
    });

    it('does not render under AUTH_MODE=none, where the session is the local stand-in, not a me', () => {
        // The none-mode server still answers /api/auth/me with the __local__ stand-in, so the
        // mode is the tell: a toggle for the deployment itself would advertise a filter the
        // server refuses with SCOPE_REQUIRES_USER.
        const local = renderPage(session('none'));
        expect(local).toContain('range-selector');
        expect(local).not.toContain('Whose usage');
        expect(local).not.toContain('Me');

        // And with no session at all (signed out on a github-mode board): absent the same way.
        const anonymous = renderPage(null);
        expect(anonymous).not.toContain('Whose usage');
    });
});
