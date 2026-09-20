import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useShell } from '../src/components/AppShell.js';
import type { TaskNavigation, UseTasks } from '../src/api/useTasks.js';
import { TaskInboxPage } from '../src/pages/TaskInboxPage.js';
import { TasksLayout, useTasksPage } from '../src/pages/TasksLayout.js';

/**
 * The tasks area nests TWO context providers: the shell publishes the shared task poll one level
 * above it, the layout publishes the workspace poll one level below. `useOutletContext` returns
 * the NEAREST provider, so a layout that re-published only its own context would shadow the
 * shell's and the pages would lose the task poll. This suite pins that both arrive — and that the
 * inbox consumes the published instance rather than instantiating its own — the one part of the
 * page wiring that a static render CAN see.
 */
const fakeTasks = {
    navigation: null,
    items: null,
    nextCursor: null,
    initial: true,
    filters: { state: 'attention', q: null, repo: null, author: null, sort: 'newest' },
} as unknown as UseTasks;

const fakeWorkspace = { data: null, loading: true, error: null, refresh: () => {} };

/** Stands in for AppShell: the tasks poll is published exactly one level above the area. */
function ShellStub() {
    return <Outlet context={{ tasks: fakeTasks, workspace: fakeWorkspace }} />;
}

let seen: { shellTasks: UseTasks | undefined; workspace: unknown; inboxTasks: UseTasks | undefined } = {
    shellTasks: undefined,
    workspace: undefined,
    inboxTasks: undefined,
};

/** Reads both contexts the way TaskInboxPage, TaskComposerPage and TaskDetailPage do. */
function Probe() {
    const shell = useShell();
    const page = useTasksPage();
    seen = { shellTasks: shell.tasks, workspace: page.workspace, inboxTasks: page.tasks };
    return null;
}

describe('tasks area wiring', () => {
    it("publishes the shell context AND the workspace to the area's pages", () => {
        seen = { shellTasks: undefined, workspace: undefined, inboxTasks: undefined };
        renderToStaticMarkup(
            <MemoryRouter initialEntries={['/tasks']}>
                <Routes>
                    <Route element={<ShellStub />}>
                        <Route path="tasks" element={<TasksLayout />}>
                            <Route index element={<Probe />} />
                        </Route>
                    </Route>
                </Routes>
            </MemoryRouter>
        );
        // Identity, not a lookalike: the page must see the very poll instance the shell owns.
        expect(seen.shellTasks).toBe(fakeTasks);
        expect(seen.inboxTasks).toBe(fakeTasks);
        // The workspace poll is present alongside it, so the pages need no second provider.
        expect(seen.workspace).toBeTruthy();
    });

    it('the inbox renders the published poll, never one of its own', () => {
        // A payload only a published poll could carry — `useEffect` never runs under
        // renderToStaticMarkup, so a page instantiating its own hook could render nothing but
        // its loading state, never this row.
        const navigation: TaskNavigation = {
            counts: { running: 1, review: 0, past: 0 },
            running: [],
            review: [],
        };
        const published = {
            ...fakeTasks,
            navigation,
            items: [
                {
                    id: '44444444-4444-4444-8444-444444444444',
                    command: 'the published row',
                    status: 'running',
                    cancelRequestedAt: null,
                    doneAt: null,
                    repo: 'acme/widgets',
                    executor: null,
                    author: null,
                    activity: null,
                    summary: null,
                    createdAt: '2026-09-02T12:00:00.000Z',
                    activityAt: '2026-09-02T12:10:00.000Z',
                },
            ],
            nextCursor: null,
            initial: false,
        } as unknown as UseTasks;
        const html = renderToStaticMarkup(
            <MemoryRouter initialEntries={['/tasks']}>
                <Routes>
                    <Route element={<Outlet context={{ tasks: published, workspace: fakeWorkspace }} />}>
                        <Route path="tasks" element={<TasksLayout />}>
                            <Route index element={<TaskInboxPage />} />
                        </Route>
                    </Route>
                </Routes>
            </MemoryRouter>
        );
        expect(html).toContain('the published row');
        expect(html).toContain('href="/tasks/44444444-4444-4444-8444-444444444444"');
    });
});
