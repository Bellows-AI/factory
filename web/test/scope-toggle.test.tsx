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
    it('renders beside the range selector when the session reports a signed-in user', () => {
        const html = renderPage(session('github'));
        expect(html).toContain('range-selector');
        expect(html).toContain('Whose usage'); // the fieldset legend
        expect(html).toContain('Me');
    });

    it('does not render at all under AUTH_MODE=none, where there is no me', () => {
        const html = renderPage(null);
        expect(html).toContain('range-selector');
        expect(html).not.toContain('Whose usage');
        expect(html).not.toContain('Me');
    });
});
