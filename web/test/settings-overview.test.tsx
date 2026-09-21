import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { EnvPayload, UseEnv } from '../src/api/useEnv.js';
import type { Session } from '../src/api/useSession.js';
import type { WorkspacePayload, UseWorkspace } from '../src/api/useWorkspace.js';
import { SettingsOverviewPage } from '../src/pages/SettingsOverviewPage.js';
import { deriveReadiness } from '../src/settings/readiness.js';

/**
 * The configuration overview's pure derivation (issue 180): five ordered readiness items computed
 * from exactly what SettingsLayout already polls — the session, the shared workspace poll and the
 * shared environment read. Presentation-neutral on purpose: no JSX, no fetches, no color words;
 * the page renders what this returns. The precedence rules the issue pins — failed repositories
 * outrank in-progress ones, a missing root outranks empty arrays, initial loading never reports
 * zero, and stale data stays visible with its error rendered separately — are pinned here, at the
 * only level where every branch can be reached without a browser.
 */

const session: Pick<Session, 'organization' | 'role'> = {
    organization: { id: 'org-1', name: 'Bellows AI' },
    role: 'member',
};

const workspaceData = (over: Partial<WorkspacePayload> = {}): WorkspacePayload => ({
    root: '/workspaces/octocat',
    repos: [],
    orphaned: [],
    executors: [],
    ...over,
});

const repo = (over: { status?: 'queued' | 'cloning' | 'ready' | 'failed'; error?: string | null }) => ({
    owner: 'acme',
    name: 'web',
    status: 'ready' as const,
    error: null,
    selectedAt: '2026-01-01T00:00:00Z',
    readyAt: '2026-01-01T00:01:00Z',
    branch: 'main',
    lastCommit: null,
    sizeBytes: 1024,
    ...over,
});

const envRow = (over: { name: string; isSecret?: boolean }) => ({
    name: over.name,
    value: null,
    isSecret: over.isSecret ?? false,
    updatedAt: '2026-01-01T00:00:00Z',
});

const emptyEnv: EnvPayload = { org: [], workspace: [], repos: [] };

const input = (
    over: {
        session?: Pick<Session, 'organization' | 'role'> | null;
        workspace?: { data?: WorkspacePayload | null; loading?: boolean; error?: string | null };
        environment?: { data?: EnvPayload | null; loading?: boolean; error?: string | null };
    } = {}
) => ({
    session: over.session === undefined ? session : over.session,
    workspace: { data: null, loading: false, error: null, ...over.workspace },
    environment: { data: null, loading: false, error: null, ...over.environment },
});

const byId = (...items: ReturnType<typeof deriveReadiness>) => new Map(items.map((item) => [item.id, item]));

describe('deriveReadiness — item order and identity', () => {
    it('returns the five items in the order the issue fixes, each with heading, status, tone, facts and action', () => {
        const items = deriveReadiness(input());
        expect(items.map((item) => item.id)).toEqual([
            'organization',
            'workspace',
            'repositories',
            'executors',
            'environment',
        ]);
        for (const item of items) {
            expect(item.heading.length).toBeGreaterThan(0);
            expect(item.status.length).toBeGreaterThan(0);
            expect(['ok', 'attention', 'pending', 'info']).toContain(item.tone);
            expect(Array.isArray(item.facts)).toBe(true);
        }
    });
});

describe('deriveReadiness — loading never reports zero', () => {
    it('reports checking states while the polls have not answered', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    session: null,
                    workspace: { loading: true },
                    environment: { loading: true },
                })
            )
        );
        expect(items.get('workspace')?.status).toBe('Checking workspace…');
        expect(items.get('repositories')?.status).toBe('Checking repositories…');
        expect(items.get('executors')?.status).toBe('Checking executors…');
        expect(items.get('environment')?.status).toBe('Checking environment scopes…');
        expect(items.get('organization')?.status).toBe('Checking organization…');
        for (const id of ['workspace', 'repositories', 'executors', 'environment'] as const) {
            expect(items.get(id)?.tone).toBe('pending');
        }
        const rendered = JSON.stringify(items);
        expect(rendered).not.toMatch(/\b0 (repositories|personal executors|environment values)/);
        expect(rendered).not.toContain('ready');
    });
});

describe('deriveReadiness — initial failure versus stale data', () => {
    it('reports unavailable with the named error when the first workspace read fails', () => {
        const items = byId(
            ...deriveReadiness(
                input({ workspace: { data: null, loading: false, error: 'The workspace request failed' } })
            )
        );
        expect(items.get('workspace')?.status).toBe('Workspace status unavailable');
        expect(items.get('workspace')?.tone).toBe('attention');
        expect(JSON.stringify(items.get('workspace')?.facts)).toContain('The workspace request failed');
        expect(items.get('repositories')?.status).toBe('Repository status unavailable');
        expect(items.get('executors')?.status).toBe('Executor status unavailable');
    });

    it('keeps deriving from stale data when a later poll fails — the error is not the item', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    workspace: {
                        data: workspaceData({ repos: [repo({ status: 'ready', name: 'web' })] }),
                        error: 'poll failed',
                    },
                })
            )
        );
        expect(items.get('workspace')?.status).toBe('Workspace available');
        expect(items.get('repositories')?.status).toBe('1 repository ready');
        expect(JSON.stringify(items.get('workspace')?.facts)).not.toContain('poll failed');
    });
});

describe('deriveReadiness — root null blocks tasks', () => {
    const items = byId(...deriveReadiness(input({ workspace: { data: workspaceData({ root: null }) } })));

    it('says the workspace is not configured and tasks cannot run', () => {
        expect(items.get('workspace')?.status).toBe('Workspace is not configured; tasks cannot run');
        expect(items.get('workspace')?.tone).toBe('attention');
        expect(items.get('workspace')?.action).toEqual({ label: 'Review workspace setup', to: '/settings/workspace' });
    });

    it('roots the repository item at the missing root, outranking the empty selection', () => {
        expect(items.get('repositories')?.status).toBe('Repository checkouts require a workspace root');
        expect(items.get('repositories')?.action).toEqual({
            label: 'Review workspace setup',
            to: '/settings/workspace',
        });
    });

    it('makes executors unavailable without calling the empty list an error', () => {
        expect(items.get('executors')?.status).toBe('Personal executors are unavailable');
        expect(items.get('executors')?.tone).toBe('attention');
        expect(JSON.stringify(items.get('executors')?.facts)).toContain('Tasks cannot run');
        expect(items.get('executors')?.action).toEqual({ label: 'Review workspace setup', to: '/settings/workspace' });
    });
});

describe('deriveReadiness — repositories by repo state', () => {
    it('failed repositories outrank queued and cloning ones, carrying names and reasons', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    workspace: {
                        data: workspaceData({
                            repos: [
                                repo({ name: 'web', status: 'ready' }),
                                { ...repo({ name: 'api' }), status: 'failed', error: 'authentication failed' },
                                repo({ name: 'cli', status: 'cloning' }),
                            ],
                        }),
                    },
                })
            )
        );
        expect(items.get('repositories')?.status).toBe('1 repository needs attention');
        expect(items.get('repositories')?.tone).toBe('attention');
        expect(JSON.stringify(items.get('repositories')?.facts)).toContain('acme/api — authentication failed');
        expect(items.get('repositories')?.action).toEqual({ label: 'Review repository status', to: '/settings/repos' });
    });

    it('reports setup while clones are queued or cloning and none failed', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    workspace: {
                        data: workspaceData({
                            repos: [repo({ name: 'web', status: 'queued' }), repo({ name: 'api', status: 'cloning' })],
                        }),
                    },
                })
            )
        );
        expect(items.get('repositories')?.status).toBe('Setting up 2 repositories');
        expect(items.get('repositories')?.tone).toBe('pending');
        expect(items.get('repositories')?.action).toEqual({ label: 'Review repository status', to: '/settings/repos' });
    });

    it('reads an empty selection with a root as a neutral not-yet-chosen state', () => {
        const items = byId(...deriveReadiness(input({ workspace: { data: workspaceData() } })));
        expect(items.get('repositories')?.status).toBe('No repositories enabled for your workspace');
        expect(items.get('repositories')?.tone).toBe('info');
        expect(items.get('repositories')?.action).toEqual({ label: 'Choose repositories', to: '/settings/repos' });
    });

    it('counts ready repositories as ready', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    workspace: { data: workspaceData({ repos: [repo({ name: 'web' }), repo({ name: 'api' })] }) },
                })
            )
        );
        expect(items.get('repositories')?.status).toBe('2 repositories ready');
        expect(items.get('repositories')?.tone).toBe('ok');
        expect(items.get('repositories')?.action).toEqual({ label: 'Review repositories', to: '/settings/repos' });
    });
});

describe('deriveReadiness — executors', () => {
    it('reads zero rows with a root as the deployment default, not an error', () => {
        const items = byId(...deriveReadiness(input({ workspace: { data: workspaceData() } })));
        expect(items.get('executors')?.status).toBe('Using the deployment default');
        expect(items.get('executors')?.tone).toBe('info');
        expect(JSON.stringify(items.get('executors')?.facts)).toContain('No personal executor rows are required');
        expect(items.get('executors')?.action).toEqual({ label: 'Manage executors', to: '/settings/executors' });
    });

    it('names the first personal executor as the one new tasks pick', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    workspace: {
                        data: workspaceData({
                            executors: [
                                { name: 'fast-box', type: 'claude', createdAt: '2026-01-01T00:00:00Z' },
                                { name: 'big-box', type: 'claude', createdAt: '2026-01-02T00:00:00Z' },
                            ],
                        }),
                    },
                })
            )
        );
        expect(items.get('executors')?.status).toBe('2 personal executors available');
        expect(items.get('executors')?.tone).toBe('ok');
        expect(JSON.stringify(items.get('executors')?.facts)).toContain('fast-box is selected first on new tasks.');
        expect(items.get('executors')?.action).toEqual({ label: 'Manage executors', to: '/settings/executors' });
    });
});

describe('deriveReadiness — environment', () => {
    it('reads an empty payload as optional, with no action to take', () => {
        const items = byId(...deriveReadiness(input({ environment: { data: emptyEnv } })));
        expect(items.get('environment')?.status).toBe('No custom environment values');
        expect(items.get('environment')?.tone).toBe('info');
        expect(JSON.stringify(items.get('environment')?.facts)).toContain('optional');
        expect(items.get('environment')?.action).toBeNull();
    });

    it('counts variables and secrets per scope without names or values, each scope linked', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    environment: {
                        data: {
                            org: [envRow({ name: 'SHARED' }), envRow({ name: 'ORG_TOKEN', isSecret: true })],
                            workspace: [envRow({ name: 'MINE' })],
                            repos: [
                                { owner: 'acme', name: 'web', vars: [envRow({ name: 'DEPLOY', isSecret: true })] },
                                { owner: 'acme', name: 'api', vars: [] },
                            ],
                        },
                    },
                })
            )
        );
        const environment = items.get('environment')!;
        expect(environment.status).toBe('4 environment values configured');
        const facts = environment.facts.map((fact) => fact.text);
        expect(facts).toContain('Organization scope: 1 variable, 1 secret');
        expect(facts).toContain('Workspace scope: 1 variable, 0 secrets');
        expect(facts).toContain('Repository scope: 0 variables, 1 secret across 2 repositories');
        expect(environment.facts.map((fact) => fact.link?.to)).toEqual([
            '/settings/organization',
            '/settings/workspace',
            '/settings/repos',
        ]);
        const rendered = JSON.stringify(environment);
        for (const secret of ['SHARED', 'ORG_TOKEN', 'MINE', 'DEPLOY']) expect(rendered).not.toContain(secret);
    });
});

describe('deriveReadiness — organization identity', () => {
    it('shows the organization name and role, with no internal id', () => {
        const items = byId(...deriveReadiness(input()));
        expect(items.get('organization')?.status).toBe('Configured');
        expect(JSON.stringify(items.get('organization')?.facts)).toContain('Bellows AI');
        expect(JSON.stringify(items.get('organization')?.facts)).toContain('Your role: Member');
        expect(items.get('organization')?.action).toEqual({
            label: 'Review organization settings',
            to: '/settings/organization',
        });
        expect(JSON.stringify(items)).not.toContain('org-1');
    });

    it('reports an admin role by its title only, with no invented powers', () => {
        const items = byId(
            ...deriveReadiness(input({ session: { organization: session.organization, role: 'admin' } }))
        );
        expect(JSON.stringify(items.get('organization')?.facts)).toContain('Your role: Admin');
    });

    it('keeps checking while the session has not resolved', () => {
        const items = byId(...deriveReadiness(input({ session: null })));
        expect(items.get('organization')?.status).toBe('Checking organization…');
        expect(items.get('organization')?.tone).toBe('pending');
    });
});

describe('SettingsOverviewPage (render)', () => {
    /** The same contract panels.render.test.tsx pins: a null metric never leaks as a value. */
    const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

    const fullSession: Session = {
        authenticated: true,
        user: {
            id: '00000000-0000-4000-8000-000000000001',
            login: 'octocat',
            name: 'The Octocat',
            githubUserId: 1,
            avatarUrl: null,
        },
        role: 'member',
        membership: { invitedAt: null, claimedAt: null },
        account: { createdAt: null, lastLoginAt: null },
        organization: { id: 'bellows', name: 'Bellows AI' },
        organizations: [{ id: 'bellows', name: 'Bellows AI' }],
        workspacePath: '/workspaces/octocat',
        mode: 'none',
    };

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
        overrides: { session?: Session | null; workspace?: Partial<UseWorkspace>; env?: Partial<UseEnv> } = {}
    ): string =>
        renderToStaticMarkup(
            <MemoryRouter initialEntries={['/settings']}>
                <Routes>
                    <Route
                        element={
                            <Outlet
                                context={{
                                    session: overrides.session === undefined ? fullSession : overrides.session,
                                    workspace: { ...idleWorkspace, ...overrides.workspace },
                                    env: { ...idleEnv, ...overrides.env },
                                }}
                            />
                        }
                    >
                        <Route path="settings" element={<SettingsOverviewPage />} />
                    </Route>
                </Routes>
            </MemoryRouter>
        );

    it('renders one h1 with the eyebrow and description naming the organization', () => {
        const html = render();
        expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1);
        expect(html).toContain('Configuration overview');
        expect(html).toContain('Settings</p>');
        expect(html).toContain('Review what is configured for Bellows AI and your workspace.');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('shows the identity definition list without the internal id', () => {
        const html = render();
        expect(html).toContain('Bellows AI');
        expect(html).toContain('Your role');
        expect(html).toContain('Member');
        expect(html).not.toContain('bellows');
    });

    it('renders the five readiness headings in order', () => {
        const html = render();
        const headings = [
            '<h2>Organization</h2>',
            '<h2>Workspace</h2>',
            '<h2>Repositories</h2>',
            '<h2>Executors</h2>',
            '<h2>Environment</h2>',
        ];
        let at = -1;
        for (const heading of headings) {
            const next = html.indexOf(heading);
            expect(next, heading).toBeGreaterThan(at);
            at = next;
        }
    });

    it('reads as checking on a cold load, with no action link yet', () => {
        const html = render({ session: null });
        expect(html).toContain('Checking workspace…');
        expect(html).toContain('Checking repositories…');
        expect(html).toContain('Checking executors…');
        expect(html).toContain('Checking environment scopes…');
        expect(html).toContain('Checking your session…');
        expect(html).not.toContain('readiness-action');
    });

    it('links every item to its exact destination once the polls answer', () => {
        const html = render({
            workspace: {
                loading: false,
                data: {
                    root: '/workspaces/octocat',
                    repos: [repo({ name: 'web' })],
                    orphaned: [],
                    executors: [{ name: 'fast-box', type: 'claude', createdAt: '2026-01-01T00:00:00Z' }],
                },
            },
            env: { loading: false, data: emptyEnv },
        });
        expect(html).toContain('href="/settings/organization"');
        expect(html).toContain('Review organization settings');
        expect(html).toContain('href="/settings/workspace"');
        expect(html).toContain('href="/settings/repos"');
        expect(html).toContain('href="/settings/executors"');
        expect(html).toContain('Workspace available');
        expect(html).toContain('1 repository ready');
        expect(html).toContain('1 personal executor available');
        expect(html).toContain('No custom environment values');
    });

    it('sends a missing root to the workspace setup page, never a generic fix', () => {
        const html = render({
            workspace: {
                loading: false,
                data: { root: null, repos: [], orphaned: [], executors: [] },
            },
            env: { loading: false, data: emptyEnv },
        });
        expect(html).toContain('Workspace is not configured; tasks cannot run');
        expect((html.match(/href="\/settings\/workspace"/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });

    it('renders a later poll failure as a separate status line under the last-good items', () => {
        const html = render({
            workspace: { loading: false, error: 'the workspace poll failed', data: workspaceData() },
            env: { loading: false, error: 'the environment read failed', data: emptyEnv },
        });
        expect(html).toContain('Workspace available');
        expect(html).toContain('<p class="status">the workspace poll failed</p>');
        expect(html).toContain('<p class="status">the environment read failed</p>');
    });

    it('names the error once on an initial failure — the item fact is the announcement', () => {
        const html = render({ workspace: { loading: false, error: 'the first read failed' } });
        expect(html).toContain('Workspace status unavailable');
        expect(html.split('the first read failed').length - 1).toBe(1);
    });
});
