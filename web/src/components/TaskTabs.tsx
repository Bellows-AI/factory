import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { Job } from '../api/useJobs.js';
import { groupLabel, taskTitle } from '../tabs.js';
import type { TaskTabs } from '../tabs.js';

/**
 * The tasks area's tab strip, drawn from the active group like Chrome's: one tab per open task,
 * the focused one marked, a close control on it, and a `+` that starts a new tab (the composer is
 * the new-tab page). The strip names the group it belongs to so a reader never mistakes two
 * groups' tabs for each other.
 *
 * Props in, markup out — the state and the navigation live in `useTaskTabs`, so this component is
 * renderable by the offline suite the same way the panels are.
 */
export function TaskTabs({ tabs, tasks }: { tabs: TaskTabs; tasks: readonly Job[] | null }) {
    const navigate = useNavigate();
    return (
        <div className="task-tabs">
            <span className="task-tabs-group">{groupLabel(tabs.active)}</span>
            {tabs.active.tabs.map((id) => (
                <TaskTab key={id} id={id} tasks={tasks} onClose={tabs.removeTab} />
            ))}
            <button
                type="button"
                className="task-tab-new"
                aria-label="New tab"
                title="New tab"
                onClick={() => navigate('/tasks')}
            >
                +
            </button>
        </div>
    );
}

function TaskTab({ id, tasks, onClose }: { id: string; tasks: readonly Job[] | null; onClose: (id: string) => void }) {
    const { pathname } = useLocation();
    const title = taskTitle(id, tasks);
    const active = pathname === `/tasks/${id}`;
    return (
        <div className={active ? 'task-tab is-active' : 'task-tab'}>
            <NavLink className="task-tab-link" to={`/tasks/${id}`} title={title}>
                {title}
            </NavLink>
            <button
                type="button"
                className="task-tab-close"
                aria-label={`Close ${title}`}
                onClick={() => onClose(id)}
            >
                ×
            </button>
        </div>
    );
}