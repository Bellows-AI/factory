import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createGitHubIdentityClient } from '../src/auth/github.js';
import { OAUTH_COOKIE, SESSION_COOKIE } from '../src/auth/session.js';
import { githubAuth, harness, memoryAuthStore, oneInstallation, stubIdentityClient } from './helpers.js';
import type { MemoryAuthStore } from './helpers.js';

const ORG = '999999';

async function setup(seed: (store: MemoryAuthStore) => void = () => {}, installations = oneInstallation(ORG)) {
    const auth = memoryAuthStore();
    seed(auth);
    const identity = stubIdentityClient();
    identity.installationsAnswer = installations;
    const { app } = await harness({
        config: { auth: githubAuth() },
        auth,
        identity,
        appSlug: async () => 'stub-app',
    });
    return { app, auth, identity };
}

/** Starts a flow and returns the state cookie the browser would be holding. */
async function begin(app: FastifyInstance, returnTo = '/', org?: string): Promise<string> {
    const params = new URLSearchParams({ returnTo });
    if (org) params.set('org', org);
    const response = await app.inject({
        method: 'GET',
        url: `/api/auth/github?${params}`,
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

const errorOf = (location: string): string | null => new URL(location, 'http://x').searchParams.get('auth_error');

/** A complete sign-in: begin, callback, and the session cookie that came out of it. */
async function signIn(app: FastifyInstance, org?: string): Promise<string> {
    const state = await begin(app, '/', org);
    const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
    expect(response.statusCode).toBe(302);
    expect(errorOf(response.headers.location as string)).toBeNull();
    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
    expect(cookie).toBeTruthy();
    return cookie!;
}

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
        expect(response.statusCode).toBe(302);
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
        const { app, auth, identity } = await setup(() => {}, []);

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

    it('binds the session to the first installation when several are reported', async () => {
        const { app } = await setup(() => {}, [
            { id: '888888', account: 'other-org' },
            { id: ORG, account: 'acme' },
        ]);

        const cookie = await signIn(app);

        // Both are materialized; the session landed in the first.
        const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: cookie } });
        expect(me.json().organization).toEqual({ id: '888888', name: 'other-org' });
        expect(me.json().organizations).toHaveLength(2);
    });

    it('binds the session to the installation a signed ?org= asked for', async () => {
        const { app } = await setup(() => {}, [
            { id: '888888', account: 'other-org' },
            { id: ORG, account: 'acme' },
        ]);

        const cookie = await signIn(app, ORG);

        // NOT the first installation — the one the deep link named.
        const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: cookie } });
        expect(me.json().organization).toEqual({ id: ORG, name: 'acme' });
    });

    it('falls back to the first installation when ?org= names an unreported one', async () => {
        // A stale deep link is a preference, never an error: the tampered or outdated org is just
        // unknown to GitHub, and the sign-in proceeds with what the account can actually see.
        const { app, auth } = await setup(() => {}, oneInstallation(ORG));

        await signIn(app, '111111');

        expect(auth.sessions()).toHaveLength(1);
    });
});

describe('the setup callback', () => {
    it('restarts sign-in after an installation was created, naming it as the org preference', async () => {
        const { app } = await setup();
        const response = await app.inject({
            method: 'GET',
            url: '/api/auth/github/setup?setup_action=install&installation_id=999999',
        });
        expect(response.statusCode).toBe(302);
        // The id rides along: the sign-in that follows lands the session in the installation
        // that was JUST created, not whichever GitHub happens to report first.
        expect(response.headers.location).toBe('/api/auth/github?org=999999');
        // The restart is a fresh login entry, which sets its own state cookie when followed.
    });

    it('reports install_cancelled when the person came back without installing', async () => {
        const { app } = await setup();
        const response = await app.inject({ method: 'GET', url: '/api/auth/github/setup' });
        expect(response.statusCode).toBe(302);
        expect(errorOf(response.headers.location as string)).toBe('install_cancelled');
    });
});

describe('identity is the numeric id, not the login', () => {
    it('follows a rename: the same account keeps its membership under a new login', async () => {
        const { app, auth, identity } = await setup();

        await signIn(app);

        // Same GitHub account, new login: the membership row's label follows, the account does not
        // multiply.
        identity.next = { ...identity.next, login: 'octocat-renamed' };
        await signIn(app);

        expect(auth.sessions()).toHaveLength(2);
    });

    it('does NOT let a new account inherit a membership by taking the freed login', async () => {
        /*
         * A rename frees the login on GitHub's side. Under installation membership the boundary is
         * what the account can SEE, not a name it registered — a different numeric id is a
         * different account, whatever it calls itself, and gets its own sign-in.
         */
        const { app, auth, identity } = await setup();

        await signIn(app);
        expect(auth.sessions()).toHaveLength(1);

        // A DIFFERENT account registers the login the original left behind.
        identity.next = { githubUserId: 9999, login: 'octocat', displayName: 'Impostor', avatarUrl: null };
        await signIn(app);

        // Two accounts, two memberships, two sessions — nobody inherited anything.
        expect(auth.sessions()).toHaveLength(2);
    });
});

describe('membership follows what GitHub last reported', () => {
    it('drops a membership of a legacy org — no installation can ever report it', async () => {
        // The pre-#99 rows: an org with no installation id (028 added the column with no
        // backfill) and the membership the single-org sign-in wrote. Nothing matches an
        // installation back to that org, so the sweep is what keeps the selector from listing
        // the same account twice — and the legacy org from reading as a second, empty one.
        const { app, auth } = await setup();
        const cookie = await signIn(app);
        const userId = (
            await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: cookie } })
        ).json().user.id as string;
        auth.seedOrg('legacy-1', 'Legacy');
        auth.seedMembership('legacy-1', userId);

        await signIn(app);

        expect((await auth.membershipsOf(userId)).map((m) => m.id)).toEqual([ORG]);
    });

    it('drops a membership whose installation is no longer reported', async () => {
        // The security property, one sign-in late: losing access to an installation ends the
        // membership the next time that account signs in — and the session's read goes with it,
        // because findSession joins through the membership.
        const { app, auth, identity } = await setup(() => {}, [
            { id: ORG, account: 'acme' },
            { id: '888888', account: 'other-org' },
        ]);

        const cookie = await signIn(app);
        const userId = (
            await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: cookie } })
        ).json().user.id as string;
        expect((await auth.membershipsOf(userId)).map((m) => m.id)).toEqual(expect.arrayContaining([ORG, '888888']));

        // The account can no longer see the first installation: the reduced answer rides the
        // one-shot queue, consumed by the second sign-in's installations call.
        identity.installationsQueue.push([{ id: '888888', account: 'other-org' }]);
        await signIn(app);

        expect((await auth.membershipsOf(userId)).map((m) => m.id)).toEqual(['888888']);
    });
});

describe('sessions end', () => {
    it('logs out, deleting the row and clearing the cookie', async () => {
        const { app, auth } = await setup();
        const cookie = await signIn(app);
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
    it('answers 200 {authenticated: false} for an anonymous caller, which is how the SPA learns to show the gate', async () => {
        // 200 rather than 401: the browser logs every 4xx as a console error even when the client
        // handles it, and the login screen must not open with red rows in the devtools of
        // everybody who has not signed in yet.
        const { app } = await setup();
        const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ authenticated: false });
    });

    it('reports the caller, their org and every org they could switch to', async () => {
        const { app, identity } = await setup(() => {}, [
            { id: ORG, account: 'acme' },
            { id: '888888', account: 'other-org' },
        ]);
        identity.next = {
            ...identity.next,
            avatarUrl: 'https://avatars.githubusercontent.com/u/4242.png',
        };
        const cookie = await signIn(app);

        const response = await app.inject({
            method: 'GET',
            url: '/api/auth/me',
            cookies: { [SESSION_COOKIE]: cookie },
        });

        expect(response.statusCode).toBe(200);
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
            // No pre-upgrade rows in a fresh store: nothing is waiting for adoption.
            legacyOrganizations: [],
            // Two installations are reported here, so no pairing is unambiguous enough to name.
            adoptInto: null,
        });
    });

    it('lists the pre-upgrade organizations still waiting for adoption', async () => {
        // The duplicate-selector symptom of #123 reads as a bug; the payload names the rows a
        // skipped `npm run adopt` left behind so the SPA can surface the command instead. With
        // exactly one installation in the database, the pairing is not a guess and the payload
        // names it; with several, which legacy org belongs to which installation is the
        // operator's `--from` decision, and nothing fills it in for them.
        const { app } = await setup((store) => {
            store.seedOrg('legacy-1', 'Legacy');
        });
        const cookie = await signIn(app);

        const body = (
            await app.inject({
                method: 'GET',
                url: '/api/auth/me',
                cookies: { [SESSION_COOKIE]: cookie },
            })
        ).json();

        expect(body.legacyOrganizations).toEqual([{ id: 'legacy-1', name: 'Legacy' }]);
        expect(body.adoptInto).toEqual({ id: ORG });
    });

    it('refuses to pair a legacy org with an installation when several exist', async () => {
        const { app } = await setup(
            (store) => {
                store.seedOrg('legacy-1', 'Legacy');
            },
            oneInstallation(ORG).concat([{ id: '888888', account: 'other-org' }])
        );
        const cookie = await signIn(app);

        const body = (
            await app.inject({
                method: 'GET',
                url: '/api/auth/me',
                cookies: { [SESSION_COOKIE]: cookie },
            })
        ).json();

        expect(body.legacyOrganizations).toEqual([{ id: 'legacy-1', name: 'Legacy' }]);
        expect(body.adoptInto).toBeNull();
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
        const { app, auth } = await setup(() => {}, [
            { id: ORG, account: 'acme' },
            { id: '888888', account: 'other-org' },
        ]);
        const cookie = await signIn(app);

        const response = await switchOrg(app, cookie, '888888');

        expect(response.statusCode).toBe(200);
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
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('UNKNOWN_ORG');
    });

    it('answers 403 for an organization the caller exists but cannot see', async () => {
        const { app } = await setup((store) => {
            // A second org exists, planted by another installation's sign-in — but this account
            // was never reported into it.
            store.seedOrg('777777', 'elsewhere', '777777');
        });
        const cookie = await signIn(app);

        const response = await switchOrg(app, cookie, '777777');

        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    it('answers 400 BAD_ORG for a body without an orgId', async () => {
        const { app } = await setup();
        const cookie = await signIn(app);
        const response = await switchOrg(app, cookie, undefined);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ORG');
    });

    it('answers 401 for an anonymous caller', async () => {
        const { app } = await setup();
        const response = await switchOrg(app, 'not-a-session', '888888');
        expect(response.statusCode).toBe(401);
    });
});
