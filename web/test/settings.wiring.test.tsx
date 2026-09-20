import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

describe('settings area wiring', () => {
    it("publishes the shell context AND both polls to the area's pages", () => {
        seen = { shellTasks: undefined, workspace: undefined, env: undefined };
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

    it('keeps the layout the one owner of both configuration polls', () => {
        // Exactly one useWorkspace() and one useEnv() call: a second instance would double the
        // request rate and fork the pages' view of the data.
        const source = readFileSync(fileURLToPath(new URL('../src/pages/SettingsLayout.tsx', import.meta.url)), 'utf8');
        expect(source.match(/useWorkspace\(/g) ?? []).toHaveLength(1);
        expect(source.match(/useEnv\(/g) ?? []).toHaveLength(1);
    });

    it('starts no repository or executor-config request from the overview (#180)', () => {
        // The overview derives everything from the polls the layout already owns: repository
        // facts come from the workspace payload, and the executor-config read carries
        // credentials — it belongs to the dialog that opens with it, never to a page render.
        const source = readFileSync(
            fileURLToPath(new URL('../src/pages/SettingsOverviewPage.tsx', import.meta.url)),
            'utf8'
        );
        expect(source).not.toContain('useRepos');
        expect(source).not.toContain('listExecutorConfigs');
        expect(source).not.toContain('fetch(');
    });
});
