import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
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
        expect(html).toContain('Name the personal runner configuration offered when you start a task.');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('scopes the list, carries the guidance, and marks only the first row selected first', () => {
        const html = render('/settings/executors', {
            workspace: {
                loading: false,
                data: {
                    root: '/workspaces',
                    repos: [],
                    orphaned: [],
                    executors: [
                        { name: 'main', type: 'claude-code', createdAt: '2026-09-01T00:00:00.000Z' },
                        { name: 'oc', type: 'opencode', createdAt: '2026-09-02T00:00:00.000Z' },
                    ],
                },
            },
        });
        expect(html).toContain('page-header-description');
        expect(html).toContain('The deployment chooses the runner CLI and image');
        expect(html).toContain('<h2>My workspace</h2>');
        expect(html.match(/Selected first on new tasks/g)?.length).toBe(1);
        expect(html).toContain('Add executor');
    });

    it('refuses before any dialog when the deployment has no workspace root', () => {
        // The executor routes answer 409 WORKSPACE_DISABLED without a root; the page refuses
        // first — the action never renders, and the sentence points at workspace setup.
        const html = render('/settings/executors', {
            workspace: { loading: false, data: { root: null, repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('Personal executors are unavailable because this deployment has no workspace root.');
        // The link is woven into the sentence — "…until <a>workspace setup</a> is complete." — so
        // the two halves are asserted around it.
        expect(html).toContain('Tasks cannot run until <a');
        expect(html).toContain('workspace setup</a> is complete.');
        expect(html).toContain('href="/settings/workspace"');
        expect(html).not.toContain('Add executor');
    });

    it('renders no list after a failed workspace read — the error is the whole story', () => {
        // "No personal executors configured" beside an error would claim a fact about the
        // workspace the request never delivered.
        const html = render('/settings/executors', {
            workspace: { loading: false, error: 'The workspace request failed' },
        });
        expect(html).toContain('The workspace request failed');
        expect(html).not.toContain('No personal executors configured');
        expect(html).not.toContain('Add executor');
    });

    it('fetches nothing on mount — the config read belongs to the dialog open, not the page', () => {
        // Stubbed at the global the page would fetch through: a static render runs no effects,
        // and nothing else in these components fetches at module scope.
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        render('/settings/executors');
        expect(fetch).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
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

describe('settings page headers', () => {
    // Every page answers "where am I" with exactly one h1 — the page header's — and the
    // Settings eyebrow names the tree the page sits in (#159).
    it.each([
        ['/settings/organization', 'Organization'],
        ['/settings/workspace', 'Workspace'],
        ['/settings/repos', 'Repositories'],
        ['/settings/executors', 'Executors'],
    ])('%s carries one h1 naming the section, under the Settings eyebrow', (path, title) => {
        const html = render(path);
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain(`<h1>${title}</h1>`);
        expect(html).toContain('page-header-eyebrow');
        expect(html).toContain('>Settings</p>');
    });

    it('leaves no inner heading restating the page title', () => {
        expect(render('/settings/organization')).not.toContain('<h2>Organization</h2>');
        expect(render('/settings/workspace')).not.toContain('<h2>Workspace</h2>');
        expect(render('/settings/executors')).not.toContain('<h2>Executors</h2>');
        // The repositories page's two inner headings name distinct panels; neither restates
        // the page title.
        expect(render('/settings/repos')).toContain('<h2>Available repositories</h2>');
        expect(render('/settings/repos')).toContain('<h2>Per repository</h2>');
    });

    it('carries the workspace sentence in the header, and the picker button in its actions', () => {
        const html = render('/settings/workspace', {
            workspace: { loading: false, data: { root: '/workspaces', repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('page-header-description');
        expect(html).toContain('Your checkouts live at');
        expect(html).toContain('page-header-actions');
        expect(html).toContain('Select repositories');
    });

    it('offers no picker action on a deployment with no workspace root', () => {
        // `root: null` is a deliberate configuration: there is nothing to check out into, so
        // the header keeps its sentence and drops its action.
        const html = render('/settings/workspace', {
            workspace: { loading: false, data: { root: null, repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('no workspace root configured');
        expect(html).not.toContain('Select repositories');
    });

    it('puts Add executor in the executors page header', () => {
        const html = render('/settings/executors', {
            workspace: { loading: false, data: { root: '/workspaces', repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('page-header-actions');
        expect(html).toContain('Add executor');
    });
});
