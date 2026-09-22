import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type {
    DefaultWorkflowSettings,
    DefaultWorkflowSettingsStore,
} from '../src/db/default-workflow-settings-store.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/**
 * Offline: the HTTP contract of `GET`/`PUT /api/workflows/default-settings` (#203) against an
 * in-memory store double. The store's own rules — the atomic upsert, org/user isolation — are
 * covered by server/test-db/default-workflow-settings-store.test.ts, which needs a container.
 */

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const BOTH_ENABLED: DefaultWorkflowSettings = {
    reviewReconciliation: true,
    mergeConflictAutofix: true,
    updatedAt: null,
};

/** The in-memory double: the route tests are about the HTTP contract, not the SQL. */
function stubSettings(): DefaultWorkflowSettingsStore & { puts: { userId: string; value: unknown }[] } {
    const rows = new Map<string, DefaultWorkflowSettings>();
    const puts: { userId: string; value: unknown }[] = [];
    return {
        puts,
        async get(userId) {
            return rows.get(userId) ?? BOTH_ENABLED;
        },
        async put(userId, value) {
            puts.push({ userId, value });
            const saved: DefaultWorkflowSettings = { ...value, updatedAt: '2026-09-22T00:00:00.000Z' };
            rows.set(userId, saved);
            return saved;
        },
    };
}

async function boot(workflowDefaults: DefaultWorkflowSettingsStore & { puts: unknown[] }) {
    const auth = memoryAuthStore();
    const alice = auth.seedMember('test-org', 'alice');
    const bob = auth.seedMember('test-org', 'bob');
    const config = testConfig({ auth: githubAuth() });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, workflowDefaults, telemetry: stubTelemetryClient() }),
        auth,
    });
    app = instance;
    return {
        instance,
        alice,
        bob,
        aliceCookie: await signedIn(auth, alice),
        bobCookie: await signedIn(auth, bob),
    };
}

describe('GET /api/workflows/default-settings', () => {
    it('needs a session', async () => {
        const store = stubSettings();
        const { instance } = await boot(store);
        const response = await instance.inject({ method: 'GET', url: '/api/workflows/default-settings' });
        expect(response.statusCode).toBe(401);
    });

    it('answers both switches on, with a null updatedAt, when no row exists — and writes nothing', async () => {
        const store = stubSettings();
        const { instance, aliceCookie } = await boot(store);
        const response = await instance.inject({
            method: 'GET',
            url: '/api/workflows/default-settings',
            headers: { cookie: aliceCookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(BOTH_ENABLED);
        expect(store.puts).toEqual([]);
    });

    it('answers 503 when the organization has no settings store', async () => {
        const config = testConfig({ auth: githubAuth() });
        const auth = memoryAuthStore();
        const alice = auth.seedMember('test-org', 'alice');
        const instance = await buildApp({ config, orgs: staticRegistry({ config }), auth });
        app = instance;
        const response = await instance.inject({
            method: 'GET',
            url: '/api/workflows/default-settings',
            headers: { cookie: await signedIn(auth, alice) },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('WORKFLOW_SETTINGS_UNAVAILABLE');
    });
});

describe('PUT /api/workflows/default-settings', () => {
    it('needs a session', async () => {
        const store = stubSettings();
        const { instance } = await boot(store);
        const response = await instance.inject({
            method: 'PUT',
            url: '/api/workflows/default-settings',
            payload: { reviewReconciliation: true, mergeConflictAutofix: true },
        });
        expect(response.statusCode).toBe(401);
    });

    it.each([
        [true, true],
        [true, false],
        [false, true],
        [false, false],
    ])('accepts { reviewReconciliation: %s, mergeConflictAutofix: %s } and echoes it back', async (rr, mca) => {
        const store = stubSettings();
        const { instance, aliceCookie } = await boot(store);
        const response = await instance.inject({
            method: 'PUT',
            url: '/api/workflows/default-settings',
            payload: { reviewReconciliation: rr, mergeConflictAutofix: mca },
            headers: { cookie: aliceCookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            reviewReconciliation: rr,
            mergeConflictAutofix: mca,
            updatedAt: expect.any(String),
        });
        expect(response.json().updatedAt).not.toBeNull();

        const get = await instance.inject({
            method: 'GET',
            url: '/api/workflows/default-settings',
            headers: { cookie: aliceCookie },
        });
        expect(get.json()).toEqual(response.json());
    });

    it.each([
        ['an empty body', {}],
        ['a partial body', { reviewReconciliation: true }],
        ['an unknown field', { reviewReconciliation: true, mergeConflictAutofix: true, extra: 1 }],
        ['a non-boolean field', { reviewReconciliation: 'yes', mergeConflictAutofix: true }],
        ['a null field', { reviewReconciliation: null, mergeConflictAutofix: true }],
        ['an array body', []],
    ])('refuses %s with 400 BAD_DEFAULT_WORKFLOW, and writes nothing', async (_label, payload) => {
        const store = stubSettings();
        const { instance, aliceCookie } = await boot(store);
        const response = await instance.inject({
            method: 'PUT',
            url: '/api/workflows/default-settings',
            payload,
            headers: { cookie: aliceCookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_DEFAULT_WORKFLOW');
        expect(store.puts).toEqual([]);
    });

    it('binds identity from the caller, never the body, and keeps members isolated', async () => {
        const store = stubSettings();
        const { instance, alice, aliceCookie, bobCookie } = await boot(store);

        const put = await instance.inject({
            method: 'PUT',
            url: '/api/workflows/default-settings',
            // userId in the body must be ignored — the caller's own id is what is bound.
            payload: { reviewReconciliation: false, mergeConflictAutofix: false, userId: 'not-alice' },
            headers: { cookie: aliceCookie },
        });
        expect(put.statusCode).toBe(400);

        const goodPut = await instance.inject({
            method: 'PUT',
            url: '/api/workflows/default-settings',
            payload: { reviewReconciliation: false, mergeConflictAutofix: false },
            headers: { cookie: aliceCookie },
        });
        expect(goodPut.statusCode).toBe(200);
        expect(store.puts).toEqual([
            { userId: alice.user.id, value: { reviewReconciliation: false, mergeConflictAutofix: false } },
        ]);

        const bobGet = await instance.inject({
            method: 'GET',
            url: '/api/workflows/default-settings',
            headers: { cookie: bobCookie },
        });
        expect(bobGet.json()).toEqual(BOTH_ENABLED);
    });

    it('answers 503 when the organization has no settings store', async () => {
        const config = testConfig({ auth: githubAuth() });
        const auth = memoryAuthStore();
        const alice = auth.seedMember('test-org', 'alice');
        const instance = await buildApp({ config, orgs: staticRegistry({ config }), auth });
        app = instance;
        const response = await instance.inject({
            method: 'PUT',
            url: '/api/workflows/default-settings',
            payload: { reviewReconciliation: true, mergeConflictAutofix: true },
            headers: { cookie: await signedIn(auth, alice) },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('WORKFLOW_SETTINGS_UNAVAILABLE');
    });
});
