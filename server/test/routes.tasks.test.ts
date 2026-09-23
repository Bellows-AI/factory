import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Job } from '../src/db/job-store-contract.js';
import type { JobStore, TaskListFilters, TaskListResponse } from '../src/db/job-store-read-model.js';
import { encodeCursor, memoryTaskList } from '../src/db/task-summary.js';
import {
    TEST_JOB_BOARD_TOKEN,
    githubAuth,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const ORG = 'test-org';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVICE_UNAVAILABLE = 503;

const UUID_SEGMENT_WIDTH = 12;

/** Root ids are uuids — the cursor binds one — so fixtures name threads by number. */
const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(UUID_SEGMENT_WIDTH, '0')}`;

const MS_PER_MINUTE = 60_000;

/** ISO stamps count backwards from a fixed base — `at(60)` is an hour before `at(5)`. */
const at = (minutes: number): string =>
    new Date(Date.parse('2026-09-10T12:00:00.000Z') - minutes * MS_PER_MINUTE).toISOString();

const job = (overrides: Partial<Job> & { id: string }): Job => ({
    command: 'crafted',
    status: 'queued',
    attempts: 1,
    maxAttempts: 3,
    claimedBy: null,
    createdBy: null,
    author: null,
    stoppedBy: null,
    doneBy: null,
    sessionId: null,
    remoteSessionId: null,
    exitCode: null,
    output: null,
    summary: null,
    gates: null,
    runtime: null,
    repo: null,
    executor: null,
    followUpTo: null,
    rootJobId: overrides.id,
    workflowNode: null,
    doneAt: null,
    cancelRequestedAt: null,
    workspacePath: null,
    createdAt: at(60),
    startedAt: null,
    finishedAt: null,
    wallClockMs: null,
    taskWallClockMs: null,
    ...overrides,
});

const HEAD_STARTED_MIN = 59;
const FOLLOWUP_ID = 11;
const FOLLOWUP_CREATED_MIN = 20;
const FOLLOWUP_STARTED_MIN = 19;
const DOCS_ID = 2;
const DOCS_CREATED_MIN = 50;
const DOCS_FINISHED_MIN = 45;
const FOOTER_ID = 3;
const FOOTER_CREATED_MIN = 40;
const FOOTER_FINISHED_MIN = 35;
const FOOTER_DONE_MIN = 30;

/**
 * The fixture board: one thread of each bucket, the running one carrying exactly the fields a
 * task summary must not leak — the output tail, the gate reports, the runtime object.
 */
const FIXTURE: Job[] = [
    job({
        id: uid(1),
        command: 'fix the login bug',
        status: 'running',
        createdAt: at(60),
        startedAt: at(HEAD_STARTED_MIN),
    }),
    job({
        id: uid(FOLLOWUP_ID),
        command: 'now adjust it',
        status: 'running',
        rootJobId: uid(1),
        followUpTo: uid(1),
        createdAt: at(FOLLOWUP_CREATED_MIN),
        startedAt: at(FOLLOWUP_STARTED_MIN),
        // The head run's run-detail fields — exactly what a task summary must not leak.
        output: 'a long tail',
        gates: [],
        runtime: { cpuPercent: 3, memUsedMb: 4, memPercent: 5, activity: 'the live line', sampledAt: at(1) },
    }),
    job({
        id: uid(DOCS_ID),
        command: 'write the docs',
        status: 'succeeded',
        createdAt: at(DOCS_CREATED_MIN),
        finishedAt: at(DOCS_FINISHED_MIN),
        summary: 'docs written',
    }),
    job({
        id: uid(FOOTER_ID),
        command: 'fix the footer',
        status: 'failed',
        createdAt: at(FOOTER_CREATED_MIN),
        finishedAt: at(FOOTER_FINISHED_MIN),
        doneAt: at(FOOTER_DONE_MIN),
        output: 'a finished tail',
    }),
];

interface TaskStub extends JobStore {
    asked: TaskListFilters[];
}

/**
 * A real read over a fixture array — `memoryTaskList`, the same rules the store serves — with the
 * filters each call saw recorded. Not a canned shape: the response contract is computed, so a
 * payload bug cannot agree with itself.
 */
const taskStub = (jobs: readonly Job[] = FIXTURE, options: { fail?: boolean } = {}): TaskStub => {
    const stub = {
        asked: [] as TaskListFilters[],
        async listTasks(filters: TaskListFilters): Promise<TaskListResponse> {
            if (options.fail) throw new Error('database is down');
            stub.asked.push(filters);
            return memoryTaskList(jobs, filters);
        },
    };
    return stub as unknown as TaskStub;
};

async function openHarness(jobs?: TaskStub) {
    const config = testConfig();
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs, telemetry: stubTelemetryClient() }),
    });
    app = instance;
    return instance;
}

async function githubHarness(jobs?: TaskStub, orgsFor?: readonly string[]) {
    const store = memoryAuthStore();
    const config = testConfig({ auth: githubAuth() });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs, telemetry: stubTelemetryClient(), ...(orgsFor ? { orgsFor } : {}) }),
        auth: store,
    });
    app = instance;
    return { instance, store };
}

const mint = (payload: Record<string, unknown>): string => Buffer.from(JSON.stringify(payload)).toString('base64url');

describe('GET /api/tasks', () => {
    it('answers the default attention page as exactly { navigation, page }', async () => {
        const store = taskStub();
        const instance = await openHarness(store);

        const response = await instance.inject({ method: 'GET', url: '/api/tasks' });

        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body.navigation.counts).toEqual({ running: 1, review: 1, past: 1 });
        // The previews are the org's, not the page's: one running thread, newest first.
        expect(body.navigation.running.map((item: { id: string }) => item.id)).toEqual([uid(1)]);
        expect(body.navigation.review.map((item: { id: string }) => item.id)).toEqual([uid(2)]);
        expect(body.page.nextCursor).toBeNull();
        // The row is exactly the summary contract — no output tail, no gate reports, no runtime
        // object, nothing the store row carried beyond what a task list renders.
        expect(body.page.items).toHaveLength(2);
        expect(body.page.items[0]).toEqual({
            id: uid(1),
            command: 'fix the login bug',
            status: 'running',
            cancelRequestedAt: null,
            doneAt: null,
            repo: null,
            executor: null,
            author: null,
            activity: 'the live line',
            summary: null,
            // No PR-wait rows in the in-memory board, so the fields read null — the stored shape.
            waitReason: null,
            waitingSince: null,
            waitTerminalReason: null,
            createdAt: at(60),
            activityAt: at(FOLLOWUP_STARTED_MIN),
        });
        expect(Object.keys(body.page.items[1])).toEqual([
            'id',
            'command',
            'status',
            'cancelRequestedAt',
            'doneAt',
            'repo',
            'executor',
            'author',
            'activity',
            'summary',
            'waitReason',
            'waitingSince',
            'waitTerminalReason',
            'createdAt',
            'activityAt',
        ]);
        expect(store.asked).toEqual([{ state: 'attention', sort: 'newest', limit: 30 }]);
    });

    it.each([
        ['attention', { running: 1, review: 1, past: 1 }, 2],
        ['running', { running: 1, review: 1, past: 1 }, 1],
        ['review', { running: 1, review: 1, past: 1 }, 1],
        ['past', { running: 1, review: 1, past: 1 }, 1],
    ])('answers the %s state — page filtered, navigation untouched', async (state, counts, expectedItems) => {
        const store = taskStub();
        const instance = await openHarness(store);

        const response = await instance.inject({ method: 'GET', url: `/api/tasks?state=${state}` });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().navigation.counts).toEqual(counts);
        expect(response.json().page.items).toHaveLength(expectedItems);
    });
});

describe('GET /api/tasks: filters and cursors', () => {
    it('passes every filter normalized to the store', async () => {
        const store = taskStub();
        const instance = await openHarness(store);

        const response = await instance.inject({
            method: 'GET',
            url: '/api/tasks?state=running&q=%20fix%20&repo=acme/web&author=Cat&sort=oldest&limit=7',
        });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(store.asked).toEqual([
            { state: 'running', q: 'fix', repo: 'acme/web', author: 'cat', sort: 'oldest', limit: 7 },
        ]);
    });

    const OVER_QUERY_LIMIT = 201;
    const OVER_AUTHOR_LIMIT = 101;
    const STALE_CURSOR_ACTIVITY_MIN = 30;
    const STALE_CURSOR_ROOT_ID = 99;

    it.each([
        ['an unknown state', '/api/tasks?state=whenever', 'BAD_TASK_STATE'],
        ['an over-long query', `/api/tasks?q=${'x'.repeat(OVER_QUERY_LIMIT)}`, 'BAD_QUERY'],
        ['a repeated query key', '/api/tasks?q=one&q=two', 'BAD_QUERY'],
        ['a malformed repository', '/api/tasks?repo=nope', 'BAD_REPO'],
        ['an over-long author', `/api/tasks?author=${'x'.repeat(OVER_AUTHOR_LIMIT)}`, 'BAD_AUTHOR'],
        ['an author with a space', '/api/tasks?author=octo%20cat', 'BAD_AUTHOR'],
        ['an unknown sort', '/api/tasks?sort=funny', 'BAD_SORT'],
        ['a zero limit', '/api/tasks?limit=0', 'BAD_LIMIT'],
        ['an over-cap limit', '/api/tasks?limit=51', 'BAD_LIMIT'],
        ['a non-numeric limit', '/api/tasks?limit=lots', 'BAD_LIMIT'],
        ['a garbage cursor', '/api/tasks?cursor=garbage', 'BAD_CURSOR'],
        [
            'a stale-version cursor',
            `/api/tasks?cursor=${mint({
                v: 99,
                sort: 'newest',
                state: 'attention',
                activityAt: at(STALE_CURSOR_ACTIVITY_MIN),
                rootId: uid(STALE_CURSOR_ROOT_ID),
            })}`,
            'BAD_CURSOR',
        ],
        [
            'a cursor minted for another sort',
            `/api/tasks?sort=oldest&cursor=${encodeCursor({
                sort: 'newest',
                state: 'attention',
                activityAt: at(STALE_CURSOR_ACTIVITY_MIN),
                rootId: uid(STALE_CURSOR_ROOT_ID),
            })}`,
            'BAD_CURSOR',
        ],
        [
            'a cursor minted under other filters',
            `/api/tasks?q=other&cursor=${encodeCursor({
                sort: 'newest',
                state: 'attention',
                q: 'crafted',
                activityAt: at(STALE_CURSOR_ACTIVITY_MIN),
                rootId: uid(STALE_CURSOR_ROOT_ID),
            })}`,
            'BAD_CURSOR',
        ],
    ])('refuses %s', async (_label, url, code) => {
        const instance = await openHarness(taskStub());
        const response = await instance.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe(code);
    });

    it('accepts a cursor this endpoint minted', async () => {
        const MINTED_ACTIVITY_MIN = 30;
        const MINTED_ROOT_ID = 99;
        const store = taskStub();
        const instance = await openHarness(store);
        const cursor = encodeCursor({
            sort: 'newest',
            state: 'attention',
            q: 'fix the',
            activityAt: at(MINTED_ACTIVITY_MIN),
            rootId: uid(MINTED_ROOT_ID),
        });

        const response = await instance.inject({ method: 'GET', url: `/api/tasks?q=fix%20the&cursor=${cursor}` });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(store.asked[0]).toMatchObject({ q: 'fix the', cursor });
    });
});

describe('GET /api/tasks: failures', () => {
    it('answers 503 when the store fails, without echoing the query', async () => {
        const instance = await openHarness(taskStub([], { fail: true }));
        const response = await instance.inject({ method: 'GET', url: '/api/tasks?q=claude%20-p%20secret-prompt' });
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(JSON.stringify(response.json())).not.toContain('secret-prompt');
    });

    it('answers 503 when the org has no job board', async () => {
        const instance = await openHarness(undefined);
        const response = await instance.inject({ method: 'GET', url: '/api/tasks' });
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json().code).toBe('JOBS_UNAVAILABLE');
    });
});

describe('GET /api/tasks authorization', () => {
    it('401s an anonymous caller', async () => {
        const { instance } = await githubHarness(taskStub());
        const response = await instance.inject({ method: 'GET', url: '/api/tasks' });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it('answers a signed-in member', async () => {
        const { instance, store } = await githubHarness(taskStub());
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        const response = await instance.inject({ method: 'GET', url: '/api/tasks', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('accepts a personal access token', async () => {
        const { instance, store } = await githubHarness(taskStub());
        const caller = store.seedMember(ORG, 'octocat');
        const token = store.seedAccessToken(ORG, 'personal', { userId: caller.user.id });
        const response = await instance.inject({
            method: 'GET',
            url: '/api/tasks',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('refuses the worker secret — the read model is a person route', async () => {
        const { instance } = await githubHarness(taskStub());
        const response = await instance.inject({
            method: 'GET',
            url: '/api/tasks',
            headers: { authorization: `Bearer ${TEST_JOB_BOARD_TOKEN}` },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(response.json().code).toBe('UNAUTHENTICATED');
    });

    it('resolves the organization from the credential, never the query', async () => {
        const { instance, store } = await githubHarness(taskStub(), [ORG]);
        const caller = store.seedMember(ORG, 'octocat');
        const cookie = await signedIn(store, caller);
        // The registry answers only for the caller's own org; a query param naming another one
        // must change nothing — the route never reads an org from the query.
        const response = await instance.inject({
            method: 'GET',
            url: '/api/tasks?org=somewhere-else',
            headers: { cookie },
        });
        expect(response.statusCode).toBe(HTTP_OK);
    });
});
