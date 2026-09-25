import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { ORG, beginOnboarding, finishOnboarding, setup, signIn } from './auth.oauth-fixtures.js';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;

describe('/api/auth/me', () => {
    it('answers 200 {authenticated: false} for an anonymous caller, which is how the SPA learns to show the gate', async () => {
        // 200 rather than 401: the browser logs every 4xx as a console error even when the client
        // handles it, and the login screen must not open with red rows in the devtools of
        // everybody who has not signed in yet.
        const { app } = await setup();
        const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ authenticated: false });
    });

    it('reports the caller, their org and every org they could switch to', async () => {
        const { app, identity } = await setup({
            installations: [
                { id: ORG, account: 'acme' },
                { id: '888888', account: 'other-org' },
            ],
        });
        identity.next = {
            ...identity.next,
            avatarUrl: 'https://avatars.githubusercontent.com/u/4242.png',
        };
        // Two installations means the sign-in goes through the selection step; both are chosen,
        // so the session lands in the first reported and the selector offers both.
        const pending = await beginOnboarding(app);
        const completion = await finishOnboarding(app, pending, { orgs: [ORG, '888888'] });
        const cookie = completion.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

        const response = await app.inject({
            method: 'GET',
            url: '/api/auth/me',
            cookies: { [SESSION_COOKIE]: cookie },
        });

        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body).toMatchObject({
            user: {
                login: 'octocat',
                githubUserId: 4242,
                avatarUrl: 'https://avatars.githubusercontent.com/u/4242.png',
            },
            role: 'member',
            account: { createdAt: expect.any(String), lastLoginAt: expect.any(String) },
            // The org the session is bound to — the first installation — and both options.
            organization: { id: ORG, name: 'acme' },
            organizations: [
                { id: ORG, name: 'acme' },
                { id: '888888', name: 'other-org' },
            ],
            // The harness configures no workspace root, and "off" is a supported state the SPA
            // renders as an absence rather than an error — the same posture as /api/workspace.
            workspacePath: null,
            mode: 'github',
        });
    });

    it('answers 503, not "not signed in", when the session store cannot be reached', async () => {
        // The two used to be one answer: an unreachable store was reported to every signed-in
        // browser as `authenticated: false`, which reads as "everybody was logged out" and left
        // nothing in the logs to contradict it.
        const { app, auth } = await setup();
        const cookie = await signIn(app);
        auth.findSession = () => Promise.reject(new Error('session store unreachable'));

        const response = await app.inject({
            method: 'GET',
            url: '/api/auth/me',
            cookies: { [SESSION_COOKIE]: cookie },
        });

        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(response.json().code).toBe('UNAVAILABLE');
        // The exception stays in the log; the requester gets a generic message. A store error
        // message carries connection strings, hostnames and query text.
        expect(response.body).not.toContain('session store unreachable');
    });

    it('still answers 200 {authenticated: false} for a cookie the store simply does not know', async () => {
        // The other arm of the same split: the store answered, it just had no row. That is not an
        // outage and must not become one.
        const { app } = await setup();
        const cookie = await signIn(app);
        const { app: other } = await setup();

        const response = await other.inject({
            method: 'GET',
            url: '/api/auth/me',
            cookies: { [SESSION_COOKIE]: cookie },
        });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ authenticated: false });
    });
});

describe('POST /api/auth/org', () => {
    const switchOrg = (app: FastifyInstance, cookie: string, orgId: unknown) =>
        app.inject({
            method: 'POST',
            url: '/api/auth/org',
            cookies: { [SESSION_COOKIE]: cookie },
            payload: { orgId },
        });

    it('moves the session to another org the caller is a member of', async () => {
        const { app, auth } = await setup({
            installations: [
                { id: ORG, account: 'acme' },
                { id: '888888', account: 'other-org' },
            ],
        });
        // The multi-installation sign-in goes through the selection step first; both are chosen.
        const pending = await beginOnboarding(app);
        const completion = await finishOnboarding(app, pending, { orgs: [ORG, '888888'] });
        const cookie = completion.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

        const response = await switchOrg(app, cookie, '888888');

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().organization).toEqual({ id: '888888', name: 'other-org' });

        // The session now resolves through the new org, and /me says so.
        const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: cookie } });
        expect(me.json().organization).toEqual({ id: '888888', name: 'other-org' });
        // The row moved; nothing else was created.
        expect(auth.sessions()).toHaveLength(1);
    });

    it('answers 400 UNKNOWN_ORG for an organization that does not exist', async () => {
        const { app } = await setup();
        const cookie = await signIn(app);
        const response = await switchOrg(app, cookie, '111111');
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('UNKNOWN_ORG');
    });

    it('answers 403 for an organization the caller exists but cannot see', async () => {
        const { app } = await setup({
            seed: (store) => {
                // A second org exists, planted by another installation's sign-in — but this account
                // was never reported into it.
                store.seedOrg('777777', 'elsewhere', '777777');
            },
        });
        const cookie = await signIn(app);

        const response = await switchOrg(app, cookie, '777777');

        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    it('answers 400 BAD_ORG for a body without an orgId', async () => {
        const { app } = await setup();
        const cookie = await signIn(app);
        const response = await switchOrg(app, cookie, undefined);
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_ORG');
    });

    it('answers 401 for an anonymous caller', async () => {
        const { app } = await setup();
        const response = await switchOrg(app, 'not-a-session', '888888');
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('answers 503, not 401, when the session store cannot be reached', async () => {
        const { app, auth } = await setup();
        const cookie = await signIn(app);
        auth.findSession = () => Promise.reject(new Error('session store unreachable'));

        const response = await switchOrg(app, cookie, '888888');

        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(response.json().code).toBe('UNAVAILABLE');
        expect(response.body).not.toContain('session store unreachable');
    });
});
