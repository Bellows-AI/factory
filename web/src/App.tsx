import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { WorkspacePage } from './pages/WorkspacePage.js';

/**
 * The route table, and nothing else.
 *
 * `AppShell` is a layout route rather than a component each page renders, which is what lets one
 * `/api/stats` poll serve both pages: it lives above the `<Outlet/>` and survives navigation
 * between them.
 *
 * Deep links work with no server change — `server/src/app.ts` already serves index.html for any
 * non-`/api/` 404, and `requirementFor()` treats every path outside `/api/` as open, so
 * `GET /workspace` is 200 HTML with no cookie. Both are pinned by tests rather than assumed.
 */
export function App() {
    return (
        <Routes>
            <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="workspace" element={<WorkspacePage />} />
                <Route path="tasks" element={<TasksPage />} />
                {/* A mistyped path lands on the dashboard rather than on nothing. `replace` so the
                    back button does not walk back into the 404. */}
                <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
        </Routes>
    );
}
