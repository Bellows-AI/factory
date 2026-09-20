import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader.js';
import { useTasksPage } from './TasksLayout.js';
import type { InboxFilters, TaskSummary } from '../api/useTasks.js';
import { relativeTime, taskTime } from '../format.js';
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

/** The URL for a filter set: defaults omitted, so the default view stays `/tasks`. */
const filtersUrl = (filters: InboxFilters): string => {
    const params = new URLSearchParams();
    if (filters.state !== 'attention') params.set('state', filters.state);
    if (filters.q !== null) params.set('q', filters.q);
    if (filters.repo !== null) params.set('repo', filters.repo);
    if (filters.author !== null) params.set('author', filters.author);
    if (filters.sort !== 'newest') params.set('sort', filters.sort);
    const query = params.toString();
    return query === '' ? '/tasks' : `/tasks?${query}`;
};

function Row({ task }: { task: TaskSummary }) {
    const status: Parameters<typeof taskDotClass>[0] = {
        status: task.status,
        cancelRequestedAt: task.cancelRequestedAt,
        doneAt: task.doneAt,
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
            <time className="inbox-when" dateTime={task.activityAt} title={taskTime(task.activityAt)}>
                {relativeTime(task.activityAt)}
            </time>
        </li>
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
            .slice(0, 200);
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

    // The workspace's selected repositories, plus the currently filtered one if it has since
    // disappeared from the configuration — a linkable URL must keep rendering its own filter.
    const repoOptions = (workspace.data?.repos ?? []).map((repo) => ({ owner: repo.owner, name: repo.name }));
    if (filters.repo !== null && !repoOptions.some((r) => `${r.owner}/${r.name}` === filters.repo)) {
        const [owner, name] = filters.repo.split('/');
        repoOptions.push({ owner: owner ?? filters.repo, name: name ?? '' });
    }

    const counts = tasks.navigation?.counts ?? null;
    const metaClauses: string[] = [];
    if (counts !== null && counts.running > 0) metaClauses.push(`${counts.running} running`);
    if (counts !== null && counts.review > 0) metaClauses.push(`${counts.review} need review`);

    const loaded = tasks.items !== null;
    const noTasksAtAll = loaded && counts !== null && counts.running === 0 && counts.review === 0 && counts.past === 0;

    return (
        <section className="inbox">
            {/* The page's one heading lives in the shared PageHeader (issue 159): no eyebrow —
                "Tasks" over "Tasks" says the same thing twice — the org-wide counts beside it,
                and New task as the page's one action. */}
            <PageHeader
                title="Tasks"
                meta={
                    <span className="muted">
                        {metaClauses.length === 0 ? 'Nothing moving' : metaClauses.join(' · ')}
                    </span>
                }
                actions={
                    <Link to="/tasks/new" className="inbox-new">
                        New task
                    </Link>
                }
            />

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
                <form className="inbox-search" onSubmit={submit}>
                    <label htmlFor="inbox-q">Search</label>
                    <input id="inbox-q" name="q" defaultValue={filters.q ?? ''} type="text" />
                    <label htmlFor="inbox-repo">Repository</label>
                    <select id="inbox-repo" name="repo" defaultValue={filters.repo ?? ''}>
                        <option value="">All repositories</option>
                        {repoOptions.map((repo) => (
                            <option key={`${repo.owner}/${repo.name}`} value={`${repo.owner}/${repo.name}`}>
                                {repo.owner}/{repo.name}
                            </option>
                        ))}
                    </select>
                    <label htmlFor="inbox-author">Author</label>
                    <input id="inbox-author" name="author" defaultValue={filters.author ?? ''} type="text" />
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

            {tasks.initial ? (
                <p className="muted">Loading tasks…</p>
            ) : noTasksAtAll ? (
                <div className="inbox-empty">
                    <p>No tasks yet</p>
                    <Link to="/tasks/new">Start your first task</Link>
                </div>
            ) : loaded && tasks.items!.length === 0 ? (
                <div className="inbox-empty">
                    <p>No tasks match these filters</p>
                    <Link to="/tasks">Clear filters</Link>
                </div>
            ) : loaded ? (
                <>
                    <ul className="inbox-rows">
                        {tasks.items!.map((task) => (
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
            ) : null}
        </section>
    );
}
