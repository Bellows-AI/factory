import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createGitHubIdentityClient } from '../src/auth/github.js';
import { OAUTH_COOKIE, SESSION_COOKIE } from '../src/auth/session.js';
import type { AuthConfig } from '../src/config.js';
import type { MemoryAuthStore } from './helpers.js';
import { githubAuth, harness, memoryAuthStore, stubIdentityClient } from './helpers.js';

const ORG = 'test-org';

async function setup(seed: (store: MemoryAuthStore) => void = () => {}) {
    const auth = memoryAuthStore();
    seed(auth);
    const identity = stubIdentityClient();
    const { app } = await harness({
        config: { auth: githubAuth() },
        auth,
        identity,
    });
    return { app, auth, identity };
}

/** Starts a flow and returns the state cookie the browser would be holding. */
async function begin(app: FastifyInstance, returnTo = '/'): Promise<string> {
    const response = await app.inject({
        method: 'GET',
        url: `/api/auth/github?returnTo=${encodeURIComponent(returnTo)}`,
    });
    expect(response.statusCode).toBe(302);
    const cookie = response.cookies.find((c) => c.name === OAUTH_COOKIE);
    expect(cookie).toBeDefined();
    return cookie!.value;
}

const callback = (app: FastifyInstance, query: string, cookie?: string) =>
    app.inject({
        method: 'GET',
        url: `/api/auth/github/callback?${query}`,
        ...(cookie ? { cookies: { [OAUTH_COOKIE]: cookie } } : {}),
    });

const errorOf = (location: string): string | null =>
    new URL(location, 'http://x').searchParams.get('auth_error');

describe('github sign-in', () => {
    it('sends the browser to GitHub with the state it just set as a cookie', async () => {
        const { app } = await setup();
        const response = await app.inject({ method: 'GET', url: '/api/auth/github' });
        const state = response.cookies.find((c) => c.name === OAUTH_COOKIE)!.value;
        // The same value in both places is the whole CSRF check: GitHub echoes what it was given,
        // and only the browser that started the flow holds the matching cookie.
        expect(response.headers.location).toContain(`state=${encodeURIComponent(state)}`);
    });

    it('signs in an invited login and claims their membership', async () => {
        const { app, auth } = await setup((store) => {
            void store.invite(ORG, 'octocat', 'member');
        });
        const state = await begin(app, '/reports');

        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('/reports');
        expect(response.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBeTruthy();
        expect(auth.sessions()).toHaveLength(1);
        expect(await auth.listMembers(ORG)).toEqual([{ login: 'octocat', role: 'member', claimed: true }]);
    });

    it('refuses a login nobody invited, and creates no session for it', async () => {
        const { app, auth } = await setup();
        const state = await begin(app);

        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(errorOf(response.headers.location as string)).toBe('no_membership');
        // The distinction that matters: an ACCOUNT may exist — the identity is a fact — but there
        // must be no session, or a refused sign-in would still be a sign-in.
        expect(auth.sessions()).toEqual([]);
        expect(response.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBeFalsy();
    });

    it('reports a cancelled consent screen as its own outcome, not as a failure', async () => {
        const { app } = await setup();
        const state = await begin(app);
        const response = await callback(app, 'error=access_denied', state);
        expect(errorOf(response.headers.location as string)).toBe('denied');
    });

    it('refuses a callback whose state does not match the cookie', async () => {
        const { app, auth } = await setup((store) => {
            void store.invite(ORG, 'octocat', 'member');
        });
        const state = await begin(app);
        const other = await begin(app);

        const response = await callback(app, `code=abc&state=${encodeURIComponent(other)}`, state);

        expect(errorOf(response.headers.location as string)).toBe('state');
        expect(auth.sessions()).toEqual([]);
    });

    it('refuses a callback with no state cookie at all', async () => {
        const { app } = await setup((store) => {
            void store.invite(ORG, 'octocat', 'member');
        });
        const state = await begin(app);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`);
        expect(errorOf(response.headers.location as string)).toBe('state');
    });

    it('clears the state cookie, so a replayed callback finds nothing', async () => {
        const { app } = await setup((store) => {
            void store.invite(ORG, 'octocat', 'member');
        });
        const state = await begin(app);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        expect(response.cookies.find((c) => c.name === OAUTH_COOKIE)?.value).toBe('');
    });

    it('redirects rather than returning JSON, because a human is mid-navigation', async () => {
        const { app } = await setup();
        const state = await begin(app);
        const response = await callback(app, 'error=access_denied', state);
        expect(response.statusCode).toBe(302);
        expect(response.headers['content-type'] ?? '').not.toContain('application/json');
    });
});

describe('auto-join from a GitHub organization', () => {
    const AUTO_JOIN_ORG = 'Bellows-AI';

    async function autoJoinSetup(seed: (store: MemoryAuthStore) => void = () => {}) {
        const auth = memoryAuthStore();
        seed(auth);
        const identity = stubIdentityClient();
        const { app } = await harness({
            config: { auth: githubAuth({ autoJoinGithubOrg: AUTO_JOIN_ORG }) },
            auth,
            identity,
        });
        return { app, auth, identity };
    }

    it('admits an uninvited member of the organization, as a member and not an admin', async () => {
        const { app, auth, identity } = await autoJoinSetup();
        identity.orgState = 'active';
        const state = await begin(app);

        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(response.headers.location).toBe('/');
        expect(auth.sessions()).toHaveLength(1);
        expect(identity.orgLookups).toEqual([AUTO_JOIN_ORG]);
        // `member`, never `admin`: admitting somebody is not the same as trusting them to invite.
        expect(await auth.listMembers(ORG)).toEqual([{ login: 'octocat', role: 'member', claimed: true }]);
    });

    it('refuses somebody outside the organization', async () => {
        const { app, auth, identity } = await autoJoinSetup();
        identity.orgState = 'none';
        const state = await begin(app);

        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(errorOf(response.headers.location as string)).toBe('no_membership');
        expect(auth.sessions()).toEqual([]);
        expect(await auth.listMembers(ORG)).toEqual([]);
    });

    it('refuses an unaccepted GitHub invitation, which is an offer and not a membership', async () => {
        // Otherwise an org admin could add a login to Factory without that person ever agreeing.
        const { app, auth, identity } = await autoJoinSetup();
        identity.orgState = 'pending';
        const state = await begin(app);

        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(errorOf(response.headers.location as string)).toBe('no_membership');
        expect(auth.sessions()).toEqual([]);
    });

    it('keeps the role an invite already granted, instead of demoting to member', async () => {
        const { app, auth, identity } = await autoJoinSetup((store) => {
            void store.invite(ORG, 'octocat', 'admin');
        });
        identity.orgState = 'active';
        const state = await begin(app);

        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(response.headers.location).toBe('/');
        expect(await auth.listMembers(ORG)).toEqual([{ login: 'octocat', role: 'admin', claimed: true }]);
        // The invite settled it, so GitHub was never asked — the ordinary member pays nothing for
        // a feature that only matters to somebody arriving without a row.
        expect(identity.orgLookups).toEqual([]);
    });

    it('asks GitHub for nothing when auto-join is off', async () => {
        const { app, identity } = await setup();
        identity.orgState = 'active';
        const state = await begin(app);

        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(errorOf(response.headers.location as string)).toBe('no_membership');
        expect(identity.orgLookups).toEqual([]);
    });

    it('requests read:org only when auto-join is configured', async () => {
        // An unscoped token reports every organization absent, so the scope is what makes the check
        // answerable at all — and asking for it when nothing reads it is a scope nobody needs.
        const base = githubAuth() as Extract<AuthConfig, { mode: 'github' }>;

        const off = createGitHubIdentityClient(base);
        expect(new URL(off.authorizeUrl('s')).searchParams.get('scope')).toBeNull();

        const on = createGitHubIdentityClient({ ...base, autoJoinGithubOrg: AUTO_JOIN_ORG });
        expect(new URL(on.authorizeUrl('s')).searchParams.get('scope')).toBe('read:org');
    });
});

describe('identity is the numeric id, not the login', () => {
    it('follows a rename: the same account keeps its membership under a new login', async () => {
        const { app, auth, identity } = await setup((store) => {
            void store.invite(ORG, 'octocat', 'admin');
        });

        const first = await begin(app);
        await callback(app, `code=a&state=${encodeURIComponent(first)}`, first);

        // Same GitHub account, new login.
        identity.next = { ...identity.next, login: 'octocat-renamed' };
        const second = await begin(app);
        const response = await callback(app, `code=b&state=${encodeURIComponent(second)}`, second);

        expect(response.headers.location).toBe('/');
        expect(auth.sessions()).toHaveLength(2);
    });

    it('does NOT let a new account inherit a claimed membership by taking the freed login', async () => {
        /*
         * The most important case in this file.
         *
         * GitHub frees a login when its owner renames, and anyone may then register it. Without the
         * `user_id is null` predicate on the claim, this sequence hands the impostor the original
         * member's row — including its admin role.
         */
        const { app, auth, identity } = await setup((store) => {
            void store.invite(ORG, 'octocat', 'admin');
        });

        const first = await begin(app);
        await callback(app, `code=a&state=${encodeURIComponent(first)}`, first);
        expect(auth.sessions()).toHaveLength(1);

        // The original renames away, and a DIFFERENT account registers the login they left behind.
        identity.next = { githubUserId: 9999, login: 'octocat', displayName: 'Impostor', avatarUrl: null };
        const second = await begin(app);
        const response = await callback(app, `code=b&state=${encodeURIComponent(second)}`, second);

        expect(errorOf(response.headers.location as string)).toBe('no_membership');
        // Still exactly one session — the original's. The impostor got no membership and no session.
        expect(auth.sessions()).toHaveLength(1);
    });
});

describe('sessions end', () => {
    it('logs out, deleting the row and clearing the cookie', async () => {
        const { app, auth } = await setup((store) => {
            void store.invite(ORG, 'octocat', 'member');
        });
        const state = await begin(app);
        const signIn = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        const cookie = signIn.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
        expect(auth.sessions()).toHaveLength(1);

        const response = await app.inject({
            method: 'POST',
            url: '/api/auth/logout',
            cookies: { [SESSION_COOKIE]: cookie },
        });

        expect(response.statusCode).toBe(204);
        expect(auth.sessions()).toEqual([]);
        expect(response.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    });

    it('answers 204 for somebody who was never signed in', async () => {
        // "Already signed out" is the desired end state, so reporting it as an error would hand the
        // client something it cannot act on.
        const { app } = await setup();
        const response = await app.inject({ method: 'POST', url: '/api/auth/logout' });
        expect(response.statusCode).toBe(204);
    });
});

describe('/api/auth/me', () => {
    it('401s for an anonymous caller, which is how the SPA learns to show the gate', async () => {
        const { app } = await setup();
        const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it('reports the caller, their role and the organization', async () => {
        const { app, identity } = await setup((store) => {
            void store.invite(ORG, 'octocat', 'admin');
        });
        identity.next = {
            ...identity.next,
            avatarUrl: 'https://avatars.githubusercontent.com/u/4242.png',
        };
        const state = await begin(app);
        const signIn = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        const cookie = signIn.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

        const response = await app.inject({
            method: 'GET',
            url: '/api/auth/me',
            cookies: { [SESSION_COOKIE]: cookie },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            user: {
                login: 'octocat',
                githubUserId: 4242,
                avatarUrl: 'https://avatars.githubusercontent.com/u/4242.png',
            },
            role: 'admin',
            membership: { invitedAt: expect.any(String), claimedAt: expect.any(String) },
            account: { createdAt: expect.any(String), lastLoginAt: expect.any(String) },
            organization: { id: ORG },
            // The harness configures no workspace root, and "off" is a supported state the SPA
            // renders as an absence rather than an error — the same posture as /api/workspace.
            workspacePath: null,
            mode: 'github',
        });
    });
});
