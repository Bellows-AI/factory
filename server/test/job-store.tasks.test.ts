import { describe, expect, it } from 'vitest';
import type { UserRef } from '@factory-ai/core';
import { buildTaskPage, taskBucket, type TaskListFilters, type TaskSummary } from '../src/db/job-store.js';

/**
 * The task-summary read model (#157) — the pure half, pinned offline for the same reason
 * `withMintedToken` is: bucket and page rules this load-bearing must not live only where a
 * database is. The SQL implements the same contract over the org's `job` rows; here the same
 * rules run over an in-memory set, and the route-test stub delegates here so HTTP tests exercise
 * real filter and cursor logic with no database.
 */

const author = (login: string): UserRef => ({ id: `user-${login}`, login, name: login, avatarUrl: null });

let seq = 0;
/** A task summary fixture: `activityAt` is what orders and paginates; `id` only breaks ties. */
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

const filters = (over: Partial<TaskListFilters> = {}): TaskListFilters => ({
    state: 'attention',
    q: null,
    repo: null,
    author: null,
    sort: 'newest',
    limit: 30,
    cursor: null,
    ...over,
});

describe('taskBucket', () => {
    it('buckets every moving status as running, regardless of done stamp', () => {
        expect(taskBucket('queued', null)).toBe('running');
        expect(taskBucket('running', null)).toBe('running');
        expect(taskBucket('standby', null)).toBe('running');
        expect(taskBucket('running', '2026-09-01T00:00:00.000Z')).toBe('running');
    });

    it('buckets terminal rows without a done stamp as needing review', () => {
        expect(taskBucket('succeeded', null)).toBe('review');
        expect(taskBucket('failed', null)).toBe('review');
        expect(taskBucket('dead', null)).toBe('review');
        expect(taskBucket('stopped', null)).toBe('review');
    });

    it('buckets terminal rows with a done stamp as past', () => {
        expect(taskBucket('succeeded', '2026-09-01T00:00:00.000Z')).toBe('past');
        expect(taskBucket('stopped', '2026-09-01T00:00:00.000Z')).toBe('past');
    });
});

describe('buildTaskPage', () => {
    const now = (minute: number) => `2026-09-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

    it('counts every bucket over the FULL set and caps previews at 3 running / 5 review', () => {
        const tasks = [
            ...Array.from({ length: 5 }, (_, i) => task({ status: 'running', activityAt: now(i), id: `a-${i}` })),
            ...Array.from({ length: 7 }, (_, i) =>
                task({ status: 'failed', doneAt: null, activityAt: now(i), id: `b-${i}` })
            ),
            ...Array.from({ length: 2 }, (_, i) =>
                task({ status: 'succeeded', doneAt: now(i), activityAt: now(i), id: `c-${i}` })
            ),
        ];
        const { navigation } = buildTaskPage(tasks, filters());
        expect(navigation.counts).toEqual({ running: 5, review: 7, past: 2 });
        expect(navigation.running).toHaveLength(3);
        expect(navigation.review).toHaveLength(5);
        // Newest first: the previews descend by activityAt.
        expect(navigation.running.map((t) => t.activityAt)).toEqual([now(4), now(3), now(2)]);
        expect(navigation.review.map((t) => t.activityAt)).toEqual([now(6), now(5), now(4), now(3), now(2)]);
    });

    it('splits attention into running and review, and serves each alone', () => {
        const tasks = [
            task({ status: 'running', activityAt: now(1), id: 'r1' }),
            task({ status: 'queued', activityAt: now(2), id: 'r2' }),
            task({ status: 'failed', doneAt: null, activityAt: now(3), id: 'v1' }),
            task({ status: 'succeeded', doneAt: now(4), activityAt: now(4), id: 'p1' }),
        ];
        expect(buildTaskPage(tasks, filters({ state: 'attention' })).page.items.map((t) => t.id)).toEqual([
            'v1',
            'r2',
            'r1',
        ]);
        expect(buildTaskPage(tasks, filters({ state: 'running' })).page.items.map((t) => t.id)).toEqual(['r2', 'r1']);
        expect(buildTaskPage(tasks, filters({ state: 'review' })).page.items.map((t) => t.id)).toEqual(['v1']);
        expect(buildTaskPage(tasks, filters({ state: 'past' })).page.items.map((t) => t.id)).toEqual(['p1']);
    });

    it('filters by search substring on the command, case-insensitively', () => {
        const tasks = [
            task({ command: 'Fix the flaky LOGIN test', activityAt: now(1), id: 'q1' }),
            task({ command: 'add a changelog', activityAt: now(2), id: 'q2' }),
        ];
        expect(buildTaskPage(tasks, filters({ q: ' login ' })).page.items.map((t) => t.id)).toEqual(['q1']);
        expect(buildTaskPage(tasks, filters({ q: 'LOGIN' })).page.items.map((t) => t.id)).toEqual(['q1']);
    });

    it('filters by exact repo and case-insensitive author login', () => {
        const tasks = [
            task({ repo: 'acme/widgets', author: author('Ada'), activityAt: now(1), id: 'f1' }),
            task({ repo: 'acme/gears', author: author('bob'), activityAt: now(2), id: 'f2' }),
        ];
        expect(buildTaskPage(tasks, filters({ repo: 'acme/widgets' })).page.items.map((t) => t.id)).toEqual(['f1']);
        expect(buildTaskPage(tasks, filters({ author: 'ada' })).page.items.map((t) => t.id)).toEqual(['f1']);
        expect(buildTaskPage(tasks, filters({ author: 'ADA' })).page.items.map((t) => t.id)).toEqual(['f1']);
    });

    it('combines filters conjunctively', () => {
        const tasks = [
            task({ repo: 'acme/widgets', author: author('ada'), activityAt: now(1), id: 'x1' }),
            task({ repo: 'acme/widgets', author: author('bob'), activityAt: now(2), id: 'x2' }),
            task({ repo: 'acme/gears', author: author('ada'), activityAt: now(3), id: 'x3' }),
        ];
        const { page } = buildTaskPage(tasks, filters({ repo: 'acme/widgets', author: 'ada', q: 'flaky' }));
        expect(page.items.map((t) => t.id)).toEqual(['x1']);
    });

    it('orders newest first with id descending as the tie-break', () => {
        const tasks = [
            task({ activityAt: now(1), id: 't-b' }),
            task({ activityAt: now(2), id: 't-a' }),
            task({ activityAt: now(1), id: 't-a' }),
        ];
        expect(buildTaskPage(tasks, filters()).page.items.map((t) => t.id)).toEqual(['t-a', 't-b', 't-a']);
    });

    it('orders oldest first under the oldest sort, id ascending on ties', () => {
        const tasks = [
            task({ activityAt: now(1), id: 't-b' }),
            task({ activityAt: now(2), id: 't-a' }),
            task({ activityAt: now(1), id: 't-a' }),
        ];
        expect(buildTaskPage(tasks, filters({ sort: 'oldest' })).page.items.map((t) => t.id)).toEqual([
            't-a',
            't-b',
            't-a',
        ]);
    });

    it('paginates forward with a keyset cursor and no duplicates or omissions', () => {
        const tasks = Array.from({ length: 7 }, (_, i) => task({ activityAt: now(i), id: `p-${i}` }));
        const first = buildTaskPage(tasks, filters({ limit: 3 }));
        expect(first.page.items.map((t) => t.id)).toEqual(['p-6', 'p-5', 'p-4']);
        expect(first.page.nextCursor).toEqual({ activityAt: now(4), rootId: 'p-4' });

        const second = buildTaskPage(tasks, filters({ limit: 3, cursor: first.page.nextCursor }));
        expect(second.page.items.map((t) => t.id)).toEqual(['p-3', 'p-2', 'p-1']);
        expect(second.page.nextCursor).toEqual({ activityAt: now(1), rootId: 'p-1' });

        const third = buildTaskPage(tasks, filters({ limit: 3, cursor: second.page.nextCursor }));
        expect(third.page.items.map((t) => t.id)).toEqual(['p-0']);
        expect(third.page.nextCursor).toBeNull();
    });

    it('paginates forward under the oldest sort with the mirrored cursor direction', () => {
        const tasks = Array.from({ length: 5 }, (_, i) => task({ activityAt: now(i), id: `o-${i}` }));
        const first = buildTaskPage(tasks, filters({ sort: 'oldest', limit: 2 }));
        expect(first.page.items.map((t) => t.id)).toEqual(['o-0', 'o-1']);
        expect(first.page.nextCursor).toEqual({ activityAt: now(1), rootId: 'o-1' });

        const second = buildTaskPage(tasks, filters({ sort: 'oldest', limit: 2, cursor: first.page.nextCursor }));
        expect(second.page.items.map((t) => t.id)).toEqual(['o-2', 'o-3']);
    });

    it('returns a null cursor when the page exactly exhausts the set', () => {
        const tasks = Array.from({ length: 3 }, (_, i) => task({ activityAt: now(i), id: `e-${i}` }));
        const page = buildTaskPage(tasks, filters({ limit: 3 }));
        expect(page.page.items).toHaveLength(3);
        expect(page.page.nextCursor).toBeNull();
    });

    it('keeps navigation filter-independent: filters move the page, never the counts', () => {
        const tasks = [
            task({ status: 'running', repo: 'acme/widgets', activityAt: now(1), id: 'n1' }),
            task({ status: 'failed', doneAt: null, repo: 'acme/gears', activityAt: now(2), id: 'n2' }),
        ];
        const filtered = buildTaskPage(tasks, filters({ repo: 'acme/gears' }));
        expect(filtered.page.items.map((t) => t.id)).toEqual(['n2']);
        expect(filtered.navigation.counts).toEqual({ running: 1, review: 1, past: 0 });
        expect(filtered.navigation.running.map((t) => t.id)).toEqual(['n1']);
    });

    it('answers an empty set with empty navigation and an empty page', () => {
        const { navigation, page } = buildTaskPage([], filters());
        expect(navigation.counts).toEqual({ running: 0, review: 0, past: 0 });
        expect(navigation.running).toEqual([]);
        expect(navigation.review).toEqual([]);
        expect(page.items).toEqual([]);
        expect(page.nextCursor).toBeNull();
    });
});
