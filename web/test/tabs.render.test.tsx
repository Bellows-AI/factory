import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Job } from '../src/api/useJobs.js';
import { TaskTabs } from '../src/components/TaskTabs.js';
import type { TaskGroup, TaskTabs as TaskTabsApi } from '../src/tabs.js';

/**
 * The strip is props in, markup out, like the panels: `useTaskTabs` owns state and navigation, so
 * a static render can pin everything the reader sees — one tab per open task of the active group,
 * the focused tab marked, a close control per tab, the `+` that starts a new tab, and the group
 * label that says whose tabs these are.
 */
const ID = '22222222-2222-4222-8222-222222222222';

function job(overrides: Partial<Job> = {}): Job {
    return {
        id: ID,
        command: 'fix the flaky login test',
        status: 'succeeded',
        attempts: 1,
        exitCode: 0,
        output: null,
        repo: null,
        executor: null,
        followUpTo: null,
        doneAt: null,
        workspacePath: null,
        createdAt: '2026-09-02T12:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        sessionId: null,
        remoteSessionId: null,
        ...overrides,
    };
}

function tabs(groups: TaskGroup[], activeId = groups[0]!.id): TaskTabsApi {
    return {
        groups,
        active: groups.find((group) => group.id === activeId) ?? groups[0]!,
        activateGroup: () => {},
        createGroup: () => {},
        removeTab: () => {},
    };
}

const render = (path: string, strip: TaskTabsApi, tasks: readonly Job[] | null = [job()]) =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <TaskTabs tabs={strip} tasks={tasks} />
        </MemoryRouter>,
    );

describe('TaskTabs', () => {
    const oneTab = tabs([{ id: '1', tabs: [ID] }]);

    it('names the group and renders each open task as a tab', () => {
        const html = render('/tasks', tabs([{ id: '1', tabs: [ID, '33333333-3333-4333-8333-333333333333'] }]));
        expect(html).toContain('Group 1');
        expect(html).not.toContain('role="tablist"');
        expect(html).not.toContain('role="tab"');
        expect(html).toContain('fix the flaky login test');
    });

    it('marks the focused tab, and only it', () => {
        const html = render(`/tasks/${ID}`, oneTab);
        expect(html).toContain('task-tab is-active');
        expect(html).toContain('aria-current="page"');
        expect(html).not.toContain('aria-selected');
    });

    it('marks no tab on the composer, where a new tab is being written', () => {
        const html = render('/tasks', oneTab);
        expect(html).not.toContain('task-tab is-active');
        expect(html).not.toContain('aria-current="page"');
        expect(html).not.toContain('aria-selected');
    });

    it('offers the chrome tab controls: a close per tab and a plus for a new one', () => {
        const html = render(`/tasks/${ID}`, oneTab);
        expect(html).toContain('task-tab-close');
        expect(html).toContain('aria-label="Close fix the flaky login test"');
        expect(html).toContain('task-tab-new');
        expect(html).toContain(`>+<`);
    });

    it('titles an unknown task by a short id rather than a placeholder', () => {
        const html = render('/tasks', oneTab, null);
        expect(html).toContain(ID.slice(0, 8));
    });
});