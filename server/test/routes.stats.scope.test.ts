import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TEST_REPO, githubAuth, harness, memoryAuthStore, signedIn, stubTelemetryClient } from './helpers.js';
const HTTP_BAD_REQUEST = 400;

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

describe('GET /api/stats scope: rejections', () => {
    const scopedHarness = async (telemetry = stubTelemetryClient()) => {
        const store = memoryAuthStore();
        const h = await harness({ telemetry, auth: store, config: { auth: githubAuth() } });
        return { ...h, store };
    };

    it('names the org scope the figures were computed under', async () => {
        const h = await harness();
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.meta.scope).toBe('org');
        expect(body.meta.scopeLogin).toBeNull();
    });

    it('rejects caller scope when nothing is signed in (open auth mode)', async () => {
        const h = await harness();
        app = h.app;
        const res = await app.inject({ method: 'GET', url: '/api/stats?scope=mine' });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('SCOPE_REQUIRES_USER');
    });

    it('rejects caller scope for an organization token, which names no person', async () => {
        const h = await scopedHarness();
        app = h.app;
        const token = h.store.seedAccessToken('test-org', 'org', { label: 'board reader' });
        const res = await app!.inject({
            method: 'GET',
            url: '/api/stats?scope=mine',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('SCOPE_REQUIRES_USER');
    });

    it('rejects a scope it does not know', async () => {
        const h = await harness();
        app = h.app;
        const res = await app.inject({ method: 'GET', url: '/api/stats?scope=team' });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json().code).toBe('BAD_SCOPE');
    });
});

describe('GET /api/stats scope: computed figures', () => {
    const ATTRIBUTED_TOKENS_INPUT = 1000;
    const ATTRIBUTED_TOKENS_OUTPUT = 500;
    const ACTIVE_SECONDS = 60;
    const CAROL_AGENT_TURNS = 7;
    const DAVE_AGENT_TURNS = 3;

    it('computes every figure over only the caller attributed sessions, naming the member', async () => {
        // The telemetry is built around the caller: two sessions attributed to them, one to
        // another member, one unattributed — so a leak in any direction shows in the counts.
        const carol = { id: 'u-carol', login: 'carol', name: 'Carol', avatarUrl: null };
        const dave = { id: 'u-dave', login: 'dave', name: null, avatarUrl: null };
        const sessionOf = (sessionId: string, user: typeof carol | null, taskKey: string | null) => ({
            sessionId,
            agent: 'claude-code',
            repo: TEST_REPO,
            user,
            taskKey,
            firstSeen: '2026-08-20T00:00:00.000Z',
            lastSeen: '2026-08-20T01:00:00.000Z',
            tokens: {
                input: ATTRIBUTED_TOKENS_INPUT,
                output: ATTRIBUTED_TOKENS_OUTPUT,
                cacheRead: null,
                cacheCreation: null,
            },
            linesAdded: 1,
            linesRemoved: 0,
            editsAccepted: 1,
            editsRejected: 0,
            activeSeconds: ACTIVE_SECONDS,
            commits: 0,
        });
        const runOf = (rootJobId: string, repo: string, createdBy: string, agentTurns: number) => ({
            rootJobId,
            repo,
            createdBy,
            createdAt: '2026-08-20T00:00:00.000Z',
            agentTurns,
            wallClockMs: 60_000,
        });
        // The caller's account id IS what the landed join resolves, so the fixture is built
        // around it once the member exists: one member's id, another's, and null.
        const store = memoryAuthStore();
        const caller = store.seedMember('test-org', 'carol');
        const telemetry = stubTelemetryClient({
            rollups: async () => ({
                sessions: [
                    sessionOf('mine-1', { ...carol, id: caller.user.id }, 't-carol'),
                    sessionOf('mine-2', { ...carol, id: caller.user.id }, 't-carol'),
                    sessionOf('daves', dave, 't-dave'),
                    sessionOf('anon', null, null),
                ],
                coverage: { from: '2026-08-20T00:00:00.000Z', to: '2026-08-20T01:00:00.000Z' },
            }),
            runs: () => [
                runOf('t-carol', TEST_REPO, caller.user.id, CAROL_AGENT_TURNS),
                runOf('t-dave', TEST_REPO, dave.id, DAVE_AGENT_TURNS),
            ],
        });
        const h = await harness({ telemetry, auth: store, config: { auth: githubAuth() } });
        app = h.app;
        const cookie = await signedIn(store, caller);
        await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
        await h.settle();

        const EXPECTED_MINE_SESSIONS = 2;
        const EXPECTED_UNATTRIBUTED = 1;
        const EXPECTED_MINE_TOKENS_P50 = 3000;
        const mine = (await app.inject({ method: 'GET', url: '/api/stats?scope=mine', headers: { cookie } })).json();
        expect(mine.meta.scope).toBe('mine');
        expect(mine.meta.scopeLogin).toBe('carol');
        expect(mine.telemetry.totals.sessions).toBe(EXPECTED_MINE_SESSIONS);
        expect(mine.telemetry.byUser.map((row: { user: { login: string } }) => row.user.login)).toEqual(['carol']);
        // Unattributed sessions stay out of the totals but keep their own figure.
        expect(mine.telemetry.unattributedSessions).toBe(EXPECTED_UNATTRIBUTED);
        // Coverage still describes the store, not the scope.
        expect(mine.telemetry.coverage.from).toBe('2026-08-20T00:00:00.000Z');
        // The task set narrows with the scope: only the caller's task survives.
        expect(mine.tasks.tokensPerTask).toMatchObject({ p50: EXPECTED_MINE_TOKENS_P50, tasks: 1 });
        expect(mine.tasks.jobTurnsPerTask.tasks).toBe(1);
        expect(mine.tasks.agentTurnsPerTask).toMatchObject({ p50: CAROL_AGENT_TURNS, tasks: 1 });

        // And the same snapshot answers the whole organization from the SAME fetch — all four
        // sessions, the unattributed one included.
        const EXPECTED_ORG_SESSIONS = 4;
        const org = (await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } })).json();
        expect(org.telemetry.totals.sessions).toBe(EXPECTED_ORG_SESSIONS);
        expect(org.tasks.tokensPerTask).toMatchObject({ tasks: 2 });
        expect(org.tasks.agentTurnsPerTask).toMatchObject({ tasks: 2 });
    });

    it('serves org and mine from the one fetch the cache paid for', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember('test-org', 'carol');
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry, auth: store, config: { auth: githubAuth() } });
        app = h.app;
        const headers = { cookie: await signedIn(store, caller) };
        await app.inject({ method: 'GET', url: '/api/stats', headers });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);

        await app.inject({ method: 'GET', url: '/api/stats?scope=mine', headers });
        await app.inject({ method: 'GET', url: '/api/stats?scope=org', headers });
        await h.settle();
        // A scope switch is a re-aggregation, never a second read.
        expect(telemetry.rollupCalls).toBe(1);
    });
});
