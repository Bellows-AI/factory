import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { EMPTY_TELEMETRY, harness, stubTelemetryClient } from './helpers.js';

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_SERVICE_UNAVAILABLE = 503;

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

describe('GET /api/stats: payload and attribution', () => {
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
        expect(cold.statusCode).toBe(HTTP_ACCEPTED);
        expect(cold.json().fetch.state).toBe('loading');

        (release as unknown as () => void)();
        await h.settle();

        const warm = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(warm.statusCode).toBe(HTTP_OK);
        expect(warm.json().meta.stale).toBe(false);
    });

    it('serves telemetry with repo and freshness metadata, and no PR fields', async () => {
        const h = await harness();
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        const EXPECTED_SESSIONS = 13;
        expect(body.telemetry.totals.sessions).toBe(EXPECTED_SESSIONS);
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
        const EXPECTED_ALICE_SESSIONS = 5;
        const EXPECTED_UNATTRIBUTED_SESSIONS = 4;
        // The fixture's in-scope sessions carry two users and four unattributed sessions — the
        // board-task join resolved server-side, never a client guess.
        expect(body.telemetry.byUser.map((row: { user: { login: string } }) => row.user.login)).toEqual([
            'alice',
            'bob',
        ]);
        expect(body.telemetry.byUser[0]).toMatchObject({
            user: { login: 'alice', name: 'Alice Doe' },
            sessions: EXPECTED_ALICE_SESSIONS,
        });
        expect(body.telemetry.byUser[0].tokens.input).toBeGreaterThan(0);
        expect(body.telemetry.unattributedSessions).toBe(EXPECTED_UNATTRIBUTED_SESSIONS);
    });
});

describe('GET /api/stats: range filtering and TTL', () => {
    const WITHIN_TTL_MS = 15_000;
    const PAST_TTL_MS = 31_000;

    it('filters sessions by overlap for a narrowed range', async () => {
        const h = await harness();
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        // The fixture's earliest session starts 2026-04-15 and the harness clock is pinned at
        // 2026-08-21, so a one-day lookback keeps only the two sessions inside it — but any
        // session straddling the lower bound must also survive.
        const EXPECTED_TOTAL_SESSIONS = 13;
        const body = (await app.inject({ method: 'GET', url: '/api/stats?range=day' })).json();
        expect(body.meta.range.preset).toBe('day');
        expect(body.telemetry.totals.sessions).toBeLessThan(EXPECTED_TOTAL_SESSIONS);
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
        h.advance(WITHIN_TTL_MS);
        const RETRY_COUNT = 3;
        for (let i = 0; i < RETRY_COUNT; i += 1) await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);
    });

    it('serves the stale entry and refetches exactly once past the TTL', async () => {
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        h.advance(PAST_TTL_MS);
        const stale = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(stale.statusCode).toBe(HTTP_OK);
        expect(stale.json().meta.stale).toBe(true);

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        const EXPECTED_REFETCH_CALLS = 2;
        expect(telemetry.rollupCalls).toBe(EXPECTED_REFETCH_CALLS);
    });
});

describe('GET /api/stats: failure handling', () => {
    const PAST_TTL_MS = 31_000;
    const JUST_PAST_TTL_MS = 30_001;

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

        h.advance(PAST_TTL_MS);
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
        expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
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

        const RETRY_COUNT = 5;
        for (let i = 0; i < RETRY_COUNT; i += 1) await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);

        h.advance(JUST_PAST_TTL_MS);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        const EXPECTED_RETRY_CALLS = 2;
        expect(telemetry.rollupCalls).toBe(EXPECTED_RETRY_CALLS);
    });

    it('collapses concurrent cold requests into one read', async () => {
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry });
        app = h.app;

        const CONCURRENT_REQUESTS = 5;
        await Promise.all(
            Array.from({ length: CONCURRENT_REQUESTS }, () => app!.inject({ method: 'GET', url: '/api/stats' }))
        );
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);
    });
});
