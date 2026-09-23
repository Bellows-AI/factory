import { UUID } from '../config.js';
import type {
    Job,
    JobStatus,
    TaskBucket,
    TaskListFilters,
    TaskListResponse,
    TaskState,
    TaskSummary,
} from './job-store.js';

/**
 * The task read model's pure half — the rules `GET /api/tasks` serves, written once so the
 * PostgreSQL query, the in-memory list and the tests cannot drift.
 *
 * The store's SQL implements the same rules over the `job` table; `memoryTaskList` implements them
 * over an array of `Job` rows, which is what the route tests and any in-memory board run on. One
 * rule, two engines: the bucket a task sits in, the stamps it orders by, the cursor that pages it.
 */

/** The terminal set: the statuses a run ends with. `dead` is the board's verdict, never a worker's. */
const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'dead', 'stopped'];

/**
 * The bucket of a task whose newest run has `status` and the user's done stamp `doneAt` — the
 * HEAD run's, not the thread's: `taskSections()` reads the head, and a done task resurrected by a
 * follow-up must land back in running because the head is that follow-up.
 *
 * An OPEN PR-review wait (`waitReason` set, `waitTerminalReason` still null) buckets as review
 * the same way a terminal status does, whatever status the row itself carries while parked on it
 * — a thread waiting on a human is exactly the actionable case review exists for, never running.
 * A wait that has gone terminal (`waitTerminalReason` set) carries no special weight here: the
 * ordinary status/doneAt rule decides, the same as a thread that never waited at all.
 */
export function taskBucket(
    status: JobStatus,
    doneAt: string | null,
    waitReason: string | null,
    waitTerminalReason: string | null
): TaskBucket {
    const terminal = TERMINAL.includes(status) || (waitReason !== null && waitTerminalReason === null);
    return terminal ? (doneAt === null ? 'review' : 'past') : 'running';
}

/**
 * When the task last changed: the head run's newest of its four stamps. ISO stamps compare as
 * strings — the same convention `activityKey()` in the web layer applies.
 */
export function activityAtOf(head: {
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    doneAt: string | null;
}): string {
    let key = head.createdAt;
    for (const stamp of [head.startedAt, head.finishedAt, head.doneAt]) {
        if (stamp !== null && stamp > key) key = stamp;
    }
    return key;
}

/**
 * The pagination cursor: the keyset position plus the exact query it was minted under, so a
 * cursor cannot silently be reused with different filters — that would answer page 2 of a
 * different question. Base64url JSON: opaque to a client, trivially auditable here.
 */
export interface TaskCursor {
    v: number;
    sort: 'newest' | 'oldest';
    state: TaskState;
    q?: string | undefined;
    repo?: string | undefined;
    author?: string | undefined;
    /** The keyset position: the last returned row's activity stamp and root id. */
    activityAt: string;
    rootId: string;
}

const CURSOR_VERSION = 1;

/** How many of each bucket the navigation strip previews, before a member opens the full list. */
const NAV_RUNNING_PREVIEW_LIMIT = 3;
const NAV_REVIEW_PREVIEW_LIMIT = 5;

/** The filters a cursor binds — the fields of `TaskListFilters` the store normalizes before use. */
export type TaskCursorFilters = Pick<TaskCursor, 'sort' | 'state' | 'q' | 'repo' | 'author'>;

export function encodeCursor(payload: Omit<TaskCursor, 'v'>): string {
    const cursor: TaskCursor = { v: CURSOR_VERSION, ...payload };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor issued by this endpoint, or null for anything a client may have invented:
 * malformed, version-stale, minted under a different sort, or carrying filters that differ from
 * the request's normalized ones — an absent filter is itself a bound value.
 */
export function decodeCursor(raw: string, expected: TaskCursorFilters): TaskCursor | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const cursor = parsed as Record<string, unknown>;
    if (cursor.v !== CURSOR_VERSION) return null;
    if (cursor.sort !== expected.sort || cursor.state !== expected.state) return null;
    for (const key of ['q', 'repo', 'author'] as const) {
        if (cursor[key] !== expected[key]) return null;
    }
    // The minted shape is exact ISO — a parseable-but-non-ISO stamp would survive here and die
    // later at the SQL cast, a 503 where BAD_CURSOR is the truthful answer.
    const stamp = typeof cursor.activityAt === 'string' ? new Date(cursor.activityAt) : null;
    if (stamp === null || Number.isNaN(stamp.getTime()) || stamp.toISOString() !== cursor.activityAt) {
        return null;
    }
    if (typeof cursor.rootId !== 'string' || !UUID.test(cursor.rootId)) return null;
    return cursor as unknown as TaskCursor;
}

type ResolvedTask = { summary: TaskSummary; bucket: TaskBucket };

/**
 * One entry per root row; a follow-up whose root is absent has no command or author to
 * summarize, so it is skipped rather than invented. The head is the thread's newest member —
 * created first, id descending on a tie — the same resolution the sidenav's chainHead applies.
 */
function resolveTaskThreads(jobs: readonly Job[]): ResolvedTask[] {
    const threads = new Map<string, { root: Job; head: Job }>();
    for (const row of jobs) {
        if (row.followUpTo === null) threads.set(row.id, { root: row, head: row });
    }
    for (const row of jobs) {
        const thread = threads.get(row.rootJobId);
        if (!thread) continue;
        if (
            row.createdAt > thread.head.createdAt ||
            (row.createdAt === thread.head.createdAt && row.id > thread.head.id)
        ) {
            thread.head = row;
        }
    }

    return [...threads.values()].map(({ root, head }): ResolvedTask => {
        const summary: TaskSummary = {
            id: root.id,
            command: root.command,
            status: head.status,
            cancelRequestedAt: head.cancelRequestedAt,
            doneAt: head.doneAt,
            repo: root.repo,
            executor: root.executor,
            author: root.author,
            activity: head.runtime?.activity ?? null,
            summary: head.summary,
            // The in-memory engine has no PR-wait store to join — a thread's wait reads null
            // here, exactly as it does on an org with no waits recorded.
            waitReason: null,
            waitingSince: null,
            waitTerminalReason: null,
            createdAt: root.createdAt,
            activityAt: activityAtOf(head),
        };
        return {
            summary,
            bucket: taskBucket(summary.status, summary.doneAt, summary.waitReason, summary.waitTerminalReason),
        };
    });
}

const byNewest = (a: { summary: TaskSummary }, b: { summary: TaskSummary }): number => {
    if (a.summary.activityAt !== b.summary.activityAt) return a.summary.activityAt < b.summary.activityAt ? 1 : -1;
    return a.summary.id < b.summary.id ? 1 : -1;
};

/**
 * Navigation is the whole organization's, before any filter: the counts and the previews a
 * poll renders must not move because a page narrowed.
 */
function buildNavigation(resolved: readonly ResolvedTask[]): TaskListResponse['navigation'] {
    const count = (bucket: TaskBucket): number => resolved.filter((task) => task.bucket === bucket).length;
    const preview = (bucket: TaskBucket, cap: number): TaskSummary[] =>
        resolved
            .filter((task) => task.bucket === bucket)
            .sort(byNewest)
            .slice(0, cap)
            .map((task) => task.summary);

    return {
        counts: { running: count('running'), review: count('review'), past: count('past') },
        running: preview('running', NAV_RUNNING_PREVIEW_LIMIT),
        review: preview('review', NAV_REVIEW_PREVIEW_LIMIT),
    };
}

/**
 * The page obeys every filter. `attention` is the inbox view — running and review at once,
 * everything that is not past.
 */
function filterTasks(
    resolved: readonly ResolvedTask[],
    filters: TaskListFilters,
    cursor: TaskCursor | null
): ResolvedTask[] {
    const stateBuckets: Record<TaskState, readonly TaskBucket[]> = {
        attention: ['running', 'review'],
        running: ['running'],
        review: ['review'],
        past: ['past'],
    };
    const allowed = stateBuckets[filters.state];
    let pageRows = resolved.filter((task) => allowed.includes(task.bucket));
    if (filters.q !== undefined) {
        const needle = filters.q.toLowerCase();
        pageRows = pageRows.filter((task) => task.summary.command.toLowerCase().includes(needle));
    }
    if (filters.repo !== undefined) pageRows = pageRows.filter((task) => task.summary.repo === filters.repo);
    if (filters.author !== undefined)
        pageRows = pageRows.filter((task) => task.summary.author?.login.toLowerCase() === filters.author);

    if (cursor === null) return pageRows;
    const newest = filters.sort === 'newest';
    const after = ({ summary }: { summary: TaskSummary }): boolean =>
        newest
            ? summary.activityAt < cursor.activityAt ||
              (summary.activityAt === cursor.activityAt && summary.id < cursor.rootId)
            : summary.activityAt > cursor.activityAt ||
              (summary.activityAt === cursor.activityAt && summary.id > cursor.rootId);
    return pageRows.filter(after);
}

/**
 * The in-memory `listTasks` — one summary per thread root over an array of `Job` rows, the shape
 * a route-test board or an in-memory store already holds. The PostgreSQL implementation computes
 * the same response in SQL; when the two disagree, one of them is wrong about the rules above.
 */
export function memoryTaskList(jobs: readonly Job[], filters: TaskListFilters): TaskListResponse {
    const cursor = filters.cursor === undefined ? null : decodeCursor(filters.cursor, filters);
    if (filters.cursor !== undefined && cursor === null) throw new Error('invalid task cursor');

    const resolved = resolveTaskThreads(jobs);
    const navigation = buildNavigation(resolved);
    const pageRows = filterTasks(resolved, filters, cursor);

    const newest = filters.sort === 'newest';
    // Fetch limit + 1: the extra row is the only honest `nextCursor` signal — a page filled
    // exactly is not.
    const selected = [...pageRows].sort(newest ? byNewest : (a, b) => -byNewest(a, b)).slice(0, filters.limit + 1);
    const hasMore = selected.length > filters.limit;
    const items = selected.slice(0, filters.limit).map((task) => task.summary);
    const last = items[items.length - 1];
    return {
        navigation,
        page: {
            items,
            nextCursor:
                hasMore && last !== undefined
                    ? encodeCursor({
                          sort: filters.sort,
                          state: filters.state,
                          q: filters.q,
                          repo: filters.repo,
                          author: filters.author,
                          activityAt: last.activityAt,
                          rootId: last.id,
                      })
                    : null,
        },
    };
}
