import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { EMPTY_TELEMETRY, harness, stubTelemetryClient } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

/** Warms the cache and returns the parsed payload. */
async function warm(h: Awaited<ReturnType<typeof harness>>) {
    await h.app.inject({ method: 'GET', url: '/api/stats' });
    await h.settle();
    return (await h.app.inject({ method: 'GET', url: '/api/stats' })).json();
}

describe('telemetry on /api/stats', () => {
    it('serves the telemetry totals', async () => {
        const h = await harness();
        app = h.app;
        const body = await warm(h);

        expect(body.meta.telemetry.status).toBe('ok');
        expect(body.meta.telemetry.source).toBe('fixture');
        expect(body.meta.telemetry.repoFilter).toEqual(['Bellows-AI/bellows.ai']);
        expect(body.telemetry.totals.sessions).toBe(13);
        expect(body.telemetry.totals.tokens.input).toBeGreaterThan(0);
    });

    it('ages the snapshot on the request clock', async () => {
        const h = await harness();
        app = h.app;
        await warm(h);

        h.advance(12_000);
        const body = (await h.app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.meta.ageSeconds).toBe(12);
        expect(body.meta.telemetry.ageSeconds).toBe(12);
        expect(body.meta.stale).toBe(false);
        expect(body.meta.telemetry.stale).toBe(false);
    });

    it('reports the two setup failures separately', async () => {
        const h = await harness();
        app = h.app;
        const body = await warm(h);

        expect(body.meta.telemetry.otherRepoSessions).toBe(1);
        expect(body.meta.telemetry.sessionsWithoutHook).toBe(1);
    });
});

describe('degradation states', () => {
    it('reports an empty store as sessions:0 with null tokens, never zeros', async () => {
        const telemetry = stubTelemetryClient({ rollups: async () => structuredClone(EMPTY_TELEMETRY) });
        const h = await harness({ telemetry });
        app = h.app;
        const body = await warm(h);

        expect(body.meta.telemetry.status).toBe('empty');
        // Non-null on purpose: the panels render their structure, which is how you see the
        // pipeline is wired and merely silent.
        expect(body.telemetry).not.toBeNull();
        expect(body.telemetry.totals.sessions).toBe(0);
        expect(body.telemetry.totals.tokens.input).toBeNull();
        expect(body.telemetry.totals.acceptRatio).toBeNull();
    });

    it('answers 503 with a named code when telemetry is switched off', async () => {
        // Telemetry is the whole payload now, so `off` empties the page entirely — a named
        // refusal rather than a cold-start 202 that would never resolve.
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry, config: { telemetrySource: 'off' } });
        app = h.app;

        const res = await h.app.inject({ method: 'GET', url: '/api/stats' });
        expect(res.statusCode).toBe(503);
        expect(res.json().code).toBe('TELEMETRY_DISABLED');
        expect(telemetry.rollupCalls).toBe(0);
    });
});

describe('GET /api/health', () => {
    it('never touches telemetry', async () => {
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry });
        app = h.app;

        const res = await app.inject({ method: 'GET', url: '/api/health' });
        expect(res.statusCode).toBe(200);
        expect(telemetry.rollupCalls).toBe(0);
        expect(telemetry.healthCalls).toBe(0);
    });
});

describe('POST /api/refresh', () => {
    it('refreshes the cache', async () => {
        const telemetry = stubTelemetryClient();
        const h = await harness({ telemetry });
        app = h.app;

        await app.inject({ method: 'POST', url: '/api/refresh' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);
    });
});

describe('loadConfig', () => {
    // DATABASE_URL is required for every configuration now, so it is a baseline rather than the
    // subject of any case here.
    const DB = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
    // The App credentials likewise: required now, and none of these cases is about them.
    const env = (extra: NodeJS.ProcessEnv = {}) => (
        {
            DATABASE_URL: DB,
            GITHUB_APP_ID: '123',
            GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
            ...extra,
        }
    );

    it('rejects an unknown source', () => {
        expect(() => loadConfig(env({ TELEMETRY_SOURCE: 'clickhouse' }))).toThrow(/TELEMETRY_SOURCE/);
    });

    it('rejects a TTL below the floor', () => {
        expect(() => loadConfig(env({ TELEMETRY_TTL_SECONDS: '1' }))).toThrow(/at least 5/);
    });

    it('defaults to the postgres source, since there is always a database', () => {
        // It used to default to `fixture` so that `npm run dev` and the test suite needed neither
        // a database nor a collector. Both now have a database by construction, and a fixture
        // default would 404 the ingest route against a collector that is already exporting.
        const config = loadConfig(env());
        expect(config.telemetrySource).toBe('postgres');
        expect(config.telemetryTtlMs).toBe(30_000);
    });

    it('still defaults the organization, which nothing here should have changed', () => {
        expect(loadConfig(env()).orgId).toBe('default');
    });
});
