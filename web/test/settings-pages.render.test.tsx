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

/** The layout's unsaved-change registry (issue 181), inert under a static render. */
const idleUnsaved = { guards: new Map(), setGuard: () => {} };

const render = (
    path: string,
    overrides: { session?: Session; workspace?: Partial<UseWorkspace>; env?: Partial<UseEnv> } = {}
) => {
    /**
     * Publishes what SettingsLayout promises — the shell context, both polls and the unsaved
     * registry — with the polls taken from the overrides, not from the real hooks: the point of
     * this suite is the pages' POSTURES, and the layout's own fetches are the wiring suite's
     * business.
     */
    function SettingsArea() {
        return (
            <Outlet
                context={{
                    session: overrides.session ?? session,
                    workspace: { ...idleWorkspace, ...overrides.workspace },
                    env: { ...idleEnv, ...overrides.env },
                    unsaved: idleUnsaved,
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
    it('states nothing about counts while either answer is unresolved — never 0 of 0', () => {
        // Cold render: the installation list has not been fetched and the workspace poll has not
        // answered. "0 of 0 repositories enabled" would be two claims about two absent answers.
        const html = render('/settings/repos');
        expect(html).toContain('Choose which repositories are checked out for your workspace');
        expect(html).not.toContain('repositories enabled');
        expect(html).not.toContain('0 of 0');
        expect(html).not.toContain('No variables configured.');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('says the workspace root is missing, links to Workspace, and holds the save', () => {
        // `root: null` is a deliberate configuration: availability and configuration stay
        // readable, but nothing may claim checkouts or save a selection into nothing.
        const html = render('/settings/repos', {
            workspace: { loading: false, data: { root: null, repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('no workspace root');
        expect(html).toContain('/settings/workspace');
        expect(html).toContain('disabled');
        expect(html).not.toContain('No variables configured.');
    });

    it('names a failed workspace read rather than stating checkout facts over it', () => {
        const html = render('/settings/repos', {
            workspace: { loading: false, error: 'The workspace request failed' },
        });
        expect(html).toContain('The workspace request failed');
        expect(html).not.toContain('Not checked out');
        expect(html).not.toContain('repositories enabled');
    });

    it('renders no repository editor after a failed environment read', () => {
        const html = render('/settings/repos', {
            env: { loading: false, error: 'The environment request failed' },
        });
        expect(html).toContain('The environment request failed');
        expect(html).not.toContain('No variables configured.');
        expect(html).not.toContain('Add variable');
    });

    it('renders no configuration detail before a repository is chosen', () => {
        const html = render('/settings/repos');
        expect(html).not.toContain('Environment for');
        expect(html).not.toContain('Choose a repository…');
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
        expect(render('/settings/repos')).not.toContain('<h2>Repositories</h2>');
        // The repositories page's inner headings name its two panels; neither restates the title.
        expect(render('/settings/repos')).toContain('<h2>Availability</h2>');
        expect(render('/settings/repos')).toContain('<h2>Repository list</h2>');
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
