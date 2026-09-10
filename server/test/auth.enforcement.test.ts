import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { requirementFor } from '../src/auth/plugin.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import type { AuthConfig } from '../src/config.js';
import type { Claim, Job, JobStore } from '../src/db/job-store.js';
import { createStatsService } from '../src/stats-service.js';
import type { TelemetryStore } from '../src/telemetry/store.js';
import type { MemoryAuthStore } from './helpers.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryPrStore,
    signedIn,
    stubClient,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';

const ORG = 'test-org';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const WORKER_TOKEN = 'fwt_test-worker-token';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const jobStub = (): JobStore =>
    ({
        async create() {
            return { id: JOB_ID };
        },
        async claim() {
            return {
                id: JOB_ID,
                command: 'echo hi',
                attempts: 1,
                leaseToken: LEASE,
                leaseExpiresAt: '2026-08-21T12:05:00.000Z',
                userId: null,
                resumeSessionId: null,
                followUp: false,
            } satisfies Claim;
        },
        async heartbeat() {
            return { result: 'ok', leaseExpiresAt: '2026-08-21T12:05:00.000Z' };
        },
        async session() {
            return 'ok';
        },
        async suspend() {
            return 'ok';
        },
        async resume() {
            return 'ok';
        },
        async complete() {
            return 'ok';
        },
        async get() {
            return null as Job | null;
        },
        async list() {
            return [];
        },
    }) as JobStore;

const telemetryStub = (): TelemetryStore => ({
    async insertMetrics() {
        return 0;
    },
    async recordBranch() {},
});

async function build(auth: AuthConfig, store: MemoryAuthStore) {
    const config = testConfig({ auth });
    const service = createStatsService({
        config,
        client: stubClient(),
        telemetry: stubTelemetryClient(),
        store: memoryPrStore(),
    });
    app = await buildApp({
        config,
        service,
        store: telemetryStub(),
        jobs: jobStub(),
        auth: store,
    });
    return app;
}

describe('the route table', () => {
    /*
     * Driven off requirementFor rather than restated, so this cannot drift from the hook. The
     * point of the table is that each answer is a decision, and three of them are load-bearing:
     * health must stay open or the compose healthcheck restarts a container that was about to
     * succeed; the SPA's document must stay open or there is nothing to render a sign-in button in;
     * and the worker routes must NOT accept a session, or any member could steal another worker's
     * lease.
     */
    it.each([
        ['/api/health', 'open'],
        ['/api/auth/github', 'open'],
        ['/api/auth/github/callback', 'open'],
        ['/api/auth/me', 'open'],
        ['/', 'open'],
        ['/index.html', 'open'],
        ['/assets/app-1234.js', 'open'],
        // A client-side route, and the reason it is here is that it fails ONLY in production: Vite
        // has its own history fallback in dev, so a wall on this path would be invisible until the
        // baked image served it. The not-found handler in app.ts sends index.html for it, and the
        // wall is on /api/* rather than on the document — see docs/auth.md.
        ['/workspace', 'open'],
        ['/api/stats', 'user'],
        ['/api/refresh', 'user'],
        ['/api/jobs', 'user'],
        [`/api/jobs/${JOB_ID}`, 'user'],
        // Nobody holds a parked job, which is exactly what makes resuming one a person's action.
        [`/api/jobs/${JOB_ID}/resume`, 'user'],
        // Both are person's actions on a finished task — a follow-up asks for adjustments, done
        // declares the task finished by hand — and both fall through to `user` like resume does.
        [`/api/jobs/${JOB_ID}/follow-up`, 'user'],
        [`/api/jobs/${JOB_ID}/done`, 'user'],
        ['/api/jobs/claim', 'worker'],
        [`/api/jobs/${JOB_ID}/heartbeat`, 'worker'],
        [`/api/jobs/${JOB_ID}/session`, 'worker'],
        [`/api/jobs/${JOB_ID}/suspend`, 'worker'],
        [`/api/jobs/${JOB_ID}/complete`, 'worker'],
        [`/api/jobs/${JOB_ID}/output`, 'worker'],
        // Both are the driver's gate machinery — the state reports after each gate runs and the
        // post-sync re-read of `.bellows.yaml`. Missing from this table is what left the last run's
        // gate state unstored: under AUTH_MODE=github both fell through to `user` and answered the
        // worker token 401, while the gates themselves ran and passed unseen.
        [`/api/jobs/${JOB_ID}/gates`, 'worker'],
        [`/api/jobs/${JOB_ID}/gates-reread`, 'worker'],
        ['/api/otlp/v1/logs', 'ingest'],
        ['/api/sessions/branch', 'ingest'],
        // Both fall through to `user` rather than being listed anywhere, which is the point: the
        // default is the safe one, so a new route is walled unless somebody deliberately opens it.
        ['/api/repos', 'user'],
        ['/api/workspace', 'user'],
        ['/api/workspace/repos', 'user'],
    ])('classifies %s as %s', (path, expected) => {
        expect(requirementFor(path)).toBe(expected);
    });
});

describe('with github auth configured', () => {
    it('answers /api/health with no credential at all', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({ method: 'GET', url: '/api/health' });
        expect(response.statusCode).toBe(200);
    });

    it('401s the dashboard for an anonymous caller', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({ method: 'GET', url: '/api/stats?range=all' });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it('401s POST /api/jobs, which is the whole reason this exists', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'rm -rf /' },
        });
        expect(response.statusCode).toBe(401);
    });

    it('lets a signed-in member queue a job', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
            headers: { cookie },
        });

        expect(response.statusCode).toBe(201);
    });

    it('stops honouring a session the moment its membership is removed', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        expect((await server.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).statusCode).toBe(200);

        await store.removeMember(ORG, 'octocat');

        // The next request, not the next fortnight. This immediacy is why sessions are rows.
        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } });
        expect(response.statusCode).toBe(401);
    });

    it('refuses a forged cookie', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const response = await server.inject({
            method: 'GET',
            url: '/api/jobs',
            headers: { cookie: `${SESSION_COOKIE}=made-up.signature` },
        });
        expect(response.statusCode).toBe(401);
    });
});

describe('the two credentials are disjoint', () => {
    it('refuses a session cookie on the claim route', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat', 'admin');
        const cookie = await signedIn(store, caller);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
            headers: { cookie },
        });

        // Even an admin. A member holding a lease is a member able to take work away from the
        // driver that is running it.
        expect(response.statusCode).toBe(401);
    });

    it('accepts a worker token on the claim route', async () => {
        const store = memoryAuthStore();
        store.seedWorkerToken(ORG, 'driver-1', WORKER_TOKEN);
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        expect(response.statusCode).toBe(200);
    });

    it('refuses a worker token on a human route', async () => {
        const store = memoryAuthStore();
        store.seedWorkerToken(ORG, 'driver-1', WORKER_TOKEN);
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // A job queued by a worker token would have no author, silently breaking the audit trail.
        expect(response.statusCode).toBe(401);
    });

    it('refuses a revoked worker token', async () => {
        const store = memoryAuthStore();
        store.seedWorkerToken(ORG, 'driver-1', WORKER_TOKEN);
        const server = await build(githubAuth(), store);
        await store.revokeWorkerToken(ORG, 'driver-1');

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        expect(response.statusCode).toBe(401);
    });

    it('refuses a worker token minted for another organization', async () => {
        const store = memoryAuthStore();
        store.seedWorkerToken('some-other-org', 'driver-1', WORKER_TOKEN);
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        expect(response.statusCode).toBe(401);
    });
});

describe('telemetry ingest', () => {
    it('stays open when no ingest token is configured', async () => {
        // Unset must keep behaving exactly as it did before accounts existed, or every collector
        // and every developer laptop breaks on upgrade with no migration path.
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: { agent: 'claude', sessionId: 'abc', repo: 'a/b', branch: 'dev' },
        });
        expect(response.statusCode).not.toBe(401);
    });

    it('requires the header once a token is configured', async () => {
        const server = await build(githubAuth({ ingestToken: 'ingest-secret' }), memoryAuthStore());

        const without = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: { agent: 'claude', sessionId: 'abc', repo: 'a/b', branch: 'dev' },
        });
        expect(without.statusCode).toBe(401);

        const with_ = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: { agent: 'claude', sessionId: 'abc', repo: 'a/b', branch: 'dev' },
            headers: { 'x-factory-ingest-token': 'ingest-secret' },
        });
        expect(with_.statusCode).not.toBe(401);
    });
});

describe('AUTH_MODE=none', () => {
    it('runs the auth path and attributes requests to the stand-in account', async () => {
        /*
         * The mode still resolves a caller rather than skipping the hook. That is what keeps one
         * code path downstream — and what keeps created_by populated in the environment where the
         * feature is actually developed.
         */
        const store = memoryAuthStore();
        store.seedLocalUser(ORG);
        const server = await build({ mode: 'none', ingestToken: null }, store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
        });

        expect(response.statusCode).toBe(201);
    });

    it('lets a driver claim with no token, because `none` means no credentials at all', async () => {
        /*
         * The two credentials are disjoint when there ARE credentials. Requiring a worker token
         * here would buy nothing — anyone who can reach this port can already queue a command an
         * agent runs — while breaking `npm run driver` against a local board and scripts/
         * test-jobs.sh, which drives the whole lease protocol with no credential at all.
         */
        const store = memoryAuthStore();
        store.seedLocalUser(ORG);
        const server = await build({ mode: 'none', ingestToken: null }, store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
        });

        expect(response.statusCode).toBe(200);
    });
});
