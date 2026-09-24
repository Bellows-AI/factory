import { Link, NavLink, useLocation } from 'react-router-dom';
import type { TaskNavigation, TaskSummary } from '../api/useTasks.js';
import { PRODUCT_NAME } from '../brand.js';
import { NAV_ITEMS, SETTINGS_SECTIONS, ariaCurrentFor } from '../nav-model.js';
import { sidenavPreview, taskDotClass, taskTitleFromCommand } from '../task-tree.js';

/**
 * The left navigation.
 *
 * `NavLink` rather than an anchor so the current page is marked without this component knowing what
 * the current page is. `aria-current="page"` comes from the router; the class is what the stylesheet
 * hangs off, and both are set from the same source so they cannot disagree. The route array and the
 * `aria-current` rule live in `nav-model.ts` — the one model the mobile drawer (issue 160) renders
 * in compact mode, so there is no second table of contents to forget a route in.
 *
 * Under the Tasks item sits the task preview, a pure selection of the org-wide navigation summary
 * (see `sidenavPreview` in task-tree.ts): up to five rows — running first, then the newest needs-
 * review, never past — with whatever did not fit collapsed into a `+N more need review` link into
 * the filtered inbox. The badges are the ORGANIZATION's counts, not this page's: they come from
 * `navigation`, which no filter moves. The list is a PROP, not a poll: AppShell owns the one
 * `/api/tasks` request and gates it to `/tasks*` (see its comment), so this component stays a pure
 * function of what it is handed — plus the location, which decides the active task (whose row is
 * kept visible even when the five slots would otherwise exclude it) and whether the Settings item
 * renders its section tree.
 *
 * The one non-task row is the New task link, pinned above the preview rows: it opens the composer
 * (`/tasks/new`) and is not a task, so the ordering can never slide a fresh task above it.
 *
 * `onNavigate` (issue 160) fires on every link activation so the mobile drawer can close itself
 * after navigation. On desktop the drawer is closed and the call is a no-op, so the persistent
 * nav's behavior is unchanged; the same wiring serves both renders, so a navigation implementation
 * cannot forget it.
 */

/*
 * No "n cloning" badge, deliberately.
 *
 * It would have to live here, above the router outlet, so the count would need a second poll of
 * `/api/workspace` running on every page including the dashboard — a request every two seconds for
 * a number nobody is looking at. The Workspace page shows the same thing where it is relevant.
 *
 * The task preview below is the same decision held at a smaller scale: the `/api/tasks` poll runs
 * only while the member is in the tasks area, so off `/tasks*` this renders no list at all rather
 * than paying for one on every page.
 */

/** One preview row: the dot that says the conversation's present tense, the title, the live summary. */
function TaskRow({ task, onNavigate }: { task: TaskSummary; onNavigate?: (() => void) | undefined }) {
    const dot = taskDotClass({
        status: task.status,
        cancelRequestedAt: task.cancelRequestedAt,
        doneAt: task.doneAt,
        waitReason: task.waitReason,
        waitTerminalReason: task.waitTerminalReason,
    });
    const live = task.status === 'running' && task.activity !== null && task.activity.trim() !== '';
    return (
        <li>
            <NavLink
                to={`/tasks/${task.id}`}
                title={taskTitleFromCommand(task.command)}
                className={({ isActive }) => (isActive ? 'sidenav-task is-active' : 'sidenav-task')}
                onClick={onNavigate}
            >
                {dot !== '' ? <span className={`sidenav-dot ${dot}`} /> : null}
                <span className="sidenav-task-title">{taskTitleFromCommand(task.command)}</span>
                <span className="sidenav-task-author">{task.author?.login ?? 'unknown'}</span>
                {live ? <span className="sidenav-task-summary">{task.activity}</span> : null}
            </NavLink>
        </li>
    );
}

/** The org-wide counts as one compact line, zero-valued clauses omitted. */
function CountLine({ navigation }: { navigation: TaskNavigation }) {
    const { running, review } = navigation.counts;
    const clauses: string[] = [];
    if (running > 0) clauses.push(`Running (${running})`);
    if (review > 0) clauses.push(`Need review (${review})`);
    if (clauses.length === 0) return <p className="sidenav-section">All caught up</p>;
    return <p className="sidenav-section">{clauses.join(' · ')}</p>;
}

export function SideNav({
    navigation,
    onNavigate,
}: {
    navigation: TaskNavigation | null;
    onNavigate?: (() => void) | undefined;
}) {
    // The Settings tree renders only inside the settings area — the same gating reading the task
    // preview's prop encodes, taken from the location because these links have no data to poll for.
    // The same location names the open task, so its preview row can be kept visible.
    const { pathname } = useLocation();
    const onSettings = pathname === '/settings' || pathname.startsWith('/settings/');
    const openTask = pathname.match(/^\/tasks\/([^/]+)/)?.[1] ?? null;
    const activeId = openTask === 'new' ? null : openTask;
    const preview = sidenavPreview(navigation, activeId);

    return (
        <nav className="sidenav" aria-label="Primary">
            <div className="sidenav-brand">{PRODUCT_NAME}</div>
            <ul className="sidenav-items">
                {NAV_ITEMS.map((item) => (
                    <li key={item.to}>
                        <NavLink
                            to={item.to}
                            end={item.end ?? false}
                            className={({ isActive }) => (isActive ? 'sidenav-link is-active' : 'sidenav-link')}
                            onClick={onNavigate}
                            aria-current={ariaCurrentFor(item, pathname)}
                        >
                            {item.label}
                        </NavLink>
                        {item.to === '/settings' && onSettings ? (
                            <ul className="sidenav-subitems">
                                {SETTINGS_SECTIONS.map((section) => (
                                    <li key={section.to}>
                                        <NavLink
                                            to={section.to}
                                            className={({ isActive }) =>
                                                isActive ? 'sidenav-sublink is-active' : 'sidenav-sublink'
                                            }
                                            onClick={onNavigate}
                                        >
                                            {section.label}
                                        </NavLink>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                        {item.to === '/tasks' && navigation !== null ? (
                            navigation.counts.running === 0 &&
                            navigation.counts.review === 0 &&
                            navigation.counts.past === 0 ? (
                                <p className="sidenav-empty">No tasks yet</p>
                            ) : (
                                <>
                                    <CountLine navigation={navigation} />
                                    <NavLink
                                        to="/tasks/new"
                                        end
                                        className={({ isActive }) =>
                                            isActive ? 'sidenav-newtask is-active' : 'sidenav-newtask'
                                        }
                                        onClick={onNavigate}
                                    >
                                        + New task
                                    </NavLink>
                                    <ul className="sidenav-subitems">
                                        {preview.rows.map((task) => (
                                            <TaskRow key={task.id} task={task} onNavigate={onNavigate} />
                                        ))}
                                    </ul>
                                    {preview.moreReview > 0 ? (
                                        // Plain links, not NavLinks: they are actions into filtered
                                        // views, not addresses, so none of them claims aria-current.
                                        <Link to="/tasks?state=review" className="sidenav-sublink" onClick={onNavigate}>
                                            +{preview.moreReview} more need review
                                        </Link>
                                    ) : null}
                                    <Link to="/tasks" className="sidenav-sublink" onClick={onNavigate}>
                                        View all tasks
                                    </Link>
                                </>
                            )
                        ) : null}
                    </li>
                ))}
            </ul>
        </nav>
    );
}
