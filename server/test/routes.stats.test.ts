import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { EMPTY_TELEMETRY, harness, stubTelemetryClient } from './helpers.js';

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
        expect(body.meta.organization).toEqual({
            mode: 'config',
            current: { id: 'test-org', name: 'Test Org' },
            available: [{ id: 'test-org', name: 'Test Org' }],
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
    const warm = async () => {
        const h = await harness();
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        return h;
    };

    it('accepts the organization it serves', async () => {
        await warm();
        const res = await app!.inject({ method: 'GET', url: '/api/stats?org=test-org' });
        expect(res.statusCode).toBe(200);
        expect(res.json().meta.organization.current.id).toBe('test-org');
    });

    it("rejects an unknown organization, never another organization's figures", async () => {
        await warm();
        const res = await app!.inject({ method: 'GET', url: '/api/stats?org=other-org' });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('UNKNOWN_ORG');
        // Names the one it does serve: the reader's next question is always "then which?".
        expect(res.json().error).toMatch(/test-org/);
    });

    it('treats an empty ?org= as unset, like every other empty value', async () => {
        await warm();
        expect((await app!.inject({ method: 'GET', url: '/api/stats?org=' })).statusCode).toBe(200);
    });

    it('rejects an unknown organization before the cold-start 202', async () => {
        // A bad request is a bad request whatever the cache is doing. Answering 202 here would
        // have the client poll forever for a request that can never succeed.
        const telemetry = stubTelemetryClient({ rollups: () => new Promise(() => {}) });
        const h = await harness({ telemetry });
        app = h.app;

        const res = await app.inject({ method: 'GET', url: '/api/stats?org=nope' });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('UNKNOWN_ORG');
    });

    it('reports the organization, not the range, when both are wrong', async () => {
        // Pins the guard's placement ahead of parseRange. Without this the ordering is untested and
        // a future reshuffle is invisible — and the organization decides WHICH data set is being
        // ranged, so it is the more fundamental of the two errors.
        await warm();
        const res = await app!.inject({ method: 'GET', url: '/api/stats?org=nope&range=fortnight' });
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
