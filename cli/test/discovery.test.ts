import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const ENV = { FACTORY_URL: 'http://board', FACTORY_TOKEN: 'fat_abc' };

const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

/** Answers each path from `routes`; a path not listed fails the test by answering 404. */
function harness(routes: Record<string, () => Response>) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetch = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
        const path = String(url).replace('http://board', '');
        calls.push({
            path,
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        return routes[path]?.() ?? json({ error: `unrouted ${path}`, code: 'NOT_FOUND' }, 404);
    }) as unknown as typeof globalThis.fetch;
    const io = { env: ENV, fetch, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
    return { out, err, calls, io };
}

const visible = (overrides: Record<string, unknown> = {}) => ({
    repos: [
        { owner: 'acme', name: 'api', private: true, defaultBranch: 'main', pushedAt: null },
        { owner: 'acme', name: 'web', private: false, defaultBranch: 'trunk', pushedAt: null },
    ],
    installation: { account: 'acme' },
    meta: { fetchedAt: '2026-10-01T00:00:00.000Z', error: null },
    ...overrides,
});

const workspace = (overrides: Record<string, unknown> = {}) => ({
    root: '/ws/org/user',
    repos: [
        { owner: 'acme', name: 'api', status: 'ready', error: null },
        { owner: 'gone', name: 'old', status: 'ready', error: null },
    ],
    orphaned: [],
    executors: [{ id: 'e1', name: 'mine', type: 'claude', suspended: false }],
    orgExecutors: [{ name: 'team', type: 'claude', suspended: true }],
    defaultExecutor: { scope: 'user', name: 'mine' },
    ...overrides,
});

describe('factory repo list', () => {
    it('joins visible with synced and keeps a synced repo the installation no longer shows', async () => {
        const { out, calls, io } = harness({
            '/api/repos': () => json(visible()),
            '/api/workspace': () => json(workspace()),
        });

        const code = await run(['repo', 'list', '--json'], io);

        expect(code).toBe(0);
        const envelope = JSON.parse(out.join(''));
        expect(envelope.command).toBe('repo list');
        expect(
            envelope.data.repos.map((r: { repo: string; visible: boolean; synced: boolean }) => [
                r.repo,
                r.visible,
                r.synced,
            ])
        ).toEqual([
            ['acme/api', true, true],
            ['acme/web', true, false],
            ['gone/old', false, true],
        ]);
        // Read-only: discovery never writes, so it can neither sync nor provision.
        expect(calls.every((call) => call.method === 'GET')).toBe(true);
    });

    it('prints one line per repo for a person', async () => {
        const { out, io } = harness({
            '/api/repos': () => json(visible()),
            '/api/workspace': () => json(workspace()),
        });

        expect(await run(['repo', 'list'], io)).toBe(0);

        const text = out.join('');
        expect(text).toContain('acme/api  visible  synced(ready)  private  main');
        expect(text).toContain('acme/web  visible  not-synced  public  trunk');
        expect(text).toContain('gone/old  not-visible  synced(ready)');
    });

    it('says so for an empty installation, and carries the board error with the last good list', async () => {
        const empty = harness({
            '/api/repos': () => json(visible({ repos: [] })),
            '/api/workspace': () => json(workspace({ repos: [] })),
        });
        expect(await run(['repo', 'list'], empty.io)).toBe(0);
        expect(empty.out.join('')).toContain('no repositories visible');

        const stale = harness({
            '/api/repos': () => json(visible({ meta: { fetchedAt: null, error: 'GitHub is unreachable' } })),
            '/api/workspace': () => json(workspace({ root: null, repos: [] })),
        });
        expect(await run(['repo', 'list', '--json'], stale.io)).toBe(0);
        const data = JSON.parse(stale.out.join('')).data;
        expect(data.error).toBe('GitHub is unreachable');
        expect(data.workspaceEnabled).toBe(false);
    });

    it('surfaces an unavailable board runtime as a refusal with its code, exit 1', async () => {
        const { out, io } = harness({
            '/api/repos': () => json({ error: "No runtime for 'o'; retry", code: 'REPOS_UNAVAILABLE' }, 503),
        });

        expect(await run(['repo', 'list', '--json'], io)).toBe(1);

        const envelope = JSON.parse(out.join(''));
        expect(envelope.outcome).toBe('refused');
        expect(envelope.error).toMatchObject({ code: 'REPOS_UNAVAILABLE', status: 503 });
    });

    it('refuses a stray argument as usage, making no request', async () => {
        const { calls, io } = harness({});
        expect(await run(['repo', 'list', 'acme/api'], io)).toBe(2);
        expect(calls).toHaveLength(0);
    });
});

describe('factory executor list', () => {
    it('lists personal then org profiles with their scope, suspension and the default', async () => {
        const { out, io } = harness({ '/api/workspace': () => json(workspace()) });

        expect(await run(['executor', 'list', '--json'], io)).toBe(0);

        expect(JSON.parse(out.join('')).data.executors).toEqual([
            { scope: 'user', name: 'mine', type: 'claude', suspended: false, default: true },
            { scope: 'org', name: 'team', type: 'claude', suspended: true, default: false },
        ]);
    });

    it('renders the human form and an empty state', async () => {
        const some = harness({ '/api/workspace': () => json(workspace()) });
        expect(await run(['executor', 'list'], some.io)).toBe(0);
        expect(some.out.join('')).toBe('user  mine  claude  active  default\norg  team  claude  suspended\n');

        const none = harness({
            '/api/workspace': () => json(workspace({ executors: [], orgExecutors: [], defaultExecutor: null })),
        });
        expect(await run(['executor', 'list'], none.io)).toBe(0);
        expect(none.out.join('')).toBe('no executors\n');
    });

    it('never carries a profile config through', async () => {
        const { out, io } = harness({
            '/api/workspace': () =>
                json(workspace({ executors: [{ name: 'mine', type: 'claude', config: { apiKey: 'sk-secret' } }] })),
        });

        await run(['executor', 'list', '--json'], io);

        expect(out.join('')).not.toContain('sk-secret');
    });
});

describe('factory skill list', () => {
    const skills = [
        {
            name: 'jira',
            description: 'Work Jira items',
            requires: { tools: ['curl'], connections: [{ name: 'jira', env: [], selectedBy: 'jiraConnection' }] },
        },
    ];

    it('lists skills with their requirements', async () => {
        const { out, io } = harness({ '/api/skills': () => json({ skills }) });

        expect(await run(['skill', 'list'], io)).toBe(0);

        expect(out.join('')).toBe(
            'jira  Work Jira items  [requires tool:curl, connection:jira (select jiraConnection)]\n'
        );
    });

    it('prints the skills in the envelope, and says so when none are installed', async () => {
        const some = harness({ '/api/skills': () => json({ skills }) });
        await run(['skill', 'list', '--json'], some.io);
        expect(JSON.parse(some.out.join('')).data.skills).toEqual(skills);

        const none = harness({ '/api/skills': () => json({ skills: [] }) });
        await run(['skill', 'list'], none.io);
        expect(none.out.join('')).toBe('no skills installed\n');
    });
});

describe('factory connection list', () => {
    const connection = {
        id: '3f2b6c1e-0000-4000-8000-000000000001',
        kind: 'jira',
        site: 'acme.atlassian.net',
        email: 'a@acme.test',
        access: 'read',
        scope: 'org',
        createdAt: '2026-10-01T00:00:00.000Z',
    };

    it('lists the org and personal connections the caller may select, without a token', async () => {
        const { out, io } = harness({
            '/api/connections': () => json({ connections: [connection, { ...connection, scope: 'user', id: 'u' }] }),
        });

        expect(await run(['connection', 'list'], io)).toBe(0);

        const text = out.join('');
        expect(text).toContain(`${connection.id}  jira  org  read  acme.atlassian.net  a@acme.test`);
        expect(text).toContain('u  jira  user');
        expect(text).not.toMatch(/token/i);
    });

    it('is empty without error when the caller has none', async () => {
        const { out, io } = harness({ '/api/connections': () => json({ connections: [] }) });
        expect(await run(['connection', 'list'], io)).toBe(0);
        expect(out.join('')).toBe('no connections available\n');
    });

    it('surfaces a missing store as a refusal', async () => {
        const { err, io } = harness({
            '/api/connections': () =>
                json({ error: 'No connection store for this organization', code: 'CONNECTIONS_UNAVAILABLE' }, 503),
        });

        expect(await run(['connection', 'list'], io)).toBe(1);
        expect(err.join('')).toContain('CONNECTIONS_UNAVAILABLE');
    });
});

describe('factory job create --jira-connection', () => {
    const ID = '3f2b6c1e-0000-4000-8000-000000000001';

    it('sends the selected connection id in the create body, and nothing when absent', async () => {
        const { calls, io } = harness({ '/api/jobs': () => json({ id: 'job-1', status: 'queued' }, 201) });

        expect(await run(['job', 'create', '--jira-connection', ID, '--', 'npm test'], io)).toBe(0);
        expect(await run(['job', 'create', '--', 'npm test'], io)).toBe(0);

        expect(calls[0]!.body).toEqual({ command: 'npm test', jiraConnection: ID });
        expect(calls[1]!.body).toEqual({ command: 'npm test' });
    });

    it("surfaces the board's refusal of an inaccessible or deleted connection, exit 1", async () => {
        const { out, io } = harness({
            '/api/jobs': () =>
                json(
                    {
                        error: 'That Jira connection does not exist or is not available to you. Pick one from GET /api/connections.',
                        code: 'CONNECTION_NOT_AUTHORIZED',
                    },
                    403
                ),
        });

        expect(await run(['job', 'create', '--jira-connection', ID, '--json', '--', 'npm test'], io)).toBe(1);

        expect(JSON.parse(out.join('')).error).toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED', status: 403 });
    });
});
