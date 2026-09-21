import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { UseEnv } from '../src/api/useEnv.js';
import type { UseTasks } from '../src/api/useTasks.js';
import type { UseWorkspace } from '../src/api/useWorkspace.js';
import { appRoutes } from '../src/App.js';
import { useShell } from '../src/components/AppShell.js';
import { useUnsavedChanges } from '../src/components/UnsavedChangesDialog.js';
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

let seen: {
    shellTasks: UseTasks | undefined;
    workspace: unknown;
    env: unknown;
    guard: ReturnType<typeof useUnsavedChanges>;
} = { shellTasks: undefined, workspace: undefined, env: undefined, guard: undefined };

/** Reads both contexts the way the settings pages do. */
function Probe() {
    const shell = useShell();
    const page = useSettingsPage();
    const guard = useUnsavedChanges();
    seen = { shellTasks: shell.tasks, workspace: page.workspace, env: page.env, guard };
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
        seen = { shellTasks: undefined, workspace: undefined, env: undefined, guard: undefined };
        renderToStaticMarkup(<RouterProvider router={settingsRouter()} />);
        // Identity, not a lookalike: the page must see the very poll instance the shell owns.
        expect(seen.shellTasks).toBe(fakeTasks);
        // Both configuration polls are present alongside it, one instance for the whole tree.
        expect(seen.workspace).toBeTruthy();
        expect(seen.env as UseEnv | undefined).toBeTruthy();
        expect(seen.workspace as UseWorkspace | undefined).toBeTruthy();
    });

    it('publishes the unsaved-change guard beside the polls, with both of its verbs', () => {
        // The guard is the layout's own context, deliberately NOT on the outlet context: the
        // polls keep the shape they always had (issue 182). The layout must be mounted inside a
        // data router, because its useBlocker throws without one — this mount is the pin.
        seen = { shellTasks: undefined, workspace: undefined, env: undefined, guard: undefined };
        renderToStaticMarkup(<RouterProvider router={settingsRouter()} />);
        expect(seen.guard).toBeTruthy();
        expect(typeof seen.guard?.registerDraft).toBe('function');
        expect(typeof seen.guard?.confirmDiscard).toBe('function');
    });
});

describe('the route table', () => {
    it('builds the routes the data router serves, settings tree intact', () => {
        // The conversion to route objects (issue 182) must not move an address: the settings tree
        // keeps its four sections and its workspace redirect, the shell layout route stays
        // pathless above everything, the detail route survives, and the catch-all stands.
        const paths = (routes: typeof appRoutes, prefix = ''): string[] =>
            routes.flatMap((route) => {
                const here = prefix + (route.path ?? '');
                return [here, ...paths(route.children ?? [], here && `${here}/`)];
            });
        const all = paths(appRoutes);
        expect(all).toContain('onboarding');
        expect(all).toContain('settings');
        expect(all).toContain('settings/organization');
        expect(all).toContain('settings/workspace');
        expect(all).toContain('settings/repos');
        expect(all).toContain('settings/executors');
        expect(all).toContain('tasks');
        expect(all).toContain('tasks/new');
        expect(all).toContain('tasks/:id');
        expect(all).toContain('account');
        expect(all).toContain('*');
        // The settings index is a redirect, not a page of its own. The settings route sits under
        // the pathless shell layout, so the search walks the whole tree.
        const findRoute = (routes: typeof appRoutes, path: string): (typeof appRoutes)[number] | undefined => {
            for (const route of routes) {
                if (route.path === path) return route;
                const nested = findRoute((route.children ?? []) as typeof appRoutes, path);
                if (nested) return nested;
            }
            return undefined;
        };
        const settings = findRoute(appRoutes, 'settings');
        expect(settings?.children?.some((child) => child.index === true)).toBe(true);
    });
});
