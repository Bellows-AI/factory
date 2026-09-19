import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { UseEnv } from '../src/api/useEnv.js';
import type { UseWorkspace } from '../src/api/useWorkspace.js';
import type { Session } from '../src/api/useSession.js';
import { SettingsExecutorsPage } from '../src/pages/SettingsExecutorsPage.js';
import { SettingsOrganizationPage } from '../src/pages/SettingsOrganizationPage.js';
import { SettingsRepositoriesPage } from '../src/pages/SettingsRepositoriesPage.js';
import { SettingsWorkspacePage } from '../src/pages/SettingsWorkspacePage.js';

/**
 * The four pages of the settings tree, rendered through a real route tree so the layout's outlet
 * context exists. Under `renderToStaticMarkup` effects never fire, so hooks normally sit in their
 * initial (loading) state — which the first tests pin. The harness also takes OVERRIDES for the
 * published context, which is how the failure postures get reached: a page whose poll already
 * FAILED (`loading: false, data: null, error`) is unreachable in a plain SSR render, and it is
 * exactly the state where an editor mounted early would seed empty drafts over stored rows.
 */

/** The same contract panels.render.test.tsx pins: a null metric never leaks as a value. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

const session: Session = {
    authenticated: true,
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
    organizations: [{ id: 'bellows', name: 'Bellows AI' }],
    workspacePath: null,
    mode: 'none',
};

/** The hooks' initial (still loading) shape — what SettingsLayout publishes on a cold render. */
const idleWorkspace = {
    data: null,
    loading: true,
    error: null,
    saving: false,
    save: async () => null,
    saveExecutors: async () => null,
    listExecutorConfigs: async () => null,
} as unknown as UseWorkspace;

const idleEnv = {
    data: null,
    loading: true,
    error: null,
    saving: false,
    refresh: () => {},
    saveOrg: async () => null,
    saveWorkspace: async () => null,
    saveRepo: async () => null,
} as unknown as UseEnv;

const render = (
    path: string,
    overrides: { session?: Session; workspace?: Partial<UseWorkspace>; env?: Partial<UseEnv> } = {}
) => {
    /**
     * Publishes what SettingsLayout promises — the shell context plus both polls — with the polls
     * taken from the overrides, not from the real hooks: the point of this suite is the pages'
     * POSTURES, and the layout's own fetches are the wiring suite's business.
     */
    function SettingsArea() {
        return (
            <Outlet
                context={{
                    session: overrides.session ?? session,
                    workspace: { ...idleWorkspace, ...overrides.workspace },
                    env: { ...idleEnv, ...overrides.env },
                }}
            />
        );
    }
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route element={<SettingsArea />}>
                    <Route path="settings">
                        <Route path="organization" element={<SettingsOrganizationPage />} />
                        <Route path="workspace" element={<SettingsWorkspacePage />} />
                        <Route path="repos" element={<SettingsRepositoriesPage />} />
                        <Route path="executors" element={<SettingsExecutorsPage />} />
                    </Route>
                </Route>
            </Routes>
        </MemoryRouter>
    );
};

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

    it('renders no editor after a failed environment read — the error is the whole story', () => {
        // loading is false and data is null: the ternary's "else" arm. An editor mounted here
        // would be an ENABLED empty draft whose save wipes whatever is stored.
        const html = render('/settings/organization', {
            env: { loading: false, error: 'The environment request failed' },
        });
        expect(html).toContain('The environment request failed');
        expect(html).not.toContain('No variables configured.');
        expect(html).not.toContain('Add variable');
    });
});

describe('Settings workspace page', () => {
    it('says it is loading until the workspace poll answers', () => {
        const html = render('/settings/workspace');
        expect(html).toContain('Loading your workspace…');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('offers no picker after a failed workspace read — unavailable data is not an empty selection', () => {
        // The picker seeds itself from the workspace selection; opened over a failed poll it
        // would read "nothing selected", and its whole-list save would deselect everything.
        const html = render('/settings/workspace', {
            workspace: { loading: false, error: 'The workspace request failed' },
        });
        expect(html).toContain('The workspace request failed');
        expect(html).not.toContain('Select repositories');
    });

    it('renders no editor after a failed environment read', () => {
        const html = render('/settings/workspace', {
            // The workspace poll must have settled for the page to reach its env section at all.
            workspace: { loading: false, data: { root: '/workspaces', repos: [], orphaned: [], executors: [] } },
            env: { loading: false, error: 'The environment request failed' },
        });
        expect(html).toContain('The environment request failed');
        expect(html).not.toContain('No variables configured.');
        expect(html).not.toContain('Add variable');
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

    it('renders no repository editor after a failed environment read', () => {
        const html = render('/settings/repos', {
            env: { loading: false, error: 'The environment request failed' },
        });
        expect(html).toContain('The environment request failed');
        expect(html).not.toContain('No variables configured.');
        expect(html).not.toContain('Add variable');
    });
});
