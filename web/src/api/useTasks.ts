import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { AuthorRef, JobStatus, QueueResult } from './useJobs.js';
import { reportUnauthenticated } from './useSession.js';

/**
 * The client's copy of the task-summary read model (`GET /api/tasks`): one row per thread ROOT,
 * the present tense read off the chain's newest run. Copied rather than imported — the web owns
 * the shapes it renders — and camelCase as served. `status`/`author` reuse the job row's types:
 * the head run's status and the root's author are the same people and the same words.
 */
export type TaskState = 'attention' | 'running' | 'review' | 'past';
export type TaskSort = 'newest' | 'oldest';

export interface TaskSummary {
    /** The root job id — the route target. */
    id: string;
    /** The root command; the UI derives the first-line title from it. */
    command: string;
    /** The newest run's status — the chain head's, not the root's. */
    status: JobStatus;
    cancelRequestedAt: string | null;
    doneAt: string | null;
    repo: string | null;
    executor: string | null;
    author: AuthorRef | null;
    /** The head's live activity line, while the head run is the one moving. */
    activity: string | null;
    /** The head's terminal summary — the agent's own last words on the newest run. */
    summary: string | null;
    /**
     * The thread's durable PR-review wait, when it has one: the block's reason, when the wait
     * began, and — once terminal — why it ended. The open wait wins over a terminal one. All
     * null for a thread that never entered a wait. Never inferred client-side from output text
     * or a workflow node name — straight off this structured contract.
     */
    waitReason: string | null;
    waitingSince: string | null;
    waitTerminalReason: string | null;
    createdAt: string;
    /** The head's newest of created/started/finished/done — what orders and paginates. */
    activityAt: string;
}

export interface TaskNavigation {
    counts: { running: number; review: number; past: number };
    /** Up to 3 running tasks, newest first — the sidenav's preview. */
    running: TaskSummary[];
    /** Up to 5 review tasks, newest first. */
    review: TaskSummary[];
}

export interface TaskListResponse {
    /** Organization-wide and filter-independent; the page below obeys the filters. */
    navigation: TaskNavigation;
    page: { items: TaskSummary[]; nextCursor: string | null };
}

/** The inbox filters, normalized. This is URL state, nothing else — no localStorage, no defaults
 * invented outside `inboxFiltersFromSearch`. */
export interface InboxFilters {
    state: TaskState;
    q: string | null;
    repo: string | null;
    author: string | null;
    sort: TaskSort;
}

export const DEFAULT_FILTERS: InboxFilters = {
    state: 'attention',
    q: null,
    repo: null,
    author: null,
    sort: 'newest',
};

const TASK_STATES: readonly TaskState[] = ['attention', 'running', 'review', 'past'];
/** A login shape, the same rule the route enforces — copied, never imported from the server. */
const AUTHOR_SHAPE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,98}[a-zA-Z0-9])?$/;
/** Two non-empty path-segment halves: anything else is not an owner/name repo and is not sent. */
const REPO_SHAPE = /^[^/\\]+\/[^/\\]+$/;
const QUERY_MAX = 200;

/**
 * The filters one URL search names, with every unknown clamped to the default — the URL is
 * user-editable input, and a hand-typed `?state=weird` must look like the default view, not
 * reach the API as a 400. Never throws.
 */
export function inboxFiltersFromSearch(search: string): InboxFilters {
    const params = new URLSearchParams(search);
    const state = params.get('state');
    const sort = params.get('sort');
    const rawQ = params.get('q');
    const q = rawQ === null ? null : rawQ.trim().slice(0, QUERY_MAX) || null;
    const repo = params.get('repo');
    const author = params.get('author');
    const trimmedAuthor = author === null ? null : author.trim();
    return {
        state: state !== null && TASK_STATES.includes(state as TaskState) ? (state as TaskState) : 'attention',
        q,
        repo: repo !== null && REPO_SHAPE.test(repo) ? repo : null,
        author: trimmedAuthor !== null && AUTHOR_SHAPE.test(trimmedAuthor) ? trimmedAuthor : null,
        sort: sort === 'oldest' || sort === 'newest' ? sort : 'newest',
    };
}

/**
 * The query string a filter set polls with — the defaults omitted, so the default inbox asks for
 * exactly `GET /api/tasks` and a link that shares a view carries only what makes it that view.
 */
export function inboxQueryString(filters: InboxFilters): string {
    const params = new URLSearchParams();
    if (filters.state !== 'attention') params.set('state', filters.state);
    if (filters.q !== null) params.set('q', filters.q);
    if (filters.repo !== null) params.set('repo', filters.repo);
    if (filters.author !== null) params.set('author', filters.author);
    if (filters.sort !== 'newest') params.set('sort', filters.sort);
    return params.toString();
}

/** What `useTasks` returns — published through the shell's outlet context, like the stats poll. */
export interface UseTasks {
    /** Organization-wide; kept through a filter change until the new response lands. */
    navigation: TaskNavigation | null;
    /** The loaded pages: the first page plus every Load-more append. Null until one lands. */
    items: TaskSummary[] | null;
    nextCursor: string | null;
    /** The first page is in flight with nothing to show yet — the skeletons state. */
    initial: boolean;
    /** A Load more request is in flight — the button disables itself on this. */
    loadingMore: boolean;
    /** A first-page refetch (poll, retry or post-mutation) is in flight over existing rows. */
    refreshing: boolean;
    /** The first page failed with nothing to show — the inline error state. */
    error: string | null;
    /** A background refresh failed; the last good rows stay beside it. */
    refreshError: string | null;
    /** An older-page fetch failed; the loaded rows stay beside it. */
    loadMoreError: string | null;
    /** The normalized filters in effect — the URL's on the inbox, the defaults elsewhere. */
    filters: InboxFilters;
    retry: () => void;
    loadMore: () => void;
    refresh: () => void;
    /** The task mutations, named as a group so the pages read `tasks.actions.queue(...)`. */
    actions: {
        queue: (
            command: string,
            repo: string | null,
            executor: string,
            workflow: string | null,
            workflowParams: Record<string, string> | null
        ) => Promise<QueueResult>;
        followUp: (id: string, command: string) => Promise<QueueResult>;
        markDone: (id: string) => Promise<string | null>;
        stop: (id: string) => Promise<string | null>;
        remove: (id: string) => Promise<string | null>;
    };
}

/** The first-page failure: the retained refresh error with nothing beside it. Exported pure so
 * the offline suite pins the depth test — a failed refresh WITH rows keeps the rows beside the
 * banner; without them it IS the page's inline error, and the skeleton state never swallows it. */
export function firstPageError(items: TaskSummary[] | null, refreshError: string | null): string | null {
    return items === null ? refreshError : null;
}

/** Raised when a page answers 401 — the caller hands the session gate the news and stops quietly. */
export class TaskAuthExpired extends Error {}

const firstPageUrl = (query: string): string => (query === '' ? '/api/tasks' : `/api/tasks?${query}`);
const morePageUrl = (query: string, cursor: string): string =>
    `/api/tasks?${query === '' ? '' : `${query}&`}cursor=${encodeURIComponent(cursor)}`;

/**
 * Reads enough successive keyset pages to REBUILD a previously loaded depth, deduped by task id
 * (first occurrence wins — the newest position). Exported with the fetch injected so the offline
 * suite can drive the whole chain: a plain first-page swap on refresh would collapse the pages
 * the member already paged through, every three seconds while anything runs.
 *
 * Returns page one's navigation (org-wide, so any page could serve it — the first is simply the
 * freshest), the merged rows, the cursor of the LAST page read (null when the list shrank below
 * the old depth — the loaded depth collapses to what the list still serves), and how many pages
 * the chain actually read.
 */
export async function fetchDepthPages(
    fetchPage: (url: string) => Promise<TaskListResponse>,
    query: string,
    depth: number
): Promise<{
    navigation: TaskNavigation;
    items: TaskSummary[];
    nextCursor: string | null;
    pages: number;
}> {
    const first = await fetchPage(firstPageUrl(query));
    const items: TaskSummary[] = [];
    const known = new Set<string>();
    for (const task of first.page.items) {
        if (!known.has(task.id)) {
            known.add(task.id);
            items.push(task);
        }
    }
    let cursor = first.page.nextCursor;
    let pages = 1;
    while (cursor !== null && pages < depth) {
        const next = await fetchPage(morePageUrl(query, cursor));
        for (const task of next.page.items) {
            if (!known.has(task.id)) {
                known.add(task.id);
                items.push(task);
            }
        }
        cursor = next.page.nextCursor;
        pages += 1;
    }
    return { navigation: first.navigation, items, nextCursor: cursor, pages };
}

/**
 * The ONE task-overview poll. Same discipline as the polls it replaces (`useJobs`): one abortable
 * chain, the last good answer stays on screen through a failed tick, 401s are handed to the gate
 * rather than bannered, and a hidden tab slows to a crawl. The cadence rides the ORG's motion —
 * 3s while anything in the organization is moving, 30s when nothing can move, 15s/60s in a hidden
 * tab — because the board is shared: another member's queued task must appear without anybody
 * here acting first.
 *
 * One instance, owned by the shell, gated to the tasks area; the filters come from the URL on the
 * inbox (`/tasks` exactly) and are the defaults on the composer and detail routes. A filter change
 * is a new page: the loaded rows and cursor reset and the in-flight request is aborted, while the
 * navigation summary — org-wide, filter-independent — is kept until the new response lands.
 */
export function useTasks(enabled: boolean): UseTasks {
    const location = useLocation();
    const onInbox = location.pathname === '/tasks';
    const filters = useMemo(
        () => (onInbox ? inboxFiltersFromSearch(location.search) : DEFAULT_FILTERS),
        [onInbox, location.search]
    );
    const query = inboxQueryString(filters);

    const [navigation, setNavigation] = useState<TaskNavigation | null>(null);
    const [items, setItems] = useState<TaskSummary[] | null>(null);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [refreshError, setRefreshError] = useState<string | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

    const timer = useRef<number | null>(null);
    const controller = useRef<AbortController | null>(null);
    const moreController = useRef<AbortController | null>(null);
    /** How many keyset pages the member has loaded — the depth every refresh must rebuild. */
    const depthRef = useRef(1);
    /** Bound at the latest render, so the callbacks below re-arm the current chain. */
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;

    const stopChain = () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
    };

    const poll = useCallback(async (signal: AbortSignal) => {
        if (signal.aborted) return;
        // The query the chain was armed with — read off the ref at tick time, not closure time,
        // so a re-armed chain always asks the CURRENT question.
        setRefreshing(true);
        // One page reader for the whole chain: refusals raise (the catch keeps the last good
        // rows whole — never a half-rebuilt page), and a 401 stops quietly at the gate.
        const fetchPage = async (url: string): Promise<TaskListResponse> => {
            const response = await fetch(url, { signal });
            if (response.status === 401) throw new TaskAuthExpired();
            if (!response.ok) {
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                throw new Error(body.error ?? `Request failed (${response.status})`);
            }
            return (await response.json()) as TaskListResponse;
        };
        try {
            const rebuilt = await fetchDepthPages(fetchPage, queryRef.current, depthRef.current);
            // The chain can complete after the area was left or the filters moved; landing it
            // would paint one question's answer onto another.
            if (signal.aborted) return;
            setNavigation(rebuilt.navigation);
            setItems(rebuilt.items);
            setNextCursor(rebuilt.nextCursor);
            depthRef.current = rebuilt.pages;
            setRefreshError(null);
            setLoadMoreError(null);
            setRefreshing(false);
            const moving = rebuilt.navigation.counts.running > 0;
            const delay = document.hidden ? (moving ? 15_000 : 60_000) : moving ? 3_000 : 30_000;
            timer.current = window.setTimeout(() => void poll(signal), delay);
        } catch (e) {
            if (signal.aborted) return;
            if (e instanceof TaskAuthExpired) {
                setRefreshing(false);
                reportUnauthenticated();
                return;
            }
            setRefreshError((e as Error).message);
            setRefreshing(false);
            // A failed tick must not end the chain: a transient 503 during a deploy would
            // otherwise freeze the inbox until somebody acts. The quiet floor is the retry pace.
            timer.current = window.setTimeout(() => void poll(signal), document.hidden ? 60_000 : 30_000);
        }
    }, []);

    /** The query the CURRENT question polls with, kept beside the chain. */
    const queryRef = useRef(query);
    queryRef.current = query;

    const start = useCallback(() => {
        if (!enabledRef.current) return;
        controller.current?.abort();
        // Retire an in-flight Load more with it: its own finally skips on abort, so the flag
        // would stay raised and hold the button disabled under the fresh chain.
        moreController.current?.abort();
        setLoadingMore(false);
        stopChain();
        const own = new AbortController();
        controller.current = own;
        void poll(own.signal);
    }, [poll]);

    useEffect(() => {
        if (!enabled) {
            // Leaving the tasks area stops the question: no chain, no timer, no stale answer held
            // in wait for the next visit.
            controller.current?.abort();
            moreController.current?.abort();
            stopChain();
            setNavigation(null);
            setItems(null);
            setNextCursor(null);
            setRefreshError(null);
            setLoadMoreError(null);
            setRefreshing(false);
            setLoadingMore(false);
            return;
        }
        // A filter change is a new PAGE, not a new board: the loaded rows and cursor reset, the
        // in-flight page request is aborted, and the org-wide navigation is kept until the fresh
        // response lands — the counts and preview must not flicker because the view narrowed.
        controller.current?.abort();
        moreController.current?.abort();
        stopChain();
        setItems(null);
        setNextCursor(null);
        setRefreshError(null);
        setLoadMoreError(null);
        setLoadingMore(false);
        depthRef.current = 1;
        start();
        return () => {
            controller.current?.abort();
            moreController.current?.abort();
            stopChain();
        };
    }, [start, enabled, query]);

    const retry = useCallback(() => start(), [start]);

    /** The poll's own re-arm, exposed for the mutations: an action changes the org's state. */
    const refresh = useCallback(() => start(), [start]);

    const loadMore = useCallback(() => {
        const cursor = nextCursor;
        if (cursor === null || loadingMore || !enabledRef.current) return;
        moreController.current?.abort();
        const own = new AbortController();
        moreController.current = own;
        setLoadingMore(true);
        setLoadMoreError(null);
        void (async () => {
            try {
                const response = await fetch(morePageUrl(queryRef.current, cursor), { signal: own.signal });
                if (response.status === 401) {
                    reportUnauthenticated();
                    return;
                }
                if (!response.ok) {
                    if (own.signal.aborted) return;
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    setLoadMoreError(body.error ?? `Could not load more tasks (${response.status})`);
                    return;
                }
                const body = (await response.json()) as TaskListResponse;
                if (own.signal.aborted) return;
                setNavigation(body.navigation);
                setItems((prev) => {
                    if (prev === null) return body.page.items;
                    // The keyset contract says no duplicates; a task whose activity stamp moved
                    // between page reads could straddle two of them anyway, and one row twice
                    // would be a visible lie. Latest activity wins the spot.
                    const known = new Set(prev.map((task) => task.id));
                    return [...prev, ...body.page.items.filter((task) => !known.has(task.id))];
                });
                setNextCursor(body.page.nextCursor);
                depthRef.current += 1;
            } catch (e) {
                if (!own.signal.aborted) setLoadMoreError((e as Error).message);
            } finally {
                if (!own.signal.aborted) setLoadingMore(false);
            }
        })();
    }, [nextCursor, loadingMore]);

    // The mutations, moved whole from useJobs: every one re-arms the first page on success, so
    // the member sees the follow-up appear, or the done state land, on the next tick.
    const actions = useMemo(
        () => ({
            async queue(
                command: string,
                repo: string | null,
                executor: string,
                workflow: string | null,
                workflowParams: Record<string, string> | null
            ): Promise<QueueResult> {
                try {
                    const response = await fetch('/api/jobs', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ command, repo, executor, workflow, workflowParams }),
                    });
                    if (response.status === 401) {
                        reportUnauthenticated();
                        return { id: null, error: 'Your session expired' };
                    }
                    if (!response.ok) {
                        const body = (await response.json().catch(() => ({}))) as { error?: string };
                        return { id: null, error: body.error ?? `Could not queue the task (${response.status})` };
                    }
                    const body = (await response.json()) as { id: string };
                    start();
                    return { id: body.id, error: null };
                } catch (e) {
                    return { id: null, error: (e as Error).message };
                }
            },
            async followUp(id: string, command: string): Promise<QueueResult> {
                try {
                    const response = await fetch(`/api/jobs/${id}/follow-up`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ command }),
                    });
                    if (response.status === 401) {
                        reportUnauthenticated();
                        return { id: null, error: 'Your session expired' };
                    }
                    if (!response.ok) {
                        const body = (await response.json().catch(() => ({}))) as { error?: string };
                        return { id: null, error: body.error ?? `Could not queue the follow-up (${response.status})` };
                    }
                    const body = (await response.json()) as { id: string };
                    start();
                    return { id: body.id, error: null };
                } catch (e) {
                    return { id: null, error: (e as Error).message };
                }
            },
            async markDone(id: string): Promise<string | null> {
                try {
                    const response = await fetch(`/api/jobs/${id}/done`, { method: 'POST' });
                    if (response.status === 401) {
                        reportUnauthenticated();
                        return 'Your session expired';
                    }
                    if (!response.ok) {
                        const body = (await response.json().catch(() => ({}))) as { error?: string };
                        return body.error ?? `Could not mark the task done (${response.status})`;
                    }
                    start();
                    return null;
                } catch (e) {
                    return (e as Error).message;
                }
            },
            async stop(id: string): Promise<string | null> {
                try {
                    const response = await fetch(`/api/jobs/${id}/stop`, { method: 'POST' });
                    if (response.status === 401) {
                        reportUnauthenticated();
                        return 'Your session expired';
                    }
                    if (!response.ok) {
                        const body = (await response.json().catch(() => ({}))) as { error?: string };
                        return body.error ?? `Could not stop the task (${response.status})`;
                    }
                    start();
                    return null;
                } catch (e) {
                    return (e as Error).message;
                }
            },
            async remove(id: string): Promise<string | null> {
                try {
                    const response = await fetch(`/api/jobs/${id}/remove`, { method: 'POST' });
                    if (response.status === 401) {
                        reportUnauthenticated();
                        return 'Your session expired';
                    }
                    if (!response.ok) {
                        const body = (await response.json().catch(() => ({}))) as { error?: string };
                        return body.error ?? `Could not remove the task (${response.status})`;
                    }
                    start();
                    return null;
                } catch (e) {
                    return (e as Error).message;
                }
            },
        }),
        [start]
    );

    // The first-page failure is the retained refresh error with nothing to show beside it — one
    // state, not two: a failed first page and a failed refresh are the same fact at different
    // depths, and the page renders it inline with a Retry while the rows exist.
    const error = firstPageError(items, refreshError);
    return {
        navigation,
        items,
        nextCursor,
        // The skeletons state: a first page in flight with nothing to show yet — including a
        // filter change, whose previous rows are deliberately gone.
        initial: items === null && error === null,
        loadingMore,
        refreshing,
        error,
        refreshError,
        loadMoreError,
        filters,
        retry,
        loadMore,
        refresh,
        actions,
    };
}
