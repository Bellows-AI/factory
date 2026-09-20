import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { UseEnv } from '../src/api/useEnv.js';
import type { UseTasks } from '../src/api/useTasks.js';
import type { UseWorkspace } from '../src/api/useWorkspace.js';
import { useShell } from '../src/components/AppShell.js';
import { SettingsLayout, useSettingsPage } from '../src/pages/SettingsLayout.js';

/**
 * The settings area nests TWO context providers: the shell publishes the shared poll one level
 * above it, the layout publishes the workspace and environment polls one level below.
 * `useOutletContext` returns the NEAREST provider, so a layout that re-published only its own
 * context would shadow the shell's and the pages would lose the task poll. This suite pins that
 * all three arrive — the one part of the page wiring that a static render CAN see.
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
    unsaved: unknown;
} = {
    shellTasks: undefined,
    workspace: undefined,
    env: undefined,
    unsaved: undefined,
};

/** Reads both contexts the way the settings pages do. */
function Probe() {
    const shell = useShell();
    const page = useSettingsPage();
    seen = { shellTasks: shell.tasks, workspace: page.workspace, env: page.env, unsaved: page.unsaved };
    return null;
}

describe('settings area wiring', () => {
    it("publishes the shell context AND both polls to the area's pages", () => {
        seen = { shellTasks: undefined, workspace: undefined, env: undefined, unsaved: undefined };
        renderToStaticMarkup(
            <MemoryRouter initialEntries={['/settings']}>
                <Routes>
                    <Route element={<ShellStub />}>
                        <Route path="settings" element={<SettingsLayout />}>
                            <Route index element={<Probe />} />
                        </Route>
                    </Route>
                </Routes>
            </MemoryRouter>
        );
        // Identity, not a lookalike: the page must see the very poll instance the shell owns.
        expect(seen.shellTasks).toBe(fakeTasks);
        // Both configuration polls are present alongside it, one instance for the whole tree.
        expect(seen.workspace).toBeTruthy();
        expect(seen.env as UseEnv | undefined).toBeTruthy();
        expect(seen.workspace as UseWorkspace | undefined).toBeTruthy();
    });

    it('publishes the unsaved-change registry beside the polls, empty on a cold render', () => {
        // Draft guards are area-wide (issue 181): every settings page must be able to register
        // one, and the registry must be THE instance — a second one would silently drop guards.
        renderToStaticMarkup(
            <MemoryRouter initialEntries={['/settings']}>
                <Routes>
                    <Route element={<ShellStub />}>
                        <Route path="settings" element={<SettingsLayout />}>
                            <Route index element={<Probe />} />
                        </Route>
                    </Route>
                </Routes>
            </MemoryRouter>
        );
        const unsaved = seen.unsaved as { guards: Map<string, unknown>; setGuard: unknown } | undefined;
        expect(unsaved?.guards).toBeInstanceOf(Map);
        expect(unsaved?.guards.size).toBe(0);
        expect(typeof unsaved?.setGuard).toBe('function');
    });
});
