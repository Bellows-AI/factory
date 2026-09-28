import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon.js';
import type { IconName } from '../components/Icon.js';
import { PageHeader } from '../components/PageHeader.js';
import { RelativeTime } from '../components/RelativeTime.js';
import { useTasksPage } from './TasksLayout.js';
import { DEFAULT_FILTERS, inboxQueryString, QUERY_MAX } from '../api/useTasks.js';
import type { InboxFilters, TaskNavigation, TaskSummary, UseTasks } from '../api/useTasks.js';
import { countLabel } from '../nav-model.js';
import { taskDotClass, taskStatusLabel, taskTitleFromCommand, taskTone } from '../task-tree.js';
import type { TaskStatus, TaskTone } from '../task-tree.js';

/**
 * `/tasks` — the task inbox. Everything it renders comes from the ONE task poll the shell owns
 * (`useTasksPage()`), never from a poll of its own; the query normalization and fetch logic live
 * in `useTasks.ts`. The filters are URL state (see `inboxFiltersFromSearch`): linkable, and
 * Back/Forward moves them — this page only writes back what its controls change.
 *
 * Top to bottom (issue 279): the header, three organization count cards (they ignore the
 * filters), the state tabs / search form / sort links, one chip per applied filter, the rows and
 * a footer that counts only what is loaded. The row grammar: the title (the row's ONE link) over
 * its one-line summary, the state as a toned pill with a VISIBLE label, repository, author and
 * the relative last activity backed by a precise `<time>`. The grid in `styles/regions/inbox.css`
 * owns the layout, and stacks each row into a card at ≤900px.
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

type CountKind = keyof TaskNavigation['counts'];

/** The three organization counts, in the order the cards read; the state each one opens. */
const COUNT_CARDS: readonly { kind: CountKind; label: string; icon: IconName }[] = [
    { kind: 'review', label: 'Needs review', icon: 'circle-dot' },
    { kind: 'running', label: 'Running', icon: 'refresh' },
    { kind: 'past', label: 'Past', icon: 'check-circle' },
];

/** The filters a chip stands for — state has its tab and sort its segmented control. */
const CHIPS: readonly { key: 'q' | 'repo' | 'author'; label: string }[] = [
    { key: 'q', label: 'Search' },
    { key: 'repo', label: 'Repository' },
    { key: 'author', label: 'Author' },
];

/**
 * Each tone's pill, per the status table in `docs/design-system.md`: the pill class, then the
 * leading glyph — an icon, or the live lamp embedded for a run that is still moving. Waiting and
 * Done carry a region modifier: the waiting edge, the done check's green.
 */
const STATE_PILL: Record<TaskTone, { className: string; mark: IconName | 'lamp' | null }> = {
    none: { className: 'pill', mark: null },
    queued: { className: 'pill pill-done', mark: 'clock' },
    running: { className: 'pill pill-ok', mark: 'lamp' },
    stopping: { className: 'pill pill-done', mark: 'lamp' },
    waiting: { className: 'pill pill-done inbox-state-waiting', mark: 'clock' },
    review: { className: 'pill pill-accent', mark: 'circle-dot' },
    failed: { className: 'pill pill-bad', mark: 'alert-circle' },
    stopped: { className: 'pill pill-done', mark: 'minus-circle' },
    done: { className: 'pill pill-done inbox-state-done', mark: 'check-circle' },
};

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

/**
 * A field's draft, reset whenever the URL's value changes under it — a removed chip, Clear
 * filters or Back must not leave the old text sitting in the box. Controlled rather than
 * remounted, so the control a keyboard user just pressed keeps its focus.
 */
function useFilterDraft(value: string | null): [string, (next: string) => void] {
    const [draft, setDraft] = useState(value ?? '');
    useEffect(() => setDraft(value ?? ''), [value]);
    return [draft, setDraft];
}

/** The organization-wide counts as three links into their state tab. They never read the
 * filters: the number is the organization's, whatever the list below is narrowed to. */
function InboxCountCards({ counts }: { counts: TaskNavigation['counts'] }) {
    return (
        <div className="inbox-cards">
            {COUNT_CARDS.map((card) => (
                <Link
                    key={card.kind}
                    to={filtersUrl({ ...DEFAULT_FILTERS, state: card.kind })}
                    className={`inbox-card inbox-card-${card.kind}`}
                    aria-label={`${countLabel(card.kind, counts[card.kind])} across the organization`}
                >
                    <span className="inbox-card-disc">
                        <Icon name={card.icon} size={24} />
                    </span>
                    <span className="inbox-card-text">
                        <span className="inbox-card-line">
                            <span className="inbox-card-value">{counts[card.kind]}</span>
                            <span className="inbox-card-label">{card.label}</span>
                        </span>
                        <span className="inbox-card-caption">Organization total</span>
                    </span>
                </Link>
            ))}
        </div>
    );
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
    const [q, setQ] = useFilterDraft(filters.q);
    const [repo, setRepo] = useFilterDraft(filters.repo);
    const [author, setAuthor] = useFilterDraft(filters.author);
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
                <input
                    className="field"
                    id={`${fieldId}-q`}
                    name="q"
                    value={q}
                    onChange={(event) => setQ(event.target.value)}
                    placeholder="Search task requests"
                    type="text"
                />
                <label htmlFor={`${fieldId}-repo`}>Repository</label>
                <select
                    className="field"
                    id={`${fieldId}-repo`}
                    name="repo"
                    value={repo}
                    onChange={(event) => setRepo(event.target.value)}
                >
                    <option value="">All repositories</option>
                    {repoOptions.map((option) => (
                        <option key={`${option.owner}/${option.name}`} value={`${option.owner}/${option.name}`}>
                            {option.owner}/{option.name}
                        </option>
                    ))}
                </select>
                <label htmlFor={`${fieldId}-author`}>Author</label>
                <input
                    className="field"
                    id={`${fieldId}-author`}
                    name="author"
                    value={author}
                    onChange={(event) => setAuthor(event.target.value)}
                    type="text"
                />
                <button type="submit">Filter</button>
            </form>
            <nav className="inbox-sort" aria-label="Sort">
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
            </nav>
        </div>
    );
}

/** One chip per applied search/repository/author filter; each × is a link to the same URL with
 * that one param gone, and Clear filters is the bare inbox. Nothing renders at the defaults. */
function InboxChips({ filters }: { filters: InboxFilters }) {
    const applied = CHIPS.filter((chip) => filters[chip.key] !== null);
    if (applied.length === 0) return null;
    return (
        <div className="inbox-chips">
            {applied.map((chip) => (
                <span key={chip.key} className="inbox-chip">
                    {chip.label}: {filters[chip.key]}
                    <Link
                        to={filtersUrl({ ...filters, [chip.key]: null })}
                        className="inbox-chip-remove"
                        aria-label={`Remove filter: ${chip.label}`}
                    >
                        <Icon name="x" size={14} />
                    </Link>
                </span>
            ))}
            <Link to="/tasks" className="inbox-clear">
                Clear filters
            </Link>
        </div>
    );
}

function StatePill({ status }: { status: TaskStatus }) {
    const pill = STATE_PILL[taskTone(status)];
    return (
        <span className={pill.className}>
            {pill.mark === 'lamp' ? (
                <span className={`sidenav-dot ${taskDotClass(status)}`} aria-hidden="true" />
            ) : pill.mark !== null ? (
                <Icon name={pill.mark} size={14} />
            ) : null}
            {taskStatusLabel(status)}
        </span>
    );
}

function Author({ author }: { author: TaskSummary['author'] }) {
    if (author === null) {
        return (
            <span className="inbox-author">
                <span className="avatar avatar-fallback" aria-hidden="true">
                    ?
                </span>
                <span className="inbox-cell-text">Unknown author</span>
            </span>
        );
    }
    return (
        <span className="inbox-author">
            {author.avatarUrl !== null ? (
                <img className="avatar" src={author.avatarUrl} alt="" width={28} height={28} />
            ) : (
                <span className="avatar avatar-fallback" aria-hidden="true">
                    {author.login.slice(0, 1).toUpperCase()}
                </span>
            )}
            <span className="inbox-cell-text">{author.login}</span>
        </span>
    );
}

/** The line under the title: what a running task is doing, or what a finished one said. A
 * queued or parked task has neither, and a stale line would lie about a run no longer going. */
function rowSummary(task: TaskSummary): string | null {
    const line = task.status === 'running' ? task.activity : task.status === 'queued' ? null : task.summary;
    return line !== null && line.trim() !== '' ? line : null;
}

function Row({ task }: { task: TaskSummary }) {
    const status: TaskStatus = {
        status: task.status,
        cancelRequestedAt: task.cancelRequestedAt,
        doneAt: task.doneAt,
        waitReason: task.waitReason,
        waitTerminalReason: task.waitTerminalReason,
    };
    const dot = taskDotClass(status);
    const summary = rowSummary(task);
    return (
        <li className="inbox-row">
            <span className="inbox-title">
                {dot !== '' ? <span className={`sidenav-dot ${dot}`} aria-hidden="true" /> : null}
                <Link to={`/tasks/${task.id}`}>{taskTitleFromCommand(task.command)}</Link>
                {summary !== null ? (
                    <span className="inbox-summary" title={summary}>
                        {summary}
                    </span>
                ) : null}
            </span>
            <span className="inbox-state">
                <StatePill status={status} />
            </span>
            <span className="inbox-repo">
                <Icon name="repo" />
                <span className="inbox-cell-text">{task.repo ?? '—'}</span>
            </span>
            <Author author={task.author} />
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
                <Icon name="list" size={24} />
                <p>No tasks yet</p>
                <Link to="/tasks/new">Start your first task</Link>
            </div>
        );
    }
    if (tasks.items === null) return null;
    if (tasks.items.length === 0) {
        return (
            <div className="inbox-empty">
                <Icon name="search" size={24} />
                <p>No tasks match these filters</p>
                <Link to="/tasks">Clear filters</Link>
            </div>
        );
    }
    const loaded = tasks.items.length;
    return (
        <>
            <div className="inbox-list">
                <div className="inbox-columns" aria-hidden="true">
                    <span>Task</span>
                    <span>State</span>
                    <span>Repository</span>
                    <span>Author</span>
                    <span>Updated</span>
                </div>
                <ul className="inbox-rows">
                    {tasks.items.map((task) => (
                        <Row key={task.id} task={task} />
                    ))}
                </ul>
            </div>
            {tasks.loadMoreError !== null ? (
                <div className="inbox-error" role="alert">
                    <p>Couldn't load more tasks — {tasks.loadMoreError}</p>
                    <button type="button" onClick={tasks.loadMore}>
                        Retry
                    </button>
                </div>
            ) : null}
            <div className="inbox-footer">
                <p className="muted">
                    Showing {loaded} loaded {loaded === 1 ? 'task' : 'tasks'}
                </p>
                {tasks.nextCursor !== null ? (
                    <button type="button" onClick={tasks.loadMore} disabled={tasks.loadingMore}>
                        {tasks.loadingMore ? 'Loading…' : 'Load more'}
                    </button>
                ) : null}
            </div>
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
                <div className="banner-bad" role="alert">
                    <Icon name="alert-circle" size={24} />
                    <div className="inbox-banner-body">
                        <p className="banner-title">Couldn't load tasks — {tasks.error}</p>
                        <button type="button" onClick={tasks.retry}>
                            Retry
                        </button>
                    </div>
                </div>
            ) : null}
            {/* Stale only when rows exist: a first-page failure carries the same message as
                `error` above, and there is no last successful update to show. */}
            {tasks.refreshError !== null && tasks.error === null ? (
                <div className="banner-warn" role="status">
                    <Icon name="alert-triangle" size={24} />
                    <p className="banner-title">Couldn't refresh tasks; showing the last successful update.</p>
                </div>
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
        // Nothing loaded yet is no baseline: the first page landing is not "N more tasks loaded".
        // A reload (any filter link) drops the old narration with the old rows.
        if (tasks.items === null) {
            lengthRef.current = null;
            setAppendNote(null);
            return;
        }
        const length = tasks.items.length;
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
                "Tasks" over "Tasks" says the same thing twice — and New task as the page's one
                action. The org-wide counts are the cards below, not a meta line. */}
            <PageHeader
                title="Tasks"
                description="Delegate software work to AI agents and review their changes."
                actions={
                    <Link to="/tasks/new" className="inbox-new">
                        <Icon name="plus" size={20} />
                        New task
                    </Link>
                }
            />

            {counts !== null ? <InboxCountCards counts={counts} /> : null}

            <InboxFilterBar filters={filters} repoOptions={repoOptions} onSubmit={submit} />

            <InboxChips filters={filters} />

            <InboxTaskList tasks={tasks} noTasksAtAll={noTasksAtAll} appendNote={appendNote} />
        </section>
    );
}
