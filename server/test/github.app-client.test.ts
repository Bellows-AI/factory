import { describe, expect, it } from 'vitest';
import type { GitHubConfig } from '../src/config.js';
import { createGitHubAppClient } from '../src/github/app-client.js';
import type { InstallationTokenProvider } from '../src/github/app-token.js';

/**
 * These tests drive the REAL client over a fake fetch, because the wire contract is exactly what
 * the stubs in helpers.ts cannot catch: which status each endpoint answers, and what a page walk
 * does at its edges.
 */
const github = {
    mode: 'app',
    appId: '1',
    apiUrl: 'https://api.github.test',
    privateKey: 'not-a-real-key',
} as unknown as Extract<GitHubConfig, { mode: 'app' }>;

const tokens: InstallationTokenProvider = {
    get: async () => 'installation-token',
    fresh: async () => 'installation-token',
    installationId: async () => '4242',
};

interface Call {
    path: string;
    status: number;
    body: unknown;
    headers?: Record<string, string>;
}

/** A fetch that answers from a script, one call per entry, and records every request path. */
function fetchScript(script: Call[], requests: string[]): typeof fetch {
    let n = 0;
    return (async (input: RequestInfo | URL) => {
        const path = String(input).replace('https://api.github.test', '');
        requests.push(path);
        const next = script[Math.min(n, script.length - 1)];
        n += 1;
        const headers = new Headers(next.headers);
        return new Response(next.body === null ? null : JSON.stringify(next.body), {
            status: next.status,
            headers,
        });
    }) as typeof fetch;
}

const repo = (owner: string, name: string) => ({
    name,
    private: false,
    default_branch: 'main',
    pushed_at: '2026-08-21T12:00:00Z',
    owner: { login: owner },
});

describe('listRepositories', () => {
    it('maps the payload and infers the installation account from a single owner', async () => {
        const requests: string[] = [];
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript(
                [
                    {
                        path: '/x',
                        status: 200,
                        body: {
                            total_count: 2,
                            repository_selection: 'selected',
                            repositories: [repo('acme', 'web'), repo('acme', 'api')],
                        },
                    },
                ],
                requests
            )
        );

        const listing = await client.listRepositories();

        expect(listing.repos).toEqual([
            { owner: 'acme', name: 'web', private: false, defaultBranch: 'main', pushedAt: '2026-08-21T12:00:00Z' },
            { owner: 'acme', name: 'api', private: false, defaultBranch: 'main', pushedAt: '2026-08-21T12:00:00Z' },
        ]);
        expect(listing.installation).toMatchObject({ id: '4242', account: 'acme', repositorySelection: 'selected' });
        expect(requests.every((p) => p.startsWith('/installation/repositories'))).toBe(true);
    });

    it('answers a null account when the installation spans several owners', async () => {
        // "The account this is installed on" is then not a single answer, and a first-repo guess
        // would be a wrong one.
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript(
                [
                    {
                        path: '/x',
                        status: 200,
                        body: { total_count: 2, repositories: [repo('acme', 'web'), repo('other', 'api')] },
                    },
                ],
                []
            )
        );

        const listing = await client.listRepositories();
        expect(listing.installation.account).toBeNull();
    });

    it('walks pages until total_count is reached', async () => {
        const requests: string[] = [];
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript(
                [
                    {
                        path: '/x',
                        status: 200,
                        body: { total_count: 3, repositories: [repo('acme', 'a'), repo('acme', 'b')] },
                    },
                    { path: '/x', status: 200, body: { total_count: 3, repositories: [repo('acme', 'c')] } },
                ],
                requests
            )
        );

        const listing = await client.listRepositories();
        expect(listing.repos).toHaveLength(3);
        expect(requests.some((p) => p.includes('page=2'))).toBe(true);
        expect(requests.some((p) => p.includes('page=3'))).toBe(false);
    });

    it('skips a malformed entry instead of costing the whole list', async () => {
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript(
                [
                    {
                        path: '/x',
                        status: 200,
                        body: { total_count: 2, repositories: [repo('acme', 'good'), { owner: { login: 'acme' } }] },
                    },
                    { path: '/x', status: 200, body: { total_count: 2, repositories: [] } },
                ],
                []
            )
        );

        const listing = await client.listRepositories();
        expect(listing.repos).toHaveLength(1);
        expect(listing.repos[0]).toMatchObject({ name: 'good' });
    });

    it('maps a failure status to a named error carrying GitHub’s reason', async () => {
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript([{ path: '/x', status: 403, body: { message: 'rate limited' } }], [])
        );

        await expect(client.listRepositories()).rejects.toThrow(/403[\s\S]*rate limited/);
    });
});
