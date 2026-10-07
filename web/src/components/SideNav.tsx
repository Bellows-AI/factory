import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import type { TaskNavigation, TaskSummary } from '../api/useTasks.js';
import { PRODUCT_NAME } from '../brand.js';
import { NAV_ITEMS, navCount } from '../nav-model.js';
import { type SidenavPreview, sidenavPreview, taskDotClass, taskTitleFromCommand } from '../task-tree.js';
import { NavItemLink, NewTaskLink, SettingsSectionItems } from './NavItems.js';

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
 * The whole preview is one disclosure (issue 274) whose summary is the count line, open by default. Its
 * open state is held here, in SideNav, which the shell keeps mounted — so a collapse survives
 * in-app navigation — and nowhere else: no storage, a reload opens it again. The Tasks item itself
 * carries the review count as a pill, spoken through the link's name (see `NavItemLink`).
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
        needsAnswer: task.needsAnswer,
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

/** The org-wide counts as one compact line, zero-valued clauses omitted — the preview's summary. */
function CountLine({ navigation }: { navigation: TaskNavigation }) {
    const { running, review } = navigation.counts;
    const clauses: string[] = [];
    if (running > 0) clauses.push(`Running (${running})`);
    if (review > 0) clauses.push(`Need review (${review})`);
    return (
        <summary className="sidenav-section">{clauses.length === 0 ? 'All caught up' : clauses.join(' · ')}</summary>
    );
}

/** The task preview under the Tasks item: one disclosure, or a sentence when there is nothing yet. */
function TaskPreview({
    navigation,
    preview,
    open,
    onToggle,
    onNavigate,
}: {
    navigation: TaskNavigation;
    preview: SidenavPreview;
    open: boolean;
    onToggle: (open: boolean) => void;
    onNavigate?: (() => void) | undefined;
}) {
    const { running, review, past } = navigation.counts;
    // Nothing to collapse, so no disclosure.
    if (running === 0 && review === 0 && past === 0) return <p className="sidenav-empty">No tasks yet</p>;
    return (
        <details className="sidenav-preview" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
            <CountLine navigation={navigation} />
            <NewTaskLink onNavigate={onNavigate} />
            <ul className="sidenav-subitems">
                {preview.rows.map((task) => (
                    <TaskRow key={task.id} task={task} onNavigate={onNavigate} />
                ))}
            </ul>
            {preview.moreReview > 0 ? (
                // Plain links, not NavLinks: they are actions into filtered views, not addresses,
                // so none of them claims aria-current.
                <Link to="/tasks?state=review" className="sidenav-sublink" onClick={onNavigate}>
                    +{preview.moreReview} more need review
                </Link>
            ) : null}
            <Link to="/tasks" className="sidenav-sublink" onClick={onNavigate}>
                View all tasks
            </Link>
        </details>
    );
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
    const [previewOpen, setPreviewOpen] = useState(true);

    return (
        <nav className="sidenav" aria-label="Primary">
            <div className="sidenav-brand">{PRODUCT_NAME}</div>
            <ul className="sidenav-items">
                {NAV_ITEMS.map((item) => (
                    <li key={item.to}>
                        <NavItemLink item={item} count={navCount(item, navigation)} onNavigate={onNavigate} />
                        {item.to === '/settings' && onSettings ? (
                            <ul className="sidenav-subitems">
                                <SettingsSectionItems onNavigate={onNavigate} />
                            </ul>
                        ) : null}
                        {item.to === '/tasks' && navigation !== null ? (
                            <TaskPreview
                                navigation={navigation}
                                preview={preview}
                                open={previewOpen}
                                onToggle={setPreviewOpen}
                                onNavigate={onNavigate}
                            />
                        ) : null}
                    </li>
                ))}
            </ul>
        </nav>
    );
}
