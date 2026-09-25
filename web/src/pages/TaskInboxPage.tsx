import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader.js';
import { RelativeTime } from '../components/RelativeTime.js';
import { useTasksPage } from './TasksLayout.js';
import { inboxQueryString, QUERY_MAX } from '../api/useTasks.js';
import type { InboxFilters, TaskSummary, UseTasks } from '../api/useTasks.js';
import { taskDotClass, taskStatusLabel, taskTitleFromCommand } from '../task-tree.js';

/**
 * `/tasks` — the task inbox. Everything it renders comes from the ONE task poll the shell owns
 * (`useTasksPage()`), never from a poll of its own; the query normalization and fetch logic live
 * in `useTasks.ts`. The filters are URL state (see `inboxFiltersFromSearch`): linkable, and
 * Back/Forward moves them — this page only writes back what its controls change.
 *
 * The row grammar is the desktop order the spec fixes: status mark with a VISIBLE label, the
 * title (the whole link — no nested buttons), repository, author, and the relative last activity
 * backed by a precise `<time>`. Metadata wraps under the title on small screens; the grid in
 * `styles.css` owns the layout.
 */

const STATES: readonly { value: InboxFilters['state']; label: string }[] = [
    { value: 'attention', label: 'Needs attention' },
    { value: 'running', label: 'Running' },
    { value: 'review', label: 'Needs review' },
    { value: 'past', label: 'Past' },
];

const SORTS: readonly { value: InboxFilters['sort']; label: string }[] = [
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
];

/** The URL for a filter set: `inboxQueryString` decides what a filter set serializes to — one
 * home, so a new filter key cannot be added to the poll and forgotten in the shareable link. */
const filtersUrl = (filters: InboxFilters): string => {
    const query = inboxQueryString(filters);
    return query === '' ? '/tasks' : `/tasks?${query}`;
};

/** The workspace's selected repositories, plus the currently filtered one if it has since
 * disappeared from the configuration — a linkable URL must keep rendering its own filter. */
function repoOptionsFor(
    workspaceRepos: readonly { owner: string; name: string }[],
    filterRepo: string | null
): { owner: string; name: string }[] {
    const options = workspaceRepos.map((repo) => ({ owner: repo.owner, name: repo.name }));
    if (filterRepo !== null && !options.some((r) => `${r.owner}/${r.name}` === filterRepo)) {
        const [owner, name] = filterRepo.split('/');
        options.push({ owner: owner ?? filterRepo, name: name ?? '' });
    }
    return options;
}

/** The page header's org-wide motion summary: "3 running · 1 need review", or "Nothing moving". */
function navMetaSummary(counts: { running: number; review: number; past: number } | null): string {
    if (counts === null) return 'Nothing moving';
    const clauses: string[] = [];
    if (counts.running > 0) clauses.push(`${counts.running} running`);
    if (counts.review > 0) clauses.push(`${counts.review} need review`);
    return clauses.length === 0 ? 'Nothing moving' : clauses.join(' · ');
}

/**
 * The state tabs, search form and sort links. Split out of `TaskInboxPage` so its own render
 * tree does not add to the page's cognitive complexity.
 */
function InboxFilterBar({
    filters,
    repoOptions,
    onSubmit,
}: {
    filters: InboxFilters;
    repoOptions: readonly { owner: string; name: string }[];
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
    // Minted, not literal: a component owns no id, and three hard-coded ones become three
    // DUPLICATE ids the moment this bar is rendered twice on a page — a duplicate id points every
    // `<label for>` at the first match, so the second bar's labels focus the first bar's fields.
    const fieldId = useId();
    return (
        <div className="inbox-filters">
            <nav className="inbox-tabs" aria-label="Task state">
                {STATES.map((state) => (
                    <Link
                        key={state.value}
                        to={filtersUrl({ ...filters, state: state.value })}
                        className={filters.state === state.value ? 'inbox-tab is-active' : 'inbox-tab'}
                        aria-current={filters.state === state.value ? 'page' : undefined}
                    >
                        {state.label}
                    </Link>
                ))}
            </nav>
            <form className="inbox-search" onSubmit={onSubmit}>
                <label htmlFor={`${fieldId}-q`}>Search</label>
                <input id={`${fieldId}-q`} name="q" defaultValue={filters.q ?? ''} type="text" />
                <label htmlFor={`${fieldId}-repo`}>Repository</label>
                <select id={`${fieldId}-repo`} name="repo" defaultValue={filters.repo ?? ''}>
                    <option value="">All repositories</option>
                    {repoOptions.map((repo) => (
                        <option key={`${repo.owner}/${repo.name}`} value={`${repo.owner}/${repo.name}`}>
                            {repo.owner}/{repo.name}
                        </option>
                    ))}
                </select>
                <label htmlFor={`${fieldId}-author`}>Author</label>
                <input id={`${fieldId}-author`} name="author" defaultValue={filters.author ?? ''} type="text" />
                <button type="submit">Filter</button>
            </form>
            <div className="inbox-sort">
                <span className="muted">Sort</span>
                {SORTS.map((sort) => (
                    <Link
                        key={sort.value}
                        to={filtersUrl({ ...filters, sort: sort.value })}
                        className={filters.sort === sort.value ? 'inbox-tab is-active' : 'inbox-tab'}
                        aria-current={filters.sort === sort.value ? 'page' : undefined}
                    >
                        {sort.label}
                    </Link>
                ))}
            </div>
        </div>
    );
}

function Row({ task }: { task: TaskSummary }) {
    const status: Parameters<typeof taskDotClass>[0] = {
        status: task.status,
        cancelRequestedAt: task.cancelRequestedAt,
        doneAt: task.doneAt,
        waitReason: task.waitReason,
        waitTerminalReason: task.waitTerminalReason,
    };
    const dot = taskDotClass(status);
    const live = task.status === 'running' && task.activity !== null && task.activity.trim() !== '';
    return (
        <li className="inbox-row">
            <span className="inbox-status">
                {dot !== '' ? <span className={`sidenav-dot ${dot}`} aria-hidden="true" /> : null}
                {taskStatusLabel(status)}
            </span>
            <span className="inbox-title">
                <Link to={`/tasks/${task.id}`}>{taskTitleFromCommand(task.command)}</Link>
                {live ? <span className="inbox-activity">{task.activity}</span> : null}
            </span>
            <span className="inbox-repo">{task.repo ?? '—'}</span>
            <span className="inbox-author">{task.author?.login ?? 'unknown'}</span>
            {/* The shared stamp component: relative label, precise UTC stamp as its title. */}
            <span className="inbox-when">
                <RelativeTime at={task.activityAt} />
            </span>
        </li>
    );
}

/**
 * Exactly one of: loading, one of two empty states, or the loaded rows with their own
 * load-more error and action. Split out of `InboxTaskList` so its own 4-way state chain does not
 * add to that component's cognitive complexity — each branch is an early return rather than a
 * nested ternary.
 */
function InboxTaskListBody({
    tasks,
    noTasksAtAll,
    appendNote,
}: {
    tasks: UseTasks;
    noTasksAtAll: boolean;
    appendNote: string | null;
}) {
    if (tasks.initial) return <p className="muted">Loading tasks…</p>;
    if (noTasksAtAll) {
        return (
            <div className="inbox-empty">
                <p>No tasks yet</p>
                <Link to="/tasks/new">Start your first task</Link>
            </div>
        );
    }
    if (tasks.items === null) return null;
    if (tasks.items.length === 0) {
        return (
            <div className="inbox-empty">
                <p>No tasks match these filters</p>
                <Link to="/tasks">Clear filters</Link>
            </div>
        );
    }
    return (
        <>
            <ul className="inbox-rows">
                {tasks.items.map((task) => (
                    <Row key={task.id} task={task} />
                ))}
            </ul>
            {tasks.loadMoreError !== null ? (
                <div className="inbox-error" role="alert">
                    <p>Couldn't load more tasks — {tasks.loadMoreError}</p>
                    <button type="button" onClick={tasks.loadMore}>
                        Retry
                    </button>
                </div>
            ) : null}
            {tasks.nextCursor !== null ? (
                <button type="button" onClick={tasks.loadMore} disabled={tasks.loadingMore}>
                    {tasks.loadingMore ? 'Loading…' : 'Load more'}
                </button>
            ) : null}
            <p className="inbox-note" role="status">
                {appendNote ?? ''}
            </p>
        </>
    );
}

/**
 * The inbox's content area: the load/refresh errors, then the body's one active state. Split out
 * of `TaskInboxPage` so its own render tree does not add to the page's cognitive complexity.
 */
function InboxTaskList({
    tasks,
    noTasksAtAll,
    appendNote,
}: {
    tasks: UseTasks;
    noTasksAtAll: boolean;
    appendNote: string | null;
}) {
    return (
        <>
            {tasks.error !== null ? (
                <div className="inbox-error" role="alert">
                    <p>Couldn't load tasks — {tasks.error}</p>
                    <button type="button" onClick={tasks.retry}>
                        Retry
                    </button>
                </div>
            ) : null}
            {tasks.refreshError !== null ? (
                <p className="inbox-error" role="status">
                    Couldn't refresh tasks; showing the last successful update.
                </p>
            ) : null}
            <InboxTaskListBody tasks={tasks} noTasksAtAll={noTasksAtAll} appendNote={appendNote} />
        </>
    );
}

export function TaskInboxPage() {
    const { tasks, workspace } = useTasksPage();
    const [, setSearchParams] = useSearchParams();
    const filters = tasks.filters;

    // The polite note after an append: how many rows the last Load more brought in. Owned here
    // because it is presentation state, not poll state — the hook holds rows, not narration.
    const [appendNote, setAppendNote] = useState<string | null>(null);
    const lengthRef = useRef<number | null>(null);
    useEffect(() => {
        const length = tasks.items?.length ?? 0;
        const previous = lengthRef.current;
        lengthRef.current = length;
        if (previous !== null && length > previous) setAppendNote(`${length - previous} more tasks loaded`);
        if (previous !== null && length < previous) setAppendNote(null);
    }, [tasks.items]);

    const applyFilters = (next: InboxFilters) => {
        setAppendNote(null);
        setSearchParams(
            // The defaults come off the URL entirely, so Back/Forward sees clean states.
            new URLSearchParams(
                filtersUrl(next)
                    .replace(/^\/tasks/, '')
                    .replace(/^\?/, '')
            ),
            { replace: false }
        );
    };

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const q = String(fields.get('q') ?? '')
            .trim()
            .slice(0, QUERY_MAX);
        const repo = String(fields.get('repo') ?? '');
        const author = String(fields.get('author') ?? '').trim();
        applyFilters({
            state: filters.state,
            q: q === '' ? null : q,
            repo: repo === '' ? null : repo,
            author: author === '' ? null : author,
            sort: filters.sort,
        });
    };

    const repoOptions = repoOptionsFor(workspace.data?.repos ?? [], filters.repo);
    const counts = tasks.navigation?.counts ?? null;
    const noTasksAtAll =
        tasks.items !== null && counts !== null && counts.running === 0 && counts.review === 0 && counts.past === 0;

    return (
        <section className="inbox">
            {/* The page's one heading lives in the shared PageHeader (issue 159): no eyebrow —
                "Tasks" over "Tasks" says the same thing twice — the org-wide counts beside it,
                and New task as the page's one action. */}
            <PageHeader
                title="Tasks"
                meta={<span className="muted">{navMetaSummary(counts)}</span>}
                actions={
                    <Link to="/tasks/new" className="inbox-new">
                        New task
                    </Link>
                }
            />

            <InboxFilterBar filters={filters} repoOptions={repoOptions} onSubmit={submit} />

            <InboxTaskList tasks={tasks} noTasksAtAll={noTasksAtAll} appendNote={appendNote} />
        </section>
    );
}
