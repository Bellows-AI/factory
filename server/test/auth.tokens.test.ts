import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AuthConfig } from '../src/config.js';
import type { JobStore } from '../src/db/job-store.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { createStatsService } from '../src/stats-service.js';
import type { TelemetryStore } from '../src/telemetry/store.js';
import type { MemoryAuthStore } from './helpers.js';
import { githubAuth, memoryAuthStore, signedIn, stubTelemetryClient, testConfig } from './helpers.js';

const ORG = 'test-org';
const JOB_ID = '11111111-1111-4111-8111-111111111111';

// The prefixes are the wire contract — greppable when leaked — so they are asserted as literals
// here rather than re-imported from the implementation.
const FAT = 'fat_';
const OAT = 'oat_';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

/** Records the author every created job carries — the audit property this whole feature guards. */
const jobStub = (authors: string[]): JobStore =>
    ({
        async create(_command: unknown, createdBy: unknown) {
            authors.push(String(createdBy));
            return { id: JOB_ID };
        },
        async get() {
            return null as Awaited<ReturnType<JobStore['get']>>;
        },
        async thread() {
            return [] as Awaited<ReturnType<JobStore['thread']>>;
        },
        async list() {
            return [] as Awaited<ReturnType<JobStore['list']>>;
        },
    }) as JobStore;

const telemetryStub = (): TelemetryStore => ({
    async insertMetrics() {
        return 0;
    },
    async recordBranch() {},
});

async function build(auth: AuthConfig, store: MemoryAuthStore, authors: string[] = []) {
    const config = testConfig({ auth });
    const repos = staticRepoSource([{ owner: 'Bellows-AI', name: 'bellows.ai' }]);
    const service = createStatsService({ config, repos, telemetry: stubTelemetryClient() });
    app = await buildApp({
        config,
        service,
        repos,
        store: telemetryStub(),
        jobs: jobStub(authors),
        auth: store,
    });
    return app;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('personal access tokens', () => {
    it('acts as its user on the board reads', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const server = await build(githubAuth(), store);

        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });

        expect(response.statusCode).toBe(200);
    });

    it('queues a job with its user as the author', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const authors: string[] = [];
        const server = await build(githubAuth(), store, authors);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
            headers: bearer(token),
        });

        expect(response.statusCode).toBe(201);
        expect(authors).toEqual([caller.user.id]);
    });

    it('is refused once revoked', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const server = await build(githubAuth(), store);
        const [row] = store.accessTokens();
        await store.revokePersonalToken(ORG, caller.user.id, row!.id);

        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });

        expect(response.statusCode).toBe(401);
    });

    it('is refused when minted for another organization', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken('some-other-org', 'personal', { userId: caller.user.id });
        const server = await build(githubAuth(), store);

        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });

        expect(response.statusCode).toBe(401);
    });

    it('dies with the membership', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const server = await build(githubAuth(), store);
        expect((await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) })).statusCode).toBe(200);

        await store.removeMember(ORG, 'octocat');

        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });
        expect(response.statusCode).toBe(401);
    });

    it('wins over a cookie when both arrive', async () => {
        const store = memoryAuthStore();
        const alice = store.seedMember(ORG, 'alice');
        const bob = store.seedMember(ORG, 'bob');
        const cookie = await signedIn(store, alice);
        const token = store.seedAccessToken(ORG, 'personal', { userId: bob.user.id });
        const authors: string[] = [];
        const server = await build(githubAuth(), store, authors);

        // A CLI never sends a cookie and a browser never sends a bearer, so both at once means a
        // proxy is rewriting — the credential that names itself wins.
        const both = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
            headers: { cookie, ...bearer(token) },
        });
        const forgedCookie = await server.inject({
            method: 'GET',
            url: '/api/jobs',
            headers: { cookie: 'factory_session=made-up.signature', ...bearer(token) },
        });

        expect(both.statusCode).toBe(201);
        expect(authors).toEqual([bob.user.id]);
        expect(forgedCookie.statusCode).toBe(200);
        expect(alice.user.id).not.toBe(bob.user.id);
    });

    it('is shown once, stored only as a hash, and never listed', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const server = await build(githubAuth(), store);

        const created = await server.inject({
            method: 'POST',
            url: '/api/tokens',
            payload: { label: 'my laptop' },
            headers: { cookie: await signedIn(store, caller) },
        });
        expect(created.statusCode).toBe(201);
        const { id, token } = created.json() as { id: string; token: string };
        expect(token.startsWith(FAT)).toBe(true);

        // At rest the row holds the sha-256, never the token — it is a bearer credential.
        const [row] = store.accessTokens();
        expect(row!.hashHex).toBe(createHash('sha256').update(token).digest('hex'));
        expect(row!.hashHex).not.toContain(token);
        expect(row!.kind).toBe('personal');
        expect(id).toBe(row!.id);

        const listed = await server.inject({
            method: 'GET',
            url: '/api/tokens',
            headers: { cookie: await signedIn(store, caller) },
        });
        expect(listed.statusCode).toBe(200);
        const body = JSON.stringify(listed.json());
        expect(body).not.toContain(token);
        expect(body).not.toContain('tokenHash');
        expect(body).toContain('my laptop');

        const revoked = await server.inject({
            method: 'POST',
            url: `/api/tokens/${id}/revoke`,
            headers: { cookie: await signedIn(store, caller) },
        });
        expect(revoked.statusCode).toBe(200);
        expect((await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) })).statusCode).toBe(401);
    });

    it('refuses a label that is empty or over the ceiling', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        const server = await build(githubAuth(), store);

        for (const label of ['', '   ', 'x'.repeat(129)]) {
            const response = await server.inject({
                method: 'POST',
                url: '/api/tokens',
                payload: { label },
                headers: { cookie },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json().code).toBe('BAD_LABEL');
        }
    });

    it('lets a member revoke only their own tokens', async () => {
        const store = memoryAuthStore();
        const alice = store.seedMember(ORG, 'alice');
        const bob = store.seedMember(ORG, 'bob');
        store.seedAccessToken(ORG, 'personal', { userId: alice.user.id });
        const [row] = store.accessTokens();
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: `/api/tokens/${row!.id}/revoke`,
            headers: { cookie: await signedIn(store, bob) },
        });

        expect(response.statusCode).toBe(404);
    });
});

describe('organization access tokens', () => {
    it('reaches exactly the allowlisted routes', async () => {
        const store = memoryAuthStore();
        const token = store.seedAccessToken(ORG, 'org');
        const server = await build(githubAuth(), store);

        // One case per ORG_TOKEN_ROUTES entry — the allowlist is the org token's entire authority,
        // and an entry that stops matching (a renamed route, a typo) must fail here, not silently
        // start refusing a legitimate read or admitting one that was never meant.
        const allowed: [string, string, number][] = [
            // The cold cache answers 202 — a fetch-pending poll, not an auth refusal.
            ['GET', '/api/stats?range=all', 202],
            ['POST', '/api/refresh', 202],
            ['GET', '/api/repos', 200],
            ['GET', '/api/jobs', 200],
            // The stub board holds no such job, so the read itself 404s — the point is the wall.
            ['GET', `/api/jobs/${JOB_ID}`, 404],
            ['GET', `/api/jobs/${JOB_ID}/thread`, 200],
        ];
        for (const [method, url, expected] of allowed) {
            const response = await server.inject({ method, url, headers: bearer(token) });
            expect(response.statusCode, `${method} ${url}`).toBe(expected);
        }

        // Off the list — a person route and a management route — is 403, before the route runs.
        const refused: [string, string][] = [
            ['POST', '/api/jobs'],
            ['GET', '/api/tokens'],
        ];
        for (const [method, url] of refused) {
            const response = await server.inject({ method, url, headers: bearer(token) });
            expect(response.statusCode, `${method} ${url}`).toBe(403);
        }
    });

    it('reads the board', async () => {
        const store = memoryAuthStore();
        const token = store.seedAccessToken(ORG, 'org');
        const server = await build(githubAuth(), store);

        // /api/stats answers 202 while the first telemetry fetch is still in flight — that is the
        // cache's cold start, not an auth refusal, so both answers mean "past the wall".
        const stats = await server.inject({ method: 'GET', url: '/api/stats?range=all', headers: bearer(token) });
        expect([200, 202]).toContain(stats.statusCode);
        const jobs = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });
        expect(jobs.statusCode).toBe(200);
    });

    it('cannot queue a job — the author of a job is a person, always', async () => {
        const store = memoryAuthStore();
        const token = store.seedAccessToken(ORG, 'org');
        const authors: string[] = [];
        const server = await build(githubAuth(), store, authors);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
            headers: bearer(token),
        });

        // 403, not 401: the token did authenticate — the org is known — but this route needs a person.
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('FORBIDDEN');
        expect(authors).toEqual([]);
    });

    it('cannot reach the token management routes', async () => {
        const store = memoryAuthStore();
        const token = store.seedAccessToken(ORG, 'org');
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/tokens',
            payload: { label: 'from an org token' },
            headers: bearer(token),
        });

        expect(response.statusCode).toBe(403);
    });

    it('is refused once revoked', async () => {
        const store = memoryAuthStore();
        const token = store.seedAccessToken(ORG, 'org');
        const server = await build(githubAuth(), store);
        const [row] = store.accessTokens();
        await store.revokeOrgToken(ORG, row!.id);

        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });

        expect(response.statusCode).toBe(401);
    });

    it('is minted by an admin only', async () => {
        const store = memoryAuthStore();
        const member = store.seedMember(ORG, 'member');
        const admin = store.seedMember(ORG, 'admin', 'admin');
        const server = await build(githubAuth(), store);

        const refused = await server.inject({
            method: 'POST',
            url: '/api/tokens/org',
            payload: { label: 'ci' },
            headers: { cookie: await signedIn(store, member) },
        });
        expect(refused.statusCode).toBe(403);

        const allowed = await server.inject({
            method: 'POST',
            url: '/api/tokens/org',
            payload: { label: 'ci' },
            headers: { cookie: await signedIn(store, admin) },
        });
        expect(allowed.statusCode).toBe(201);
        expect((allowed.json() as { token: string }).token.startsWith(OAT)).toBe(true);
    });

    it('rejects an unknown or wrong-prefix bearer without falling through to a session', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        const server = await build(githubAuth(), store);

        const unknown = await server.inject({
            method: 'GET',
            url: '/api/jobs',
            headers: bearer(`${FAT}not-a-real-token`),
        });
        expect(unknown.statusCode).toBe(401);

        // An fwt_ bearer names a worker credential; on a person route it must not silently become
        // the cookie-holder's session.
        const workerPrefix = await server.inject({
            method: 'GET',
            url: '/api/jobs',
            headers: { cookie, ...bearer('fwt_something-else') },
        });
        expect(workerPrefix.statusCode).toBe(401);
    });
});

describe('AUTH_MODE=none', () => {
    it('ignores access-token bearers, like every credential in that mode', async () => {
        const store = memoryAuthStore();
        store.seedLocalUser(ORG);
        const server = await build({ mode: 'none', ingestToken: null }, store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
            headers: bearer(`${FAT}meaningless-here`),
        });

        expect(response.statusCode).toBe(201);
    });
});
