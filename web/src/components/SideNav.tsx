import { Link, NavLink, useLocation } from 'react-router-dom';
import type { TaskNavigation, TaskSummary } from '../api/useTasks.js';
import { sidenavPreview, taskDotClass, taskTitleFromCommand } from '../task-tree.js';

/**
 * The left navigation.
 *
 * `NavLink` rather than an anchor so the current page is marked without this component knowing what
 * the current page is. `aria-current="page"` comes from the router; the class is what the stylesheet
 * hangs off, and both are set from the same source so they cannot disagree.
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
 * The Settings item does the same at a smaller scale: four static section links (issue 150), rendered
 * only while the member is in the settings area — navigation for the section you are in, not a
 * second table of contents on every page. No data behind them, so nothing is polled for them.
 *
 * The one non-task row is the New task link, pinned above the preview rows: it opens the composer
 * (`/tasks/new`) and is not a task, so the ordering can never slide a fresh task above it.
 */

interface Item {
    readonly to: string;
    readonly label: string;
    /** True for `/`, which would otherwise match every path below it. */
    readonly end?: boolean;
}

const ITEMS: readonly Item[] = [
    { to: '/', label: 'Dashboard', end: true },
    { to: '/settings', label: 'Settings' },
    { to: '/tasks', label: 'Tasks' },
];

/** The Settings tree's sections, in the issue's order. Static — no data behind them. */
const SETTINGS_SECTIONS: readonly Item[] = [
    { to: '/settings/organization', label: 'Organization' },
    { to: '/settings/workspace', label: 'Workspace' },
    { to: '/settings/repos', label: 'Repositories' },
    { to: '/settings/executors', label: 'Executors' },
];

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
function TaskRow({ task }: { task: TaskSummary }) {
    const dot = taskDotClass({
        status: task.status,
        cancelRequestedAt: task.cancelRequestedAt,
        doneAt: task.doneAt,
    });
    const live = task.status === 'running' && task.activity !== null && task.activity.trim() !== '';
    return (
        <li>
            <NavLink
                to={`/tasks/${task.id}`}
                title={taskTitleFromCommand(task.command)}
                className={({ isActive }) => (isActive ? 'sidenav-task is-active' : 'sidenav-task')}
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

export function SideNav({ navigation }: { navigation: TaskNavigation | null }) {
    // The Settings tree renders only inside the settings area — the same gating reading the task
    // preview's prop encodes, taken from the location because these links have no data to poll for.
    // The same location names the open task, so its preview row can be kept visible.
    const { pathname } = useLocation();
    const onSettings = pathname === '/settings' || pathname.startsWith('/settings/');
    const openTask = pathname.match(/^\/tasks\/([^/]+)/)?.[1] ?? null;
    const activeId = openTask === 'new' ? null : openTask;
    const preview = sidenavPreview(navigation, activeId);

    return (
        <nav className="sidenav" aria-label="Sections">
            <div className="sidenav-brand">Factory</div>
            <ul className="sidenav-items">
                {ITEMS.map((item) => (
                    <li key={item.to}>
                        <NavLink
                            to={item.to}
                            end={item.end ?? false}
                            className={({ isActive }) => (isActive ? 'sidenav-link is-active' : 'sidenav-link')}
                            /* A tree marks ONE address as the page: on a section page the parent
                               /settings link is open and lit but explicitly NOT the current page —
                               the leaf's own link carries aria-current="page". */
                            aria-current={
                                item.to === '/settings' ? (pathname === '/settings' ? 'page' : 'false') : undefined
                            }
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
                                        >
                                            {section.label}
                                        </NavLink>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                        {item.to === '/tasks' && navigation !== null ? (
                            navigation.counts.running === 0 && navigation.counts.review === 0 ? (
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
                                    >
                                        + New task
                                    </NavLink>
                                    <ul className="sidenav-subitems">
                                        {preview.rows.map((task) => (
                                            <TaskRow key={task.id} task={task} />
                                        ))}
                                    </ul>
                                    {preview.moreReview > 0 ? (
                                        // Plain links, not NavLinks: they are actions into filtered
                                        // views, not addresses, so none of them claims aria-current.
                                        <Link to="/tasks?state=review" className="sidenav-sublink">
                                            +{preview.moreReview} more need review
                                        </Link>
                                    ) : null}
                                    <Link to="/tasks" className="sidenav-sublink">
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
