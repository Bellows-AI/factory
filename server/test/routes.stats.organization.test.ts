import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { githubAuth, harness, memoryAuthStore, signedIn, stubTelemetryClient } from './helpers.js';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

describe('GET /api/stats organization', () => {
    const warm = async (harnessOptions: Parameters<typeof harness>[0] = {}) => {
        const h = await harness(harnessOptions);
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        return h;
    };

    /** A signed-in member of test-org, with the org planted for the membership checks. */
    const memberOfTestOrg = async (
        extraSeed?: (store: ReturnType<typeof memoryAuthStore>) => void,
        options: { telemetry?: ReturnType<typeof stubTelemetryClient>; skipWarm?: boolean } = {}
    ) => {
        const auth = memoryAuthStore();
        extraSeed?.(auth);
        const caller = auth.seedMember('test-org', 'octocat');
        const cookie = await signedIn(auth, caller);
        const h = await harness({
            auth,
            config: { auth: githubAuth() },
            ...(options.telemetry ? { telemetry: options.telemetry } : {}),
        });
        app = h.app;
        // Warm WITH the cookie: a github-mode board 401s the anonymous probe, and the cold
        // cache would 202 the assertions below. Skippable for the tests that PIN the cold 202.
        if (!options.skipWarm) {
            await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
            await h.settle();
        }
        return { h, cookie };
    };

    it("serves the caller's own org from the session, not from a parameter", async () => {
        const { cookie } = await memberOfTestOrg();

        const res = await app!.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });

        expect(res.statusCode).toBe(HTTP_OK);
        // meta names the CALLER's org: directory mode, one current, the memberships available.
        expect(res.json().meta.organization).toEqual({
            mode: 'directory',
            current: { id: 'test-org', name: 'test-org' },
            available: [{ id: 'test-org', name: 'test-org' }],
        });
    });

    it('accepts ?org= naming an org the caller is a member of', async () => {
        const { cookie } = await memberOfTestOrg();

        const res = await app!.inject({ method: 'GET', url: '/api/stats?org=test-org', headers: { cookie } });

        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.json().meta.organization.current.id).toBe('test-org');
    });

    it("rejects an unknown organization with 400, never another organization's figures", async () => {
        const { cookie } = await memberOfTestOrg();

        const res = await app!.inject({ method: 'GET', url: '/api/stats?org=other-org', headers: { cookie } });

        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('UNKNOWN_ORG');
        // Names the one it refused: the reader's next question is always "then which?".
        expect(res.json().error).toMatch(/other-org/);
    });

    it('rejects a known organization the caller is not a member of with 403', async () => {
        // The distinction the issue draws: unknown is a typo (400), known-but-not-yours is a
        // boundary (403) — the caller authenticated, the answer just belongs to somebody else.
        const { cookie } = await memberOfTestOrg((store) => {
            store.seedOrg('planted-org', 'Planted', '777777');
        });

        const res = await app!.inject({ method: 'GET', url: '/api/stats?org=planted-org', headers: { cookie } });

        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json().code).toBe('FORBIDDEN');
    });

    it('treats an empty ?org= as unset, like every other empty value', async () => {
        const { cookie } = await memberOfTestOrg();
        expect((await app!.inject({ method: 'GET', url: '/api/stats?org=', headers: { cookie } })).statusCode).toBe(
            HTTP_OK
        );
    });

    it('rejects an unknown organization before the cold-start 202', async () => {
        // A bad request is a bad request whatever the cache is doing. Answering 202 here would
        // have the client poll forever for a request that can never succeed. The telemetry stub
        // never resolves and the cache is left cold on purpose: a 400 can then only have come
        // from the guard running ahead of the fetch.
        const telemetry = stubTelemetryClient({ rollups: () => new Promise(() => {}) });
        const { cookie } = await memberOfTestOrg(undefined, { telemetry, skipWarm: true });

        const res = await app!.inject({ method: 'GET', url: '/api/stats?org=nope', headers: { cookie } });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('UNKNOWN_ORG');
    });

    it('reports the organization, not the range, when both are wrong', async () => {
        // Pins the guard's placement ahead of parseRange. Without this the ordering is untested and
        // a future reshuffle is invisible — and the organization decides WHICH data set is being
        // ranged, so it is the more fundamental of the two errors.
        const { cookie } = await memberOfTestOrg();
        const res = await app!.inject({
            method: 'GET',
            url: '/api/stats?org=nope&range=fortnight',
            headers: { cookie },
        });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('UNKNOWN_ORG');
    });

    it('answers 503 when the org runtime failed to build — never a 400 for a proven org', async () => {
        // resolveOrg just proved the org exists (membership), so null from the registry is a
        // failed build: a 503 like every other unavailable backing service, not a client error.
        const auth = memoryAuthStore();
        const caller = auth.seedMember('test-org', 'octocat');
        const cookie = await signedIn(auth, caller);
        const h = await harness({ auth, config: { auth: githubAuth() }, orgsFor: ['never-this-org'] });
        app = h.app;

        const res = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });

        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(res.json().code).toBe('ORG_UNAVAILABLE');
    });

    it('answers the no-caller case in the none-mode shape it serves', async () => {
        // No auth hook at all — the route-test mode. The bound org is the local one, and any
        // requested org other than it is unknown by definition: there is no store to know others.
        await warm();
        const res = await app!.inject({ method: 'GET', url: '/api/stats?org=test-org' });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('UNKNOWN_ORG');
    });
});
