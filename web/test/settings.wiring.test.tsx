import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { UseEnv } from '../src/api/useEnv.js';
import type { UseTasks } from '../src/api/useTasks.js';
import type { UseWorkspace } from '../src/api/useWorkspace.js';
import { appRoutes } from '../src/App.js';
import { useShell } from '../src/components/AppShell.js';
import { SettingsLayout, useSettingsPage } from '../src/pages/SettingsLayout.js';

/**
 * The settings area nests TWO context providers: the shell publishes the shared poll one level
 * above it, the layout publishes the workspace and environment polls one level below.
 * `useOutletContext` returns the NEAREST provider, so a layout that re-published only its own
 * context would shadow the shell's and the pages would lose the task poll. This suite pins that
 * all three arrive — the one part of the page wiring that a static render CAN see.
 *
 * The routers here are DATA routers (`createMemoryRouter` + `RouterProvider`), not `<MemoryRouter>`:
 * the settings layout hosts the unsaved-change guard (issue 182), whose `useBlocker` throws the
 * data-router invariant under anything else — so this suite's mount is the same shape the real
 * app uses, and doubles as the pin that the layout static-renders with an idle blocker.
 */
const fakeTasks = { jobs: null, error: null } as unknown as UseTasks;

/** Stands in for AppShell: the task poll is published exactly one level above the area. */
function ShellStub() {
    return <Outlet context={{ tasks: fakeTasks }} />;
}

let seen: { shellTasks: UseTasks | undefined; workspace: unknown; env: unknown } = {
    shellTasks: undefined,
    workspace: undefined,
    env: undefined,
};

/** Reads both contexts the way the settings pages do. */
function Probe() {
    const shell = useShell();
    const page = useSettingsPage();
    seen = { shellTasks: shell.tasks, workspace: page.workspace, env: page.env };
    return null;
}

function settingsRouter() {
    return createMemoryRouter(
        [
            {
                element: <ShellStub />,
                children: [
                    {
                        path: 'settings',
                        element: <SettingsLayout />,
                        children: [{ index: true, element: <Probe /> }],
                    },
                ],
            },
        ],
        { initialEntries: ['/settings'] }
    );
}

describe('settings area wiring', () => {
    it("publishes the shell context AND both polls to the area's pages", () => {
        seen = { shellTasks: undefined, workspace: undefined, env: undefined };
        renderToStaticMarkup(<RouterProvider router={settingsRouter()} />);
        // Identity, not a lookalike: the page must see the very poll instance the shell owns.
        expect(seen.shellTasks).toBe(fakeTasks);
        // Both configuration polls are present alongside it, one instance for the whole tree.
        expect(seen.workspace).toBeTruthy();
        expect(seen.env as UseEnv | undefined).toBeTruthy();
        expect(seen.workspace as UseWorkspace | undefined).toBeTruthy();
    });
});

describe('the route table', () => {
    it('builds the routes the data router serves, settings tree intact', () => {
        // The conversion to route objects (issue 182) must not move an address: the settings tree
        // keeps its four sections and its workspace redirect, and the shell layout route stays
        // pathless above everything.
        const paths = (routes: typeof appRoutes, prefix = ''): string[] =>
            routes.flatMap((route) => {
                const here = prefix + (route.path ?? (route.index ? '' : ''));
                return [here, ...paths(route.children ?? [], here && `${here}/`)];
            });
        const all = paths(appRoutes);
        expect(all).toContain('onboarding');
        expect(all).toContain('settings');
        expect(all).toContain('settings/organization');
        expect(all).toContain('settings/workspace');
        expect(all).toContain('settings/repos');
        expect(all).toContain('settings/executors');
        expect(all).toContain('tasks/new');
        expect(all).toContain('account');
    });
});
