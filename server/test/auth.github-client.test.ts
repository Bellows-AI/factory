import { describe, expect, it } from 'vitest';
import { createGitHubIdentityClient, GitHubAuthError } from '../src/auth/github.js';
import { githubAuth } from './helpers.js';

const client = (fetchFn: typeof fetch) =>
    createGitHubIdentityClient(githubAuth() as Extract<ReturnType<typeof githubAuth>, { mode: 'github' }>, fetchFn);

/** Answers `/user/installations` the way GitHub does, recording the request. */
function stubInstallations(body: unknown, status = 200) {
    const calls: { url: string; authorization: string }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: String(input),
            authorization: String((init?.headers as Record<string, string>)?.authorization ?? ''),
        });
        return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { calls, fetchFn };
}

describe('the installations seam (#99)', () => {
    it('asks /user/installations with the exchanged token and maps the accounts', async () => {
        const { calls, fetchFn } = stubInstallations({
            installations: [
                { id: 999999, account: { login: 'acme' } },
                { id: 888888, account: { login: 'other-org' } },
            ],
        });
        const list = await client(fetchFn).installations('access-token-1');

        expect(list).toEqual([
            { id: '999999', account: 'acme' },
            { id: '888888', account: 'other-org' },
        ]);
        expect(calls).toHaveLength(1);
        // Derived from the same userUrl seam /user uses, so the stub IdP needs no second knob.
        expect(calls[0]!.url).toBe('https://api.github.test/user/installations?per_page=100&page=1');
        // The signing-in person's own token: what they can see IS the membership decision.
        expect(calls[0]!.authorization).toBe('Bearer access-token-1');
    });

    it('walks pages while GitHub keeps filling them', async () => {
        // signIn DELETES every membership of an installation this list does not report, so a
        // truncated walk is not an incomplete answer — it is a destructive one.
        const requests: string[] = [];
        const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, account: { login: `org-${i}` } }));
        const fetchFn = (async (input: string | URL) => {
            const url = String(input);
            requests.push(url);
            const page = Number(new URL(url).searchParams.get('page'));
            return new Response(JSON.stringify({ installations: page === 1 ? full : [{ id: 999, account: null }] }), {
                status: 200,
            });
        }) as typeof fetch;

        const list = await client(fetchFn).installations('t');

        expect(list).toHaveLength(101);
        expect(requests.some((r) => r.includes('page=2'))).toBe(true);
        expect(requests.some((r) => r.includes('page=3'))).toBe(false);
    });

    it('fails loud past the page cap instead of feeding signIn a prefix', async () => {
        // Every page full means there may be more; treating 1000 as the whole list would delete
        // the memberships beyond it on the very next sign-in.
        const fetchFn = (async () =>
            new Response(JSON.stringify({ installations: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) }), {
                status: 200,
            })) as typeof fetch;

        await expect(client(fetchFn).installations('t')).rejects.toThrow(/truncated/);
    });

    it('skips entries without a numeric id rather than failing the sign-in', async () => {
        const { fetchFn } = stubInstallations({
            installations: [{ id: 999999, account: { login: 'acme' } }, { account: { login: 'ghost' } }],
        });
        await expect(client(fetchFn).installations('t')).resolves.toEqual([{ id: '999999', account: 'acme' }]);
    });

    it('answers an empty payload as no installations', async () => {
        const { fetchFn } = stubInstallations({ installations: [] });
        await expect(client(fetchFn).installations('t')).resolves.toEqual([]);
    });

    it('fails the sign-in loudly when GitHub cannot be asked', async () => {
        // A 403 here is a missing scope or a secondary rate limit, never "no installations".
        const { fetchFn } = stubInstallations({ message: 'rate limited' }, 403);
        await expect(client(fetchFn).installations('t')).rejects.toBeInstanceOf(GitHubAuthError);
    });
});
