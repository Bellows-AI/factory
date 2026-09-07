import { NavLink } from 'react-router-dom';
import type { Job } from '../api/useJobs.js';

/**
 * The left navigation.
 *
 * `NavLink` rather than an anchor so the current page is marked without this component knowing what
 * the current page is. `aria-current="page"` comes from the router; the class is what the stylesheet
 * hangs off, and both are set from the same source so they cannot disagree.
 *
 * Under the Tasks item sits the recent task list — the tree-like menu the issue asked for. The list
 * is a PROP, not a poll: AppShell owns the one `/api/jobs` request and gates it to `/tasks*` (see
 * its comment), so this component stays a pure function of what it is handed.
 */

interface Item {
    readonly to: string;
    readonly label: string;
    /** True for `/`, which would otherwise match every path below it. */
    readonly end?: boolean;
}

const ITEMS: readonly Item[] = [
    { to: '/', label: 'Dashboard', end: true },
    { to: '/workspace', label: 'Workspace' },
    { to: '/tasks', label: 'Tasks' },
];

/*
 * No "n cloning" badge, deliberately.
 *
 * It would have to live here, above the router outlet, so the count would need a second poll of
 * `/api/workspace` running on every page including the dashboard — a request every two seconds for
 * a number nobody is looking at. The Workspace page shows the same thing where it is relevant.
 *
 * The task list below is the same decision held at a smaller scale: the `/api/jobs` poll runs only
 * while the member is in the tasks area, so off `/tasks*` this renders no list at all rather than
 * paying for one on every page. And it lists TASKS, not runs: a follow-up is a new row on the
 * board, but it continues the conversation it was asked on, so only thread roots
 * (`followUpTo === null`) appear here — the detail view resolves any member's id to the whole
 * chain.
 */
export function SideNav({ tasks }: { tasks: readonly Job[] | null }) {
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
                        >
                            {item.label}
                        </NavLink>
                        {item.to === '/tasks' && tasks !== null ? (
                            tasks.length === 0 ? (
                                <p className="sidenav-empty">No tasks yet</p>
                            ) : (
                                <ul className="sidenav-subitems">
                                    {tasks
                                        .filter((task) => task.followUpTo === null)
                                        .map((task) => (
                                            <li key={task.id}>
                                                <NavLink
                                                    to={`/tasks/${task.id}`}
                                                    title={task.command}
                                                    className={({ isActive }) =>
                                                        isActive ? 'sidenav-task is-active' : 'sidenav-task'
                                                    }
                                                >
                                                    {task.command}
                                                </NavLink>
                                            </li>
                                        ))}
                                </ul>
                            )
                        ) : null}
                    </li>
                ))}
            </ul>
        </nav>
    );
}
