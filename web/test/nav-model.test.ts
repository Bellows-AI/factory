import { describe, expect, it } from 'vitest';
import {
    MAX_PREVIEW,
    NAV_ITEMS,
    SETTINGS_SECTIONS,
    ariaCurrentFor,
    countLabel,
    navCount,
    preview,
} from '../src/nav-model.js';
import type { TaskNavigation, TaskSummary } from '../src/api/useTasks.js';

const entry = (id: string): TaskSummary => ({
    id,
    command: `task ${id}`,
    status: 'running',
    cancelRequestedAt: null,
    doneAt: null,
    repo: null,
    executor: null,
    author: null,
    activity: null,
    summary: null,
    waitReason: null,
    waitingSince: null,
    waitTerminalReason: null,
    createdAt: '2026-09-02T12:00:00.000Z',
    activityAt: '2026-09-02T12:10:00.000Z',
});

describe('nav model', () => {
    it('is the one route array the shell navigates by, each item with its glyph', () => {
        expect(NAV_ITEMS.map((item) => [item.to, item.label, item.end ?? false, item.icon])).toEqual([
            ['/', 'Dashboard', true, 'home'],
            // Observe → act → configure (#159): the report, then the work, then the configuration.
            ['/tasks', 'Tasks', false, 'list'],
            ['/settings', 'Settings', false, 'settings'],
        ]);
    });

    it('carries the Settings tree, Overview first, in the order the sections ship', () => {
        expect(SETTINGS_SECTIONS.map((item) => [item.to, item.label, item.end ?? false])).toEqual([
            // The overview is end-matched, so it never stays lit on a section page (#274).
            ['/settings', 'Overview', true],
            ['/settings/organization', 'Organization', false],
            ['/settings/workspace', 'Workspace', false],
            ['/settings/repos', 'Repositories', false],
            ['/settings/executors', 'Executors', false],
            ['/settings/workflows', 'Workflows', false],
        ]);
    });

    it('never lets the parent Settings link claim the page — the Overview child owns it (#274)', () => {
        expect(ariaCurrentFor({ to: '/settings', label: 'Settings' })).toBe('false');
        // Every other item lets the router decide.
        expect(ariaCurrentFor({ to: '/', label: 'Dashboard' })).toBeUndefined();
        expect(ariaCurrentFor({ to: '/tasks', label: 'Tasks' })).toBeUndefined();
    });

    it('counts the review queue on the Tasks item only, and only when there is one', () => {
        const REVIEW_COUNT = 12;
        const RUNNING_COUNT = 3;
        const counts = (review: number): TaskNavigation => ({
            counts: { running: RUNNING_COUNT, review, past: 0 },
            running: [],
            review: [],
        });
        const [dashboard, tasks, settings] = NAV_ITEMS;
        expect(navCount(tasks!, counts(REVIEW_COUNT))).toBe(REVIEW_COUNT);
        expect(navCount(tasks!, counts(0))).toBeNull();
        expect(navCount(tasks!, null)).toBeNull();
        expect(navCount(dashboard!, counts(REVIEW_COUNT))).toBeNull();
        expect(navCount(settings!, counts(REVIEW_COUNT))).toBeNull();
    });

    it('previews at most five entries, keeping the section order', () => {
        const entries = Array.from({ length: 100 }, (_, i) => entry(`id-${i}`));
        const rows = preview(entries);
        expect(rows).toHaveLength(MAX_PREVIEW);
        const EXPECTED_MAX_PREVIEW = 5;
        expect(MAX_PREVIEW).toBe(EXPECTED_MAX_PREVIEW);
        expect(rows.map((row) => row.id)).toEqual(['id-0', 'id-1', 'id-2', 'id-3', 'id-4']);
    });

    it('previews a short section whole', () => {
        expect(preview([entry('a')]).map((row) => row.id)).toEqual(['a']);
        expect(preview([])).toEqual([]);
    });

    it('writes counts a screen reader can speak, singular and plural', () => {
        const RUNNING_COUNT = 3;
        const REVIEW_COUNT = 38;
        const PAST_COUNT = 2;
        expect(countLabel('running', RUNNING_COUNT)).toBe('3 running tasks');
        expect(countLabel('running', 1)).toBe('1 running task');
        expect(countLabel('running', 0)).toBe('0 running tasks');
        expect(countLabel('review', REVIEW_COUNT)).toBe('38 tasks need review');
        expect(countLabel('review', 1)).toBe('1 task needs review');
        expect(countLabel('past', PAST_COUNT)).toBe('2 past tasks');
        expect(countLabel('past', 1)).toBe('1 past task');
    });
});
