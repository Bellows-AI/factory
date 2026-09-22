import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
 * The pages of the settings tree, rendered through a real route tree so the layout's outlet
 * context exists. Under `renderToStaticMarkup` effects never fire, so hooks normally sit in their
 * initial (loading) state — which the first tests pin. The harness also takes OVERRIDES for the
 * published context, which is how the failure postures get reached: a page whose poll already
 * FAILED (`loading: false, data: null, error`) is unreachable in a plain SSR render, and it is
 * exactly the state where an editor mounted early would seed empty drafts over stored rows.
 */

/** The same contract panels.render.test.tsx pins: a null metric never leaks as a value. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

/** Source inspection, the `window.confirm` idiom: some contracts are about the file, not the render. */
const sourceOf = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/pages/${name}`, import.meta.url)), 'utf8');

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
    it('renders identity and scope context, and holds the core editor back until the environment arrives', () => {
        // The stub is gone (issue 180): the page answers "who am I and what is this scope" before
        // any editor. The editor still mounts only on data: its draft is seeded from initialVars
        // in a state initializer, so an early mount would freeze empty rows over the stored ones.
        const html = render('/settings/organization');
        expect(html).toContain('Bellows AI');
        expect(html).toContain('Your role');
        expect(html).toContain('Admin');
        expect(html).not.toContain('bellows');
        expect(html).toContain('Any member can edit.');
        expect(html).toContain('Loading environment…');
        expect(html).not.toContain('No variables configured.');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('leaves the editor enabled for a member — the server route is the authorization', () => {
        // `PUT /api/env/org` accepts any member of the installation (routes.env.test.ts), so a
        // disabled browser control was never authorization — it was a false claim about the API.
        const html = render('/settings/organization', {
            session: { ...session, role: 'member' },
            env: {
                loading: false,
                data: {
                    org: [{ name: 'SHARED', value: '1', isSecret: false, updatedAt: '2026-01-01T00:00:00Z' }],
                    workspace: [],
                    repos: [],
                },
            },
        });
        // No INPUT is disabled for a member — the row's name and value stay editable. (The Save
        // button itself may render disabled while the draft is clean, which is issue 182's
        // save-state rule, not a role gate.)
        expect(html.match(/<input [^>]*disabled/g) ?? []).toHaveLength(0);
        expect(html).not.toContain('shown here read-only');
    });

    it('carries no client-only admin gate in its source', () => {
        for (const page of ['SettingsOrganizationPage.tsx', 'SettingsRepositoriesPage.tsx']) {
            const source = sourceOf(page);
            expect(source, page).not.toContain('isAdmin');
        }
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

    it('states the workspace scope before its editor', () => {
        // The workspace poll must have settled for the page to reach its env section at all —
        // the loading posture early-returns with the header and the status line only.
        const html = render('/settings/workspace', {
            workspace: { loading: false, data: { root: '/workspaces', repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('My workspace');
        expect(html).toContain('Applies only to tasks the current member starts.');
        expect(html).toContain('Edited only by that member.');
    });

    it('offers no checkout management after a failed workspace read — unavailable data is not an empty workspace', () => {
        const html = render('/settings/workspace', {
            workspace: { loading: false, error: 'The workspace request failed' },
        });
        expect(html).toContain('The workspace request failed');
        expect(html).not.toContain('Manage repository checkouts');
        expect(html).not.toContain('Select repositories');
    });

    it('links to the repositories page for checkout management, and nowhere offers a picker', () => {
        const html = render('/settings/workspace', {
            workspace: { loading: false, data: { root: '/workspaces', repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('Your checkouts live at');
        expect(html).toContain('Manage repository checkouts');
        expect(html).toContain('/settings/repos');
        expect(html).not.toContain('Select repositories');
        expect(html).not.toContain('No variables configured.');
    });

    it('states the mandated root-null copy — an operator, not the member, fixes it', () => {
        const html = render('/settings/workspace', {
            workspace: { loading: false, data: { root: null, repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('This deployment has no workspace root. Tasks cannot run until an operator sets');
        expect(html).toContain('ORG_WORKSPACE_ROOT');
        expect(html).not.toContain('Manage repository checkouts');
    });

    it('keeps the orphaned checkouts visible, named, and without a delete action', () => {
        const html = render('/settings/workspace', {
            workspace: {
                loading: false,
                data: { root: '/workspaces', repos: [], orphaned: [{ owner: 'acme', name: 'gone' }], executors: [] },
            },
        });
        expect(html).toContain('Still on disk');
        expect(html).toContain('acme/gone');
        expect(html).toContain('no longer enabled');
        expect(html).toContain('remains on disk');
        expect(html).not.toContain('Delete');
    });

    it('renders the personal environment editor when its store answers', () => {
        const html = render('/settings/workspace', {
            workspace: { loading: false, data: { root: '/workspaces', repos: [], orphaned: [], executors: [] } },
            env: { loading: false, data: { org: [], workspace: [], repos: [] } },
        });
        expect(html).toContain('My workspace');
        expect(html).toContain('No variables configured.');
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
        expect(html).toContain('Each task runs with its selected executor');
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

    it('keeps no role-conditional sentence — the editor is every member\u2019s to edit (issue 180)', () => {
        // The old page told members the editor was read-only; the server route never was
        // (routes.env.test.ts accepts a member). The rewritten page has no role gate and no
        // such sentence — and no editor before a repository is chosen.
        const html = render('/settings/repos', { session: { ...session, role: 'member' } });
        expect(html).not.toContain('shown here read-only');
        expect(html).not.toContain('An admin configures repository environment');
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

describe('settings scope context (issue 182 invariants)', () => {
    // Scope context stays BEFORE the controls: each page's own sentence names the scope, and the
    // editor mounts under it. The guard dialog copy never appears in a clean render — it exists
    // only when the coordinator has something pending, which a static render cannot be.
    const envData = {
        org: [{ name: 'CORE_SECRET', value: null, isSecret: true, updatedAt: '2026-09-01T00:00:00.000Z' }],
        workspace: [],
        repos: [{ owner: 'octo', name: 'hooks', vars: [] }],
    };

    it('renders the org editor under its scope sentence, tabs counting the stored rows', () => {
        const html = render('/settings/organization', { env: { loading: false, data: envData } });
        expect(html).toContain('Injected into every runner in this deployment');
        expect(html).toContain('Variables (0)');
        expect(html).toContain('Secrets (1)');
        expect(html).not.toContain('Discard unsaved changes?');
    });

    it('renders the workspace editor under its scope sentence', () => {
        const html = render('/settings/workspace', {
            workspace: { loading: false, data: { root: '/workspaces', repos: [], orphaned: [], executors: [] } },
            env: { loading: false, data: envData },
        });
        expect(html).toContain('Your own defaults, on every task you queue.');
        expect(html).toContain('No variables configured.');
        expect(html).not.toContain('Discard unsaved changes?');
    });

    it('renders the repositories page with no dialog while clean, and no empty editor before a choice', () => {
        // Issue 182's invariant on the repos page: a clean area raises no discard dialog. Issue
        // 181's shape: the editor appears only behind a row's Configure action — no select panel
        // renders an empty draft before a repository is chosen.
        const html = render('/settings/repos', { env: { loading: false, data: envData } });
        expect(html).not.toContain('Choose a repository…');
        expect(html).not.toContain('Environment for');
        expect(html).not.toContain('Discard unsaved changes?');
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

    it('carries the workspace sentence in the header, and the checkout-management link in its actions', () => {
        const html = render('/settings/workspace', {
            workspace: { loading: false, data: { root: '/workspaces', repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('page-header-description');
        expect(html).toContain('Your checkouts live at');
        expect(html).toContain('page-header-actions');
        expect(html).toContain('Manage repository checkouts');
    });

    it('offers no checkout-management action on a deployment with no workspace root', () => {
        // `root: null` is a deliberate configuration: there is nothing to check out into, so
        // the header keeps its sentence and drops its action.
        const html = render('/settings/workspace', {
            workspace: { loading: false, data: { root: null, repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('no workspace root');
        expect(html).not.toContain('Manage repository checkouts');
    });

    it('puts Add executor in the executors page header', () => {
        const html = render('/settings/executors', {
            workspace: { loading: false, data: { root: '/workspaces', repos: [], orphaned: [], executors: [] } },
        });
        expect(html).toContain('page-header-actions');
        expect(html).toContain('Add executor');
    });
});
