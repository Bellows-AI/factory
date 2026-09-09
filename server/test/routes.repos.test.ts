import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { GitHubAppClient, InstallationListing } from '../src/github/app-client.js';
import { createRepoSource } from '../src/github/repo-source.js';
import { createStatsService } from '../src/stats-service.js';
import { memoryPrStore, stubClient, stubTelemetryClient, testConfig } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

function listing(overrides: Partial<InstallationListing> = {}): InstallationListing {
    return {
        repos: [
            { owner: 'acme', name: 'web', private: true, defaultBranch: 'main', pushedAt: '2026-08-20T00:00:00.000Z' },
            { owner: 'acme', name: 'api', private: false, defaultBranch: 'dev', pushedAt: null },
        ],
        installation: { id: '4242', account: 'acme', repositorySelection: 'selected' },
        ...overrides,
    };
}

/** An App client with no fetch behind it, so the suite stays offline. */
function stubAppClient(behaviour: () => Promise<InstallationListing>): GitHubAppClient {
    return { listRepositories: behaviour };
}

async function boot(client?: GitHubAppClient) {
    const config = testConfig();
    const repos = createRepoSource({ client });
    const service = createStatsService({
        config,
        client: stubClient(),
        repos,
        telemetry: stubTelemetryClient(),
        store: memoryPrStore(),
    });
    app = await buildApp({ config, service, repos });
    return { app, repos };
}

describe('GET /api/repos', () => {
    it('reports what the installation can see', async () => {
        const { app } = await boot(stubAppClient(async () => listing()));
        const response = await app.inject({ method: 'GET', url: '/api/repos' });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.repos).toEqual([
            { owner: 'acme', name: 'web', private: true, defaultBranch: 'main', pushedAt: '2026-08-20T00:00:00.000Z' },
            { owner: 'acme', name: 'api', private: false, defaultBranch: 'dev', pushedAt: null },
        ]);
        expect(body.installation).toEqual({ id: '4242', account: 'acme', repositorySelection: 'selected' });
        expect(body.meta.error).toBeNull();
    });

    it('answers 200 with an empty list when no App client was built', async () => {
        // The code-only `none` arm. Not a 503: "nothing is installed" is a real state the picker
        // renders a different thing for, and a route that errors here would make the whole page
        // unreachable on a process that deliberately fetches nothing.
        const { app } = await boot(undefined);
        const response = await app.inject({ method: 'GET', url: '/api/repos' });

        expect(response.statusCode).toBe(200);
        expect(response.json().repos).toEqual([]);
        expect(response.json().meta.error).toBeNull();
    });

    it('serves the last good list with a named error when a refresh fails', async () => {
        // Same rule /api/stats follows. An empty picker and an unreachable GitHub look identical
        // otherwise, and only one of them is somebody's fault.
        let fail = false;
        const client = stubAppClient(async () => {
            if (fail) throw new Error('connect ECONNREFUSED');
            return listing();
        });
        const { app, repos } = await boot(client);

        await app.inject({ method: 'GET', url: '/api/repos' });
        fail = true;
        // Past the ten-minute list TTL, so the next read actually attempts a refresh.
        const stale = createRepoSource({ client, ttlMs: 0 });
        await stale.list().catch(() => {});

        expect(repos.snapshot()).toHaveLength(2);
    });

    it('names the failure rather than reporting an empty installation', async () => {
        const repos = createRepoSource({ client: stubAppClient(async () => { throw new Error('boom'); }) });
        await repos.list();
        expect(repos.lastError()).toMatch(/boom/);
        expect(repos.snapshot()).toEqual([]);
    });
});

describe('the repo source', () => {
    it('falls back to the repos already stored when there is no App client', async () => {
        // What keeps a seeded database browsable with no credential: every stored read is scoped BY
        // the repo list, so without an answer a warm database renders as an empty dashboard.
        const repos = createRepoSource({ stored: async () => ['acme/web', 'other-owner/api'] });
        await expect(repos.list()).resolves.toEqual([
            { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
            { owner: 'other-owner', name: 'api', private: false, defaultBranch: null, pushedAt: null },
        ]);
        expect(repos.snapshotNames()).toEqual(['acme/web', 'other-owner/api']);
    });

    it('never blocks in snapshot(), because current() is synchronous by design', async () => {
        const repos = createRepoSource({ stored: async () => ['acme/web'] });
        // Empty until something has loaded one. current() aggregates an already-fetched payload
        // over a date range and must never become a fetch.
        expect(repos.snapshot()).toEqual([]);
        await repos.list();
        expect(repos.snapshot()).toHaveLength(1);
    });

    it('skips a stored name that is not owner/name rather than building a bad path', async () => {
        const repos = createRepoSource({ stored: async () => ['acme/web', 'nameless', 'trailing/'] });
        await expect(repos.list()).resolves.toEqual([
            { owner: 'acme', name: 'web', private: false, defaultBranch: null, pushedAt: null },
        ]);
    });
});
