import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { AccountPage } from './pages/AccountPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { OnboardingPage } from './pages/OnboardingPage.js';
import { SettingsExecutorsPage } from './pages/SettingsExecutorsPage.js';
import { SettingsLayout } from './pages/SettingsLayout.js';
import { SettingsOrganizationPage } from './pages/SettingsOrganizationPage.js';
import { SettingsRepositoriesPage } from './pages/SettingsRepositoriesPage.js';
import { SettingsWorkspacePage } from './pages/SettingsWorkspacePage.js';
import { TaskComposerPage } from './pages/TaskComposerPage.js';
import { TaskDetailPage } from './pages/TaskDetailPage.js';
import { TaskInboxPage } from './pages/TaskInboxPage.js';
import { TasksLayout } from './pages/TasksLayout.js';

/**
 * The route table, and nothing else.
 *
 * `AppShell` is a layout route rather than a component each page renders, which is what lets one
 * `/api/stats` poll serve both pages: it lives above the `<Outlet/>` and survives navigation
 * between them.
 *
 * Two areas nest the same way, each layout owning the polls its pages share: `TasksLayout` owns
 * the workspace poll for `/tasks` and its children — the inbox, the composer, a task's detail —
 * and `SettingsLayout` owns the workspace and environment polls for `/settings/*`. Each index
 * route is its area's default pane: the inbox for tasks, the workspace section for settings
 * (which redirects there).
 *
 * Deep links work with no server change — `server/src/app.ts` already serves index.html for any
 * non-`/api/` 404, and `requirementFor()` treats every path outside `/api/` as open, so
 * `GET /settings/workspace` is 200 HTML with no cookie. Both are pinned by tests rather than
 * assumed.
 */
export function App() {
    return (
        <Routes>
            {/* The sign-in selection screen (issue 125). Outside the shell: its caller holds no session
                yet — the pending cookie, not a session cookie, is what the page stands on — so the
                sidenav and the stats poll have nothing to stand on either. */}
            <Route path="onboarding" element={<OnboardingPage />} />
            <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                {/* The organization's settings tree (issue 150): one sidenav item, four sections. */}
                <Route path="settings" element={<SettingsLayout />}>
                    <Route index element={<Navigate to="/settings/workspace" replace />} />
                    <Route path="organization" element={<SettingsOrganizationPage />} />
                    <Route path="workspace" element={<SettingsWorkspacePage />} />
                    <Route path="repos" element={<SettingsRepositoriesPage />} />
                    <Route path="executors" element={<SettingsExecutorsPage />} />
                </Route>
                <Route path="tasks" element={<TasksLayout />}>
                    {/* The inbox is the index (issue 158); the composer is its own address below it —
                        `new` MUST come before `:id`, or the router would hand the word "new" to
                        the detail page. */}
                    <Route index element={<TaskInboxPage />} />
                    <Route path="new" element={<TaskComposerPage />} />
                    <Route path=":id" element={<TaskDetailPage />} />
                </Route>
                {/* The member's own account. Reached from the topbar's user menu, not the sidenav:
                    it is personal, not a section of the dashboard — `/settings/*` is the
                    organization's tree, so the personal page lives beside it at `/account`. */}
                <Route path="account" element={<AccountPage />} />
                {/* A mistyped path lands on the dashboard rather than on nothing. `replace` so the
                    back button does not walk back into the 404. */}
                <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
        </Routes>
    );
}
