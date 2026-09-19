import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import { SettingsLayout } from '../src/pages/SettingsLayout.js';
import { SettingsExecutorsPage } from '../src/pages/SettingsExecutorsPage.js';
import { SettingsOrganizationPage } from '../src/pages/SettingsOrganizationPage.js';
import { SettingsRepositoriesPage } from '../src/pages/SettingsRepositoriesPage.js';
import { SettingsWorkspacePage } from '../src/pages/SettingsWorkspacePage.js';

/**
 * The four pages of the settings tree, rendered through a real route tree so the layout's outlet
 * context exists. Under `renderToStaticMarkup` effects never fire, so every data hook sits in its
 * initial (loading) state — which is exactly what these assertions pin: the loading posture of
 * each page, and that no editor mounts before its data (the draft-survival contract: an editor
 * mounted early would seed empty drafts and a later save would wipe the stored rows).
 */

/** The same contract panels.render.test.tsx pins: a null metric never leaks as a value. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

const session: Session = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        login: 'octocat',
        name: 'The Octocat',
        githubUserId: 4242,
        avatarUrl: null,
    },
    role: 'admin',
    membership: { invitedAt: null, claimedAt: null },
    account: { createdAt: null, lastLoginAt: null },
    organization: { id: 'bellows', name: 'Bellows AI' },
    workspacePath: null,
    mode: 'none',
};

/** Stands in for AppShell, publishing the session the layout re-publishes. */
function ShellStub() {
    return <Outlet context={{ session }} />;
}

const routes = (
    <Route element={<ShellStub />}>
        <Route path="settings" element={<SettingsLayout />}>
            <Route path="organization" element={<SettingsOrganizationPage />} />
            <Route path="workspace" element={<SettingsWorkspacePage />} />
            <Route path="repos" element={<SettingsRepositoriesPage />} />
            <Route path="executors" element={<SettingsExecutorsPage />} />
        </Route>
    </Route>
);

const render = (path: string) =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <Routes>{routes}</Routes>
        </MemoryRouter>
    );

describe('Settings organization page', () => {
    it('renders the stub, and holds the core editor back until the environment arrives', () => {
        const html = render('/settings/organization');
        expect(html).toContain('Organization settings are not built yet.');
        expect(html).toContain('Loading environment…');
        // The editor mounts only on data: its draft is seeded from initialVars in a state
        // initializer, so an early mount would freeze empty rows over the stored ones.
        expect(html).not.toContain('No variables configured.');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('Settings workspace page', () => {
    it('says it is loading until the workspace poll answers', () => {
        const html = render('/settings/workspace');
        expect(html).toContain('Loading your workspace…');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('Settings executors page', () => {
    it('says it is loading until the workspace poll answers, executors riding that poll', () => {
        const html = render('/settings/executors');
        expect(html).toContain('Loading your workspace…');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('Settings repositories page', () => {
    it('renders both sections, the repository editor held back until data arrives', () => {
        const html = render('/settings/repos');
        expect(html).toContain('Available repositories');
        expect(html).toContain('Per repository');
        expect(html).toContain('Choose a repository…');
        expect(html).not.toContain('No variables configured.');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});
