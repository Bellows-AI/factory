import { describe, expect, it } from 'vitest';
import { MAX_PREVIEW, NAV_ITEMS, SETTINGS_SECTIONS, countLabel, preview } from '../src/nav-model.js';
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
    createdAt: '2026-09-02T12:00:00.000Z',
    activityAt: '2026-09-02T12:10:00.000Z',
});

describe('nav model', () => {
    it('is the one route array the shell navigates by', () => {
        expect(NAV_ITEMS.map((item) => [item.to, item.label, item.end ?? false])).toEqual([
            ['/', 'Dashboard', true],
            ['/settings', 'Settings', false],
            ['/tasks', 'Tasks', false],
        ]);
    });

    it('carries the Settings tree, in the order the sections ship', () => {
        expect(SETTINGS_SECTIONS.map((item) => [item.to, item.label])).toEqual([
            ['/settings/organization', 'Organization'],
            ['/settings/workspace', 'Workspace'],
            ['/settings/repos', 'Repositories'],
            ['/settings/executors', 'Executors'],
        ]);
    });

    it('previews at most five entries, keeping the section order', () => {
        const entries = Array.from({ length: 100 }, (_, i) => entry(`id-${i}`));
        const rows = preview(entries);
        expect(rows).toHaveLength(MAX_PREVIEW);
        expect(MAX_PREVIEW).toBe(5);
        expect(rows.map((row) => row.id)).toEqual(['id-0', 'id-1', 'id-2', 'id-3', 'id-4']);
    });

    it('previews a short section whole', () => {
        expect(preview([entry('a')]).map((row) => row.id)).toEqual(['a']);
        expect(preview([])).toEqual([]);
    });

    it('writes counts a screen reader can speak, singular and plural', () => {
        expect(countLabel('running', 3)).toBe('3 running tasks');
        expect(countLabel('running', 1)).toBe('1 running task');
        expect(countLabel('running', 0)).toBe('0 running tasks');
        expect(countLabel('review', 38)).toBe('38 tasks need review');
        expect(countLabel('review', 1)).toBe('1 task needs review');
        expect(countLabel('past', 2)).toBe('2 past tasks');
        expect(countLabel('past', 1)).toBe('1 past task');
    });
});
