import { describe, expect, it } from 'vitest';
import type { EnvPayload } from '../src/api/useEnv.js';
import type { Session } from '../src/api/useSession.js';
import type { WorkspacePayload } from '../src/api/useWorkspace.js';
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

const input = (over: {
    session?: Pick<Session, 'organization' | 'role'> | null;
    workspace?: { data?: WorkspacePayload | null; loading?: boolean; error?: string | null };
    environment?: { data?: EnvPayload | null; loading?: boolean; error?: string | null };
} = {}) => ({
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
            ...deriveReadiness(input({ workspace: { data: null, loading: false, error: 'The workspace request failed' } }))
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
                    workspace: { data: workspaceData({ repos: [repo({ status: 'ready', name: 'web' })] }), error: 'poll failed' },
                })
            )
        );
        expect(items.get('workspace')?.status).toBe('Workspace available');
        expect(items.get('repositories')?.status).toBe('1 repository ready');
        expect(JSON.stringify(items.get('workspace')?.facts)).not.toContain('poll failed');
    });
});

describe('deriveReadiness — root null blocks tasks', () => {
    const items = byId(
        ...deriveReadiness(input({ workspace: { data: workspaceData({ root: null }) } }))
    );

    it('says the workspace is not configured and tasks cannot run', () => {
        expect(items.get('workspace')?.status).toBe('Workspace is not configured; tasks cannot run');
        expect(items.get('workspace')?.tone).toBe('attention');
        expect(items.get('workspace')?.action).toEqual({ label: 'Review workspace setup', to: '/settings/workspace' });
    });

    it('roots the repository item at the missing root, outranking the empty selection', () => {
        expect(items.get('repositories')?.status).toBe('Repository checkouts require a workspace root');
        expect(items.get('repositories')?.action).toEqual({ label: 'Review workspace setup', to: '/settings/workspace' });
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
