import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InstallationRepo } from '../src/github/app-client.js';
import { OAUTH_COOKIE, PENDING_COOKIE, SESSION_COOKIE } from '../src/auth/session.js';
import { githubAuth, harness, memoryAuthStore, oneInstallation, stubIdentityClient } from './helpers.js';
import type { MemoryAuthStore } from './helpers.js';

/**
 * Shared fixtures for the auth.oauth test suite, split across auth.oauth.sign-in.test.ts,
 * auth.oauth.identity.test.ts, auth.oauth.me.test.ts and the auth.oauth.selection-*.test.ts files.
 */

export const ORG = '999999';

const HTTP_FOUND = 302;

export interface SetupOptions {
    seed?: (store: MemoryAuthStore) => void;
    installations?: { id: string; account: string | null }[];
    installationListing?: (installationId: string) => Promise<InstallationRepo[] | null>;
}

export async function setup({
    seed = () => {},
    installations = oneInstallation(ORG),
    installationListing,
}: SetupOptions = {}) {
    const auth = memoryAuthStore();
    seed(auth);
    const identity = stubIdentityClient();
    identity.installationsAnswer = installations;
    const { app, orgs, repos } = await harness({
        config: { auth: githubAuth() },
        auth,
        identity,
        appSlug: async () => 'stub-app',
        installationListing,
    });
    return { app, auth, identity, orgs, repos };
}

/** Starts a flow and returns the state cookie the browser would be holding. */
export async function begin(app: FastifyInstance, returnTo = '/', org?: string, reselect = false): Promise<string> {
    const params = new URLSearchParams({ returnTo });
    if (org) params.set('org', org);
    if (reselect) params.set('reselect', '1');
    const response = await app.inject({
        method: 'GET',
        url: `/api/auth/github?${params}`,
    });
    expect(response.statusCode).toBe(HTTP_FOUND);
    const cookie = response.cookies.find((c) => c.name === OAUTH_COOKIE);
    expect(cookie).toBeDefined();
    return cookie!.value;
}

export const callback = (app: FastifyInstance, query: string, cookie?: string) =>
    app.inject({
        method: 'GET',
        url: `/api/auth/github/callback?${query}`,
        ...(cookie ? { cookies: { [OAUTH_COOKIE]: cookie } } : {}),
    });

export const errorOf = (location: string): string | null =>
    new URL(location, 'http://x').searchParams.get('auth_error');

/** A complete sign-in: begin, callback, and the session cookie that came out of it. */
export async function signIn(app: FastifyInstance, org?: string): Promise<string> {
    const state = await begin(app, '/', org);
    const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
    expect(response.statusCode).toBe(HTTP_FOUND);
    expect(errorOf(response.headers.location as string)).toBeNull();
    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
    expect(cookie).toBeTruthy();
    return cookie!;
}

export const pendingRoute = (app: FastifyInstance, cookie?: string) =>
    app.inject({
        method: 'GET',
        url: '/api/auth/github/pending',
        ...(cookie ? { cookies: { [PENDING_COOKIE]: cookie } } : {}),
    });

export const completeRoute = (app: FastifyInstance, body: unknown, cookie?: string) =>
    app.inject({
        method: 'POST',
        url: '/api/auth/github/complete',
        ...(cookie ? { cookies: { [PENDING_COOKIE]: cookie } } : {}),
        payload: body,
    });

export const reposRoute = (app: FastifyInstance, installationId: string, cookie?: string) =>
    app.inject({
        method: 'GET',
        url: `/api/auth/github/pending/installations/${installationId}/repos`,
        ...(cookie ? { cookies: { [PENDING_COOKIE]: cookie } } : {}),
    });

/**
 * The first hop of an onboarding sign-in: begin, callback — and the pending cookie the selection
 * screen would be holding, after asserting the callback actually redirected there.
 */
export async function beginOnboarding(
    app: FastifyInstance,
    returnTo = '/',
    org?: string,
    reselect = false
): Promise<string> {
    const state = await begin(app, returnTo, org, reselect);
    const response = await callback(app, `code=abc&state=${encodeURIComponent(state)}`, state);
    expect(response.statusCode).toBe(HTTP_FOUND);
    expect(response.headers.location).toBe('/onboarding');
    const cookie = response.cookies.find((c) => c.name === PENDING_COOKIE)?.value;
    expect(cookie).toBeTruthy();
    return cookie!;
}

/** Finishes an onboarding: callback hop, then the completion POST. Returns the completion response. */
export function finishOnboarding(
    app: FastifyInstance,
    cookie: string,
    body: { orgs: string[]; repos?: Record<string, string[]> }
) {
    return completeRoute(app, body, cookie);
}
