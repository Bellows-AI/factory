import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createStatsService } from '../src/stats-service.js';
import type { RepoSource } from '../src/github/repo-source.js';
import {
    githubAuth,
    harness,
    memoryAuthStore,
    memoryEnvVarStore,
    signedIn,
    stubClient,
    stubTelemetryClient,
    testConfig,
    type MemoryEnvVarStore,
} from './helpers.js';

/**
 * Offline: the routes against the in-memory double, the way routes.workspace.test.ts runs. The SQL
 * behind the store — the keep-a-null-secret rule, the stacking itself — is covered by
 * server/test-db/env-var-store.test.ts, which needs a container.
 */

const REPOS = [
    { owner: 'acme', name: 'web' },
    { owner: 'acme', name: 'api' },
];

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

async function boot(options: { envVars?: MemoryEnvVarStore } = {}) {
    const auth = memoryAuthStore();
    // The stand-in admin writes core and repository env; a plain member may write only their own.
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const envVars = options.envVars ?? memoryEnvVarStore();
    const h = await harness({
        client: stubClient(),
        auth,
        envVars,
        repos: REPOS,
        config: { auth: githubAuth() },
    });
    app = h.app;
    return {
        app: h.app,
        admin,
        member,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
        envVars,
    };
}

describe('GET /api/env', () => {
    it('needs a session', async () => {
        const { app } = await boot();
        expect((await app.inject({ method: 'GET', url: '/api/env' })).statusCode).toBe(401);
    });

    it('answers the three scopes, with every secret value nulled', async () => {
        const { app, admin, adminCookie, envVars } = await boot();
        await envVars.replaceOrg([{ name: 'CORE_SECRET', value: 's3cr3t', isSecret: true }]);
        await envVars.replaceWorkspace(admin.user.id, [
            { name: 'MINE', value: 'visible', isSecret: false },
        ]);
        await envVars.replaceRepo('acme', 'web', [{ name: 'REPO_SECRET', value: 'r', isSecret: true }]);

        const response = await app.inject({ method: 'GET', url: '/api/env', headers: { cookie: adminCookie } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            org: [{ name: 'CORE_SECRET', value: null, isSecret: true, updatedAt: expect.any(String) }],
            workspace: [{ name: 'MINE', value: 'visible', isSecret: false, updatedAt: expect.any(String) }],
            repos: [
                {
                    owner: 'acme',
                    name: 'web',
                    vars: [{ name: 'REPO_SECRET', value: null, isSecret: true, updatedAt: expect.any(String) }],
                },
            ],
        });
    });

    it('answers empty scopes, still 200, when nothing is configured', async () => {
        const { app, adminCookie } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/env', headers: { cookie: adminCookie } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ org: [], workspace: [], repos: [] });
    });
});

describe('PUT /api/env/workspace', () => {
    it('replaces the whole list, so replaying the body changes nothing', async () => {
        const { app, member, memberCookie } = await boot();
        const payload = { vars: [{ name: 'FIRST', value: '1', isSecret: false }] };
        expect(
            (await app.inject({ method: 'PUT', url: '/api/env/workspace', headers: { cookie: memberCookie }, payload })).statusCode,
        ).toBe(200);
        await app.inject({
            method: 'PUT',
            url: '/api/env/workspace',
            headers: { cookie: memberCookie },
            payload: { vars: [{ name: 'SECOND', value: '2', isSecret: false }] },
        });

        const rows = await app
            .inject({ method: 'GET', url: '/api/env', headers: { cookie: memberCookie } })
            .then((r) => r.json().workspace);
        expect(rows.map((row: { name: string }) => row.name)).toEqual(['SECOND']);
        expect(member.user.id).toBeTruthy();
    });

    it('keeps a secret whose value comes back null, and deletes an omitted one', async () => {
        const { app, memberCookie } = await boot();
        await app.inject({
            method: 'PUT',
            url: '/api/env/workspace',
            headers: { cookie: memberCookie },
            payload: {
                vars: [
                    { name: 'SECRET_A', value: 'a', isSecret: true },
                    { name: 'SECRET_B', value: 'b', isSecret: true },
                ],
            },
        });
        // SECRET_B omitted — gone. SECRET_A echoed with a null value — kept verbatim.
        await app.inject({
            method: 'PUT',
            url: '/api/env/workspace',
            headers: { cookie: memberCookie },
            payload: { vars: [{ name: 'SECRET_A', value: null, isSecret: true }] },
        });

        const rows = await app
            .inject({ method: 'GET', url: '/api/env', headers: { cookie: memberCookie } })
            .then((r) => r.json().workspace);
        expect(rows.map((row: { name: string }) => row.name)).toEqual(['SECRET_A']);
    });

    it('needs a session', async () => {
        const { app } = await boot();
        expect(
            (await app.inject({ method: 'PUT', url: '/api/env/workspace', payload: { vars: [] } })).statusCode,
        ).toBe(401);
    });
});

describe('PUT /api/env/org and /api/env/repo', () => {
    it('refuses a member and accepts an admin', async () => {
        const { app, memberCookie, adminCookie } = await boot();
        const memberPut = await app.inject({
            method: 'PUT',
            url: '/api/env/org',
            headers: { cookie: memberCookie },
            payload: { vars: [{ name: 'CORE', value: '1', isSecret: false }] },
        });
        expect(memberPut.statusCode).toBe(403);

        const adminPut = await app.inject({
            method: 'PUT',
            url: '/api/env/org',
            headers: { cookie: adminCookie },
            payload: { vars: [{ name: 'CORE', value: '1', isSecret: false }] },
        });
        expect(adminPut.statusCode).toBe(200);
    });

    it('refuses a member and accepts an admin for a repository scope too', async () => {
        const { app, memberCookie, adminCookie } = await boot();
        const memberPut = await app.inject({
            method: 'PUT',
            url: '/api/env/repo',
            headers: { cookie: memberCookie },
            payload: { repo: { owner: 'acme', name: 'web' }, vars: [{ name: 'R', value: '1', isSecret: false }] },
        });
        expect(memberPut.statusCode).toBe(403);

        const adminPut = await app.inject({
            method: 'PUT',
            url: '/api/env/repo',
            headers: { cookie: adminCookie },
            payload: { repo: { owner: 'acme', name: 'web' }, vars: [{ name: 'R', value: '1', isSecret: false }] },
        });
        expect(adminPut.statusCode).toBe(200);
    });

    it('refuses a repository outside the installation', async () => {
        const { app, adminCookie } = await boot();
        const response = await app.inject({
            method: 'PUT',
            url: '/api/env/repo',
            headers: { cookie: adminCookie },
            payload: { repo: { owner: 'acme', name: 'not-installed' }, vars: [] },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('UNKNOWN_REPO');
    });

    it('answers 503 when the installation cannot be asked', async () => {
        // The harness's static repo source never fails, so this case boots its own app with a
        // source that reports the empty-list-with-an-error state — the same bargain the repos
        // route makes: refused, never waved through.
        const auth = memoryAuthStore();
        const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
        const unreachable: RepoSource = {
            snapshot: () => [],
            snapshotNames: () => [],
            list: async () => [],
            detail: async () => ({ repos: [], installation: null }),
            lastError: () => 'github is down',
            fetchedAt: () => null,
        };
        const config = testConfig({ auth: githubAuth() });
        const service = createStatsService({
            config,
            client: stubClient(),
            telemetry: stubTelemetryClient(),
        });
        const instance = await buildApp({
            config,
            service,
            repos: unreachable,
            envVars: memoryEnvVarStore(),
            auth,
        });
        app = instance;

        const response = await instance.inject({
            method: 'PUT',
            url: '/api/env/repo',
            headers: { cookie: await signedIn(auth, admin) },
            payload: { repo: { owner: 'acme', name: 'web' }, vars: [] },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });
});

describe('env var validation', () => {
    it.each([
        ['a bad name', { vars: [{ name: 'not a name', value: '1', isSecret: false }] }, 'BAD_ENV_NAME'],
        [
            'a reserved name',
            { vars: [{ name: 'WORKDIR', value: '/etc', isSecret: false }] },
            'RESERVED_ENV_NAME',
        ],
        [
            'the gate credential the driver mints per run',
            { vars: [{ name: 'BELLOWS_GATE_TOKEN', value: 'spoof', isSecret: true }] },
            'RESERVED_ENV_NAME',
        ],
        [
            'the gate endpoint the driver advertises per run',
            { vars: [{ name: 'BELLOWS_GATE_URL', value: 'http://attacker', isSecret: false }] },
            'RESERVED_ENV_NAME',
        ],
        [
            'the credential-helper code the driver passes the fetch',
            { vars: [{ name: 'CRED_HELPER', value: '!evil', isSecret: false }] },
            'RESERVED_ENV_NAME',
        ],
        [
            'the sync restore-mode switch',
            { vars: [{ name: 'RESTORE', value: '1', isSecret: false }] },
            'RESERVED_ENV_NAME',
        ],
        [
            'the stats url the branch reporter posts to',
            { vars: [{ name: 'FACTORY_STATS_URL', value: 'http://attacker', isSecret: false }] },
            'RESERVED_ENV_NAME',
        ],
        [
            'the ingest token the branch reporter authenticates with',
            { vars: [{ name: 'INGEST_TOKEN', value: 'spoof', isSecret: true }] },
            'RESERVED_ENV_NAME',
        ],
        [
            'the session id the branch reporter claims',
            { vars: [{ name: 'BELLOWS_SESSION_ID', value: 'spoof', isSecret: false }] },
            'RESERVED_ENV_NAME',
        ],
        [
            'a null value on a non-secret',
            { vars: [{ name: 'PLAIN', value: null, isSecret: false }] },
            'BAD_VALUE',
        ],
        [
            'a value with a newline',
            { vars: [{ name: 'MULTI', value: 'line1\nline2', isSecret: false }] },
            'BAD_ENV_VALUE',
        ],
        [
            'an oversized name',
            { vars: [{ name: 'X'.repeat(256), value: '1', isSecret: false }] },
            'BAD_ENV_NAME',
        ],
        [
            'a duplicated name',
            {
                vars: [
                    { name: 'DUP', value: '1', isSecret: false },
                    { name: 'DUP', value: '2', isSecret: false },
                ],
            },
            'ENV_NAME_CONFLICT',
        ],
    ])('refuses %s with 400', async (_label, payload, code) => {
        const { app, memberCookie } = await boot();
        const response = await app.inject({
            method: 'PUT',
            url: '/api/env/workspace',
            headers: { cookie: memberCookie },
            payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
    });

    it('refuses a list past the ceiling', async () => {
        const { app, memberCookie } = await boot();
        const vars = Array.from({ length: 101 }, (_, i) => ({ name: `V_${i}`, value: '1', isSecret: false }));
        const response = await app.inject({
            method: 'PUT',
            url: '/api/env/workspace',
            headers: { cookie: memberCookie },
            payload: { vars },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('TOO_MANY_ENV_VARS');
    });

    it('refuses a body that is not a vars array', async () => {
        const { app, memberCookie } = await boot();
        const response = await app.inject({
            method: 'PUT',
            url: '/api/env/workspace',
            headers: { cookie: memberCookie },
            payload: { vars: 'nope' },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_BODY');
    });
});

describe('a broken store', () => {
    it('answers 503 through guard, leaking nothing', async () => {
        const broken = memoryEnvVarStore();
        broken.broken = true;
        const { app, memberCookie } = await boot({ envVars: broken });
        const response = await app.inject({
            method: 'PUT',
            url: '/api/env/workspace',
            headers: { cookie: memberCookie },
            payload: { vars: [{ name: 'X', value: '1', isSecret: false }] },
        });
        expect(response.statusCode).toBe(503);
    });
});
