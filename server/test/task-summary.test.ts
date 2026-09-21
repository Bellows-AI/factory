import { describe, expect, it } from 'vitest';
import type { Job, JobStatus, TaskListFilters } from '../src/db/job-store.js';
import { activityAtOf, decodeCursor, encodeCursor, memoryTaskList, taskBucket } from '../src/db/task-summary.js';

/** ISO stamps count backwards from a fixed base — `at(60)` is an hour before `at(5)`. */
const at = (minutes: number): string =>
    new Date(Date.parse('2026-09-10T12:00:00.000Z') - minutes * 60_000).toISOString();

const ID = '11111111-1111-4111-8111-111111111111';

/**
 * Root ids are uuids — the cursor binds one, and only a uuid may ride in it — so the tests name
 * roots by number and get a deterministic, lexicographically ordered uuid back.
 */
const tid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A full Job row with sane defaults, overridden per test — the store's own shape, not a lookalike. */
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
    createdAt: '2026-09-01T12:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    wallClockMs: null,
    taskWallClockMs: null,
    ...overrides,
});

/** A root plus its follow-ups: each run is a newer row sharing the root's thread id. */
const task = (
    id: string,
    overrides: Partial<Job> = {},
    ...runs: { id: string; status: JobStatus; createdMinutesAgo?: number }[]
): Job[] => [
    job({ id, ...overrides }),
    ...runs.map((run) => job({ ...run, rootJobId: id, followUpTo: id, createdAt: at(run.createdMinutesAgo ?? 5) })),
];

describe('taskBucket', () => {
    it('buckets queued, running and standby as running, done stamp or not', () => {
        for (const status of ['queued', 'running', 'standby'] as const) {
            expect(taskBucket(status, null)).toBe('running');
            expect(taskBucket(status, at(5))).toBe('running');
        }
    });

    it('buckets a terminal run without the user done as review', () => {
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            expect(taskBucket(status, null)).toBe('review');
        }
    });

    it('buckets a terminal run the user declared done as past', () => {
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            expect(taskBucket(status as JobStatus, at(5))).toBe('past');
        }
    });
});

describe('activityAtOf', () => {
    it('takes the newest of the head stamps, ignoring the absent ones', () => {
        expect(activityAtOf({ createdAt: at(60), startedAt: at(50), finishedAt: null, doneAt: null })).toBe(at(50));
        expect(activityAtOf({ createdAt: at(60), startedAt: at(50), finishedAt: at(10), doneAt: at(5) })).toBe(at(5));
        expect(activityAtOf({ createdAt: at(60), startedAt: null, finishedAt: null, doneAt: at(30) })).toBe(at(30));
    });
});

describe('the task cursor', () => {
    const mint = (payload: Record<string, unknown>): string =>
        Buffer.from(JSON.stringify(payload)).toString('base64url');

    it('round trips through base64url', () => {
        const cursor = encodeCursor({ sort: 'newest', state: 'running', activityAt: at(3), rootId: ID });
        expect(cursor).not.toMatch(/[+/=]/);
        expect(decodeCursor(cursor, { sort: 'newest', state: 'running' })).toEqual({
            v: 1,
            sort: 'newest',
            state: 'running',
            activityAt: at(3),
            rootId: ID,
        });
    });

    it('answers null for a malformed payload', () => {
        expect(decodeCursor('not base64!!', { sort: 'newest', state: 'attention' })).toBeNull();
        expect(decodeCursor(mint({ v: 1 }), { sort: 'newest', state: 'attention' })).toBeNull();
    });

    it('binds the sort and every normalized filter', () => {
        const cursor = encodeCursor({
            sort: 'newest',
            state: 'review',
            q: 'fix',
            repo: 'a/b',
            author: 'cat',
            activityAt: at(3),
            rootId: ID,
        });
        expect(decodeCursor(cursor, { sort: 'newest', state: 'attention' })).toBeNull();
        expect(decodeCursor(cursor, { sort: 'oldest', state: 'review' })).toBeNull();
        expect(decodeCursor(cursor, { sort: 'newest', state: 'review', q: 'fix', repo: 'a/b', author: 'cat' })).toEqual(
            {
                v: 1,
                sort: 'newest',
                state: 'review',
                q: 'fix',
                repo: 'a/b',
                author: 'cat',
                activityAt: at(3),
                rootId: ID,
            }
        );
        // An absent filter is itself a bound value: a cursor minted under one must not spend under
        // the other.
        expect(decodeCursor(cursor, { sort: 'newest', state: 'review', q: 'fix', repo: 'a/b' })).toBeNull();
        expect(
            decodeCursor(cursor, { sort: 'newest', state: 'review', q: 'other', repo: 'a/b', author: 'cat' })
        ).toBeNull();
        expect(
            decodeCursor(cursor, { sort: 'newest', state: 'review', q: 'fix', repo: 'other/one', author: 'cat' })
        ).toBeNull();
        expect(
            decodeCursor(cursor, { sort: 'newest', state: 'review', q: 'fix', repo: 'a/b', author: 'other' })
        ).toBeNull();
    });

    it('answers null on a stale version', () => {
        const payload = JSON.parse(
            Buffer.from(
                encodeCursor({ sort: 'newest', state: 'running', activityAt: at(3), rootId: ID }),
                'base64url'
            ).toString()
        ) as Record<string, unknown>;
        expect(decodeCursor(mint({ ...payload, v: 99 }), { sort: 'newest', state: 'running' })).toBeNull();
    });

    it('answers null when the stamp or root id is not the shape it minted', () => {
        expect(
            decodeCursor(mint({ v: 1, sort: 'newest', state: 'running', activityAt: 'nope', rootId: ID }), {
                sort: 'newest',
                state: 'running',
            })
        ).toBeNull();
        // Parseable but not the exact ISO shape the encoder mints: it would survive decode and
        // die at the SQL cast later — a 503 where BAD_CURSOR is the truthful answer.
        expect(
            decodeCursor(mint({ v: 1, sort: 'newest', state: 'running', activityAt: 'Sept 5 2026', rootId: ID }), {
                sort: 'newest',
                state: 'running',
            })
        ).toBeNull();
        expect(
            decodeCursor(mint({ v: 1, sort: 'newest', state: 'running', activityAt: at(3), rootId: 'nope' }), {
                sort: 'newest',
                state: 'running',
            })
        ).toBeNull();
    });
});

describe('memoryTaskList', () => {
    const filters = (overrides: Partial<TaskListFilters> = {}): TaskListFilters => ({
        state: 'attention',
        sort: 'newest',
        limit: 30,
        ...overrides,
    });

    it('folds a thread into one summary: identity from the root, present tense from the head', () => {
        const jobs = task(
            tid(1),
            {
                command: 'the opening ask',
                repo: 'acme/widgets',
                executor: 'main',
                author: { id: 'u1', login: 'cat', name: 'Cat', avatarUrl: null },
                status: 'succeeded',
                createdAt: at(60),
                finishedAt: at(50),
                summary: 'root words',
            },
            { id: tid(11), status: 'running', createdMinutesAgo: 20 }
        );
        jobs[1]!.runtime = { cpuPercent: 1, memUsedMb: 2, memPercent: 3, activity: 'the live line', sampledAt: at(1) };

        const { navigation, page } = memoryTaskList(jobs, filters());
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toEqual({
            id: tid(1),
            command: 'the opening ask',
            status: 'running',
            cancelRequestedAt: null,
            doneAt: null,
            repo: 'acme/widgets',
            executor: 'main',
            author: { id: 'u1', login: 'cat', name: 'Cat', avatarUrl: null },
            activity: 'the live line',
            summary: null,
            // The in-memory engine carries no PR-wait rows; the SQL engine's lateral join
            // populates these for a thread that ever waited.
            waitReason: null,
            waitingSince: null,
            waitTerminalReason: null,
            createdAt: at(60),
            activityAt: at(20),
        });
        expect(navigation.counts).toEqual({ running: 1, review: 0, past: 0 });
    });

    it('takes the close-time summary from the head run', () => {
        const jobs = task(
            tid(1),
            {
                status: 'succeeded',
                createdAt: at(60),
                finishedAt: at(55),
                summary: 'root words',
            },
            { id: tid(11), status: 'succeeded', createdMinutesAgo: 40 }
        );
        jobs[1]!.finishedAt = at(35);
        jobs[1]!.summary = 'last words';

        const { page } = memoryTaskList(jobs, filters({ state: 'review' }));
        expect(page.items[0]).toMatchObject({ status: 'succeeded', summary: 'last words', activityAt: at(35) });
    });

    it('resurrects a done task with a queued follow-up — running again, done gone', () => {
        const jobs = task(
            tid(1),
            { status: 'succeeded', createdAt: at(60), finishedAt: at(50), doneAt: at(40) },
            {
                id: tid(11),
                status: 'queued',
                createdMinutesAgo: 10,
            }
        );
        const { navigation, page } = memoryTaskList(jobs, filters());
        expect(page.items[0]).toMatchObject({ status: 'queued', doneAt: null });
        expect(navigation.counts).toEqual({ running: 1, review: 0, past: 0 });
    });

    it('lists one task per root and never a follow-up itself', () => {
        const jobs = [
            ...task(
                tid(1),
                { status: 'succeeded', createdAt: at(60), finishedAt: at(55), doneAt: at(50) },
                {
                    id: tid(11),
                    status: 'succeeded',
                    createdMinutesAgo: 40,
                }
            ),
            ...task(tid(2), { status: 'failed', createdAt: at(30), finishedAt: at(20) }),
        ];
        const { page } = memoryTaskList(jobs, filters({ state: 'attention' }));
        expect(page.items.map((item) => item.id)).toEqual([tid(2), tid(1)]);
    });

    it('keeps navigation counts and previews global while the page obeys the filters', () => {
        const jobs = [
            ...task(tid(1), { command: 'fix the login bug', status: 'running', createdAt: at(60), startedAt: at(59) }),
            ...task(tid(2), {
                command: 'write the docs',
                repo: 'acme/widgets',
                status: 'succeeded',
                createdAt: at(50),
                finishedAt: at(45),
            }),
            ...task(tid(3), {
                command: 'fix the footer',
                status: 'failed',
                createdAt: at(40),
                finishedAt: at(35),
                doneAt: at(30),
            }),
            ...task(tid(4), {
                repo: 'acme/other',
                status: 'succeeded',
                createdAt: at(20),
                finishedAt: at(15),
                doneAt: at(10),
            }),
        ];
        const { navigation, page } = memoryTaskList(jobs, filters({ state: 'review', repo: 'acme/widgets' }));
        expect(navigation.counts).toEqual({ running: 1, review: 1, past: 2 });
        expect(page.items.map((item) => item.id)).toEqual([tid(2)]);
    });

    it('caps the running preview at three and the review preview at five, newest first', () => {
        const jobs: Job[] = [];
        for (let i = 0; i < 5; i++)
            jobs.push(...task(tid(20 + i), { status: 'running', createdAt: at(i + 2), startedAt: at(i + 1) }));
        for (let i = 0; i < 7; i++)
            jobs.push(...task(tid(40 + i), { status: 'succeeded', createdAt: at(i + 2), finishedAt: at(i + 1) }));
        const { navigation } = memoryTaskList(jobs, filters({ state: 'past' }));
        expect(navigation.running.map((item) => item.id)).toEqual([tid(20), tid(21), tid(22)]);
        expect(navigation.review.map((item) => item.id)).toEqual([tid(40), tid(41), tid(42), tid(43), tid(44)]);
        expect(navigation.counts).toEqual({ running: 5, review: 7, past: 0 });
    });

    it('searches the root command case-insensitively, never a follow-up command', () => {
        const jobs = [
            ...task(
                tid(1),
                { command: 'Fix the LOGIN flow', status: 'running', createdAt: at(60) },
                {
                    id: tid(11),
                    status: 'running',
                    createdMinutesAgo: 10,
                }
            ),
            ...task(
                tid(2),
                { command: 'unrelated', status: 'succeeded', createdAt: at(50), finishedAt: at(45) },
                {
                    id: tid(12),
                    status: 'succeeded',
                    createdMinutesAgo: 10,
                }
            ),
        ];
        jobs[3]!.command = 'touch the login page later';
        const { page } = memoryTaskList(jobs, filters({ q: 'LOGIN' }));
        expect(page.items.map((item) => item.id)).toEqual([tid(1)]);
    });

    it('filters by author case-insensitively', () => {
        const jobs = [
            ...task(tid(1), {
                status: 'running',
                createdAt: at(60),
                author: { id: 'u1', login: 'Octocat', name: null, avatarUrl: null },
            }),
            ...task(tid(2), { status: 'running', createdAt: at(50) }),
        ];
        const { page } = memoryTaskList(jobs, filters({ author: 'octocat' }));
        expect(page.items.map((item) => item.id)).toEqual([tid(1)]);
    });

    it('paginates newest first on (activityAt, id) without duplicates or omissions', () => {
        const jobs: Job[] = [];
        for (let i = 0; i < 7; i++) jobs.push(...task(tid(i + 1), { status: 'running', createdAt: at(i + 1) }));
        // Two roots sharing one activity stamp: the id descending breaks the tie.
        jobs.push(...task(tid(80), { status: 'running', createdAt: at(50) }));
        jobs.push(...task(tid(79), { status: 'running', createdAt: at(50) }));

        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard++) {
            const { page } = memoryTaskList(jobs, { ...filters({ limit: 3 }), ...(cursor ? { cursor } : {}) });
            seen.push(...page.items.map((item) => item.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
        }
        expect(seen).toEqual([tid(1), tid(2), tid(3), tid(4), tid(5), tid(6), tid(7), tid(80), tid(79)]);
    });

    it('splits an exactly-tied pair across a page boundary', () => {
        // Three roots on one activity stamp: the exclusive (activityAt, id) comparison must hand
        // the third over whole — neither duplicated nor skipped.
        const jobs = [
            ...task(tid(3), { status: 'running', createdAt: at(30) }),
            ...task(tid(2), { status: 'running', createdAt: at(30) }),
            ...task(tid(1), { status: 'running', createdAt: at(30) }),
        ];
        const first = memoryTaskList(jobs, filters({ limit: 2 }));
        expect(first.page.items.map((item) => item.id)).toEqual([tid(3), tid(2)]);
        const second = memoryTaskList(jobs, { ...filters({ limit: 2 }), cursor: first.page.nextCursor! });
        expect(second.page.items.map((item) => item.id)).toEqual([tid(1)]);
        expect(second.page.nextCursor).toBeNull();
    });

    it('paginates oldest first under its own direction', () => {
        const jobs: Job[] = [];
        for (let i = 0; i < 5; i++) jobs.push(...task(tid(i + 1), { status: 'running', createdAt: at(i + 1) }));
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard++) {
            const { page } = memoryTaskList(jobs, {
                ...filters({ sort: 'oldest', limit: 2 }),
                ...(cursor ? { cursor } : {}),
            });
            seen.push(...page.items.map((item) => item.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
        }
        expect(seen).toEqual([tid(5), tid(4), tid(3), tid(2), tid(1)]);
    });

    it('answers a null nextCursor on the last page even when it is full', () => {
        const jobs: Job[] = [];
        for (let i = 0; i < 3; i++) jobs.push(...task(tid(i + 1), { status: 'running', createdAt: at(i + 1) }));
        expect(memoryTaskList(jobs, filters({ limit: 3 })).page.nextCursor).toBeNull();
        expect(memoryTaskList(jobs, filters({ limit: 2 })).page.nextCursor).not.toBeNull();
    });

    it('throws when handed a cursor minted under other filters', () => {
        const jobs = [
            ...task(tid(1), { status: 'running', createdAt: at(60) }),
            ...task(tid(2), { status: 'running', createdAt: at(50) }),
        ];
        const first = memoryTaskList(jobs, filters({ limit: 1, q: 'crafted' }));
        expect(first.page.nextCursor).not.toBeNull();
        expect(() =>
            memoryTaskList(jobs, filters({ limit: 1, q: 'crafted', cursor: first.page.nextCursor! }))
        ).not.toThrow();
        expect(() => memoryTaskList(jobs, filters({ limit: 1, q: 'other', cursor: first.page.nextCursor! }))).toThrow();
    });

    it('skips a follow-up whose root row is absent rather than inventing a summary', () => {
        const orphan = job({
            id: tid(11),
            rootJobId: 'gone',
            followUpTo: 'gone',
            status: 'running',
            createdAt: at(10),
        });
        const { navigation, page } = memoryTaskList([orphan], filters());
        expect(page.items).toEqual([]);
        expect(navigation.counts).toEqual({ running: 0, review: 0, past: 0 });
    });
});
