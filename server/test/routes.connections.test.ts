import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ConnectionStore, ConnectionView, NewConnection } from '../src/db/connection-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/**
 * Offline: the connection routes' HTTP contract (issue #546) and the task-create selection check,
 * against an in-memory store double. The store's SQL is pinned by server/test-db/connection-store.test.ts.
 */

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;

const CLOUD_ID = 'bc18dcc3-123a-4216-a5a2-4f7b0e55b297';
const API_TOKEN = 'secret-atlassian-token';
const SITE = { site: 'https://Example.atlassian.net/', email: 'agent@example.com', apiToken: API_TOKEN };

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

/** A store double with the real scoping rule, holding tokens like the table does. */
function memoryConnections(): ConnectionStore & { rows: (NewConnection & { id: string })[] } {
    const rows: (NewConnection & { id: string })[] = [];
    const view = (row: NewConnection & { id: string }): ConnectionView => ({
        id: row.id,
        kind: 'jira',
        site: row.site,
        email: row.email,
        access: row.access,
        scope: row.ownerUserId === null ? 'org' : 'user',
        createdAt: '2026-10-08T00:00:00.000Z',
    });
    return {
        rows,
        async list(userId) {
            return rows.filter((r) => r.ownerUserId === null || r.ownerUserId === userId).map(view);
        },
        async create(input) {
            const row = { ...input, id: crypto.randomUUID() };
            rows.push(row);
            return view(row);
        },
        async authorizedFor(userId, id) {
            return rows.some((r) => r.id === id && (r.ownerUserId === null || r.ownerUserId === userId));
        },
        async remove(id, { userId, admin }) {
            const at = rows.findIndex(
                (r) => r.id === id && (r.ownerUserId === userId || (r.ownerUserId === null && admin))
            );
            if (at === -1) return false;
            rows.splice(at, 1);
            return true;
        },
    };
}

async function boot() {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const other = auth.seedMember('test-org', 'hubot');
    const connections = memoryConnections();
    const created: { connection: string | null | undefined }[] = [];
    const jobs = {
        async create(_command: string, _by: string | null, target: { jiraConnectionId?: string | null }) {
            created.push({ connection: target.jiraConnectionId });
            return { id: crypto.randomUUID() };
        },
    } as unknown as JobStore;
    const config = testConfig({ auth: githubAuth() });
    app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient(), connections, jobs }),
        auth,
        cloudIdLookup: async (host) => (host === 'example.atlassian.net' ? CLOUD_ID : null),
    });
    return {
        instance: app,
        connections,
        created,
        cookie: {
            admin: await signedIn(auth, admin),
            member: await signedIn(auth, member),
            other: await signedIn(auth, other),
        },
    };
}

describe('connection routes', () => {
    it('need a session', async () => {
        const { instance } = await boot();
        expect((await instance.inject({ method: 'GET', url: '/api/connections' })).statusCode).toBe(HTTP_UNAUTHORIZED);
        expect((await instance.inject({ method: 'POST', url: '/api/connections', payload: SITE })).statusCode).toBe(
            HTTP_UNAUTHORIZED
        );
    });

    it('creates a member-owned read connection, never echoing the token', async () => {
        const { instance, cookie, connections } = await boot();
        const res = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: SITE,
        });
        expect(res.statusCode).toBe(HTTP_CREATED);
        expect(res.json()).toMatchObject({ site: 'example.atlassian.net', access: 'read', scope: 'user' });
        expect(res.body).not.toContain(API_TOKEN);
        expect(connections.rows[0]).toMatchObject({ cloudId: CLOUD_ID, apiToken: API_TOKEN });
        const list = await instance.inject({
            method: 'GET',
            url: '/api/connections',
            headers: { cookie: cookie.member },
        });
        expect(list.statusCode).toBe(HTTP_OK);
        expect(list.body).not.toContain(API_TOKEN);
    });

    it('lets only an admin create an org-wide connection', async () => {
        const { instance, cookie } = await boot();
        const refused = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: { ...SITE, scope: 'org' },
        });
        expect(refused.statusCode).toBe(HTTP_FORBIDDEN);
        const allowed = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.admin },
            payload: { ...SITE, scope: 'org', access: 'write' },
        });
        expect(allowed.statusCode).toBe(HTTP_CREATED);
        expect(allowed.json()).toMatchObject({ scope: 'org', access: 'write' });
    });

    it.each([
        ['a non-Atlassian host', { ...SITE, site: 'evil.example.com' }],
        ['an internal host', { ...SITE, site: 'localhost' }],
        ['a missing token', { ...SITE, apiToken: '' }],
        ['a quote in the email', { ...SITE, email: 'a"b@example.com' }],
        ['an unknown access level', { ...SITE, access: 'admin' }],
        ['an unknown scope', { ...SITE, scope: 'global' }],
    ])('refuses %s', async (_label, payload) => {
        const { instance, cookie, connections } = await boot();
        const res = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload,
        });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json()).toMatchObject({ code: 'BAD_CONNECTION' });
        expect(connections.rows).toHaveLength(0);
    });

    it('refuses a site whose cloud id cannot be resolved', async () => {
        const { instance, cookie } = await boot();
        const res = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: { ...SITE, site: 'nowhere.atlassian.net' },
        });
        expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
    });

    it("hides another member's connection from list and delete, and lets an admin delete only org ones", async () => {
        const { instance, cookie, connections } = await boot();
        const own = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: SITE,
        });
        const id = own.json().id as string;
        const seen = await instance.inject({
            method: 'GET',
            url: '/api/connections',
            headers: { cookie: cookie.other },
        });
        expect(seen.json().connections).toEqual([]);
        for (const who of ['other', 'admin'] as const) {
            const res = await instance.inject({
                method: 'DELETE',
                url: `/api/connections/${id}`,
                headers: { cookie: cookie[who] },
            });
            expect(res.statusCode).toBe(HTTP_NOT_FOUND);
        }
        expect(connections.rows).toHaveLength(1);
        const mine = await instance.inject({
            method: 'DELETE',
            url: `/api/connections/${id}`,
            headers: { cookie: cookie.member },
        });
        expect(mine.statusCode).toBe(HTTP_NO_CONTENT);
        expect(connections.rows).toHaveLength(0);
    });
});

describe('selecting a connection for a task', () => {
    const create = (instance: FastifyInstance, cookie: string, jiraConnection?: unknown) =>
        instance.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie },
            payload: { command: 'look at ABC-1', ...(jiraConnection === undefined ? {} : { jiraConnection }) },
        });

    it('stamps an authorized connection on the created task', async () => {
        const { instance, cookie, created } = await boot();
        const made = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: SITE,
        });
        const res = await create(instance, cookie.member, made.json().id);
        expect(res.statusCode).toBe(HTTP_CREATED);
        expect(created).toEqual([{ connection: made.json().id }]);
    });

    it("refuses another member's connection and an unknown id, creating nothing", async () => {
        const { instance, cookie, created } = await boot();
        const made = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.member },
            payload: SITE,
        });
        for (const id of [made.json().id, crypto.randomUUID()]) {
            const res = await create(instance, cookie.other, id);
            expect(res.statusCode).toBe(HTTP_FORBIDDEN);
            expect(res.json()).toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
        }
        expect(created).toEqual([]);
    });

    it('lets every member select an org-owned connection, and refuses a malformed id', async () => {
        const { instance, cookie, created } = await boot();
        const org = await instance.inject({
            method: 'POST',
            url: '/api/connections',
            headers: { cookie: cookie.admin },
            payload: { ...SITE, scope: 'org' },
        });
        expect((await create(instance, cookie.other, org.json().id)).statusCode).toBe(HTTP_CREATED);
        expect(created).toHaveLength(1);
        const bad = await create(instance, cookie.other, 'not-a-uuid');
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(bad.json()).toMatchObject({ code: 'BAD_CONNECTION' });
    });

    it('creates a task with no connection when none is named', async () => {
        const { instance, cookie, created } = await boot();
        expect((await create(instance, cookie.member)).statusCode).toBe(HTTP_CREATED);
        expect(created).toEqual([{ connection: null }]);
    });
});
