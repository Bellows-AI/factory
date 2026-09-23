import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AuthConfig } from '../src/config.js';
import type { JobStore } from '../src/db/job-store-read-model.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { TelemetryStore } from '../src/telemetry/store.js';
import type { MemoryAuthStore } from './helpers.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

const ORG = 'test-org';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

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
    app = await buildApp({
        config,
        orgs: staticRegistry({ config, repos, jobs: jobStub(authors), telemetry: stubTelemetryClient() }),
        store: telemetryStub(),
        auth: store,
    });
    return app;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('personal access tokens: authentication', () => {
    it('acts as its user on the board reads', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const server = await build(githubAuth(), store);

        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });

        expect(response.statusCode).toBe(HTTP_OK);
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

        expect(response.statusCode).toBe(HTTP_CREATED);
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

        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('is refused when minted for another organization', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken('some-other-org', 'personal', { userId: caller.user.id });
        const server = await build(githubAuth(), store);

        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });

        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('dies with the membership', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const server = await build(githubAuth(), store);
        expect((await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) })).statusCode).toBe(
            HTTP_OK
        );

        // Nothing in production deletes a membership except the sign-in propagation — this
        // stands in for GitHub no longer reporting the installation.
        store.removeMembership(ORG, caller.user.id);

        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('personal access tokens: credential precedence and lifecycle', () => {
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

        expect(both.statusCode).toBe(HTTP_CREATED);
        expect(authors).toEqual([bob.user.id]);
        expect(forgedCookie.statusCode).toBe(HTTP_OK);
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
        expect(created.statusCode).toBe(HTTP_CREATED);
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
        expect(listed.statusCode).toBe(HTTP_OK);
        const body = JSON.stringify(listed.json());
        expect(body).not.toContain(token);
        expect(body).not.toContain('tokenHash');
        expect(body).toContain('my laptop');

        const revoked = await server.inject({
            method: 'POST',
            url: `/api/tokens/${id}/revoke`,
            headers: { cookie: await signedIn(store, caller) },
        });
        expect(revoked.statusCode).toBe(HTTP_OK);
        expect((await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) })).statusCode).toBe(
            HTTP_UNAUTHORIZED
        );
    });
});

describe('personal access tokens: label and ownership validation', () => {
    it('refuses a label that is empty or over the ceiling', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        const server = await build(githubAuth(), store);

        const OVER_LABEL_LIMIT = 129;
        for (const label of ['', '   ', 'x'.repeat(OVER_LABEL_LIMIT)]) {
            const response = await server.inject({
                method: 'POST',
                url: '/api/tokens',
                payload: { label },
                headers: { cookie },
            });
            expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
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

        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
    });
});

describe('organization access tokens: allowlist and reads', () => {
    it('reaches exactly the allowlisted routes', async () => {
        const store = memoryAuthStore();
        const token = store.seedAccessToken(ORG, 'org');
        const server = await build(githubAuth(), store);

        // One case per ORG_TOKEN_ROUTES entry — the allowlist is the org token's entire authority,
        // and an entry that stops matching (a renamed route, a typo) must fail here, not silently
        // start refusing a legitimate read or admitting one that was never meant.
        const allowed: [string, string, number][] = [
            // The cold cache answers 202 — a fetch-pending poll, not an auth refusal.
            ['GET', '/api/stats?range=all', HTTP_ACCEPTED],
            ['POST', '/api/refresh', HTTP_ACCEPTED],
            ['GET', '/api/repos', HTTP_OK],
            ['GET', '/api/jobs', HTTP_OK],
            // The stub board holds no such job, so the read itself 404s — the point is the wall.
            ['GET', `/api/jobs/${JOB_ID}`, HTTP_NOT_FOUND],
            ['GET', `/api/jobs/${JOB_ID}/thread`, HTTP_OK],
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
            expect(response.statusCode, `${method} ${url}`).toBe(HTTP_FORBIDDEN);
        }
    });

    it('reads the board', async () => {
        const store = memoryAuthStore();
        const token = store.seedAccessToken(ORG, 'org');
        const server = await build(githubAuth(), store);

        // /api/stats answers 202 while the first telemetry fetch is still in flight — that is the
        // cache's cold start, not an auth refusal, so both answers mean "past the wall".
        const stats = await server.inject({ method: 'GET', url: '/api/stats?range=all', headers: bearer(token) });
        expect([HTTP_OK, HTTP_ACCEPTED]).toContain(stats.statusCode);
        const jobs = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });
        expect(jobs.statusCode).toBe(HTTP_OK);
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
        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
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

        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
    });
});

describe('organization access tokens: lifecycle and validation', () => {
    it('is refused once revoked', async () => {
        const store = memoryAuthStore();
        const token = store.seedAccessToken(ORG, 'org');
        const server = await build(githubAuth(), store);
        const [row] = store.accessTokens();
        await store.revokeOrgToken(ORG, row!.id);

        const response = await server.inject({ method: 'GET', url: '/api/jobs', headers: bearer(token) });

        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('is minted by any member — the roles that gated it retired with the roster (#99)', async () => {
        // Installation access IS membership, and every member is the same trust level: an org
        // token mints, lists and revokes without an admin anywhere in the deployment.
        const store = memoryAuthStore();
        const member = store.seedMember(ORG, 'member');
        const memberCookie = await signedIn(store, member);
        const server = await build(githubAuth(), store);

        const mint = await server.inject({
            method: 'POST',
            url: '/api/tokens/org',
            payload: { label: 'ci' },
            headers: { cookie: memberCookie },
        });
        expect(mint.statusCode).toBe(HTTP_CREATED);
        expect((mint.json() as { token: string }).token.startsWith(OAT)).toBe(true);

        const list = await server.inject({
            method: 'GET',
            url: '/api/tokens/org',
            headers: { cookie: memberCookie },
        });
        expect(list.statusCode).toBe(HTTP_OK);
        expect(list.json()).toMatchObject({ tokens: [{ label: 'ci' }] });

        // Still a real revoke: a member-revoked org token dies like any other.
        const mintedId = (list.json() as { tokens: { id: string }[] }).tokens[0]!.id;
        const revoke = await server.inject({
            method: 'POST',
            url: `/api/tokens/org/${mintedId}/revoke`,
            headers: { cookie: memberCookie },
        });
        expect(revoke.statusCode).toBe(HTTP_OK);
        expect(revoke.json()).toMatchObject({ revoked: true });
    });

    it('validates the revoke id as a uuid', async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        const server = await build(githubAuth(), store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/tokens/not-a-uuid/revoke',
            headers: { cookie },
        });

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_ID');
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
        expect(unknown.statusCode).toBe(HTTP_UNAUTHORIZED);

        // An fwt_ bearer names a worker credential; on a person route it must not silently become
        // the cookie-holder's session.
        const workerPrefix = await server.inject({
            method: 'GET',
            url: '/api/jobs',
            headers: { cookie, ...bearer('fwt_something-else') },
        });
        expect(workerPrefix.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('AUTH_MODE=none', () => {
    it('ignores access-token bearers, like every credential in that mode', async () => {
        const store = memoryAuthStore();
        store.seedLocalUser('default');
        const server = await build({ mode: 'none', ingestToken: null }, store);

        const response = await server.inject({
            method: 'POST',
            url: '/api/jobs',
            payload: { command: 'echo hi' },
            headers: bearer(`${FAT}meaningless-here`),
        });

        expect(response.statusCode).toBe(HTTP_CREATED);
    });
});
