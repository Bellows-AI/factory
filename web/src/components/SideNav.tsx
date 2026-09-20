import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { Job } from '../api/useJobs.js';
import { NAV_ITEMS, SETTINGS_SECTIONS, ariaCurrentFor, preview } from '../nav-model.js';
import { taskDotClass, taskSections } from '../task-tree.js';
import type { TaskTreeEntry } from '../task-tree.js';

/**
 * The left navigation.
 *
 * `NavLink` rather than an anchor so the current page is marked without this component knowing what
 * the current page is. `aria-current="page"` comes from the router; the class is what the stylesheet
 * hangs off, and both are set from the same source so they cannot disagree.
 *
 * Under the Tasks item sits the task tree: three automatic sections — Running, Need review, Past
 * tasks — computed from task state on every render (see `task-tree.ts`). Nothing is arranged by
 * hand and nothing is persisted: the poll's answer IS the tree, so every browser sees the same one,
 * and a task finishing simply moves from Running to the top of Need review. The list is a PROP, not
 * a poll: AppShell owns the one `/api/jobs` request and gates it to `/tasks*` (see its comment), so
 * this component stays a pure function of what it is handed — plus two session-only inputs, whether
 * the history in Past tasks is expanded, and the location, which decides whether the Settings item
 * renders its section tree.
 *
 * The Settings item does the same at a smaller scale: four static section links (issue 150), rendered
 * only while the member is in the settings area — navigation for the section you are in, not a
 * second table of contents on every page. No data behind them, so nothing is polled for them.
 *
 * The one non-tree row is the New task link pinned above the Running rows: it opens the composer
 * (`/tasks`) and is not a task, so the activity ordering can never slide a fresh task above it.
 */

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
 * chain.
 */

/** One task row: the dot that says the conversation's present tense, the title, the live summary. */
function TaskRow({ entry, onNavigate }: { entry: TaskTreeEntry; onNavigate?: (() => void) | undefined }) {
    const dot = taskDotClass(entry.status);
    return (
        <li>
            <NavLink
                to={`/tasks/${entry.id}`}
                title={entry.title}
                className={({ isActive }) => (isActive ? 'sidenav-task is-active' : 'sidenav-task')}
                onClick={onNavigate}
            >
                {dot !== '' ? <span className={`sidenav-dot ${dot}`} /> : null}
                <span className="sidenav-task-title">{entry.title}</span>
                <span className="sidenav-task-author">{entry.author ?? 'unknown'}</span>
                {entry.summary !== null ? <span className="sidenav-task-summary">{entry.summary}</span> : null}
            </NavLink>
        </li>
    );
}

/** A section's rows — capped at the preview limit — or the sentence that says it is empty. */
function SectionRows({
    entries,
    empty,
    onNavigate,
}: {
    entries: readonly TaskTreeEntry[];
    empty: string;
    onNavigate?: (() => void) | undefined;
}) {
    if (entries.length === 0) return <p className="sidenav-empty">{empty}</p>;
    return (
        <ul className="sidenav-subitems">
            {preview(entries).map((entry) => (
                <TaskRow key={entry.id} entry={entry} onNavigate={onNavigate} />
            ))}
        </ul>
    );
}

export function SideNav({
    tasks,
    onNavigate,
}: {
    tasks: readonly Job[] | null;
    onNavigate?: (() => void) | undefined;
}) {
    // History stays folded away until the reader asks for it: the live sections are why the panel
    // is open, and Past tasks must not push them off screen. Session-only — no persistence.
    const [pastOpen, setPastOpen] = useState(false);
    // The Settings tree renders only inside the settings area — the same gating reading the task
    // tree's prop encodes, taken from the location because these links have no data to poll for.
    const { pathname } = useLocation();
    const onSettings = pathname === '/settings' || pathname.startsWith('/settings/');
    const sections = taskSections(tasks);

    /*
     * `onNavigate` (issue 160) fires on every link activation so the mobile drawer can close
     * itself after navigation. On desktop the drawer is closed and the call is a no-op, so the
     * persistent nav's behavior is unchanged; the same wiring serves both renders, so a
     * navigation implementation cannot forget it.
     */

    return (
        <nav className="sidenav" aria-label="Primary">
            <div className="sidenav-brand">Factory</div>
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
                        {item.to === '/tasks' && tasks !== null ? (
                            tasks.length === 0 ? (
                                <p className="sidenav-empty">No tasks yet</p>
                            ) : (
                                <>
                                    <p className="sidenav-section">Running ({sections.running.length})</p>
                                    <NavLink
                                        to="/tasks"
                                        end
                                        className={({ isActive }) =>
                                            isActive ? 'sidenav-newtask is-active' : 'sidenav-newtask'
                                        }
                                        onClick={onNavigate}
                                    >
                                        + New task
                                    </NavLink>
                                    <SectionRows
                                        entries={sections.running}
                                        empty="Nothing running"
                                        onNavigate={onNavigate}
                                    />
                                    <p className="sidenav-section">Need review ({sections.review.length})</p>
                                    <SectionRows
                                        entries={sections.review}
                                        empty="Nothing to review"
                                        onNavigate={onNavigate}
                                    />
                                    <button
                                        type="button"
                                        className="sidenav-section"
                                        aria-expanded={pastOpen}
                                        aria-controls={sections.past.length > 0 ? 'sidenav-past' : undefined}
                                        onClick={() => setPastOpen((open) => !open)}
                                    >
                                        Past tasks ({sections.past.length})
                                    </button>
                                    {sections.past.length > 0 ? (
                                        <ul className="sidenav-subitems" id="sidenav-past" hidden={!pastOpen}>
                                            {preview(sections.past).map((entry) => (
                                                <TaskRow key={entry.id} entry={entry} onNavigate={onNavigate} />
                                            ))}
                                        </ul>
                                    ) : (
                                        <p className="sidenav-empty">No past tasks</p>
                                    )}
                                </>
                            )
                        ) : null}
                    </li>
                ))}
            </ul>
        </nav>
    );
}
