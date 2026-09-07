import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useShell } from '../src/components/AppShell.js';
import type { UseJobs } from '../src/api/useJobs.js';
import { TasksLayout, useTasksPage } from '../src/pages/TasksLayout.js';

/**
 * The tasks area nests TWO context providers: the shell publishes the shared task poll one level
 * above it, the layout publishes the workspace poll one level below. `useOutletContext` returns
 * the NEAREST provider, so a layout that re-published only its own context would shadow the
 * shell's and the pages would lose the task poll. This suite pins that both arrive — the one part
 * of the page wiring that a static render CAN see.
 */
const fakeTasks = { jobs: null, error: null } as unknown as UseJobs;

/** Stands in for AppShell: the tasks poll is published exactly one level above the area. */
function ShellStub() {
    return <Outlet context={{ tasks: fakeTasks }} />;
}

let seen: { shellTasks: UseJobs | undefined; workspace: unknown } = { shellTasks: undefined, workspace: undefined };

/** Reads both contexts the way TaskComposerPage and TaskDetailPage do. */
function Probe() {
    const shell = useShell();
    const page = useTasksPage();
    seen = { shellTasks: shell.tasks, workspace: page.workspace };
    return null;
}

describe('tasks area wiring', () => {
    it('publishes the shell context AND the workspace to the area\'s pages', () => {
        seen = { shellTasks: undefined, workspace: undefined };
        renderToStaticMarkup(
            <MemoryRouter initialEntries={['/tasks']}>
                <Routes>
                    <Route element={<ShellStub />}>
                        <Route path="tasks" element={<TasksLayout />}>
                            <Route index element={<Probe />} />
                        </Route>
                    </Route>
                </Routes>
            </MemoryRouter>,
        );
        // Identity, not a lookalike: the page must see the very poll instance the shell owns.
        expect(seen.shellTasks).toBe(fakeTasks);
        // The workspace poll is present alongside it, so the pages need no second provider.
        expect(seen.workspace).toBeTruthy();
    });
});
