import { describe, expect, it } from 'vitest';
import { MAX_PREVIEW, NAV_ITEMS, SETTINGS_SECTIONS, ariaCurrentFor, countLabel, preview } from '../src/nav-model.js';
import type { TaskSummary } from '../src/api/useTasks.js';

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
    it('is the one route array the shell navigates by', () => {
        expect(NAV_ITEMS.map((item) => [item.to, item.label, item.end ?? false])).toEqual([
            ['/', 'Dashboard', true],
            // Observe → act → configure (#159): the report, then the work, then the configuration.
            ['/tasks', 'Tasks', false],
            ['/settings', 'Settings', false],
        ]);
    });

    it('carries the Settings tree, in the order the sections ship', () => {
        expect(SETTINGS_SECTIONS.map((item) => [item.to, item.label])).toEqual([
            ['/settings/organization', 'Organization'],
            ['/settings/workspace', 'Workspace'],
            ['/settings/repos', 'Repositories'],
            ['/settings/executors', 'Executors'],
            ['/settings/workflows', 'Workflows'],
        ]);
    });

    it('keeps the parent at /settings as the overview, with no duplicate child (#180)', () => {
        // /settings IS a page now — the configuration overview. The parent link is its address,
        // so the tree must not also grow an "Overview" child.
        expect(NAV_ITEMS.some((item) => item.to === '/settings')).toBe(true);
        expect(SETTINGS_SECTIONS.some((item) => item.to === '/settings')).toBe(false);
        const EXPECTED_SETTINGS_SECTION_COUNT = 5;
        expect(SETTINGS_SECTIONS).toHaveLength(EXPECTED_SETTINGS_SECTION_COUNT);
    });

    it('marks /settings as the page only on the overview itself (#180)', () => {
        expect(ariaCurrentFor({ to: '/settings', label: 'Settings' }, '/settings')).toBe('page');
        // On a section page the parent is open but explicitly not the current page.
        expect(ariaCurrentFor({ to: '/settings', label: 'Settings' }, '/settings/workspace')).toBe('false');
        // Every other item lets the router decide.
        expect(ariaCurrentFor({ to: '/', label: 'Dashboard' }, '/settings')).toBeUndefined();
        expect(ariaCurrentFor({ to: '/tasks', label: 'Tasks' }, '/tasks')).toBeUndefined();
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
