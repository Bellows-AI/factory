import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { AuthStore } from '../src/auth/store.js';
import { MAX_EXECUTORS_PER_ORG, MAX_EXECUTORS_PER_USER } from '../src/routes/executor-fields.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryUserExecutorStore,
    memoryUserRepoStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';
import type { MemoryUserExecutorStore } from './helpers-user-executor-store.js';

/**
 * Offline: the HTTP contract of the organization-scoped executor routes (issue 391) against the
 * in-memory store double. The store's own rules — the per-scope name index, the preference
 * fallback chain — are covered by server/test-db/user-executor-store.test.ts, which needs a
 * container.
 */

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const CLAUDE_CODE = { name: 'team-runner', type: 'claude-code', config: { model: 'sonnet' } };

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-org-exec-'));
});

async function boot(executors: MemoryUserExecutorStore = memoryUserExecutorStore()) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    // A workspace root: the tests that seed personal rows do it through the personal PUT, which
    // refuses 409 without one — the org routes themselves touch no checkout.
    const config = testConfig({ auth: githubAuth(), workspaceRoot: root });
    const instance = await build(executors, auth, config);
    app = instance;
    return {
        instance,
        admin,
        member,
        executors,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
    };
}

/** Boots the app with the given executor store and NO workspace root — these routes need none. */
function build(executors: MemoryUserExecutorStore, auth: AuthStore, config: AppConfig) {
    return buildApp({
        config,
        orgs: staticRegistry({
            config,
            userRepos: memoryUserRepoStore(),
            userExecutors: executors,
            telemetry: stubTelemetryClient(),
        }),
        auth,
    });
}

describe('organization executors: permissions', () => {
    it('needs a session', async () => {
        const { instance } = await boot();
        expect((await instance.inject({ method: 'GET', url: '/api/org/executors' })).statusCode).toBe(
            HTTP_UNAUTHORIZED
        );
        expect(
            (await instance.inject({ method: 'POST', url: '/api/org/executors', payload: CLAUDE_CODE })).statusCode
        ).toBe(HTTP_UNAUTHORIZED);
    });

    it('a member reads selection metadata, never the configuration', async () => {
        const { instance, adminCookie, memberCookie } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });

        const response = await instance.inject({
            method: 'GET',
            url: '/api/org/executors',
            headers: { cookie: memberCookie },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body.executors).toEqual([expect.objectContaining({ name: 'team-runner', type: 'claude-code' })]);
        // The config may hold provider credentials: members get the fact a profile exists and
        // what it launches, never the payload.
        expect(JSON.stringify(body)).not.toContain('sonnet');
        expect(body.executors[0].config).toBeUndefined();
    });

    it('an admin reads the full configuration', async () => {
        const { instance, adminCookie } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });

        const body = (
            await instance.inject({ method: 'GET', url: '/api/org/executors', headers: { cookie: adminCookie } })
        ).json();
        expect(body.executors).toEqual([
            expect.objectContaining({
                name: 'team-runner',
                config: { model: 'sonnet' },
                createdBy: expect.any(String),
            }),
        ]);
    });

    it('non-admin mutations return 403 and leave the data unchanged', async () => {
        const { instance, adminCookie, memberCookie, executors } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        const id = executors.rows()[0]!.id;

        for (const request of [
            { method: 'POST', url: '/api/org/executors', payload: { ...CLAUDE_CODE, name: 'other' } },
            { method: 'PUT', url: `/api/org/executors/${id}`, payload: { ...CLAUDE_CODE, name: 'renamed' } },
            { method: 'DELETE', url: `/api/org/executors/${id}` },
            { method: 'POST', url: `/api/org/executors/${id}/scope`, payload: { scope: 'user' } },
        ] as const) {
            const response = await instance.inject({ ...request, headers: { cookie: memberCookie } });
            expect(response.statusCode, `${request.method} ${request.url}`).toBe(HTTP_FORBIDDEN);
            expect(response.json().code).toBe('FORBIDDEN');
        }
        // Every refusal left the org row exactly as the admin wrote it.
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'team-runner', userId: null })]);
    });

    it('a member cannot promote their own personal profile — 403, rows untouched', async () => {
        const { instance, memberCookie, member, executors } = await boot();
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: memberCookie },
            payload: { executors: [{ name: 'mine', type: 'claude-code', config: {} }] },
        });
        const personal = executors.rows().find((row) => row.userId === member.user.id)!;

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${personal.id}/scope`,
            headers: { cookie: memberCookie },
            payload: { scope: 'org' },
        });
        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'mine', userId: member.user.id })]);
    });

    it('a whole-list replacement attempt on the org scope is refused — the org scope has no list PUT', async () => {
        // The personal PUT is the caller's own list; an org-shaped entry in it is a tamper attempt
        // against the shared scope and refuses loudly rather than being rewritten.
        const { instance, adminCookie, memberCookie, executors } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });

        for (const [label, cookie, entries] of [
            ['member', memberCookie, [{ ...CLAUDE_CODE, scope: 'org' }]],
            ['admin', adminCookie, [{ ...CLAUDE_CODE, scope: 'org' }]],
            [
                'userId tamper',
                memberCookie,
                [
                    {
                        name: 'x',
                        type: 'claude-code',
                        config: {},
                        userId: '00000000-0000-4000-8000-000000000000',
                    },
                ],
            ],
        ] as const) {
            const response = await instance.inject({
                method: 'PUT',
                url: '/api/workspace/executors',
                headers: { cookie },
                payload: { executors: entries },
            });
            expect(response.statusCode, label).toBe(HTTP_BAD_REQUEST);
        }
        // The org row was never touched by any of those PUTs.
        expect(executors.rows().filter((row) => row.userId === null)).toHaveLength(1);
    });
});

describe('organization executors: admin CRUD', () => {
    it('creates an org profile and answers it with its config', async () => {
        const { instance, adminCookie, executors } = await boot();
        const response = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: { ...CLAUDE_CODE, gateFixRounds: 5 },
        });

        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(response.json()).toEqual(
            expect.objectContaining({ name: 'team-runner', config: { model: 'sonnet' }, gateFixRounds: 5 })
        );
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'team-runner', userId: null })]);
    });

    it('edits and deletes by id', async () => {
        const { instance, adminCookie, executors } = await boot();
        const created = (
            await instance.inject({
                method: 'POST',
                url: '/api/org/executors',
                headers: { cookie: adminCookie },
                payload: CLAUDE_CODE,
            })
        ).json();
        const id = created.id as string;

        const renamed = await instance.inject({
            method: 'PUT',
            url: `/api/org/executors/${id}`,
            headers: { cookie: adminCookie },
            payload: { name: 'renamed', type: 'claude-code', config: { model: 'opus' }, gateFixRounds: 1 },
        });
        expect(renamed.statusCode).toBe(HTTP_OK);
        expect(renamed.json()).toEqual(expect.objectContaining({ name: 'renamed', config: { model: 'opus' } }));

        const removed = await instance.inject({
            method: 'DELETE',
            url: `/api/org/executors/${id}`,
            headers: { cookie: adminCookie },
        });
        expect(removed.statusCode).toBe(HTTP_OK);
        expect(executors.rows()).toEqual([]);
    });

    it('answers 404 for an id that names no org row', async () => {
        const { instance, adminCookie } = await boot();
        const ghost = '99999999-9999-4999-8999-999999999999';
        expect(
            (
                await instance.inject({
                    method: 'PUT',
                    url: `/api/org/executors/${ghost}`,
                    headers: { cookie: adminCookie },
                    payload: CLAUDE_CODE,
                })
            ).statusCode
        ).toBe(HTTP_NOT_FOUND);
        expect(
            (
                await instance.inject({
                    method: 'DELETE',
                    url: `/api/org/executors/${ghost}`,
                    headers: { cookie: adminCookie },
                })
            ).statusCode
        ).toBe(HTTP_NOT_FOUND);
    });

    it('refuses a duplicate org name with 409', async () => {
        const { instance, adminCookie } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        const response = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: { ...CLAUDE_CODE, config: {} },
        });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('NAME_TAKEN');
    });

    it('a personal row of the same name is not a conflict', async () => {
        const { instance, adminCookie } = await boot();
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: { executors: [{ name: 'team-runner', type: 'opencode', config: {} }] },
        });
        const response = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        expect(response.statusCode).toBe(HTTP_CREATED);
    });

    it('caps the org list', async () => {
        const { instance, adminCookie } = await boot();
        for (let i = 0; i < MAX_EXECUTORS_PER_ORG; i += 1) {
            const response = await instance.inject({
                method: 'POST',
                url: '/api/org/executors',
                headers: { cookie: adminCookie },
                payload: { name: `executor-${i}`, type: 'claude-code', config: {} },
            });
            expect(response.statusCode).toBe(HTTP_CREATED);
        }
        const over = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: { name: 'one-too-many', type: 'claude-code', config: {} },
        });
        expect(over.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(over.json().code).toBe('TOO_MANY_EXECUTORS');
    });

    it('validates the create body: type, name shape, config object, rounds', async () => {
        const { instance, adminCookie } = await boot();
        const refusals = [
            [{ name: 'x', type: 'codex', config: {} }, 'BAD_EXECUTOR_TYPE'],
            [{ name: 'a/b', type: 'claude-code', config: {} }, 'BAD_EXECUTOR_NAME'],
            [{ name: 'x', type: 'claude-code', config: 'text' }, 'BAD_BODY'],
            [{ name: 'x', type: 'claude-code', config: {}, gateFixRounds: 11 }, 'BAD_EXECUTOR_ROUNDS'],
        ] as const;
        for (const [payload, code] of refusals) {
            const response = await instance.inject({
                method: 'POST',
                url: '/api/org/executors',
                headers: { cookie: adminCookie },
                payload,
            });
            expect(response.statusCode, JSON.stringify(payload)).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code).toBe(code);
        }
    });
});

describe('organization executors: scope changes', () => {
    it('an admin promotes their own personal row; the name is freed in the personal scope', async () => {
        const { instance, adminCookie, admin, executors } = await boot();
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: { executors: [{ name: 'mine', type: 'claude-code', config: { model: 'm' } }] },
        });
        const personal = executors.rows().find((row) => row.userId === admin.user.id)!;

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${personal.id}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'org' },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(executors.rows()).toEqual([
            expect.objectContaining({ name: 'mine', userId: null, createdBy: admin.user.id }),
        ]);
    });

    it('an admin demotes an org row into their own personal list', async () => {
        const { instance, adminCookie, admin, executors } = await boot();
        const created = (
            await instance.inject({
                method: 'POST',
                url: '/api/org/executors',
                headers: { cookie: adminCookie },
                payload: CLAUDE_CODE,
            })
        ).json();

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${created.id}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'user' },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'team-runner', userId: admin.user.id })]);
    });

    it('a scope change colliding with a name in the target scope answers 409 and moves nothing', async () => {
        const { instance, adminCookie, executors } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: { executors: [{ name: 'team-runner', type: 'opencode', config: {} }] },
        });
        const orgRow = executors.rows().find((row) => row.userId === null)!;

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${orgRow.id}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'user' },
        });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(executors.rows()).toEqual([
            expect.objectContaining({ name: 'team-runner', userId: null }),
            expect.objectContaining({ name: 'team-runner', userId: expect.any(String) }),
        ]);
    });

    it('a promotion into a full org list answers 400 and moves nothing', async () => {
        const { instance, adminCookie, admin, executors } = await boot();
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: { executors: [{ name: 'mine', type: 'claude-code', config: {} }] },
        });
        const personal = executors.rows().find((row) => row.userId === admin.user.id)!;
        for (let i = 0; i < MAX_EXECUTORS_PER_ORG; i += 1) {
            await instance.inject({
                method: 'POST',
                url: '/api/org/executors',
                headers: { cookie: adminCookie },
                payload: { name: `full-${i}`, type: 'claude-code', config: {} },
            });
        }

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${personal.id}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'org' },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('TOO_MANY_EXECUTORS');
        // Nothing moved: the personal row is still the caller's.
        expect(executors.rows().find((row) => row.name === 'mine')?.userId).toBe(admin.user.id);
    });

    it('a demotion into a full personal list answers 400 and moves nothing', async () => {
        const { instance, adminCookie, executors } = await boot();
        const created = await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        const orgId = (created.json() as { id: string }).id;
        const mine = Array.from({ length: MAX_EXECUTORS_PER_USER }, (_, i) => ({
            name: `p-${i}`,
            type: 'claude-code',
            config: {},
        }));
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: { executors: mine },
        });

        const response = await instance.inject({
            method: 'POST',
            url: `/api/org/executors/${orgId}/scope`,
            headers: { cookie: adminCookie },
            payload: { scope: 'user' },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('TOO_MANY_EXECUTORS');
        // Nothing moved: the org row is still the organization's.
        expect(executors.rows().find((row) => row.id === orgId)?.userId).toBeNull();
    });

    it('refuses a scope value that is neither user nor org', async () => {
        const { instance, adminCookie } = await boot();
        const response = await instance.inject({
            method: 'POST',
            url: '/api/org/executors/99999999-9999-4999-8999-999999999999/scope',
            headers: { cookie: adminCookie },
            payload: { scope: 'repo' },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_SCOPE');
    });
});

describe('the workspace poll and the personal routes after 391', () => {
    it('the poll carries org selection metadata and the resolved default, no org config', async () => {
        const { instance, adminCookie } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });
        await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: { executors: [{ name: 'mine', type: 'opencode', config: { model: 'secret-model' } }] },
        });

        const body = (
            await instance.inject({ method: 'GET', url: '/api/workspace', headers: { cookie: adminCookie } })
        ).json();
        expect(body.executors).toEqual([expect.objectContaining({ name: 'mine', type: 'opencode' })]);
        expect(body.executors[0].config).toBeUndefined();
        expect(body.orgExecutors).toEqual([expect.objectContaining({ name: 'team-runner', type: 'claude-code' })]);
        expect(JSON.stringify(body)).not.toContain('sonnet');
        // No preference stored: the resolved default is the first personal row.
        expect(body.defaultExecutor).toEqual({ scope: 'user', name: 'mine' });
    });

    it('PUT /api/workspace/executors/default stores a per-member preference naming its scope', async () => {
        const { instance, adminCookie, memberCookie, executors } = await boot();
        await instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: adminCookie },
            payload: CLAUDE_CODE,
        });

        const response = await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: memberCookie },
            payload: { executor: 'team-runner', executorScope: 'org' },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(executors.defaults()).toEqual([expect.objectContaining({ scope: 'org', name: 'team-runner' })]);

        // The poll folds the stored preference in: the member now autoselects the org profile.
        const poll = (
            await instance.inject({ method: 'GET', url: '/api/workspace', headers: { cookie: memberCookie } })
        ).json();
        expect(poll.defaultExecutor).toEqual({ scope: 'org', name: 'team-runner' });
    });

    it('the default route answers 404 for a profile the caller cannot resolve, and 400 for a bad scope', async () => {
        const { instance, adminCookie } = await boot();
        const missing = await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: adminCookie },
            payload: { executor: 'ghost', executorScope: 'org' },
        });
        expect(missing.statusCode).toBe(HTTP_NOT_FOUND);

        const badScope = await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: adminCookie },
            payload: { executor: 'x', executorScope: 'repo' },
        });
        expect(badScope.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(badScope.json().code).toBe('BAD_EXECUTOR_SCOPE');
    });

    it('a PUT entry carrying isDefault is refused — the flag moved to the preference route', async () => {
        const { instance, adminCookie } = await boot();
        const response = await instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            headers: { cookie: adminCookie },
            payload: { executors: [{ name: 'x', type: 'claude-code', config: {}, isDefault: true }] },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('answers 503 when the deployment has no executor store', async () => {
        const auth = memoryAuthStore();
        const member = auth.seedMember('test-org', 'octocat');
        const config = testConfig({ auth: githubAuth() });
        const instance = await buildApp({
            config,
            orgs: staticRegistry({
                config,
                userRepos: memoryUserRepoStore(),
                telemetry: stubTelemetryClient(),
            }),
            auth,
        });
        app = instance;
        const cookie = await signedIn(auth, member);
        const response = await instance.inject({ method: 'GET', url: '/api/org/executors', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
    });
});
