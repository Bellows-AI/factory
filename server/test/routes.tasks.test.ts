import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRuntime } from '../src/orgs.js';
import { createStatsService } from '../src/stats-service.js';
import {
    buildTaskPage,
    type JobStore,
    type TaskCursorPosition,
    type TaskListFilters,
    type TaskSummary,
} from '../src/db/job-store.js';
import type { AuthStore } from '../src/auth/store.js';
import {
    githubAuth,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
    TEST_JOB_BOARD_TOKEN,
} from './helpers.js';
import { decodeTaskCursor, encodeTaskCursor } from '../src/routes/tasks.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';

let seq = 0;
const task = (over: Partial<TaskSummary> = {}): TaskSummary => {
    seq += 1;
    return {
        id: over.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        command: over.command ?? 'fix the flaky login test',
        status: over.status ?? 'succeeded',
        cancelRequestedAt: over.cancelRequestedAt ?? null,
        doneAt: over.doneAt ?? null,
        repo: over.repo ?? 'acme/widgets',
        executor: over.executor ?? null,
        author: over.author ?? null,
        activity: over.activity ?? null,
        summary: over.summary ?? null,
        createdAt: over.createdAt ?? over.activityAt ?? '2026-09-01T00:00:00.000Z',
        activityAt: over.activityAt ?? '2026-09-01T00:00:00.000Z',
    };
};

/** Two review tasks and one running one, spread over activity stamps 3..1. */
const inbox = (): TaskSummary[] => [
    task({ status: 'running', activityAt: '2026-09-01T00:03:00.000Z' }),
    task({ activityAt: '2026-09-01T00:02:00.000Z' }),
    task({ activityAt: '2026-09-01T00:01:00.000Z', repo: 'acme/gears' }),
    task({ doneAt: '2026-09-01T00:00:30.000Z', activityAt: '2026-09-01T00:00:30.000Z' }),
];

/**
 * A store whose listTasks IS the real pure implementation over canned rows — the HTTP contract
 * (validation, cursor binding, response shape) is what these tests pin; the filter and cursor
 * semantics behind it are already pinned by job-store.tasks.test.ts. Everything else throws: a
 * route that reaches for another method is a route this suite does not describe.
 */
const storeOf = (tasks: TaskSummary[]): JobStore =>
    ({
        listTasks: (filters: TaskListFilters) => buildTaskPage(tasks, filters),
    }) as unknown as JobStore;

async function harnessWith(jobs?: JobStore): Promise<FastifyInstance> {
    const config = testConfig();
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs, telemetry: stubTelemetryClient() }),
    });
    app = instance;
    return instance;
}

/** A github-mode harness with one org per store, so a signed-in member reads only their org's. */
async function harnessOfOrgs(
    orgs: readonly (readonly [string, JobStore])[],
    auth: { store: AuthStore }
): Promise<FastifyInstance> {
    const config = testConfig({ auth: githubAuth() });
    const runtimes = new Map<string, OrgRuntime>(
        orgs.map(([orgId, jobs]): [string, OrgRuntime] => {
            const repos = staticRepoSource([]);
            const telemetry = stubTelemetryClient();
            return [
                orgId,
                { orgId, repos, telemetry, service: createStatsService({ config, repos, telemetry }), jobs },
            ];
        })
    );
    const instance = await buildApp({
        config,
        auth: auth.store,
        orgs: {
            ...staticRegistry({ config, telemetry: stubTelemetryClient() }),
            for: async (orgId) => runtimes.get(orgId) ?? null,
            list: async () => orgs.map(([orgId]) => ({ id: orgId, name: orgId, installationId: null })),
        } as never,
        warmAll: undefined,
    } as never);
    app = instance;
    return instance;
}

describe('GET /api/tasks', () => {
    it('answers the default attention page with exactly { navigation, page }', async () => {
        const tasks = inbox();
        const instance = await harnessWith(storeOf(tasks));

        const response = await instance.inject({ method: 'GET', url: '/api/tasks' });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(Object.keys(body).sort()).toEqual(['navigation', 'page']);
        expect(body.navigation.counts).toEqual({ running: 1, review: 2, past: 1 });
        // attention = running + review, newest first; the past task is page-invisible.
        expect(body.page.items.map((t: TaskSummary) => t.activityAt)).toEqual([
            '2026-09-01T00:03:00.000Z',
            '2026-09-01T00:02:00.000Z',
            '2026-09-01T00:01:00.000Z',
        ]);
    });

    it('serves each state filter and leaves navigation filter-independent', async () => {
        const tasks = inbox();
        const instance = await harnessWith(storeOf(tasks));

        const running = await instance.inject({ method: 'GET', url: '/api/tasks?state=running' });
        expect(running.json().page.items.map((t: TaskSummary) => t.status)).toEqual(['running']);
        expect(running.json().navigation.counts).toEqual({ running: 1, review: 2, past: 1 });

        const past = await instance.inject({ method: 'GET', url: '/api/tasks?state=past' });
        expect(past.json().page.items.map((t: TaskSummary) => t.status)).toEqual(['succeeded']);
        expect(past.json().navigation.counts).toEqual({ running: 1, review: 2, past: 1 });
    });

    it('filters by search, repository, author and sort, alone and combined', async () => {
        const tasks = [
            task({ command: 'Fix the LOGIN flow', repo: 'acme/widgets', activityAt: '2026-09-01T00:05:00.000Z' }),
            task({ command: 'add a changelog', repo: 'acme/gears', activityAt: '2026-09-01T00:04:00.000Z' }),
            task({ command: 'fix the login again', repo: 'acme/widgets', activityAt: '2026-09-01T00:03:00.000Z' }),
        ];
        const instance = await harnessWith(storeOf(tasks));
        const ids = async (url: string) =>
            (await instance.inject({ method: 'GET', url })).json().page.items.map((t: TaskSummary) => t.command);

        expect(await ids('/api/tasks?q=login')).toEqual(['Fix the LOGIN flow', 'fix the login again']);
        expect(await ids('/api/tasks?repo=acme/gears')).toEqual(['add a changelog']);
        expect(await ids('/api/tasks?sort=oldest')).toEqual([
            'fix the login again',
            'add a changelog',
            'Fix the LOGIN flow',
        ]);
        expect(await ids('/api/tasks?q=login&repo=acme/widgets&sort=oldest')).toEqual([
            'fix the login again',
            'Fix the LOGIN flow',
        ]);
    });

    it.each([
        ['an unknown state', '/api/tasks?state=nope', 'BAD_TASK_STATE'],
        ['a repeated state key', '/api/tasks?state=running&state=past', 'BAD_TASK_STATE'],
        ['a repeated limit key', '/api/tasks?limit=10&limit=20', 'BAD_LIMIT'],
        ['an oversized search', `/api/tasks?q=${'x'.repeat(201)}`, 'BAD_QUERY'],
        ['a malformed repo', '/api/tasks?repo=not-owner-slash-name', 'BAD_REPO'],
        ['a malformed author', '/api/tasks?author=-bad-', 'BAD_AUTHOR'],
        ['an oversized author', `/api/tasks?author=${'x'.repeat(101)}`, 'BAD_AUTHOR'],
        ['an unknown sort', '/api/tasks?sort=soon', 'BAD_SORT'],
        ['a zero limit', '/api/tasks?limit=0', 'BAD_LIMIT'],
        ['an oversized limit', '/api/tasks?limit=51', 'BAD_LIMIT'],
        ['a non-integer limit', '/api/tasks?limit=3.5', 'BAD_LIMIT'],
        ['a malformed cursor', '/api/tasks?cursor=@@@', 'BAD_CURSOR'],
    ])('refuses %s', async (_label, url, code) => {
        const instance = await harnessWith(storeOf(inbox()));
        const response = await instance.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
    });

    it('bounds the limit at 50 and passes it through', async () => {
        const tasks = Array.from({ length: 45 }, (_, i) =>
            task({ activityAt: `2026-09-01T00:${String(i).padStart(2, '0')}:00.000Z` })
        );
        const instance = await harnessWith(storeOf(tasks));

        const page = await instance.inject({ method: 'GET', url: '/api/tasks?limit=50' });
        expect(page.statusCode).toBe(200);
        expect(page.json().page.items).toHaveLength(45);
        expect(page.json().page.nextCursor).toBeNull();
    });

    describe('pagination', () => {
        const tasks = Array.from({ length: 5 }, (_, i) => task({ activityAt: `2026-09-01T00:0${i}:00.000Z` }));

        it('hands out pages through an opaque cursor, ending in a null one', async () => {
            const instance = await harnessWith(storeOf(tasks));

            const first = await instance.inject({ method: 'GET', url: '/api/tasks?limit=2' });
            expect(first.json().page.items).toHaveLength(2);
            const cursor = first.json().page.nextCursor;
            expect(typeof cursor).toBe('string');

            const second = await instance.inject({ method: 'GET', url: `/api/tasks?limit=2&cursor=${cursor}` });
            const seen = [...first.json().page.items, ...second.json().page.items].map((t: TaskSummary) => t.id);
            expect(new Set(seen).size).toBe(seen.length);

            const third = await instance.inject({
                method: 'GET',
                url: `/api/tasks?limit=2&cursor=${second.json().page.nextCursor}`,
            });
            expect(third.json().page.items).toHaveLength(1);
            expect(third.json().page.nextCursor).toBeNull();
        });

        it('refuses a cursor issued for a different question', async () => {
            const instance = await harnessWith(storeOf(tasks));
            const first = await instance.inject({ method: 'GET', url: '/api/tasks?limit=2&state=attention' });
            const cursor = first.json().page.nextCursor as string;

            // Same position, different question: a stale or foreign cursor is a 400, never a page.
            for (const url of [
                `/api/tasks?limit=2&state=past&cursor=${cursor}`,
                `/api/tasks?limit=2&sort=oldest&cursor=${cursor}`,
                `/api/tasks?limit=2&q=needle&cursor=${cursor}`,
                `/api/tasks?limit=2&repo=acme/gears&cursor=${cursor}`,
                `/api/tasks?limit=2&author=octo&cursor=${cursor}`,
            ]) {
                const response = await instance.inject({ method: 'GET', url });
                expect(response.statusCode).toBe(400);
                expect(response.json().code).toBe('BAD_CURSOR');
            }
        });

        it('refuses a cursor of a foreign version or shape', async () => {
            const instance = await harnessWith(storeOf(tasks));
            const foreign = (payload: Record<string, unknown>) =>
                encodeTaskCursor({
                    v: 1,
                    sort: 'newest',
                    state: 'attention',
                    q: null,
                    repo: null,
                    author: null,
                    activityAt: '2026-09-01T00:00:00.000Z',
                    rootId: '00000000-0000-4000-8000-000000000000',
                    ...payload,
                } as never);

            for (const cursor of [
                encodeTaskCursor({
                    v: 2,
                    sort: 'newest',
                    state: 'attention',
                    q: null,
                    repo: null,
                    author: null,
                    activityAt: '2026-09-01T00:00:00.000Z',
                    rootId: '00000000-0000-4000-8000-000000000000',
                } as never),
                foreign({ activityAt: 'not a timestamp' }),
                foreign({ rootId: 'not-a-uuid' }),
            ]) {
                const response = await instance.inject({ method: 'GET', url: `/api/tasks?limit=2&cursor=${cursor}` });
                expect(response.statusCode).toBe(400);
                expect(response.json().code).toBe('BAD_CURSOR');
            }
        });

        it('round-trips through decode only for the question it was issued with', () => {
            const expected = {
                sort: 'newest' as const,
                state: 'attention' as const,
                q: null,
                repo: null,
                author: null,
            };
            const cursor = encodeTaskCursor({
                v: 1,
                ...expected,
                activityAt: '2026-09-01T00:00:00.000Z',
                rootId: '00000000-0000-4000-8000-000000000000',
            });
            expect(decodeTaskCursor(cursor, expected)).toEqual({
                activityAt: '2026-09-01T00:00:00.000Z',
                rootId: '00000000-0000-4000-8000-000000000000',
            });
            expect(decodeTaskCursor(cursor, { ...expected, sort: 'oldest' })).toBeNull();
            expect(decodeTaskCursor('not base64url json at all', expected)).toBeNull();
        });
    });

    it('answers 503 JOBS_UNAVAILABLE when the organization has no job board', async () => {
        const instance = await harnessWith(undefined);
        const response = await instance.inject({ method: 'GET', url: '/api/tasks' });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('JOBS_UNAVAILABLE');
    });

    it('maps a store failure to 503', async () => {
        const failing = {
            listTasks: () => {
                throw new Error('database is down');
            },
        } as unknown as JobStore;
        const instance = await harnessWith(failing);
        const response = await instance.inject({ method: 'GET', url: '/api/tasks' });
        expect(response.statusCode).toBe(503);
    });

    it('refuses the shared worker token', async () => {
        const config = testConfig({ auth: githubAuth() });
        const instance = await buildApp({
            config,
            auth: memoryAuthStore(),
            orgs: staticRegistry({ config, jobs: storeOf(inbox()), telemetry: stubTelemetryClient() }),
        });
        app = instance;
        const response = await instance.inject({
            method: 'GET',
            url: '/api/tasks',
            headers: { authorization: `Bearer ${TEST_JOB_BOARD_TOKEN}` },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it("scopes the read to the signed-in member's organization", async () => {
        const store = memoryAuthStore();
        const here = storeOf([task({ command: 'mine' })]);
        const there = storeOf([task({ command: 'theirs' })]);
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        await harnessOfOrgs(
            [
                [ORG, here],
                [OTHER_ORG, there],
            ],
            { store }
        );
        const instance = app!;

        const response = await instance.inject({ method: 'GET', url: '/api/tasks', headers: { cookie } });
        expect(response.statusCode).toBe(200);
        expect(response.json().page.items.map((t: TaskSummary) => t.command)).toEqual(['mine']);
        expect(response.json().navigation.counts).toEqual({ running: 0, review: 1, past: 0 });
    });

    it('carries no run payload: no output, no gates, no runtime config', async () => {
        const instance = await harnessWith(storeOf(inbox()));
        const response = await instance.inject({ method: 'GET', url: '/api/tasks' });
        const body = response.json();
        for (const summary of [...body.page.items, ...body.navigation.running, ...body.navigation.review]) {
            expect(Object.keys(summary).sort()).toEqual([
                'activity',
                'activityAt',
                'author',
                'cancelRequestedAt',
                'command',
                'createdAt',
                'doneAt',
                'executor',
                'id',
                'repo',
                'status',
                'summary',
            ]);
        }
    });
});

describe('cursor encode/decode', () => {
    const expected = {
        sort: 'newest' as const,
        state: 'running' as const,
        q: 'fix',
        repo: 'acme/widgets',
        author: 'octo',
    };
    const position: TaskCursorPosition = {
        activityAt: '2026-09-01T00:00:00.000Z',
        rootId: '00000000-0000-4000-8000-000000000000',
    };

    it('round-trips the position with the filters bound', () => {
        const cursor = encodeTaskCursor({ v: 1, ...expected, ...position });
        expect(decodeTaskCursor(cursor, expected)).toEqual(position);
    });

    it('refuses any mismatch with the asking question', () => {
        const cursor = encodeTaskCursor({ v: 1, ...expected, ...position });
        for (const drift of [
            { ...expected, sort: 'oldest' as const },
            { ...expected, state: 'past' as const },
            { ...expected, q: null },
            { ...expected, repo: null },
            { ...expected, author: null },
        ]) {
            expect(decodeTaskCursor(cursor, drift)).toBeNull();
        }
    });
});
