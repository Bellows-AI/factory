import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
    EMPTY_TELEMETRY,
    githubAuth,
    harness,
    memoryAuthStore,
    signedIn,
    stubTelemetryClient,
    TEST_REPO,
} from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

describe('GET /api/stats', () => {
    it('answers 202 while the cold read is running, then 200', async () => {
        let release: (() => void) | null = null;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const telemetry = stubTelemetryClient({
            rollups: async () => {
                await gate;
                return structuredClone(EMPTY_TELEMETRY);
            },
        });
        const h = await harness({ telemetry });
        app = h.app;

        const cold = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(cold.statusCode).toBe(202);
        expect(cold.json().fetch.state).toBe('loading');

        (release as unknown as () => void)();
        await h.settle();

        const warm = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(warm.statusCode).toBe(200);
        expect(warm.json().meta.stale).toBe(false);
    });

    it('serves telemetry with repo and freshness metadata, and no PR fields', async () => {
        const h = await harness();
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.telemetry.totals.sessions).toBe(13);
        expect(body.telemetry.totals.tokens.input).toBeGreaterThan(0);
        expect(body.meta.repos).toEqual([{ owner: 'Bellows-AI', name: 'bellows.ai' }]);
        // No auth hook in this harness, so the request carries no caller: the payload names the
        // local org, mode 'config' — the AUTH_MODE=none shape.
        expect(body.meta.organization).toEqual({
            mode: 'config',
            current: { id: 'default', name: 'default' },
            available: [{ id: 'default', name: 'default' }],
        });
        // The property the selector rests on: one element, equal to current, so the SPA needs no
        // second endpoint and no mode-specific branch in its markup.
        expect(body.meta.organization.available).toEqual([body.meta.organization.current]);
        expect(body.meta.ageSeconds).toBe(0);

        // The removal, pinned: the payload carries no PR stats and no PR metadata. A survivor of
        // the old envelope would silently render blank panels the type system cannot see.
        expect(body.stats).toBeUndefined();
        expect(body.meta.rateLimit).toBeUndefined();
        expect(body.meta.revert).toBeUndefined();
        expect(body.meta.baseBranch).toBeUndefined();
        expect(body.meta.persistence).toBeUndefined();
        expect(body.telemetry.prs).toBeUndefined();
        expect(body.telemetry.unmatched).toBeUndefined();
    });

    it('reports the two setup failures separately', async () => {
        const h = await harness();
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.meta.telemetry.otherRepoSessions).toBe(1);
        expect(body.meta.telemetry.sessionsWithoutHook).toBe(1);
    });

    it('serves per-user attribution beside the totals', async () => {
        const h = await harness();
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        // The fixture's in-scope sessions carry two users and four unattributed sessions — the
        // board-task join resolved server-side, never a client guess.
        expect(body.telemetry.byUser.map((row: { user: { login: string } }) => row.user.login)).toEqual([
            'alice',
            'bob',
        ]);
        expect(body.telemetry.byUser[0]).toMatchObject({ user: { login: 'alice', name: 'Alice Doe' }, sessions: 5 });
        expect(body.telemetry.byUser[0].tokens.input).toBeGreaterThan(0);
        expect(body.telemetry.unattributedSessions).toBe(4);
    });

    it('filters sessions by overlap for a narrowed range', async () => {
        const h = await harness();
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        // The fixture's earliest session starts 2026-04-15 and the harness clock is pinned at
        // 2026-08-21, so a one-day lookback keeps only the two sessions inside it — but any
        // session straddling the lower bound must also survive.
        const body = (await app.inject({ method: 'GET', url: '/api/stats?range=day' })).json();
        expect(body.meta.range.preset).toBe('day');
        expect(body.telemetry.totals.sessions).toBeLessThan(13);
        expect(body.telemetry.coverage.from).toBe('2026-04-15T12:00:00Z');
    });

    it('does not refetch inside the TTL', async () => {
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);

        // Strictly inside the 30s TTL. Advancing to exactly the TTL is already stale.
        h.advance(15_000);
        for (let i = 0; i < 3; i += 1) await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);
    });

    it('serves the stale entry and refetches exactly once past the TTL', async () => {
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        h.advance(31_000);
        const stale = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(stale.statusCode).toBe(200);
        expect(stale.json().meta.stale).toBe(true);

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(2);
    });

    it('keeps serving the last good payload when a later read fails', async () => {
        let calls = 0;
        const telemetry = stubTelemetryClient({
            rollups: async () => {
                calls += 1;
                if (calls > 1) throw new Error('connection lost');
                return structuredClone(EMPTY_TELEMETRY);
            },
        });
        const h = await harness({ telemetry });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        h.advance(31_000);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.telemetry).not.toBeNull();
        expect(body.meta.telemetry.stale).toBe(true);
        expect(body.meta.telemetry.reason).toBe('connection lost');
    });

    it('answers 503 when the first read fails cold', async () => {
        const telemetry = stubTelemetryClient({
            rollups: async () => {
                throw new Error('connection refused');
            },
        });
        const h = await harness({ telemetry });
        app = h.app;

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const res = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe('connection refused');
    });

    it('does not retry on every request while the failure is fresh', async () => {
        const telemetry = stubTelemetryClient({
            rollups: async () => {
                throw new Error('connection refused');
            },
        });
        const h = await harness({ telemetry });
        app = h.app;

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);

        for (let i = 0; i < 5; i += 1) await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);

        h.advance(30_001);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(2);
    });

    it('retries immediately when a refresh is asked for explicitly', async () => {
        const telemetry = stubTelemetryClient({
            rollups: async () => {
                throw new Error('connection refused');
            },
        });
        const h = await harness({ telemetry });
        app = h.app;

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        await app.inject({ method: 'POST', url: '/api/refresh' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(2);
    });

    it('collapses concurrent cold requests into one read', async () => {
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry });
        app = h.app;

        await Promise.all(Array.from({ length: 5 }, () => app!.inject({ method: 'GET', url: '/api/stats' })));
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);
    });
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
    const memberOfTestOrg = async (extraSeed?: (store: ReturnType<typeof memoryAuthStore>) => void) => {
        const auth = memoryAuthStore();
        extraSeed?.(auth);
        const caller = auth.seedMember('test-org', 'octocat');
        const cookie = await signedIn(auth, caller);
        const h = await harness({ auth, config: { auth: githubAuth() } });
        app = h.app;
        // Warm WITH the cookie: a github-mode board 401s the anonymous probe, and the cold
        // cache would 202 the assertions below.
        await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
        await h.settle();
        return { h, cookie };
    };

    it("serves the caller's own org from the session, not from a parameter", async () => {
        const { cookie } = await memberOfTestOrg();

        const res = await app!.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });

        expect(res.statusCode).toBe(200);
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

        expect(res.statusCode).toBe(200);
        expect(res.json().meta.organization.current.id).toBe('test-org');
    });

    it("rejects an unknown organization with 400, never another organization's figures", async () => {
        const { cookie } = await memberOfTestOrg();

        const res = await app!.inject({ method: 'GET', url: '/api/stats?org=other-org', headers: { cookie } });

        expect(res.statusCode).toBe(400);
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

        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('FORBIDDEN');
    });

    it('treats an empty ?org= as unset, like every other empty value', async () => {
        const { cookie } = await memberOfTestOrg();
        expect((await app!.inject({ method: 'GET', url: '/api/stats?org=', headers: { cookie } })).statusCode).toBe(
            200
        );
    });

    it('rejects an unknown organization before the cold-start 202', async () => {
        // A bad request is a bad request whatever the cache is doing. Answering 202 here would
        // have the client poll forever for a request that can never succeed.
        const telemetry = stubTelemetryClient({ rollups: () => new Promise(() => {}) });
        const { cookie } = await memberOfTestOrg();
        void telemetry;

        const res = await app.inject({ method: 'GET', url: '/api/stats?org=nope', headers: { cookie } });
        expect(res.statusCode).toBe(400);
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
        expect(res.statusCode).toBe(400);
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

        expect(res.statusCode).toBe(503);
        expect(res.json().code).toBe('ORG_UNAVAILABLE');
    });

    it('answers the no-caller case in the none-mode shape it serves', async () => {
        // No auth hook at all — the route-test mode. The bound org is the local one, and any
        // requested org other than it is unknown by definition: there is no store to know others.
        await warm();
        const res = await app!.inject({ method: 'GET', url: '/api/stats?org=test-org' });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('UNKNOWN_ORG');
    });
});

describe('POST /api/refresh', () => {
    it('is single-flight when called twice', async () => {
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry });
        app = h.app;

        const [a, b] = await Promise.all([
            app.inject({ method: 'POST', url: '/api/refresh' }),
            app.inject({ method: 'POST', url: '/api/refresh' }),
        ]);
        await h.settle();

        expect(a.statusCode).toBe(202);
        expect(b.statusCode).toBe(202);
        expect(telemetry.rollupCalls).toBe(1);
    });
});

describe('GET /api/stats scope', () => {
    /**
     * A signed-in-member harness: github-mode [auth] plus a memory store, so `?scope=mine` has
     * a caller to resolve and the refusal cases have a credential to be refused for.
     */
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
        expect(res.statusCode).toBe(400);
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
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('SCOPE_REQUIRES_USER');
    });

    it('rejects a scope it does not know', async () => {
        const h = await harness();
        app = h.app;
        const res = await app.inject({ method: 'GET', url: '/api/stats?scope=team' });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('BAD_SCOPE');
    });

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
            tokens: { input: 1000, output: 500, cacheRead: null, cacheCreation: null },
            linesAdded: 1,
            linesRemoved: 0,
            editsAccepted: 1,
            editsRejected: 0,
            activeSeconds: 60,
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
            runs: () => [runOf('t-carol', TEST_REPO, caller.user.id, 7), runOf('t-dave', TEST_REPO, dave.id, 3)],
        });
        const h = await harness({ telemetry, auth: store, config: { auth: githubAuth() } });
        app = h.app;
        const cookie = await signedIn(store, caller);
        await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
        await h.settle();

        const mine = (await app.inject({ method: 'GET', url: '/api/stats?scope=mine', headers: { cookie } })).json();
        expect(mine.meta.scope).toBe('mine');
        expect(mine.meta.scopeLogin).toBe('carol');
        expect(mine.telemetry.totals.sessions).toBe(2);
        expect(mine.telemetry.byUser.map((row: { user: { login: string } }) => row.user.login)).toEqual(['carol']);
        // Unattributed sessions stay out of the totals but keep their own figure.
        expect(mine.telemetry.unattributedSessions).toBe(1);
        // Coverage still describes the store, not the scope.
        expect(mine.telemetry.coverage.from).toBe('2026-08-20T00:00:00.000Z');
        // The task set narrows with the scope: only the caller's task survives.
        expect(mine.tasks.tokensPerTask).toMatchObject({ p50: 3000, tasks: 1 });
        expect(mine.tasks.jobTurnsPerTask.tasks).toBe(1);
        expect(mine.tasks.agentTurnsPerTask).toMatchObject({ p50: 7, tasks: 1 });

        // And the same snapshot answers the whole organization from the SAME fetch — all four
        // sessions, the unattributed one included.
        const org = (await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } })).json();
        expect(org.telemetry.totals.sessions).toBe(4);
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

describe('GET /api/stats task statistics', () => {
    const taskSession = (
        sessionId: string,
        taskKey: string | null,
        input: number | null,
        output: number | null,
        seen: string,
        repo = TEST_REPO
    ) => ({
        sessionId,
        agent: 'claude-code',
        repo,
        user: null,
        taskKey,
        firstSeen: seen,
        lastSeen: seen,
        tokens: { input, output, cacheRead: null, cacheCreation: null },
        linesAdded: 1,
        linesRemoved: 0,
        editsAccepted: 1,
        editsRejected: 0,
        activeSeconds: 60,
        commits: 0,
    });

    const taskHarness = async () => {
        const telemetry = stubTelemetryClient({
            rollups: async () => ({
                sessions: [
                    // t1: two measured sessions, 1k and 3k billable tokens.
                    taskSession('a', 't1', 600, 400, '2026-08-20T01:00:00Z'),
                    taskSession('b', 't1', 2400, 600, '2026-08-20T02:00:00Z'),
                    // t2: one measured session and one null — the null contributor is skipped,
                    // and the task still enters the token distribution on what it measured.
                    taskSession('c', 't2', 500, 500, '2026-08-20T03:00:00Z'),
                    taskSession('d', 't2', null, null, '2026-08-20T04:00:00Z'),
                    // An other-repo session: excluded from the totals above, excluded here too.
                    taskSession('e', 't5', 90_000, 90_000, '2026-08-20T05:00:00Z', 'Other/repo'),
                ],
                coverage: { from: '2026-08-20T01:00:00Z', to: '2026-08-20T03:00:00Z' },
            }),
            runs: () => [
                {
                    rootJobId: 't1',
                    repo: TEST_REPO,
                    createdBy: 'u-alice',
                    createdAt: '2026-08-19T00:00:00Z',
                    agentTurns: 9,
                    wallClockMs: 600_000,
                },
                {
                    rootJobId: 't1',
                    repo: TEST_REPO,
                    createdBy: 'u-alice',
                    createdAt: '2026-08-20T05:00:00Z',
                    agentTurns: 4,
                    wallClockMs: 300_000,
                },
                // t2's only run is unmeasured: excluded from the turn distribution only.
                {
                    rootJobId: 't2',
                    repo: TEST_REPO,
                    createdBy: 'u-bob',
                    createdAt: '2026-08-20T06:00:00Z',
                    agentTurns: null,
                    wallClockMs: null,
                },
                // An other-repo task: out of the repo scope the totals apply, so out of here too.
                {
                    rootJobId: 't5',
                    repo: 'Other/repo',
                    createdBy: 'u-bob',
                    createdAt: '2026-08-20T07:00:00Z',
                    agentTurns: 50,
                    wallClockMs: 60_000,
                },
            ],
        });
        return harness({ telemetry });
    };

    it('reports the per-task distributions over the range, with their counts', async () => {
        const h = await taskHarness();
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        // Tokens: t1 totals 4k over its two sessions, t2 1k — the null contributor skipped,
        // and the other-repo task t5 nowhere in the distribution.
        expect(body.tasks.tokensPerTask).toEqual({ avg: 2500, p50: 1000, p95: 4000, tasks: 2 });
        expect(body.tasks.tokensPerTask.p95).toBeLessThan(90_000);
        // Job turns: t1 ran twice, t2 once — t2 counts here even though its run was unmeasured.
        expect(body.tasks.jobTurnsPerTask).toEqual({ avg: 1.5, p50: 1, p95: 2, tasks: 2 });
        // Agent turns: t1 banks 9 + 4 = 13; t2 for its unmeasured run and t5 for its repo are
        // both out.
        expect(body.tasks.agentTurnsPerTask).toEqual({ avg: 13, p50: 13, p95: 13, tasks: 1 });
        // Wall clock: t1 banks 600k + 300k ms; t2's never-executed run leaves it out here too.
        expect(body.tasks.wallClockPerTask).toEqual({ avg: 900_000, p50: 900_000, p95: 900_000, tasks: 1 });
    });

    it('answers null figures, not zeros, for a range with nothing in it', async () => {
        const h = await taskHarness();
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const url = '/api/stats?range=custom&from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z';
        const body = (await app.inject({ method: 'GET', url })).json();
        expect(body.telemetry.totals.sessions).toBe(0);
        expect(body.tasks.tokensPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(body.tasks.jobTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(body.tasks.agentTurnsPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
        expect(body.tasks.wallClockPerTask).toEqual({ avg: null, p50: null, p95: null, tasks: 0 });
    });
});
