import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ConnectionOfLease, LiveConnection } from '../src/db/connection-store.js';
import { githubAuth, memoryAuthStore, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/**
 * Offline: the Jira connector proxy's HTTP contract (issue #546) against a stub per-call check and
 * a stub Atlassian. The check's own SQL — lease rotation, cancel, membership — is pinned by
 * server/test-db/connection-store.test.ts.
 */

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_REQUEST = 400;
const HTTP_BAD_GATEWAY = 502;

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const CLOUD_ID = 'bc18dcc3-123a-4216-a5a2-4f7b0e55b297';
const EMAIL = 'agent@example.com';
const API_TOKEN = 'secret-atlassian-token';
const PAIR = { 'x-factory-job-id': JOB_ID, 'x-factory-job-lease-token': LEASE };
const BASE = `/api/jobs/${JOB_ID}/connectors/jira/rest/api/3`;

const live = (access: 'read' | 'write' = 'read'): LiveConnection => ({
    ok: true,
    cloudId: CLOUD_ID,
    email: EMAIL,
    apiToken: API_TOKEN,
    access,
});

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

interface Upstream {
    url: string;
    init: RequestInit;
}

async function boot(answer: LiveConnection, mode: 'github' | 'none' = 'github') {
    const calls: Upstream[] = [];
    const lookups: [string, string][] = [];
    const connectionOfLease: ConnectionOfLease = async (jobId, leaseToken) => {
        lookups.push([jobId, leaseToken]);
        return jobId === JOB_ID && leaseToken === LEASE ? answer : { ok: false, reason: 'lease' };
    };
    const fetchFn = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('{"key":"ABC-1"}', { status: HTTP_OK, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const config = testConfig({ auth: mode === 'github' ? githubAuth() : testConfig().auth });
    app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
        auth: memoryAuthStore(),
        connectionOfLease,
        fetchFn,
    });
    return { instance: app, calls, lookups };
}

describe('the Jira connector proxy', () => {
    it('forwards a GET with the connection credential added on the board, to the connection cloud id', async () => {
        const { instance, calls } = await boot(live());
        const res = await instance.inject({ method: 'GET', url: `${BASE}/issue/ABC-1?fields=summary`, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_OK);
        expect(res.json()).toEqual({ key: 'ABC-1' });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(
            `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/issue/ABC-1?fields=summary`
        );
        const headers = calls[0]!.init.headers as Record<string, string>;
        expect(headers.authorization).toBe(`Basic ${Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64')}`);
        // Nothing the runner sent rides upstream, and nothing credential-shaped comes back.
        expect(JSON.stringify(headers)).not.toContain(LEASE);
        expect(JSON.stringify(res.headers)).not.toContain(API_TOKEN);
        expect(res.body).not.toContain(API_TOKEN);
    });

    it('works the same under AUTH_MODE=none: the pair is required in every mode', async () => {
        const { instance, calls } = await boot(live(), 'none');
        expect((await instance.inject({ method: 'GET', url: `${BASE}/myself` })).statusCode).toBe(HTTP_UNAUTHORIZED);
        expect((await instance.inject({ method: 'GET', url: `${BASE}/myself`, headers: PAIR })).statusCode).toBe(
            HTTP_OK
        );
        expect(calls).toHaveLength(1);
    });

    it.each([
        ['no credential', {}],
        ['a lease token with no job id', { 'x-factory-job-lease-token': LEASE }],
        ['a job id that is not the URL job', { ...PAIR, 'x-factory-job-id': '33333333-3333-4333-8333-333333333333' }],
        ['a bearer instead of the pair', { authorization: 'Bearer anything' }],
    ])('refuses %s with 401 and never reaches Atlassian', async (_label, headers) => {
        const { instance, calls, lookups } = await boot(live());
        const res = await instance.inject({ method: 'GET', url: `${BASE}/myself`, headers });
        expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(calls).toHaveLength(0);
        expect(lookups).toHaveLength(0);
    });

    it('refuses a stale lease token (a reclaimed or finished attempt) with an actionable 403', async () => {
        const { instance, calls } = await boot(live());
        const res = await instance.inject({
            method: 'GET',
            url: `${BASE}/myself`,
            headers: { ...PAIR, 'x-factory-job-lease-token': '44444444-4444-4444-8444-444444444444' },
        });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json()).toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
        expect(res.json().error).toContain('no longer running');
        expect(calls).toHaveLength(0);
    });

    it.each([
        ['unselected', 'No Jira connection is selected'],
        ['revoked', 'no longer authorized'],
    ] as const)('refuses a %s connection and tells the member what to fix', async (reason, message) => {
        const { instance, calls } = await boot({ ok: false, reason });
        const res = await instance.inject({ method: 'GET', url: `${BASE}/myself`, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.json()).toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
        expect(res.json().error).toContain(message);
        expect(calls).toHaveLength(0);
    });

    it('refuses a write on a read connection, and forwards it on a write connection', async () => {
        const readOnly = await boot(live('read'));
        const refused = await readOnly.instance.inject({
            method: 'POST',
            url: `${BASE}/issue/ABC-1/comment`,
            headers: PAIR,
            payload: { body: 'x' },
        });
        expect(refused.statusCode).toBe(HTTP_FORBIDDEN);
        expect(refused.json()).toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
        expect(readOnly.calls).toHaveLength(0);
        await readOnly.instance.close();

        const writable = await boot(live('write'));
        const sent = await writable.instance.inject({
            method: 'POST',
            url: `${BASE}/issue/ABC-1/comment`,
            headers: PAIR,
            payload: { body: 'x' },
        });
        expect(sent.statusCode).toBe(HTTP_OK);
        expect(writable.calls[0]!.init).toMatchObject({ method: 'POST', body: '{"body":"x"}' });
    });

    it.each([
        ['outside the REST base', '/api/jobs/' + JOB_ID + '/connectors/jira/oauth/token/rotate'],
        ['a traversal', `${BASE}/../../../admin`],
        ['an encoded traversal', `${BASE}/%2e%2e/%2e%2e/admin`],
        // A URL parser deletes tabs and newlines, so `.<tab>.` would become `..` upstream.
        ['a tab-split traversal', `${BASE}/.%09./.%09./other-cloud/rest/api/3/myself`],
        ['a newline-split traversal', `${BASE}/.%0A./.%0A./other-cloud/rest/api/3/myself`],
    ])('refuses a path %s', async (_label, url) => {
        const { instance, calls } = await boot(live());
        const res = await instance.inject({ method: 'GET', url, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(res.json()).toMatchObject({ code: 'BAD_CONNECTION' });
        expect(calls).toHaveLength(0);
    });

    it('answers 502 without echoing the upstream error or the credential when Atlassian is down', async () => {
        const config = testConfig({ auth: githubAuth() });
        app = await buildApp({
            config,
            orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
            auth: memoryAuthStore(),
            connectionOfLease: async () => live(),
            fetchFn: (async () => {
                throw new Error(`connect failed for ${API_TOKEN}`);
            }) as unknown as typeof fetch,
        });
        const res = await app.inject({ method: 'GET', url: `${BASE}/myself`, headers: PAIR });
        expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
        expect(res.body).not.toContain(API_TOKEN);
    });
});
