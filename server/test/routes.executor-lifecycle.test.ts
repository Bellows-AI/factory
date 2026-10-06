import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { JobStore } from '../src/db/job-store-types.js';
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

/**
 * Offline: the HTTP contract of the executor lifecycle (issue 440) — removing and suspending a
 * personal profile by id, suspending an org profile, the default/fallback that skips a suspended
 * row, and the refusal of a task that targets one. The SQL under it is covered by
 * server/test-db/user-executor-store.test.ts and job-store.executor-scope.test.ts.
 */

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-exec-lifecycle-'));
});

const READY_REPO = { owner: 'acme', name: 'web' };

const entry = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    type: 'claude-code',
    config: { model: 'sonnet' },
    ...extra,
});

async function boot() {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const other = auth.seedMember('test-org', 'hubot');
    const executors = memoryUserExecutorStore();
    // A task needs a synced repository (issue 263): the member has one, so these tests keep
    // exercising the executor refusal rather than the repository's.
    const repos = memoryUserRepoStore();
    await repos.select(member.user.id, [READY_REPO]);
    await repos.markReady(member.user.id, READY_REPO);
    const queued: { command: string; executor: string | null; scope: string | undefined }[] = [];
    const jobs = {
        async create(command: string, _by: string | null, target?: { executor?: string; executorScope?: string }) {
            queued.push({ command, executor: target?.executor ?? null, scope: target?.executorScope });
            return { id: '11111111-1111-4111-8111-111111111111' };
        },
    } as unknown as JobStore;
    const config = testConfig({ auth: githubAuth(), workspaceRoot: root });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({
            config,
            jobs,
            userRepos: repos,
            userExecutors: executors,
            telemetry: stubTelemetryClient(),
        }),
        auth,
    });
    app = instance;
    return {
        instance,
        executors,
        repos,
        memberId: member.user.id,
        queued,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
        otherCookie: await signedIn(auth, other),
    };
}

type Booted = Awaited<ReturnType<typeof boot>>;

const putPersonal = (b: Booted, cookie: string, executors: unknown[]) =>
    b.instance.inject({ method: 'PUT', url: '/api/workspace/executors', headers: { cookie }, payload: { executors } });

const createOrg = async (b: Booted, name: string) =>
    (
        await b.instance.inject({
            method: 'POST',
            url: '/api/org/executors',
            headers: { cookie: b.adminCookie },
            payload: entry(name),
        })
    ).json().id as string;

const poll = async (b: Booted, cookie: string) =>
    (await b.instance.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();

const personalId = (b: Booted, name: string, cookie: string) =>
    poll(b, cookie).then((p) => p.executors.find((row: { name: string }) => row.name === name).id as string);

const suspend = (b: Booted, url: string, cookie: string, suspended: boolean) =>
    b.instance.inject({ method: 'POST', url, headers: { cookie }, payload: { suspended } });

const queue = (b: Booted, cookie: string, executor: string, executorScope: 'user' | 'org') =>
    b.instance.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { cookie },
        payload: { command: 'echo hi', executor, executorScope, repo: `${READY_REPO.owner}/${READY_REPO.name}` },
    });

describe('personal profiles: remove by id', () => {
    it('removes only the named row and leaves the rest of the list', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('keep'), entry('drop')]);
        const id = await personalId(b, 'drop', b.memberCookie);

        const response = await b.instance.inject({
            method: 'DELETE',
            url: `/api/workspace/executors/${id}`,
            headers: { cookie: b.memberCookie },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect((await poll(b, b.memberCookie)).executors.map((r: { name: string }) => r.name)).toEqual(['keep']);
    });

    it("never removes another member's row or an organization row, and says 404 without touching data", async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        const orgId = await createOrg(b, 'shared');
        const mineId = await personalId(b, 'mine', b.memberCookie);

        for (const [cookie, id] of [
            [b.otherCookie, mineId],
            [b.memberCookie, orgId],
        ] as const) {
            const response = await b.instance.inject({
                method: 'DELETE',
                url: `/api/workspace/executors/${id}`,
                headers: { cookie },
            });
            expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        }
        expect(b.executors.rows().map((r) => r.name)).toEqual(expect.arrayContaining(['mine', 'shared']));
        expect(b.executors.rows()).toHaveLength(2);
    });
});

describe('personal profiles: suspend and resume', () => {
    it('persists the suspension, keeps config and shows it in the poll', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        const id = await personalId(b, 'mine', b.memberCookie);

        const response = await suspend(b, `/api/workspace/executors/${id}/suspension`, b.memberCookie, true);
        expect(response.statusCode).toBe(HTTP_OK);
        expect((await poll(b, b.memberCookie)).executors[0]).toMatchObject({ name: 'mine', suspended: true });
        expect(b.executors.rows()[0]).toMatchObject({ config: { model: 'sonnet' }, suspended: true });

        await suspend(b, `/api/workspace/executors/${id}/suspension`, b.memberCookie, false);
        expect((await poll(b, b.memberCookie)).executors[0].suspended).toBe(false);
    });

    it("refuses another member's row and an org row with 404, and a non-boolean body with 400", async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        const orgId = await createOrg(b, 'shared');
        const mineId = await personalId(b, 'mine', b.memberCookie);

        expect(
            (await suspend(b, `/api/workspace/executors/${mineId}/suspension`, b.otherCookie, true)).statusCode
        ).toBe(HTTP_NOT_FOUND);
        expect(
            (await suspend(b, `/api/workspace/executors/${orgId}/suspension`, b.memberCookie, true)).statusCode
        ).toBe(HTTP_NOT_FOUND);
        const bad = await b.instance.inject({
            method: 'POST',
            url: `/api/workspace/executors/${mineId}/suspension`,
            headers: { cookie: b.memberCookie },
            payload: { suspended: 'yes' },
        });
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(b.executors.rows().every((r) => !r.suspended)).toBe(true);
    });

    it('survives a whole-list save of the same names, and a rename that carries the flag', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('a'), entry('b')]);
        await suspend(
            b,
            `/api/workspace/executors/${await personalId(b, 'a', b.memberCookie)}/suspension`,
            b.memberCookie,
            true
        );

        await putPersonal(b, b.memberCookie, [entry('a', { gateFixRounds: 1 }), entry('b')]);
        expect(b.executors.rows().map((r) => [r.name, r.suspended])).toEqual([
            ['a', true],
            ['b', false],
        ]);

        await putPersonal(b, b.memberCookie, [entry('a2', { suspended: true }), entry('b')]);
        expect(b.executors.rows().map((r) => [r.name, r.suspended])).toEqual([
            ['a2', true],
            ['b', false],
        ]);
    });
});

describe('organization profiles: suspend and resume', () => {
    it('is admin-only: a member gets 403 and the row is unchanged', async () => {
        const b = await boot();
        const id = await createOrg(b, 'shared');

        const response = await suspend(b, `/api/org/executors/${id}/suspension`, b.memberCookie, true);
        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
        expect(b.executors.rows()[0]!.suspended).toBe(false);
    });

    it('an admin suspends it for every member without exposing the config, and resumes it', async () => {
        const b = await boot();
        const id = await createOrg(b, 'shared');

        const response = await suspend(b, `/api/org/executors/${id}/suspension`, b.adminCookie, true);
        expect(response.statusCode).toBe(HTTP_OK);
        const seen = await poll(b, b.memberCookie);
        expect(seen.orgExecutors).toEqual([expect.objectContaining({ name: 'shared', suspended: true })]);
        expect(JSON.stringify(seen)).not.toContain('sonnet');
        const list = (
            await b.instance.inject({ method: 'GET', url: '/api/org/executors', headers: { cookie: b.memberCookie } })
        ).json();
        expect(list.executors[0]).toMatchObject({ suspended: true });
        expect(list.executors[0].config).toBeUndefined();

        await suspend(b, `/api/org/executors/${id}/suspension`, b.adminCookie, false);
        expect((await poll(b, b.memberCookie)).orgExecutors[0].suspended).toBe(false);
    });

    it('answers 404 for an unknown id and for a personal row reached through the org door', async () => {
        const b = await boot();
        await putPersonal(b, b.adminCookie, [entry('mine')]);
        const mineId = await personalId(b, 'mine', b.adminCookie);

        expect((await suspend(b, `/api/org/executors/${mineId}/suspension`, b.adminCookie, true)).statusCode).toBe(
            HTTP_NOT_FOUND
        );
        expect(b.executors.rows()[0]!.suspended).toBe(false);
    });
});

describe('defaults and the fallback chain', () => {
    it('refuses a suspended profile as the default with EXECUTOR_SUSPENDED and stores nothing', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        await suspend(
            b,
            `/api/workspace/executors/${await personalId(b, 'mine', b.memberCookie)}/suspension`,
            b.memberCookie,
            true
        );

        const response = await b.instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: b.memberCookie },
            payload: { executor: 'mine', executorScope: 'user' },
        });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('EXECUTOR_SUSPENDED');
        expect(b.executors.defaults()).toEqual([]);
    });

    it('falls back past suspended rows, personal before org, and restores the stored preference on resume', async () => {
        const b = await boot();
        const orgId = await createOrg(b, 'shared');
        await putPersonal(b, b.memberCookie, [entry('first'), entry('second')]);
        await b.instance.inject({
            method: 'PUT',
            url: '/api/workspace/executors/default',
            headers: { cookie: b.memberCookie },
            payload: { executor: 'second', executorScope: 'user' },
        });
        const secondId = await personalId(b, 'second', b.memberCookie);
        const firstId = await personalId(b, 'first', b.memberCookie);

        await suspend(b, `/api/workspace/executors/${secondId}/suspension`, b.memberCookie, true);
        expect((await poll(b, b.memberCookie)).defaultExecutor).toEqual({ scope: 'user', name: 'first' });

        await suspend(b, `/api/workspace/executors/${firstId}/suspension`, b.memberCookie, true);
        expect((await poll(b, b.memberCookie)).defaultExecutor).toEqual({ scope: 'org', name: 'shared' });

        await suspend(b, `/api/org/executors/${orgId}/suspension`, b.adminCookie, true);
        expect((await poll(b, b.memberCookie)).defaultExecutor).toBeNull();

        // The stored preference was never rewritten, so resuming restores it.
        await suspend(b, `/api/workspace/executors/${secondId}/suspension`, b.memberCookie, false);
        expect((await poll(b, b.memberCookie)).defaultExecutor).toEqual({ scope: 'user', name: 'second' });
    });
});

describe('POST /api/jobs against a suspended profile', () => {
    it('refuses with 409 EXECUTOR_SUSPENDED naming the profile, and queues nothing', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        await suspend(
            b,
            `/api/workspace/executors/${await personalId(b, 'mine', b.memberCookie)}/suspension`,
            b.memberCookie,
            true
        );

        const response = await queue(b, b.memberCookie, 'mine', 'user');
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('EXECUTOR_SUSPENDED');
        expect(response.json().error).toContain('"mine"');
        expect(b.queued).toEqual([]);
    });

    it('keeps scope identity: a suspended personal profile does not block the same-named org one', async () => {
        const b = await boot();
        await createOrg(b, 'same');
        await putPersonal(b, b.memberCookie, [entry('same')]);
        await suspend(
            b,
            `/api/workspace/executors/${await personalId(b, 'same', b.memberCookie)}/suspension`,
            b.memberCookie,
            true
        );

        expect((await queue(b, b.memberCookie, 'same', 'user')).statusCode).toBe(HTTP_CONFLICT);
        expect((await queue(b, b.memberCookie, 'same', 'org')).statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toEqual([expect.objectContaining({ executor: 'same', scope: 'org' })]);
    });

    it('accepts a profile again once it is resumed', async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        const url = `/api/workspace/executors/${await personalId(b, 'mine', b.memberCookie)}/suspension`;
        await suspend(b, url, b.memberCookie, true);
        await suspend(b, url, b.memberCookie, false);

        expect((await queue(b, b.memberCookie, 'mine', 'user')).statusCode).toBe(HTTP_CREATED);
    });
});

describe('POST /api/jobs against an unsynced repository (issue 263)', () => {
    const launch = (b: Booted, payload: Record<string, unknown>) =>
        b.instance.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie: b.memberCookie },
            payload: { command: 'echo hi', executor: 'mine', executorScope: 'user', ...payload },
        });

    const bootWithExecutor = async () => {
        const b = await boot();
        await putPersonal(b, b.memberCookie, [entry('mine')]);
        return b;
    };

    it('refuses a task with no repository, even though another repository is ready', async () => {
        const b = await bootWithExecutor();
        const response = await launch(b, {});
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('REPO_REQUIRED');
        expect(b.queued).toEqual([]);
    });

    it('refuses a repository that was never selected, even though another is ready', async () => {
        const b = await bootWithExecutor();
        const response = await launch(b, { repo: 'acme/other' });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('REPO_REQUIRED');
        expect(b.queued).toEqual([]);
    });

    it('refuses a repository deselected after the page loaded', async () => {
        const b = await bootWithExecutor();
        await b.repos.select(b.memberId, []);
        const response = await launch(b, { repo: 'acme/web' });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('REPO_REQUIRED');
        expect(b.queued).toEqual([]);
    });

    it.each(['queued', 'cloning', 'failed'] as const)('refuses a selected repository that is %s', async (status) => {
        const b = await bootWithExecutor();
        const target = { owner: 'acme', name: 'api' };
        await b.repos.select(b.memberId, [READY_REPO, target]);
        if (status === 'cloning') b.repos.strand(b.memberId, target);
        if (status === 'failed') await b.repos.markFailed(b.memberId, target, 'boom');

        const response = await launch(b, { repo: 'acme/api' });
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('REPO_NOT_READY');
        expect(response.json().error).toContain(status);
        expect(b.queued).toEqual([]);
    });

    it('queues a task against a selected, ready repository', async () => {
        const b = await bootWithExecutor();
        expect((await launch(b, { repo: 'acme/web' })).statusCode).toBe(HTTP_CREATED);
        expect(b.queued).toHaveLength(1);
    });
});
