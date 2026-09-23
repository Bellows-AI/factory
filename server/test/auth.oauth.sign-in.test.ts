import { describe, expect, it } from 'vitest';
import { createGitHubIdentityClient } from '../src/auth/github.js';
import { OAUTH_COOKIE, PENDING_COOKIE } from '../src/auth/session.js';
import { githubAuth, harness, memoryAuthStore, oneInstallation, stubIdentityClient } from './helpers.js';
import { ORG, begin, callback, errorOf, pendingRoute, setup, signIn } from './auth.oauth-fixtures.js';

const HTTP_FOUND = 302;

describe('github sign-in', () => {
    it('sends the browser to GitHub with the state it just set as a cookie', async () => {
        const { app } = await setup();
        const response = await app.inject({ method: 'GET', url: '/api/auth/github' });
        const state = response.cookies.find((c) => c.name === OAUTH_COOKIE)!.value;
        // The same value in both places is the whole CSRF check: GitHub echoes what it was given,
        // and only the browser that started the flow holds the matching cookie.
        expect(response.headers.location).toContain(`state=${encodeURIComponent(state)}`);
    });

    it('requests read:org, because listing installations is the membership decision', async () => {
        // The real client, not the harness stub: the stub's authorize URL is a fixed string.
        const url = createGitHubIdentityClient(
            githubAuth() as Extract<ReturnType<typeof githubAuth>, { mode: 'github' }>
        ).authorizeUrl('s');
        expect(new URL(url).searchParams.get('scope')).toBe('read:org');
    });

    it('materializes the installation as an organization, a membership and a session', async () => {
        const { app, auth } = await setup();

        const cookie = await signIn(app);

        expect(cookie).toBeTruthy();
        expect(auth.sessions()).toHaveLength(1);
        // The org the session names is the installation, named after its account.
        expect(await auth.findOrg(ORG)).toEqual({ id: ORG, name: 'acme' });
    });

    it('refuses a callback whose state does not match the cookie', async () => {
        const { app, auth } = await setup();
        const state = await begin(app);
        const other = await begin(app);

        const response = await callback(app, `code=abc&state=${encodeURIComponent(other)}`, state);

        expect(errorOf(response.headers.location as string)).toBe('state');
        expect(auth.sessions()).toEqual([]);
    });

    it('refuses a callback with no state cookie at all', async () => {
        const { app, auth } = await setup();
        const state = await begin(app);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`);
        expect(errorOf(response.headers.location as string)).toBe('state');
        expect(auth.sessions()).toEqual([]);
    });

    it('clears the state cookie, so a replayed callback finds nothing', async () => {
        const { app } = await setup();
        const state = await begin(app);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        expect(response.cookies.find((c) => c.name === OAUTH_COOKIE)?.value).toBe('');
    });

    it('redirects rather than returning JSON, because a human is mid-navigation', async () => {
        const { app } = await setup();
        const state = await begin(app);
        const response = await callback(app, 'error=access_denied', state);
        expect(response.statusCode).toBe(HTTP_FOUND);
        expect(response.headers['content-type'] ?? '').not.toContain('application/json');
    });

    it('reports a cancelled consent screen as its own outcome, not as a failure', async () => {
        const { app, auth } = await setup();
        const state = await begin(app);
        const response = await callback(app, 'error=access_denied', state);
        expect(errorOf(response.headers.location as string)).toBe('denied');
        expect(auth.sessions()).toEqual([]);
    });
});

describe('installations are the membership decision', () => {
    it('redirects to the install page when the account can see no installations', async () => {
        const { app, auth, identity } = await setup({ installations: [] });

        const state = await begin(app);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(response.headers.location).toBe('https://github.com/apps/stub-app/installations/new');
        // No installations means no membership means no session: nothing was signed in.
        expect(auth.sessions()).toEqual([]);
        expect(identity.installationsCalls).toEqual(['installations']);
    });

    it('reports install as its own failure when the slug cannot be resolved', async () => {
        // Offline (or GitHub failing) there is no install page to send anybody to; the sign-in
        // screen says so instead of dead-ending on a redirect to nowhere.
        const auth = memoryAuthStore();
        const identity = stubIdentityClient();
        identity.installationsAnswer = [];
        const { app } = await harness({
            config: { auth: githubAuth() },
            auth,
            identity,
            // No appSlug at all — the offline shape.
        });
        const state = await begin(app);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
        expect(errorOf(response.headers.location as string)).toBe('install');
        expect(auth.sessions()).toEqual([]);
    });

    it('redirects a first sign-in with several installations to the selection screen instead of signing in', async () => {
        // Nothing to choose with exactly one installation; with two or more, #125's step asks
        // which of them this deployment should track before anything is materialized.
        const { app, auth, identity } = await setup({
            installations: [
                { id: '888888', account: 'other-org' },
                { id: ORG, account: 'acme' },
            ],
        });

        const state = await begin(app);
        const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(response.headers.location).toBe('/onboarding');
        // The code was spent and the report is in hand — it rides the pending row now, not a
        // re-exchange (the code is single-use).
        expect(identity.exchanges).toEqual(['abc']);
        // Nothing materialized: no membership, no session, no org row.
        expect(auth.sessions()).toEqual([]);
        expect(auth.pendingSignIns()).toEqual([
            { githubUserId: 4242, installations: ['888888', ORG], expiresAt: expect.any(Number) },
        ]);
        // The pending cookie is set, and the single-use state cookie is spent either way.
        expect(response.cookies.find((c) => c.name === PENDING_COOKIE)?.value).toBeTruthy();
        expect(response.cookies.find((c) => c.name === OAUTH_COOKIE)?.value).toBe('');
    });

    it('falls back to the first installation when ?org= names an unreported one', async () => {
        // A stale deep link is a preference, never an error: the tampered or outdated org is just
        // unknown to GitHub, and the sign-in proceeds with what the account can actually see.
        const { app, auth } = await setup({ installations: oneInstallation(ORG) });

        await signIn(app, '111111');

        expect(auth.sessions()).toHaveLength(1);
    });
});

describe('the setup callback', () => {
    it('restarts sign-in after an installation was created, naming it and reopening selection', async () => {
        const { app } = await setup();
        const response = await app.inject({
            method: 'GET',
            url: '/api/auth/github/setup?setup_action=install&installation_id=999999',
        });
        expect(response.statusCode).toBe(HTTP_FOUND);
        // The id rides along, and an existing stored choice must not hide the installation that
        // was JUST created. The callback will park on onboarding before materializing anything.
        expect(response.headers.location).toBe('/api/auth/github?org=999999&reselect=1');
        // The restart is a fresh login entry, which sets its own state cookie when followed.
    });

    it('shows a newly installed organization to an account with an existing selection', async () => {
        const { app, identity } = await setup();
        await signIn(app);
        identity.installationsAnswer = [
            { id: ORG, account: 'acme' },
            { id: '888888', account: 'new-org' },
        ];

        const installed = await app.inject({
            method: 'GET',
            url: '/api/auth/github/setup?setup_action=install&installation_id=888888',
        });
        const restarted = await app.inject({ method: 'GET', url: installed.headers.location as string });
        const state = restarted.cookies.find((cookie) => cookie.name === OAUTH_COOKIE)!.value;
        const parked = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);

        expect(parked.headers.location).toBe('/onboarding');
        const pending = parked.cookies.find((cookie) => cookie.name === PENDING_COOKIE)!.value;
        expect((await pendingRoute(app, pending)).json()).toMatchObject({
            installations: [
                { id: ORG, account: 'acme' },
                { id: '888888', account: 'new-org' },
            ],
            selected: [ORG],
            org: '888888',
            reselect: true,
        });
    });

    it('reports install_cancelled when the person came back without installing', async () => {
        const { app } = await setup();
        const response = await app.inject({ method: 'GET', url: '/api/auth/github/setup' });
        expect(response.statusCode).toBe(HTTP_FOUND);
        expect(errorOf(response.headers.location as string)).toBe('install_cancelled');
    });
});
