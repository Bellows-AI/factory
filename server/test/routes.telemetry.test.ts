import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { TelemetryError } from '../src/telemetry/errors.js';
import { EMPTY_TELEMETRY, harness, stubClient, stubTelemetryClient } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

/** Warms both caches and returns the parsed payload. */
async function warm(h: Awaited<ReturnType<typeof harness>>) {
    await h.app.inject({ method: 'GET', url: '/api/stats' });
    await h.settle();
    return (await h.app.inject({ method: 'GET', url: '/api/stats' })).json();
}

describe('telemetry on /api/stats', () => {
    it('serves attributed telemetry beside the PR stats', async () => {
        const h = await harness({ client: stubClient() });
        app = h.app;
        const body = await warm(h);

        expect(body.meta.telemetry.status).toBe('ok');
        expect(body.meta.telemetry.source).toBe('fixture');
        expect(body.meta.telemetry.repoFilter).toEqual(['Bellows-AI/bellows.ai']);
        expect(body.telemetry.totals.sessions).toBe(13);
        expect(body.telemetry.totals.tokens.input).toBeGreaterThan(0);
        expect(body.telemetry.prs.find((r: { number: number }) => r.number === 204).attribution).toBe('exact');
    });

    it('reports the two setup failures separately', async () => {
        const h = await harness({ client: stubClient() });
        app = h.app;
        const body = await warm(h);

        expect(body.meta.telemetry.otherRepoSessions).toBe(1);
        expect(body.meta.telemetry.sessionsWithoutHook).toBe(1);
    });

    it('ages the two snapshots independently', async () => {
        const h = await harness({ client: stubClient() });
        app = h.app;
        await warm(h);

        h.advance(12_000);
        const body = (await h.app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.meta.ageSeconds).toBe(12);
        expect(body.meta.telemetry.ageSeconds).toBe(12);
        expect(body.meta.stale).toBe(false);
        expect(body.meta.telemetry.stale).toBe(false);
    });
});

describe('failure isolation', () => {
    it('keeps the PR stats intact when telemetry is unreachable', async () => {
        // The telemetry analogue of "the revert rate degrades alone". This is the one that
        // matters: a dead database must not blank a dashboard that has nothing to do with it.
        const telemetry = stubTelemetryClient({
            rollups: async () => {
                throw new TelemetryError('connection refused', 'UNREACHABLE');
            },
        });
        const h = await harness({ client: stubClient(), telemetry });
        app = h.app;
        const body = await warm(h);

        expect(body.stats.meta.counts.mergedToBase).toBe(178);
        expect(body.stats.threads.total).toBe(654);
        expect(body.telemetry).toBeNull();
        expect(body.meta.telemetry.status).toBe('unreachable');
        expect(body.meta.telemetry.reason).toBe('connection refused');
    });

    it('serves the last good telemetry when a later read fails', async () => {
        let calls = 0;
        const telemetry = stubTelemetryClient({
            rollups: async () => {
                calls += 1;
                if (calls > 1) throw new TelemetryError('connection lost', 'UNREACHABLE');
                return structuredClone(EMPTY_TELEMETRY);
            },
        });
        const h = await harness({ client: stubClient(), telemetry });
        app = h.app;
        await warm(h);

        h.advance(31_000);
        await h.app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await h.app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.telemetry).not.toBeNull();
        expect(body.meta.telemetry.stale).toBe(true);
        expect(body.meta.telemetry.reason).toBe('connection lost');
    });

    it('does not let a GitHub cooldown suppress the telemetry read', async () => {
        const client = stubClient({
            prs: async () => {
                throw new Error('rate limited');
            },
        });
        const telemetry = stubTelemetryClient();
        const h = await harness({ client, telemetry });
        app = h.app;

        await h.app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        // Inside ERROR_COOLDOWN_MS the PR fetch is held back; telemetry must not be.
        expect(telemetry.rollupCalls).toBe(1);

        h.advance(31_000);
        await h.app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(2);
    });

    it('holds off for its own short cooldown after a failure', async () => {
        const telemetry = stubTelemetryClient({
            rollups: async () => {
                throw new TelemetryError('down', 'UNREACHABLE');
            },
        });
        const h = await harness({ client: stubClient(), telemetry });
        app = h.app;
        await warm(h);
        expect(telemetry.rollupCalls).toBe(1);

        h.advance(1_000);
        await h.app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(1);

        // 5s, not the 30s GitHub cooldown: the failure here is a socket, not a quota.
        h.advance(5_000);
        await h.app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(2);
    });
});

describe('independent TTLs', () => {
    it('refetches telemetry on its own 30s clock while the PR cache stays warm', async () => {
        const client = stubClient();
        const telemetry = stubTelemetryClient();
        const h = await harness({ client, telemetry });
        app = h.app;
        await warm(h);
        expect(client.prCalls).toBe(1);
        expect(telemetry.rollupCalls).toBe(1);

        h.advance(31_000);
        await h.app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(telemetry.rollupCalls).toBe(2);
        expect(client.prCalls).toBe(1);
    });

    it('refetches the PR stats past 900s without spinning telemetry extra times', async () => {
        const client = stubClient();
        const telemetry = stubTelemetryClient();
        const h = await harness({ client, telemetry });
        app = h.app;
        await warm(h);

        h.advance(900_001);
        await h.app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(client.prCalls).toBe(2);
        // One telemetry read, because its TTL also expired — not one per request.
        expect(telemetry.rollupCalls).toBe(2);
    });
});

describe('degradation states', () => {
    it('reports an empty store as sessions:0 with null tokens, never zeros', async () => {
        const telemetry = stubTelemetryClient({ rollups: async () => structuredClone(EMPTY_TELEMETRY) });
        const h = await harness({ client: stubClient(), telemetry });
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

    it('never calls the client when telemetry is switched off', async () => {
        const telemetry = stubTelemetryClient();
        const h = await harness({
            client: stubClient(),
            telemetry,
            config: { telemetrySource: 'off' },
        });
        app = h.app;
        const body = await warm(h);

        expect(body.meta.telemetry.status).toBe('disabled');
        expect(body.telemetry).toBeNull();
        expect(telemetry.rollupCalls).toBe(0);
    });
});

describe('GET /api/health', () => {
    it('never touches telemetry, mirroring the GitHub guarantee', async () => {
        const telemetry = stubTelemetryClient();
        const h = await harness({ client: stubClient(), telemetry });
        app = h.app;

        const res = await app.inject({ method: 'GET', url: '/api/health' });
        expect(res.statusCode).toBe(200);
        expect(telemetry.rollupCalls).toBe(0);
        expect(telemetry.healthCalls).toBe(0);
    });
});

describe('POST /api/refresh', () => {
    it('refreshes both caches', async () => {
        const client = stubClient();
        const telemetry = stubTelemetryClient();
        const h = await harness({ client, telemetry });
        app = h.app;

        await app.inject({ method: 'POST', url: '/api/refresh' });
        await h.settle();
        expect(client.prCalls).toBe(1);
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
