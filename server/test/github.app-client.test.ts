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
    installationId: '4242',
    apiUrl: 'https://api.github.test',
    privateKey: 'not-a-real-key',
} as unknown as Extract<GitHubConfig, { mode: 'app' }>;

const tokens: InstallationTokenProvider = {
    get: async () => 'installation-token',
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

const member = (id: number, login: string) => ({ id, login });

describe('teamMembership', () => {
    // "Get team membership for a user" answers 200 WITH a body ({ state }) — not 204. Reading it
    // as a 204-probe made every real team grant throw, which left members with no stored set
    // unscoped: the opposite of what the enumeration exists to do.
    it('answers yes only for an active 200 membership, and no for a 404', async () => {
        const requests: string[] = [];
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript(
                [
                    { path: '/x', status: 200, body: { state: 'active' } },
                    { path: '/x', status: 200, body: { state: 'pending' } },
                    { path: '/x', status: 404, body: { message: 'not found' } },
                ],
                requests
            )
        );

        await expect(client.teamMembership('acme', 'core', 'octocat')).resolves.toBe(true);
        await expect(client.teamMembership('acme', 'core', 'octocat')).resolves.toBe(false);
        await expect(client.teamMembership('acme', 'core', 'octocat')).resolves.toBe(false);
        expect(requests.every((path) => path.includes('/teams/core/memberships/octocat'))).toBe(true);
    });

    it('refuses to guess on any other status', async () => {
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript([{ path: '/x', status: 403, body: { message: 'rate limited' } }], [])
        );

        await expect(client.teamMembership('acme', 'core', 'octocat')).rejects.toThrow(/403/);
    });
});

describe('collaborator', () => {
    // The collaborator check is the opposite wire shape: 204 no-content for yes, 404 for no.
    it('answers 204 as yes and 404 as no', async () => {
        let status = 204;
        const fetchFn = (async () => new Response(null, { status })) as typeof fetch;
        const client = createGitHubAppClient(github, tokens, fetchFn);

        await expect(client.collaborator('acme', 'web', 'octocat')).resolves.toBe(true);
        status = 404;
        await expect(client.collaborator('acme', 'web', 'octocat')).resolves.toBe(false);
    });
});

describe('page walks', () => {
    it('stops at a short page instead of asking once more', async () => {
        const requests: string[] = [];
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript([{ path: '/x', status: 200, body: [member(1, 'a'), member(2, 'b')] }], requests)
        );

        const roster = await client.orgMembers('acme');
        expect(roster.members).toHaveLength(2);
        // One request per walk — the member walk and the admin walk — the short page ending each.
        expect(requests.filter((p) => p.includes('/orgs/acme/members'))).toHaveLength(2);
    });

    it('refuses to persist a truncated enumeration when the safety limit is exhausted', async () => {
        // A full hundredth page means there may be a hundred and first; treating the first 10,000
        // entries as the whole roster would de-scope members it never saw.
        const full = Array.from({ length: 100 }, (_, i) => member(i, `user-${i}`));
        const client = createGitHubAppClient(
            github,
            tokens,
            fetchScript([{ path: '/x', status: 200, body: full }], [])
        );

        await expect(client.orgMembers('acme')).rejects.toThrow(/truncated/);
    });
});
