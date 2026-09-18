import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { OAUTH_COOKIE, PENDING_COOKIE } from '../src/auth/session.js';
import { buildApp } from '../src/app.js';
import { createRepoSource } from '../src/github/repo-source.js';
import type { OrgRegistry, OrgRuntime } from '../src/orgs.js';
import { createStatsService } from '../src/stats-service.js';
import {
    githubAuth,
    memoryAuthStore,
    oneInstallation,
    stubIdentityClient,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';

const ORG = '999999';

/**
 * The first hop of an onboarding sign-in: begin, callback — and the pending cookie the selection
 * screen would be holding. `reselect=1` parks even a first sign-in, which is how these tests get
 * a screen to complete with a single installation.
 */
async function beginOnboarding(app: FastifyInstance): Promise<string> {
    const begin = await app.inject({ method: 'GET', url: '/api/auth/github?reselect=1' });
    expect(begin.statusCode).toBe(302);
    const state = begin.cookies.find((c) => c.name === OAUTH_COOKIE)!.value;
    const callback = await app.inject({
        method: 'GET',
        url: `/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
        cookies: { [OAUTH_COOKIE]: state },
    });
    expect(callback.headers.location).toBe('/onboarding');
    const cookie = callback.cookies.find((c) => c.name === PENDING_COOKIE)?.value;
    expect(cookie).toBeTruthy();
    return cookie!;
}

describe('completion and the org repo cache', () => {
    it('a refresh already in flight cannot land the pre-write allowlist under a fresh timestamp', async () => {
        // The repo source's cache is single-flight: a produce that started before completion
        // holds the PRE-write allowlist and, when it lands, stores that stale list with a fresh
        // timestamp — one expire() cannot touch a result that did not exist yet, and the old
        // selection would be served for another full TTL. Completion drains the in-flight
        // produce and expires the freshly-stamped result, so the next read re-produces with the
        // allowlist that now stands.
        const store = memoryAuthStore();
        const identity = stubIdentityClient();
        identity.installationsAnswer = oneInstallation(ORG);

        // One gated produce: the first allowlist read captures the pre-write value and parks
        // there, so the produce can only land AFTER completion has written and invalidated.
        let release: () => void = () => {};
        const parked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reads = 0;
        const repos = createRepoSource({
            stored: async () => ['acme/web', 'acme/other'],
            allowlist: async () => {
                const tracked = await store.trackedRepos(ORG);
                reads += 1;
                if (reads === 1) await parked;
                return tracked;
            },
        });

        const config = testConfig({ auth: githubAuth() });
        const telemetry = stubTelemetryClient();
        const runtime: OrgRuntime = {
            orgId: ORG,
            repos,
            telemetry,
            service: createStatsService({ config, repos, telemetry }),
        };
        const orgs: OrgRegistry = {
            for: async () => runtime,
            list: async () => [{ id: ORG, name: 'acme', installationId: ORG }],
            warmAll: async () => {},
        };
        const app = await buildApp({
            config,
            orgs,
            auth: store,
            identity,
            appSlug: async () => 'stub-app',
            installationListing: async () => [
                { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
            ],
        });

        // The racing produce: parks with the empty (track-everything) allowlist in hand.
        const racing = repos.list();

        const cookie = await beginOnboarding(app);
        const done = app.inject({
            method: 'POST',
            url: '/api/auth/github/complete',
            cookies: { [PENDING_COOKIE]: cookie },
            payload: { orgs: [ORG], repos: { [ORG]: ['acme/web'] } },
        });

        // The allowlist write has landed while the produce is still parked on the old value.
        while ((await store.trackedRepos(ORG)).length === 0) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        release();

        expect((await done).statusCode).toBe(200);
        await racing;

        // The drained produce captured the pre-write allowlist; if completion let it stand
        // fresh, this read would serve the whole installation for another TTL instead of the
        // narrowing that was just made.
        const after = await repos.list();
        expect(after.map((repo) => `${repo.owner}/${repo.name}`)).toEqual(['acme/web']);
    });
});
