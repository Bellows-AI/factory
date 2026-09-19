import { isTerminal } from './api/useJobs.js';
import type { Job, JobStatus } from './api/useJobs.js';

/**
 * The task tree's model — the pure half of the left panel's task list.
 *
 * The tree is organized not by manual groups but by what a task IS right now: running, finished
 * and waiting for the reader's verdict, or done and past. The three sections are computed from
 * the poll's rows on every render, so a task finishing simply moves from Running to the top of
 * Need review — there is no arrangement to maintain, nothing to persist, and every browser sees
 * the same tree. One task's state is its thread's newest run, resolved through the served root
 * the same way the detail page resolves a conversation.
 */

/** What the status dot of a task shows: the NEWEST run's state — the conversation's present tense. */
export interface TaskStatus {
    status: JobStatus | null;
    cancelRequestedAt: string | null;
    doneAt: string | null;
}

const NO_STATUS: TaskStatus = { status: null, cancelRequestedAt: null, doneAt: null };

/**
 * A task's status — the NEWEST member of its follow-up chain, resolved from ANY member's id the
 * way the detail page resolves a thread: the board serves `rootJobId` on every row (022), so the
 * members of one conversation are the rows sharing it, and a link on some adjustment answers
 * for the whole conversation. The sidenav paints one dot per task, not per run.
 *
 * The resolution lives in `chainHead`, shared with `taskSummary`, so the dot and the summary
 * always answer for the same run.
 */
export function taskStatus(id: string, jobs: readonly Job[] | null): TaskStatus {
    const head = chainHead(id, jobs);
    return head === null
        ? NO_STATUS
        : { status: head.status, cancelRequestedAt: head.cancelRequestedAt, doneAt: head.doneAt };
}

/**
 * The head of a task's thread — the newest run, the member with the highest `createdAt` (id as
 * tie-break, matching the board's own ordering) — resolved from ANY member's id. Every member
 * carries the root even when the poll's capped window no longer holds the root ROW itself, so a
 * long conversation stays resolvable. Null when the id names no polled job at all.
 */
export function chainHead(id: string, jobs: readonly Job[] | null): Job | null {
    if (jobs === null) return null;
    const named = jobs.find((job) => job.id === id);
    if (named === undefined) return null;

    let head: Job | undefined;
    for (const job of jobs) {
        if (job.rootJobId !== named.rootJobId) continue;
        if (
            head === undefined ||
            job.createdAt > head.createdAt ||
            (job.createdAt === head.createdAt && job.id > head.id)
        ) {
            head = job;
        }
    }
    return head ?? null;
}

/** A tree row's label: the task's command once the poll knows it, a short id until then. */
export function taskTitle(id: string, jobs: readonly Job[] | null): string {
    const found = jobs?.find((job) => job.id === id);
    return found !== undefined ? found.command : id.slice(0, 8);
}

/**
 * A task's live summary — what the agent is doing right now — for the left nav and
 * the top of the task view: the head run's `runtime.activity` line, and only while that run is
 * running. A parked or finished run's last activity is a stale line that would lie about a run no
 * longer going, and the activity also disappears while a task is still queued.
 */
export function taskSummary(id: string, jobs: readonly Job[] | null): string | null {
    const head = chainHead(id, jobs);
    if (head === null || head.status !== 'running') return null;
    const activity = head.runtime?.activity ?? null;
    return activity !== null && activity.trim() !== '' ? activity : null;
}

/** One listed task: the link target plus everything the row renders, resolved once. */
export interface TaskTreeEntry {
    readonly id: string;
    readonly title: string;
    readonly summary: string | null;
    readonly status: TaskStatus;
    /** Who queued the task — the ROOT row's author, the person the conversation belongs to. */
    readonly author: string | null;
}

export interface TaskSections {
    readonly running: readonly TaskTreeEntry[];
    readonly review: readonly TaskTreeEntry[];
    readonly past: readonly TaskTreeEntry[];
}

/**
 * When the task last changed: the head run's newest of its four stamps. `createdAt` is always
 * there; the rest fill in as the run moves. ISO stamps compare as strings, the same convention
 * `chainHead` sorts by.
 */
function activityKey(head: Job): string {
    let key = head.createdAt;
    for (const stamp of [head.startedAt, head.finishedAt, head.doneAt]) {
        if (stamp !== null && stamp > key) key = stamp;
    }
    return key;
}

/**
 * The three sections of the task tree, from the poll's rows.
 *
 * Only thread roots are listed — a follow-up is a new row on the board but continues the
 * conversation it was asked on, so it folds into its root's entry through `chainHead`. The
 * section is the HEAD's, not the root row's: a follow-up queued on a done task resurrects the
 * conversation into Running, and the done verdict the user stamped on the thread does not pull a
 * still-moving run into the past. Within a section the entries sort newest activity first, so the
 * task that just changed is the first thing the reader sees.
 */
export function taskSections(jobs: readonly Job[] | null): TaskSections {
    type Resolved = { entry: TaskTreeEntry; key: string; section: 'running' | 'review' | 'past' };
    const resolved: Resolved[] = [];
    if (jobs !== null) {
        for (const root of jobs) {
            if (root.followUpTo !== null) continue;
            const head = chainHead(root.id, jobs);
            if (head === null) continue;
            const status: TaskStatus = {
                status: head.status,
                cancelRequestedAt: head.cancelRequestedAt,
                doneAt: head.doneAt,
            };
            resolved.push({
                entry: {
                    id: root.id,
                    title: taskTitle(root.id, jobs),
                    summary: taskSummary(root.id, jobs),
                    status,
                    author: root.author?.login ?? null,
                },
                key: activityKey(head),
                section: isTerminal(head.status) ? (head.doneAt === null ? 'review' : 'past') : 'running',
            });
        }
    }

    // Newest first, id descending on an equal stamp — the same direction `chainHead` breaks ties.
    const byNewest = (a: Resolved, b: Resolved): number => {
        if (a.key !== b.key) return a.key < b.key ? 1 : -1;
        return a.entry.id < b.entry.id ? 1 : -1;
    };
    const pick = (section: Resolved['section']): readonly TaskTreeEntry[] =>
        resolved
            .filter((task) => task.section === section)
            .sort(byNewest)
            .map((task) => task.entry);
    return { running: pick('running'), review: pick('review'), past: pick('past') };
}

/**
 * What the dot beside a task wears: a live run breathes, a parked or queued one holds grey, a
 * failed/dead one is red, and anything finished or declared done is solid green. A stopped task
 * stays on the plain dot — the user ended that turn themselves, and neither a failure's red nor a
 * done task's green would say that.
 */
export function taskDotClass(status: TaskStatus): string {
    if (status.doneAt !== null || status.status === 'succeeded') return 'sidenav-dot-done';
    if (status.status === 'running')
        return status.cancelRequestedAt !== null ? 'sidenav-dot-stopping' : 'sidenav-dot-running';
    if (status.status === 'standby' || status.status === 'queued') return 'sidenav-dot-paused';
    if (status.status === 'failed' || status.status === 'dead') return 'sidenav-dot-failed';
    return '';
}
