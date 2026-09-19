import { Outlet, useOutletContext } from 'react-router-dom';
import { useEnv } from '../api/useEnv.js';
import type { UseEnv } from '../api/useEnv.js';
import { useWorkspace } from '../api/useWorkspace.js';
import type { UseWorkspace } from '../api/useWorkspace.js';
import { useShell } from '../components/AppShell.js';
import type { ShellContext } from '../components/AppShell.js';

/**
 * The layout route of the settings area: `/settings` and everything under it.
 *
 * It owns the two configuration polls the four sections share. The workspace poll feeds the
 * workspace page (root, repos, orphaned checkouts) AND the executors page (the rows and the
 * whole-list PUT), so it must be ONE instance above both; the environment poll feeds the org,
 * workspace and per-repository editors, and its after-save refetch exists to keep the repository
 * select's options tracking the store. Navigating between the sections refetches nothing, and
 * leaving the area unmounts both — the same route-scoping by mount that TasksLayout gives
 * `/tasks*`, and the reason the sidenav can stay poll-free.
 *
 * `useOutletContext` returns the NEAREST provider, so an Outlet context of just the polls would
 * shadow the shell's and strip the shared task poll and the session off every page below. This
 * route is a direct child of the shell's Outlet, so it reads the shell context HERE and
 * re-publishes it with the polls added — one context, everything below.
 */
export interface SettingsPageContext extends ShellContext {
    workspace: UseWorkspace;
    env: UseEnv;
}

/** Typed access to what this layout route publishes. */
export function useSettingsPage(): SettingsPageContext {
    return useOutletContext<SettingsPageContext>();
}

export function SettingsLayout() {
    const shell = useShell();
    const workspace = useWorkspace();
    const env = useEnv();
    const context: SettingsPageContext = { ...shell, workspace, env };
    return <Outlet context={context} />;
}
