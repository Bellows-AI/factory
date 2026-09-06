import { Outlet, useOutletContext } from 'react-router-dom';
import { useWorkspace } from '../api/useWorkspace.js';
import type { UseWorkspace } from '../api/useWorkspace.js';
import { useShell } from '../components/AppShell.js';
import type { ShellContext } from '../components/AppShell.js';

/**
 * The layout route of the tasks area: `/tasks` and everything under it.
 *
 * It owns the one `/api/workspace` poll the area needs — the repo and executor lists both pages
 * render — so navigating between the composer and a task's detail view does not refetch it, and
 * leaving the area for the dashboard unmounts it entirely. The task LIST lives one level up, in the
 * shell (see its comment); what is shared down here is only the workspace configuration.
 *
 * `useOutletContext` returns the NEAREST provider, so an Outlet context of just `{ workspace }`
 * would shadow the shell's and strip the shared task poll off every page below. This route is a
 * direct child of the shell's Outlet, so it reads the shell context HERE and re-publishes it with
 * the workspace added — one context, both polls.
 */
export interface TasksPageContext extends ShellContext {
    workspace: UseWorkspace;
}

/** Typed access to what this layout route publishes. */
export function useTasksPage(): TasksPageContext {
    return useOutletContext<TasksPageContext>();
}

export function TasksLayout() {
    const shell = useShell();
    const workspace = useWorkspace();
    const context: TasksPageContext = { ...shell, workspace };
    return <Outlet context={context} />;
}
