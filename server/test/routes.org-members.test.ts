import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryUserRepoStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';
import type { MemoryAuthStore } from './helpers-auth-store.js';

/**
 * Offline: the HTTP contract of the member-roster routes (issue 410) against the in-memory store
 * double. The store's own rules — the last-admin predicate, the bootstrap promotion — are covered
 * by server/test-db/auth-store.test.ts, which needs a container.
 */

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

async function boot(): Promise<{
    instance: FastifyInstance;
    auth: MemoryAuthStore;
    admin: ReturnType<MemoryAuthStore['seedMember']>;
    member: ReturnType<MemoryAuthStore['seedMember']>;
    adminCookie: string;
    memberCookie: string;
}> {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const config = testConfig({ auth: githubAuth() });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, userRepos: memoryUserRepoStore(), telemetry: stubTelemetryClient() }),
        auth,
    });
    app = instance;
    return {
        instance,
        auth,
        admin,
        member,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
    };
}

describe('member roster routes: permissions (issue 410)', () => {
    it('needs a session', async () => {
        const { instance } = await boot();
        expect((await instance.inject({ method: 'GET', url: '/api/org/members' })).statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(
            (
                await instance.inject({
                    method: 'PUT',
                    url: `/api/org/members/${crypto.randomUUID()}/role`,
                    payload: { role: 'member' },
                })
            ).statusCode
        ).toBe(HTTP_UNAUTHORIZED);
    });

    it('a member is refused on both, and the roster is untouched', async () => {
        const { instance, admin, memberCookie } = await boot();
        const list = await instance.inject({
            method: 'GET',
            url: '/api/org/members',
            headers: { cookie: memberCookie },
        });
        expect(list.statusCode).toBe(HTTP_FORBIDDEN);
        expect(list.json()).toMatchObject({ code: 'FORBIDDEN' });

        const write = await instance.inject({
            method: 'PUT',
            url: `/api/org/members/${admin.user.id}/role`,
            headers: { cookie: memberCookie },
            payload: { role: 'member' },
        });
        expect(write.statusCode).toBe(HTTP_FORBIDDEN);
        expect(write.json()).toMatchObject({ code: 'FORBIDDEN' });
    });
});

describe('GET /api/org/members', () => {
    it('an admin reads the roster, login-ordered, one org only', async () => {
        const { instance, auth, admin, adminCookie } = await boot();
        const elsewhere = auth.seedMember('other-org', 'elsewhere-cat');

        const body = (
            await instance.inject({ method: 'GET', url: '/api/org/members', headers: { cookie: adminCookie } })
        ).json();
        expect(body.members).toEqual([
            {
                githubLogin: 'admin-cat',
                userId: admin.user.id,
                role: 'admin',
                invitedAt: expect.any(String),
                claimedAt: expect.any(String),
                lastLoginAt: expect.any(String),
            },
            {
                githubLogin: 'octocat',
                userId: expect.any(String),
                role: 'member',
                invitedAt: expect.any(String),
                claimedAt: expect.any(String),
                lastLoginAt: expect.any(String),
            },
        ]);
        // Another org's roster never leaks into this list.
        expect(body.members.map((m: { githubLogin: string }) => m.githubLogin)).not.toContain(elsewhere.user.login);
    });
});

describe('PUT /api/org/members/:userId/role', () => {
    it('promotes a member, and the change bites the target’s next request with no re-login', async () => {
        const { instance, member, memberCookie, adminCookie } = await boot();

        const written = await instance.inject({
            method: 'PUT',
            url: `/api/org/members/${member.user.id}/role`,
            headers: { cookie: adminCookie },
            payload: { role: 'admin' },
        });
        expect(written.statusCode).toBe(HTTP_OK);
        expect(written.json()).toEqual({ userId: member.user.id, role: 'admin' });

        // The role is read fresh per request through the org_membership join — the target's
        // existing session is an admin's on its very next request.
        expect(
            (await instance.inject({ method: 'GET', url: '/api/org/members', headers: { cookie: memberCookie } }))
                .statusCode
        ).toBe(HTTP_OK);
    });

    it('refuses a role outside ROLES — unknown, missing, or not a string', async () => {
        const { instance, member, adminCookie } = await boot();
        const url = `/api/org/members/${member.user.id}/role`;
        const headers = { cookie: adminCookie };

        for (const payload of [{ role: 'owner' }, {}, { role: 42 }]) {
            const response = await instance.inject({ method: 'PUT', url, headers, payload });
            expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
            expect(response.json()).toMatchObject({ code: 'BAD_ROLE' });
        }
    });

    it('refuses a userId that is not a uuid', async () => {
        const { instance, adminCookie } = await boot();
        const response = await instance.inject({
            method: 'PUT',
            url: '/api/org/members/not-a-uuid/role',
            headers: { cookie: adminCookie },
            payload: { role: 'member' },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json()).toMatchObject({ code: 'BAD_ID' });
    });

    it('answers 404 for a member of another org and for an unknown id', async () => {
        const { instance, auth, adminCookie } = await boot();
        const elsewhere = auth.seedMember('other-org', 'elsewhere-cat');

        for (const id of [elsewhere.user.id, crypto.randomUUID()]) {
            const response = await instance.inject({
                method: 'PUT',
                url: `/api/org/members/${id}/role`,
                headers: { cookie: adminCookie },
                payload: { role: 'member' },
            });
            expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        }
    });

    it('refuses demoting the last admin — even the caller themselves — and changes nothing', async () => {
        const { instance, auth, admin, adminCookie, memberCookie } = await boot();

        const response = await instance.inject({
            method: 'PUT',
            url: `/api/org/members/${admin.user.id}/role`,
            headers: { cookie: adminCookie },
            payload: { role: 'member' },
        });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json()).toMatchObject({ code: 'LAST_ADMIN' });
        // The refusal left the roster exactly as it was.
        expect((await auth.listMembers('test-org')).map((m) => [m.githubLogin, m.role])).toEqual([
            ['admin-cat', 'admin'],
            ['octocat', 'member'],
        ]);
        // Still an admin: the gated surface stays reachable with the same cookie.
        expect(
            (await instance.inject({ method: 'GET', url: '/api/org/members', headers: { cookie: adminCookie } }))
                .statusCode
        ).toBe(HTTP_OK);
        expect(
            (await instance.inject({ method: 'GET', url: '/api/org/members', headers: { cookie: memberCookie } }))
                .statusCode
        ).toBe(HTTP_FORBIDDEN);
    });

    it('allows demoting yourself while another admin exists', async () => {
        const { instance, auth, admin, member, adminCookie } = await boot();
        await instance.inject({
            method: 'PUT',
            url: `/api/org/members/${member.user.id}/role`,
            headers: { cookie: adminCookie },
            payload: { role: 'admin' },
        });

        const demoted = await instance.inject({
            method: 'PUT',
            url: `/api/org/members/${admin.user.id}/role`,
            headers: { cookie: adminCookie },
            payload: { role: 'member' },
        });
        expect(demoted.statusCode).toBe(HTTP_OK);
        expect((await auth.listMembers('test-org')).find((m) => m.userId === admin.user.id)?.role).toBe('member');
    });
});
