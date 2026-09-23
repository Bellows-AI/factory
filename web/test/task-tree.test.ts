import { describe, expect, it } from 'vitest';
import type { Job } from '../src/api/useJobs.js';
import type { TaskNavigation, TaskSummary } from '../src/api/useTasks.js';
import {
    sidenavPreview,
    taskDotClass,
    taskStatusLabel,
    taskSummary,
    taskTitleFromCommand,
    type TaskStatus,
} from '../src/task-tree.js';

/**
 * The task UI's pure model: titles, labels, dots and the sidenav's preview selection. The browser
 * no longer groups threads — the task-summary read model answers one row per task — so what is
 * pinned here is the rendering contract those rows flow through.
 */

const summary = (over: Partial<TaskSummary> = {}): TaskSummary => ({
    id: over.id ?? '11111111-1111-4111-8111-111111111111',
    command: over.command ?? 'fix the flaky login test',
    status: over.status ?? 'succeeded',
    cancelRequestedAt: over.cancelRequestedAt ?? null,
    doneAt: over.doneAt ?? null,
    repo: over.repo ?? 'acme/widgets',
    executor: over.executor ?? null,
    author: over.author ?? null,
    activity: over.activity ?? null,
    summary: over.summary ?? null,
    waitReason: over.waitReason ?? null,
    waitingSince: over.waitingSince ?? null,
    waitTerminalReason: over.waitTerminalReason ?? null,
    createdAt: over.createdAt ?? '2026-09-01T12:00:00.000Z',
    activityAt: over.activityAt ?? '2026-09-01T12:10:00.000Z',
});

describe('taskTitleFromCommand', () => {
    it('takes the first line of the command, trimmed', () => {
        expect(taskTitleFromCommand('fix the flaky login test\nsecond line\nthird')).toBe('fix the flaky login test');
        expect(taskTitleFromCommand('  padded  ')).toBe('padded');
    });

    it('answers an empty string for an empty command rather than inventing one', () => {
        expect(taskTitleFromCommand('')).toBe('');
    });
});

describe('taskStatusLabel', () => {
    const status = (over: Partial<TaskStatus>): TaskStatus => ({
        status: over.status ?? null,
        cancelRequestedAt: over.cancelRequestedAt ?? null,
        doneAt: over.doneAt ?? null,
        waitReason: over.waitReason ?? null,
        waitTerminalReason: over.waitTerminalReason ?? null,
    });

    it('names the moving states, a stop request louder than the run itself', () => {
        expect(taskStatusLabel(status({ status: 'running' }))).toBe('Running');
        expect(taskStatusLabel(status({ status: 'queued' }))).toBe('Queued');
        expect(taskStatusLabel(status({ status: 'standby' }))).toBe('Parked');
        expect(taskStatusLabel(status({ status: 'running', cancelRequestedAt: '2026-09-01T12:00:00.000Z' }))).toBe(
            'Stopping'
        );
    });

    it('marks a terminal result the user has not closed as needing review', () => {
        expect(taskStatusLabel(status({ status: 'succeeded' }))).toBe('Succeeded · Needs review');
        expect(taskStatusLabel(status({ status: 'failed' }))).toBe('Failed · Needs review');
        expect(taskStatusLabel(status({ status: 'dead' }))).toBe('Failed · Needs review');
        expect(taskStatusLabel(status({ status: 'stopped' }))).toBe('Stopped · Needs review');
    });

    it('reads a closed task as done, whatever the verdict was', () => {
        expect(taskStatusLabel(status({ status: 'succeeded', doneAt: '2026-09-01T13:00:00.000Z' }))).toBe('Done');
        expect(taskStatusLabel(status({ status: 'failed', doneAt: '2026-09-01T13:00:00.000Z' }))).toBe('Done');
    });

    it('reads an open PR-review wait as waiting, whatever non-terminal status it is parked under', () => {
        for (const s of ['queued', 'standby'] as const) {
            expect(taskStatusLabel(status({ status: s, waitReason: 'review' }))).toBe('Waiting for review');
        }
        // Never as running, queued or parked while a wait is genuinely open.
        expect(taskStatusLabel(status({ status: 'standby', waitReason: 'review' }))).not.toBe('Parked');
    });

    it('never overrides a live run with a waiting label — running stays the loudest state', () => {
        expect(taskStatusLabel(status({ status: 'running', waitReason: 'review' }))).toBe('Running');
    });

    it('appends the terminal wait reason to the ordinary needs-review copy once the wait has ended', () => {
        expect(taskStatusLabel(status({ status: 'succeeded', waitReason: 'review', waitTerminalReason: 'exhausted' }))).toBe(
            'Succeeded · Needs review · exhausted'
        );
        expect(taskStatusLabel(status({ status: 'failed', waitReason: 'review', waitTerminalReason: 'cancelled' }))).toBe(
            'Failed · Needs review · cancelled'
        );
    });
});

describe('taskDotClass', () => {
    const status = (over: Partial<TaskStatus>): TaskStatus => ({
        status: over.status ?? null,
        cancelRequestedAt: over.cancelRequestedAt ?? null,
        doneAt: over.doneAt ?? null,
        waitReason: over.waitReason ?? null,
        waitTerminalReason: over.waitTerminalReason ?? null,
    });

    it('breathes green for a live run, grey while a stop request travels', () => {
        expect(taskDotClass(status({ status: 'running' }))).toBe('sidenav-dot-running');
        expect(taskDotClass(status({ status: 'running', cancelRequestedAt: '2026-09-01T12:00:00.000Z' }))).toBe(
            'sidenav-dot-stopping'
        );
    });

    it('holds grey for parked and queued runs', () => {
        expect(taskDotClass(status({ status: 'standby' }))).toBe('sidenav-dot-paused');
        expect(taskDotClass(status({ status: 'queued' }))).toBe('sidenav-dot-paused');
    });

    it('paints failure red, finished and done green, and leaves stopped plain', () => {
        expect(taskDotClass(status({ status: 'failed' }))).toBe('sidenav-dot-failed');
        expect(taskDotClass(status({ status: 'dead' }))).toBe('sidenav-dot-failed');
        expect(taskDotClass(status({ status: 'succeeded' }))).toBe('sidenav-dot-done');
        expect(taskDotClass(status({ status: 'failed', doneAt: '2026-09-01T13:00:00.000Z' }))).toBe('sidenav-dot-done');
        expect(taskDotClass(status({ status: 'stopped' }))).toBe('');
        expect(taskDotClass(status({}))).toBe('');
    });

    it('holds grey for an open wait, never green or red, whatever status it is parked under', () => {
        expect(taskDotClass(status({ status: 'standby', waitReason: 'review' }))).toBe('sidenav-dot-paused');
        expect(taskDotClass(status({ status: 'queued', waitReason: 'review' }))).toBe('sidenav-dot-paused');
    });

    it('leaves a live run breathing even with a stray wait — running stays the loudest state', () => {
        expect(taskDotClass(status({ status: 'running', waitReason: 'review' }))).toBe('sidenav-dot-running');
    });
});

describe('taskSummary', () => {
    const threadJob = (id: string, overrides: Partial<Job> = {}): Job => ({
        id,
        command: `command ${id}`,
        status: 'succeeded',
        attempts: 1,
        author: null,
        stoppedBy: null,
        doneBy: null,
        exitCode: 0,
        output: null,
        repo: null,
        executor: null,
        followUpTo: null,
        rootJobId: id,
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        wallClockMs: null,
        taskWallClockMs: null,
        summary: null,
        sessionId: null,
        remoteSessionId: null,
        waitReason: null,
        waitingSince: null,
        waitTerminalReason: null,
        ...overrides,
    });

    it("shows the running head's activity line", () => {
        const root = threadJob('11111111-1111-4111-8111-111111111111', { status: 'succeeded' });
        const child = threadJob('22222222-2222-4222-8222-222222222222', {
            status: 'running',
            followUpTo: root.id,
            rootJobId: root.id,
            createdAt: '2026-09-01T12:05:00.000Z',
            runtime: { cpuPercent: 1, memUsedMb: 1, memPercent: null, activity: '→ Bash npm test', sampledAt: 'x' },
        });
        expect(taskSummary(root.id, [root, child])).toBe('→ Bash npm test');
    });

    it('keeps it out of parked and finished tasks, and of blank activity lines', () => {
        const finished = threadJob('11111111-1111-4111-8111-111111111111');
        expect(taskSummary(finished.id, [finished])).toBeNull();
        const parked = threadJob('22222222-2222-4222-8222-222222222222', { status: 'standby' });
        expect(taskSummary(parked.id, [parked])).toBeNull();
        const blank = threadJob('33333333-3333-4333-8333-333333333333', {
            status: 'running',
            runtime: { cpuPercent: 1, memUsedMb: 1, memPercent: null, activity: '   ', sampledAt: 'x' },
        });
        expect(taskSummary(blank.id, [blank])).toBeNull();
    });
});

describe('sidenavPreview', () => {
    const navigation = (over: {
        running?: TaskSummary[];
        review?: TaskSummary[];
        counts?: TaskNavigation['counts'];
    }): TaskNavigation => ({
        counts: over.counts ?? { running: over.running?.length ?? 0, review: over.review?.length ?? 0, past: 0 },
        running: over.running ?? [],
        review: over.review ?? [],
    });

    const UUID_SUFFIX_WIDTH = 12;
    const running = (i: number) =>
        summary({ id: `00000000-0000-4000-8000-${String(i).padStart(UUID_SUFFIX_WIDTH, '0')}`, status: 'running' });
    const review = (i: number) =>
        summary({ id: `10000000-0000-4000-8000-${String(i).padStart(UUID_SUFFIX_WIDTH, '0')}`, status: 'failed' });

    const THIRD = 3;
    const FOURTH = 4;
    const MAX_PREVIEW_ROWS = 5;

    it('caps the preview at five rows and never shows past tasks', () => {
        const nav = navigation({
            running: [running(1), running(2), running(THIRD)],
            review: [review(1), review(2), review(THIRD), review(FOURTH)],
            counts: { running: 3, review: 4, past: 40 },
        });
        const { rows } = sidenavPreview(nav, null);
        expect(rows).toHaveLength(MAX_PREVIEW_ROWS);
        expect(rows.every((task) => task.status !== 'succeeded' || task.doneAt === null || true)).toBe(true);
        // Three running first, then the newest review.
        expect(rows.map((task) => task.id)).toEqual([
            running(1).id,
            running(2).id,
            running(THIRD).id,
            review(1).id,
            review(2).id,
        ]);
    });

    it('fills the slots review tasks leave open with more running, and reports the overflow', () => {
        const nav = navigation({
            running: [running(1), running(2), running(THIRD)],
            review: [review(1), review(2)],
            counts: { running: 3, review: 12, past: 0 },
        });
        const preview = sidenavPreview(nav, null);
        expect(preview.rows).toHaveLength(MAX_PREVIEW_ROWS);
        const EXPECTED_OVERFLOW = 10;
        expect(preview.moreReview).toBe(EXPECTED_OVERFLOW);
    });

    it('reports zero overflow when every review task fits', () => {
        const nav = navigation({ running: [running(1)], review: [review(1), review(2)] });
        expect(sidenavPreview(nav, null).moreReview).toBe(0);
    });

    it('injects the open task when it is running or in review but outside the five rows', () => {
        const nav = navigation({
            running: [running(1), running(2), running(THIRD)],
            review: [review(1), review(2), review(THIRD)],
            counts: { running: 3, review: 3, past: 0 },
        });
        const { rows } = sidenavPreview(nav, review(THIRD).id);
        expect(rows).toHaveLength(MAX_PREVIEW_ROWS);
        expect(rows.map((task) => task.id)).toEqual([
            running(1).id,
            running(2).id,
            running(THIRD).id,
            review(1).id,
            review(THIRD).id, // injected, displacing the last review slot
        ]);
    });

    it('leaves the preview alone when the open task is already shown, and ignores unknown ids', () => {
        const nav = navigation({ running: [running(1), running(2)], review: [review(1)] });
        expect(sidenavPreview(nav, running(1).id).rows.map((t) => t.id)).toEqual([
            running(1).id,
            running(2).id,
            review(1).id,
        ]);
        const unknown = '99999999-9999-4999-8999-999999999999';
        const EXPECTED_ROW_COUNT = 3;
        expect(sidenavPreview(nav, unknown).rows).toHaveLength(EXPECTED_ROW_COUNT);
    });

    it('answers an empty preview for a null navigation and a quiet board', () => {
        expect(sidenavPreview(null, null)).toEqual({ rows: [], moreReview: 0 });
        expect(sidenavPreview(navigation({}), null)).toEqual({ rows: [], moreReview: 0 });
    });
});
