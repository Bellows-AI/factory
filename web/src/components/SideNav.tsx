import { NavLink } from 'react-router-dom';
import type { Job } from '../api/useJobs.js';
import { groupLabel, taskTitle } from '../tabs.js';
import type { TaskTabs } from '../tabs.js';

/**
 * The left navigation.
 *
 * `NavLink` rather than an anchor so the current page is marked without this component knowing what
 * the current page is. `aria-current="page"` comes from the router; the class is what the stylesheet
 * hangs off, and both are set from the same source so they cannot disagree.
 *
 * Under the Tasks item sits the task tree the issue asked for: the top level is the task GROUPS
 * (each a heading that focuses the group), then each group's open tabs. Tasks not open in any group
 * stay visible under "Recent", so a colleague's newly queued task is reachable even though nobody
 * opened a tab for it. The list is a PROP, not a poll: AppShell owns the one `/api/jobs` request and
 * gates it to `/tasks*` (see its comment), so this component stays a pure function of what it is
 * handed. The tab groups themselves are state — `useTaskTabs` — and arrive as a prop too.
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
    { to: '/env', label: 'Environment' },
    { to: '/tasks', label: 'Tasks' },
];

/*
 * No "n cloning" badge, deliberately.
 *
 * It would have to live here, above the router outlet, so the count would need a second poll of
 * `/api/workspace` running on every page including the dashboard — a request every two seconds for
 * a number nobody is looking at. The Workspace page shows the same thing where it is relevant.
 *
 * The task tree below is the same decision held at a smaller scale: the `/api/jobs` poll runs only
 * while the member is in the tasks area, so off `/tasks*` this renders no list at all rather than
 * paying for one on every page. And it lists TASKS, not runs: a follow-up is a new row on the
 * board, but it continues the conversation it was asked on, so only thread roots
 * (`followUpTo === null`) appear here — the detail view resolves any member's id to the whole
 * chain. A task's address IS its tab, so opening anything lands it inside a group; "Recent" is
 * what is left over.
 */
export function SideNav({ tasks, tabs }: { tasks: readonly Job[] | null; tabs: TaskTabs }) {
    const openIds = new Set(tabs.groups.flatMap((group) => group.tabs));
    const recent = (tasks ?? []).filter((task) => task.followUpTo === null && !openIds.has(task.id));
    const taskById = (id: string): Job | null => tasks?.find((task) => task.id === id) ?? null;

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
                            <>
                                <ul className="sidenav-groups">
                                    {tabs.groups.map((group) => (
                                        <li key={group.id}>
                                            <button
                                                type="button"
                                                aria-pressed={group.id === tabs.active.id}
                                                className={
                                                    group.id === tabs.active.id
                                                        ? 'sidenav-group is-active'
                                                        : 'sidenav-group'
                                                }
                                                onClick={() => tabs.activateGroup(group.id)}
                                            >
                                                {groupLabel(group)}
                                            </button>
                                            {group.tabs.length > 0 ? (
                                                <ul className="sidenav-subitems">
                                                    {group.tabs.map((id) => {
                                                        const task = taskById(id);
                                                        return (
                                                            <li key={id}>
                                                                <NavLink
                                                                    to={`/tasks/${id}`}
                                                                    title={task?.command ?? id}
                                                                    className={({ isActive }) =>
                                                                        isActive ? 'sidenav-task is-active' : 'sidenav-task'
                                                                    }
                                                                >
                                                                    {taskTitle(id, tasks)}
                                                                </NavLink>
                                                            </li>
                                                        );
                                                    })}
                                                </ul>
                                            ) : null}
                                        </li>
                                    ))}
                                    <li>
                                        <button
                                            type="button"
                                            className="sidenav-add-group"
                                            onClick={() => tabs.createGroup()}
                                        >
                                            + Group
                                        </button>
                                    </li>
                                </ul>
                                {tasks.length === 0 ? (
                                    <p className="sidenav-empty">No tasks yet</p>
                                ) : recent.length > 0 ? (
                                    <>
                                        <p className="sidenav-recent">Recent</p>
                                        <ul className="sidenav-subitems">
                                            {recent.map((task) => (
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
                                    </>
                                ) : null}
                            </>
                        ) : null}
                    </li>
                ))}
            </ul>
        </nav>
    );
}
