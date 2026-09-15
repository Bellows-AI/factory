import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import type { Caller } from '../src/auth/store.js';
import type { JobStore } from '../src/db/job-store.js';
import type { RepoAccessScope } from '../src/github/access-scope.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { createStatsService } from '../src/stats-service.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryEnvVarStore,
    memoryUserRepoStore,
    signedIn,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const ORG = 'test-org';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const REPOS = [
    { owner: 'Bellows-AI', name: 'bellows.ai' },
    { owner: 'acme', name: 'web' },
];

/**
 * A scope with hand-set answers: the enumeration itself is covered in
 * github.access-scope.test.ts, and these tests are about who the ROUTES consult and what they
 * refuse. A missing entry means "never computed" — the same null the real store answers.
 */
const fixedScope = (sets: Map<string, readonly string[] | null>): RepoAccessScope => ({
    refreshUser: async () => {},
    scopedNames: async (userId) => (sets.has(userId) ? sets.get(userId)! : null),
    roster: async () => new Map(),
});

interface BootOptions {
    /** login → computed set. Omit `scope` entirely to boot unscoped. */
    scope?: Map<string, readonly string[] | null>;
    workspaceRoot?: string | null;
    /** Registers the env routes, backed by a memory store the boot hands back. */
    withEnvVars?: boolean;
}

async function boot({ scope: sets, workspaceRoot = null, withEnvVars = false }: BootOptions = {}) {
    const store = memoryAuthStore();
    // POST /api/jobs is the only jobs route these tests reach, and create() is its whole store
    // surface — the remaining methods are the claim protocol, which worker tokens, not members,
    // arrive at.
    const jobs = { create: async () => ({ id: JOB_ID }) } as unknown as JobStore;
    const config = testConfig({ auth: githubAuth(), workspaceRoot });
    const repos = staticRepoSource(REPOS);
    const service = createStatsService({ config, repos, telemetry: stubTelemetryClient() });
    const envVars = withEnvVars ? memoryEnvVarStore() : undefined;
    app = await buildApp({
        config,
        service,
        repos,
        jobs,
        auth: store,
        scope: sets ? fixedScope(sets) : undefined,
        userRepos: workspaceRoot ? memoryUserRepoStore() : undefined,
        envVars,
    });
    return { app, store, envVars: envVars! };
}

const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

async function member(store: ReturnType<typeof memoryAuthStore>): Promise<{ caller: Caller; cookie: string }> {
    const caller = store.seedMember(ORG, 'octocat');
    return { caller, cookie: await signedIn(store, caller) };
}

describe('GET /api/repos', () => {
    it('narrows the picker to the repos the member can actually reach', async () => {
        const sets = new Map();
        const { app, store } = await boot({ scope: sets });
        const { caller, cookie } = await member(store);
        sets.set(caller.user.id, ['acme/web']);

        const response = await app.inject({ method: 'GET', url: '/api/repos', headers: { cookie } });

        expect(response.statusCode).toBe(200);
        expect(response.json().repos.map((r: { owner: string; name: string }) => `${r.owner}/${r.name}`)).toEqual([
            'acme/web',
        ]);
    });

    it('leaves a member with no computed set on the full installation list', async () => {
        const sets = new Map();
        const { app, store } = await boot({ scope: sets });
        const { cookie } = await member(store);

        const response = await app.inject({ method: 'GET', url: '/api/repos', headers: { cookie } });

        expect(response.json().repos).toHaveLength(REPOS.length);
    });

    it('never scopes an organization token — it names the org, not a person', async () => {
        const sets = new Map();
        const { app, store } = await boot({ scope: sets });
        sets.set('00000000-0000-4000-8000-000000000099', ['acme/web']);
        const token = store.seedAccessToken(ORG, 'org');

        const response = await app.inject({
            method: 'GET',
            url: '/api/repos',
            headers: { authorization: `Bearer ${token}` },
        });

        expect(response.json().repos).toHaveLength(REPOS.length);
    });

    it('is unscoped entirely when no scope is wired', async () => {
        const { app, store } = await boot();
        const { cookie } = await member(store);

        const response = await app.inject({ method: 'GET', url: '/api/repos', headers: { cookie } });

        expect(response.json().repos).toHaveLength(REPOS.length);
    });
});

describe('GET /api/stats', () => {
    it("computes the figures over the member's repos and says so in meta", async () => {
        const sets = new Map();
        const { app, store } = await boot({ scope: sets });
        const { caller, cookie } = await member(store);
        sets.set(caller.user.id, ['acme/web']);

        await app.inject({ method: 'POST', url: '/api/refresh', headers: { cookie } });
        await settle();
        const response = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.meta.repos.map((r: { owner: string; name: string }) => `${r.owner}/${r.name}`)).toEqual([
            'acme/web',
        ]);
        expect(body.meta.telemetry.repoFilter).toEqual(['acme/web']);
        // The fixture's sessions all live on Bellows-AI/bellows.ai, outside this member's set —
        // "reachable but silent" is the honest status for a caller whose subset has no activity,
        // and it is derived from THEIR figures, not the org-wide cache's.
        expect(body.meta.telemetry.status).toBe('empty');
    });

    it('keeps the full installation in meta for a member with no computed set', async () => {
        const sets = new Map();
        const { app, store } = await boot({ scope: sets });
        const { cookie } = await member(store);
        await app.inject({ method: 'POST', url: '/api/refresh', headers: { cookie } });
        await settle();

        const response = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });

        expect(response.json().meta.repos).toHaveLength(REPOS.length);
        expect(response.json().meta.telemetry.status).toBe('ok');
    });
});

describe('POST /api/jobs', () => {
    const create = (app: FastifyInstance, cookie: string, repo?: string) =>
        app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie },
            payload: { command: 'echo hi', ...(repo === undefined ? {} : { repo }) },
        });

    it("refuses a repo outside the member's set", async () => {
        const sets = new Map();
        const { app, store } = await boot({ scope: sets });
        const { caller, cookie } = await member(store);
        sets.set(caller.user.id, ['acme/web']);

        const response = await create(app, cookie, 'Bellows-AI/bellows.ai');

        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('REPO_NOT_ACCESSIBLE');
    });

    it('queues a repo inside the set, and a repo-less command either way', async () => {
        const sets = new Map();
        const { app, store } = await boot({ scope: sets });
        const { caller, cookie } = await member(store);
        sets.set(caller.user.id, ['acme/web']);

        expect((await create(app, cookie, 'acme/web')).statusCode).toBe(201);
        expect((await create(app, cookie)).statusCode).toBe(201);
    });

    it('does not scope a member whose set was never computed', async () => {
        const sets = new Map();
        const { app, store } = await boot({ scope: sets });
        const { cookie } = await member(store);

        expect((await create(app, cookie, 'Bellows-AI/bellows.ai')).statusCode).toBe(201);
    });
});

describe('PUT /api/workspace/repos', () => {
    const root = '/tmp/opencode/factory-scoping-test';

    it("refuses a selection that reaches past the member's set", async () => {
        const sets = new Map();
        const { app, store } = await boot({ scope: sets, workspaceRoot: root });
        const { caller, cookie } = await member(store);
        sets.set(caller.user.id, ['acme/web']);

        const response = await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'Bellows-AI', name: 'bellows.ai' }] },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('REPO_NOT_ACCESSIBLE');
    });

    it('accepts a selection inside the set', async () => {
        const sets = new Map();
        const { app, store } = await boot({ scope: sets, workspaceRoot: root });
        const { caller, cookie } = await member(store);
        sets.set(caller.user.id, ['acme/web']);

        const response = await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });

        expect(response.statusCode).toBe(202);
    });
});

describe('GET /api/env', () => {
    it("filters the repo scope list to the caller's set", async () => {
        const sets = new Map();
        const { app, store, envVars } = await boot({ scope: sets, withEnvVars: true });
        const { caller, cookie } = await member(store);
        sets.set(caller.user.id, ['acme/web']);
        await envVars.replaceRepo('acme', 'web', [{ name: 'MODEL', value: 'x', isSecret: false }]);
        await envVars.replaceRepo('Bellows-AI', 'bellows.ai', [{ name: 'MODEL', value: 'y', isSecret: false }]);

        const response = await app.inject({ method: 'GET', url: '/api/env', headers: { cookie } });

        expect(response.statusCode).toBe(200);
        expect(response.json().repos.map((r: { owner: string; name: string }) => `${r.owner}/${r.name}`)).toEqual([
            'acme/web',
        ]);
    });
});

describe('AUTH_MODE=none', () => {
    it('stays unscoped even with a scope wired — there is no caller to scope', async () => {
        // The open mode is the offline tooling's posture: nothing fetches, so nothing can enumerate
        // per-user access, and a scoping wall with no accounts behind it would only lie.
        const config = testConfig();
        const repos = staticRepoSource(REPOS);
        const service = createStatsService({ config, repos, telemetry: stubTelemetryClient() });
        app = await buildApp({ config, service, repos, scope: fixedScope(new Map()) });

        const response = await app.inject({ method: 'GET', url: '/api/repos' });

        expect(response.json().repos).toHaveLength(REPOS.length);
    });
});
