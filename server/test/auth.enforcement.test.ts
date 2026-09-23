import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { requirementFor } from '../src/auth/plugin.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import type { AuthConfig } from '../src/config.js';
import type { Claim, Job } from '../src/db/job-store-types.js';
import type { JobStore } from '../src/db/job-store-types.js';
import type { TelemetryStore } from '../src/telemetry/store.js';
import type { AppDeps } from '../src/app.js';
import type { MemoryAuthStore } from './helpers.js';
import {
    githubAuth,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
    TEST_JOB_BOARD_TOKEN,
} from './helpers.js';

const ORG = 'test-org';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const WORKER_TOKEN = TEST_JOB_BOARD_TOKEN;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_ACCEPTED = 202;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

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
            return { result: 'ok', status: 'standby' };
        },
        async complete() {
            return 'ok';
        },
        async get() {
            return null as Job | null;
        },
        async thread() {
            return [] as Job[];
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

async function build(
    auth: AuthConfig,
    store: MemoryAuthStore,
    orgOfLease?: AppDeps['orgOfLease'],
    // When set, the registry answers null for every org id outside it — the production shape,
    // where an org that does not exist resolves to nothing.
    orgsFor?: readonly string[]
) {
    const config = testConfig({ auth });
    app = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs: jobStub(), telemetry: stubTelemetryClient(), orgsFor }),
        store: telemetryStub(),
        auth: store,
        // The attempt-scoped pair the runner's branch reporter presents. Default: the one live
        // attempt the constants below describe; a test passes its own to model a lost lease.
        orgOfLease:
            orgOfLease ?? (async (jobId, leaseToken) => (jobId === JOB_ID && leaseToken === LEASE ? ORG : null)),
        // The worker routes' org resolvers: the one job the constants describe, nothing else.
        orgOfJob: async (jobId) => (jobId === JOB_ID ? ORG : null),
        orgOfReclaim: async (reclaimId) => (reclaimId === JOB_ID ? ORG : null),
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
        // The installation webhook answers to the HMAC signature over its body — a credential the
        // route verifies itself — so the session hook must not demand a cookie of it.
        ['/api/github/webhook', 'open'],
        ['/api/auth/github/callback', 'open'],
        // The onboarding screen's read and write (#125): the pending cookie IS the credential
        // here — these run before any session exists, which is the whole point of the step.
        ['/api/auth/github/pending', 'open'],
        ['/api/auth/github/pending/installations/123/repos', 'open'],
        ['/api/auth/github/complete', 'open'],
        ['/api/auth/me', 'open'],
        ['/', 'open'],
        ['/index.html', 'open'],
        ['/assets/app-1234.js', 'open'],
        // A client-side route, and the reason it is here is that it fails ONLY in production: Vite
        // has its own history fallback in dev, so a wall on this path would be invisible until the
        // baked image served it. The not-found handler in app.ts sends index.html for it, and the
        // wall is on /api/* rather than on the document — see docs/auth.md.
        ['/settings/workspace', 'open'],
        ['/api/stats', 'user'],
        ['/api/refresh', 'user'],
        ['/api/jobs', 'user'],
        // The task read model (#157): a person's inbox view over the same board. It falls through
        // to `user` by the safe default rather than being listed anywhere — pinned here because a
        // worker token reading every task summary of the board would be the thread-read hole
        // again, one level up.
        ['/api/tasks', 'user'],
        [`/api/jobs/${JOB_ID}`, 'user'],
        // Both are person's actions on a finished task — a follow-up asks for adjustments, done
        // declares the task finished by hand — and both fall through to `user`.
        [`/api/jobs/${JOB_ID}/follow-up`, 'user'],
        [`/api/jobs/${JOB_ID}/done`, 'user'],
        // Stop and remove are person's actions too. The driver is told to stop through the
        // heartbeat it already holds, never through a stop route of its own; and a worker token
        // removing the audit rows of jobs it never held would be the thread-read hole (#47) again.
        [`/api/jobs/${JOB_ID}/stop`, 'user'],
        [`/api/jobs/${JOB_ID}/remove`, 'user'],
        ['/api/jobs/claim', 'worker'],
        // The worktree-reclaim queue POST /remove feeds: the driver polls it and acks each
        // reclaim, so both ends are as worker-only as claim and complete.
        ['/api/reclaims/claim', 'worker'],
        [`/api/reclaims/${JOB_ID}/ack`, 'worker'],
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
        // The publish credential ask is the driver's too — the loop calls it right before the
        // push. Missing from this table is what made it answer the worker token 401 in
        // production while the fix looked deployed (jobs 9bf1002a, 4bcfe8be and b0ac2284,
        // 2026-09-14): the silent null sent every long run to the push with its expired
        // claim-time token, and only runs under an hour published.
        [`/api/jobs/${JOB_ID}/publish-token`, 'worker'],
        // The thread read is a person's again: it carries commands, output and session ids of the
        // WHOLE thread, and a worker token on it could read the audit trail of jobs it never held.
        // The driver's one use for it (the worktree-reclaim terminality, issue #47) rides the
        // lease-guarded complete response as `threadDone` instead.
        [`/api/jobs/${JOB_ID}/thread`, 'user'],
        ['/api/otlp/v1/logs', 'ingest'],
        // The branch write stopped being an ingest-token route on purpose (CWE-862): the report's
        // repo must never choose the org it lands in, so the credential does. Its own requirement,
        // between worker and ingest — the pair is the attempt's, the bearer a member's.
        ['/api/sessions/branch', 'branch'],
        // Both fall through to `user` rather than being listed anywhere, which is the point: the
        // default is the safe one, so a new route is walled unless somebody deliberately opens it.
        ['/api/repos', 'user'],
        ['/api/workspace', 'user'],
        ['/api/workspace/repos', 'user'],
        // Access-token management: a person's settings act, so session cookie or personal bearer —
        // never a worker token, and an org token is 403'd by the hook (not on its allowlist).
        ['/api/tokens', 'user'],
        ['/api/tokens/org', 'user'],
        [`/api/tokens/${JOB_ID}/revoke`, 'user'],
    ])('classifies %s as %s', (path, expected) => {
        expect(requirementFor(path)).toBe(expected);
    });
});

describe('with github auth configured', () => {
    it('answers /api/health with no credential at all', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({ method: 'GET', url: '/api/health' });
        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('401s the dashboard for an anonymous caller', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({ method: 'GET', url: '/api/stats?range=all' });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it('401s POST /api/jobs, which is the whole reason this exists', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'rm -rf /' },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
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

        expect(response.statusCode).toBe(HTTP_CREATED);
    });

    it('stops honouring a session the moment its membership is removed', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        expect((await server.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } })).statusCode).toBe(
            HTTP_OK
        );

        // Nothing in production deletes a membership except the sign-in propagation (GitHub no
        // longer reporting an installation) — which is exactly what this stands in for.
        store.removeMembership(ORG, caller.user.id);

        // The next request, not the next fortnight. This immediacy is why sessions are rows.
        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('refuses a forged cookie', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const response = await server.inject({
            method: 'GET',
            url: '/api/jobs',
            headers: { cookie: `${SESSION_COOKIE}=made-up.signature` },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('the two credentials are disjoint: claim and job-scoped routes', () => {
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
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('accepts the shared board secret on the claim route', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // No org binding and no token row: the secret IS the driver credential, and the claim is
        // offered every org's queue.
        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('resolves a job-scoped worker call from the row its URL names', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: `/api/jobs/${JOB_ID}/heartbeat`,
            payload: { leaseToken: LEASE },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('404s a job-scoped worker call whose job does not exist', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/99999999-9999-4999-8999-999999999999/heartbeat',
            payload: { leaseToken: LEASE },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // Authenticated (the secret matched) but routed nowhere: the org read from the row is
        // the only honest answer, and there is no row.
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('404s a job-scoped worker call whose id is not a uuid', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store, undefined, [ORG]);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/not-a-uuid/heartbeat',
            payload: { leaseToken: LEASE },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // A malformed id names no row either. Letting it through with a null org hands the
        // route's storeOf() an org that does not exist, and the driver reads a 503
        // JOBS_UNAVAILABLE where the route's own id validation should have spoken.
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });

    it('404s a reclaim ack whose id is not a uuid', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store, undefined, [ORG]);

        const response = await server.inject({
            method: 'POST',
            url: '/api/reclaims/not-a-uuid/ack',
            payload: { worker: 'driver-1' },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });
});

describe('the two credentials are disjoint: cross-credential refusals', () => {
    it('refuses the worker secret on a human route', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // A job queued by the driver would have no author, silently breaking the audit trail.
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('keeps the thread read session-only, in both directions', async () => {
        // The SPA renders the task detail page with a session cookie — that has to keep working.
        const sessionStore = memoryAuthStore();
        const sessionServer = await build(githubAuth(), sessionStore);
        const caller = sessionStore.seedMember(ORG, 'octocat');
        const cookie = await signedIn(sessionStore, caller);
        expect(
            (
                await sessionServer.inject({
                    method: 'GET',
                    url: `/api/jobs/${JOB_ID}/thread`,
                    headers: { cookie },
                })
            ).statusCode
        ).toBe(HTTP_OK);

        // The worker secret on the full thread read would let the driver read commands, output
        // and session ids of jobs it never held a lease on — the thread is audit data, and the
        // driver's only need from it (the reclaim terminality) rides the complete response.
        const tokenServer = await build(githubAuth(), memoryAuthStore());
        expect(
            (
                await tokenServer.inject({
                    method: 'GET',
                    url: `/api/jobs/${JOB_ID}/thread`,
                    headers: { authorization: `Bearer ${WORKER_TOKEN}` },
                })
            ).statusCode
        ).toBe(HTTP_UNAUTHORIZED);
    });

    it("refuses the worker secret on the single-job read, which stays a person's", async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'GET',
            url: `/api/jobs/${JOB_ID}`,
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });

        // The job row — command, output, verdict — is a person's view of their audit trail; a
        // worker secret reaching it would make a member's session no stronger than any leaked one.
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('refuses a wrong secret', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
            headers: { authorization: 'Bearer fwt_a-token-from-another-deployment' },
        });

        // There is no row to be revoked: the secret simply matches or it does not. A deployment
        // rotates by changing the value on both sides.
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('telemetry ingest', () => {
    it('stays open when no ingest token is configured', async () => {
        // Unset must keep behaving exactly as it did before accounts existed, or every collector
        // and every developer laptop breaks on upgrade with no migration path.
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: 'POST',
            url: '/api/otlp/v1/logs',
            payload: { resourceLogs: [] },
        });
        expect(response.statusCode).not.toBe(HTTP_UNAUTHORIZED);
    });

    it('requires the header once a token is configured', async () => {
        const server = await build(githubAuth({ ingestToken: 'ingest-secret' }), memoryAuthStore());

        const without = await server.inject({
            method: 'POST',
            url: '/api/otlp/v1/logs',
            payload: { resourceLogs: [] },
        });
        expect(without.statusCode).toBe(HTTP_UNAUTHORIZED);

        const with_ = await server.inject({
            method: 'POST',
            url: '/api/otlp/v1/logs',
            payload: { resourceLogs: [] },
            headers: { 'x-factory-ingest-token': 'ingest-secret' },
        });
        expect(with_.statusCode).not.toBe(HTTP_UNAUTHORIZED);

        // The OTLP routes are the ONLY thing the ingest token still reaches. It is a deployment
        // -wide authenticity check for machine exports, never an org binding — which is exactly
        // why it must not authorize a branch write (see the branch describe below).
        const branch = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: { agent: 'claude', sessionId: 'abc', repo: 'a/b', branch: 'dev' },
            headers: { 'x-factory-ingest-token': 'ingest-secret' },
        });
        expect(branch.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('the branch route needs an org-bound credential in github mode', () => {
    const report = { agent: 'claude', sessionId: 'abc', repo: 'a/b', branch: 'dev', at: '2026-08-21T10:40:00Z' };

    // The runner's reporter presents the attempt it runs for — the job it claimed and that
    // attempt's lease token — and the server's verifier answers the org the pair belongs to.
    // A failed pair is a 401 with no fall-through: a caller presenting a credential that does
    // not resolve must not be able to ride a weaker one standing behind it, the same rule a
    // failed bearer gets on the person routes.
    it('resolves the org from the attempt’s job id + lease token pair', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: report,
            headers: { 'x-factory-job-id': JOB_ID, 'x-factory-job-lease-token': LEASE },
        });
        expect(response.statusCode).toBe(HTTP_ACCEPTED);
    });

    it('401s a pair that does not resolve, even with a bearer behind it', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const response = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: report,
            headers: {
                'x-factory-job-id': JOB_ID,
                'x-factory-job-lease-token': '99999999-9999-4999-8999-999999999999',
                authorization: `Bearer ${token}`,
            },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it('401s a missing pair', async () => {
        const server = await build(githubAuth(), memoryAuthStore());
        const response = await server.inject({ method: 'POST', url: '/api/sessions/branch', payload: report });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('accepts a personal access token — the laptop plugin’s credential', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const response = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: report,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(HTTP_ACCEPTED);
    });

    // 403, not 401, and deliberately so: the oat_ DID authenticate — findOrgToken resolved it —
    // and the refusal is the route needing a human-or-lease credential behind it, the exact
    // shape orgTokenAllowed already answers with on the person routes. org tokens are a
    // read-only allowlist; branch ingest is a write.
    it('403s an organization token — the read-only allowlist must not reach a write', async () => {
        const store = memoryAuthStore();
        const server = await build(githubAuth(), store);
        const token = store.seedAccessToken(ORG, 'org');
        const response = await server.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            payload: report,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
        expect(response.json().code).toBe('FORBIDDEN');
    });

    it('stays open in none mode, like every other route in it', async () => {
        const store = memoryAuthStore();
        store.seedLocalUser('default');
        const server = await build({ mode: 'none', ingestToken: null }, store, async () => {
            throw new Error('none mode must not consult the lease');
        });
        const response = await server.inject({ method: 'POST', url: '/api/sessions/branch', payload: report });
        expect(response.statusCode).toBe(HTTP_ACCEPTED);
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
        store.seedLocalUser('default');
        const server = await build({ mode: 'none', ingestToken: null }, store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
        });

        expect(response.statusCode).toBe(HTTP_CREATED);
    });

    it('lets a driver claim with no token, because `none` means no credentials at all', async () => {
        /*
         * The two credentials are disjoint when there ARE credentials. Requiring a worker token
         * here would buy nothing — anyone who can reach this port can already queue a command an
         * agent runs — while breaking `npm run driver` against a local board and scripts/
         * test-jobs.sh, which drives the whole lease protocol with no credential at all.
         */
        const store = memoryAuthStore();
        store.seedLocalUser('default');
        const server = await build({ mode: 'none', ingestToken: null }, store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs/claim',
            payload: { worker: 'driver-1' },
        });

        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('reports the stand-in account from /api/auth/me, with nothing pretending to be GitHub data', async () => {
        /*
         * The settings page renders this caller. Its login is unrepresentable as a real GitHub
         * login and its numeric id is 0, a value GitHub never issues — so the payload must carry
         * the facts as they are and let the page decide what a stand-in looks like, rather than
         * the server inventing a displayable identity.
         */
        const store = memoryAuthStore();
        store.seedLocalUser('default');
        const server = await build({ mode: 'none', ingestToken: null }, store);

        const response = await server.inject({ method: 'GET', url: '/api/auth/me' });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toMatchObject({
            user: { login: '__local__', githubUserId: 0, avatarUrl: null },
            role: 'admin',
            mode: 'none',
            workspacePath: null,
        });
    });

    it('reports the member workspace path once a root is configured, without creating anything', async () => {
        const store = memoryAuthStore();
        store.seedLocalUser('default');
        const config = testConfig({
            auth: { mode: 'none', ingestToken: null },
            workspaceRoot: '/tmp/factory-settings-test',
        });
        const server = await buildApp({
            config,
            orgs: staticRegistry({ config, jobs: jobStub(), telemetry: stubTelemetryClient() }),
            store: telemetryStub(),
            auth: store,
        });
        app = server;

        const response = await server.inject({ method: 'GET', url: '/api/auth/me' });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().workspacePath).toBe(
            '/tmp/factory-settings-test/default/00000000-0000-4000-8000-000000000000'
        );
        // Read-only display: computing a path must not provision a directory. That is
        // GET /api/workspace's job, and it is idempotent there.
        expect(existsSync('/tmp/factory-settings-test')).toBe(false);
    });
});
