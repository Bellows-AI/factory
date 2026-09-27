import type { Job, JobStatus } from './api/useJobs.js';
import type { TaskNavigation, TaskSummary } from './api/useTasks.js';

/**
 * The pure half of the task UI, shared by the sidenav preview, the inbox rows and the detail
 * view: how a task is titled, how its state is labelled, and what the sidenav's five-row preview
 * holds. The thread grouping this file used to do browser-side (`taskSections`) is gone — the
 * server's task-summary read model answers one row per task with the head's state already
 * resolved, and `useTasks` is the single poll that serves it.
 */

/**
 * What the status dot of a task shows: the NEWEST run's state — the conversation's present
 * tense. The server derives it; this is only the rendering shape the dot and the label share.
 */
export interface TaskStatus {
    status: JobStatus | null;
    cancelRequestedAt: string | null;
    doneAt: string | null;
    /**
     * The thread's durable PR-review wait (206), straight off the structured `waitReason` /
     * `waitTerminalReason` contract — never inferred from output text or a workflow node name.
     * An open wait (`waitReason` set, `waitTerminalReason` still null) reads as waiting; once
     * `waitTerminalReason` is set the wait is over and carries no special weight here.
     */
    waitReason: string | null;
    waitTerminalReason: string | null;
}

/**
 * A task's one-line title: the first line of the command that was asked, trimmed — multi-line
 * prose must not swallow the title. The ONE derivation for the sidenav, the inbox and the detail
 * view; every panel that used to split the command itself calls this.
 */
export function taskTitleFromCommand(command: string): string {
    return command.split('\n')[0]!.trim();
}

/** A terminal verdict's label, with the wait's bounded reason appended once it has one. */
const withWaitReason = (status: TaskStatus, label: string): string =>
    status.waitTerminalReason !== null ? `${label} · ${status.waitTerminalReason}` : label;

/** A task's state as one word — the precedence the label and the dot share. */
export type TaskTone =
    | 'queued'
    | 'running'
    | 'stopping'
    | 'waiting'
    | 'review'
    | 'failed'
    | 'stopped'
    | 'done'
    | 'none';

/**
 * The ONE status precedence, first match wins: no run → `none`; a live run → `running` /
 * `stopping`; a task the user closed → `done`; an OPEN PR-review wait (206) → `waiting`; `queued`;
 * then the terminal verdicts the user has not closed yet (`review` for a success, `failed` for
 * failed/dead, `stopped`).
 *
 * `running` stays the loudest state — the contract never expects a run and a wait at once, and a
 * stray wait must not paint an executing task as idle. Closure outranks an open wait: once the
 * user has marked the task done, a wait the board has not settled yet must not keep it reading as
 * blocked on a human. A wait that has gone terminal carries no special weight here.
 */
export function taskTone(status: TaskStatus): TaskTone {
    if (status.status === null) return 'none';
    if (status.status === 'running') return status.cancelRequestedAt !== null ? 'stopping' : 'running';
    if (status.doneAt !== null) return 'done';
    if (status.waitReason !== null && status.waitTerminalReason === null) return 'waiting';
    switch (status.status) {
        case 'queued':
            return 'queued';
        case 'succeeded':
            return 'review';
        case 'failed':
        case 'dead':
            return 'failed';
        case 'stopped':
            return 'stopped';
    }
}

/**
 * The visible status label: workflow state and execution result as TEXT, never color alone —
 * the dot is supplementary. A lookup on `taskTone`, so the label and the dot never disagree:
 * Running / Stopping / Done / Waiting for review / Queued, then the terminal verdicts with
 * `· Needs review` marking a result the user has not closed yet. `dead` (the board's verdict for
 * a worker that vanished) reads as the failure it is. A terminal wait's reason rides beside the
 * ordinary needs-review copy.
 */
export function taskStatusLabel(status: TaskStatus): string {
    switch (taskTone(status)) {
        case 'none':
            return '—';
        case 'running':
            return 'Running';
        case 'stopping':
            return 'Stopping';
        case 'done':
            return 'Done';
        case 'waiting':
            return 'Waiting for review';
        case 'queued':
            return 'Queued';
        case 'review':
            return withWaitReason(status, 'Succeeded · Needs review');
        case 'failed':
            return withWaitReason(status, 'Failed · Needs review');
        case 'stopped':
            return withWaitReason(status, 'Stopped · Needs review');
    }
}

/**
 * A task's live summary — what the agent is doing right now — for the nav and the top of the
 * task view: the head run's `runtime.activity` line, and only while that run is running. A
 * parked or finished run's last activity is a stale line that would lie about a run no longer
 * going.
 *
 * Takes the thread as a list, because the detail page holds the WHOLE chain from its own poll —
 * the head of a summary row's chain is already resolved server-side and rides the row itself.
 */
export function taskSummary(id: string, jobs: readonly Job[] | null): string | null {
    if (jobs === null) return null;
    const named = jobs.find((job) => job.id === id);
    if (named === undefined) return null;
    // The newest member: highest createdAt, id as tie-break — the board's own ordering.
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
    if (head === undefined || head.status !== 'running') return null;
    const activity = head.runtime?.activity ?? null;
    return activity !== null && activity.trim() !== '' ? activity : null;
}

/** Each tone's dot class; `''` is the plain dot. */
const DOT_CLASS: Record<TaskTone, string> = {
    none: '',
    running: 'sidenav-dot-running',
    stopping: 'sidenav-dot-stopping',
    done: 'sidenav-dot-done',
    waiting: 'sidenav-dot-paused',
    queued: 'sidenav-dot-paused',
    review: 'sidenav-dot-review',
    failed: 'sidenav-dot-failed',
    stopped: '',
};

/**
 * What the dot beside a task wears, a lookup on `taskTone`: a live run breathes, a queued or
 * review-waiting one holds grey, a success the user has not closed is accent blue (their turn),
 * a failed/dead one is red, and a done task is solid green — even while its review wait is still
 * open. A stopped task stays on the plain dot — the user ended that turn themselves, and neither
 * a failure's red nor a done task's green would say that.
 */
export function taskDotClass(status: TaskStatus): string {
    return DOT_CLASS[taskTone(status)];
}

/** The sidenav's preview: the rows chosen, plus how many review tasks did not fit. */
export interface SidenavPreview {
    rows: TaskSummary[];
    /** counts.review minus the review rows shown — zero means every review task is visible. */
    moreReview: number;
}

const PREVIEW_ROWS = 5;
const PREVIEW_RUNNING = 3;

/**
 * Which tasks the compact sidenav preview shows, from the org-wide navigation alone — a pure
 * selection, tested here and rendered verbatim: up to 3 running first, the remaining slots
 * filled with the newest needs-review, five rows total, never Past. A task the member is
 * LOOKING at stays visible: if the open task is running or in review but outside the five
 * chosen rows, it is injected and the last non-active row evicted to make room. Whatever review
 * rows did not fit collapse into the `+N more need review` summary the caller renders.
 */
export function sidenavPreview(navigation: TaskNavigation | null, activeId: string | null): SidenavPreview {
    if (navigation === null) return { rows: [], moreReview: 0 };
    const running = navigation.running.slice(0, PREVIEW_RUNNING);
    const reviewSlots = PREVIEW_ROWS - running.length;
    const review = navigation.review.slice(0, reviewSlots);
    const rows = [...running, ...review];

    if (activeId !== null && !rows.some((task) => task.id === activeId)) {
        const active = [...navigation.running, ...navigation.review].find((task) => task.id === activeId);
        if (active !== undefined) {
            // Evict from the end, never the active row itself (it is not among them yet).
            if (rows.length >= PREVIEW_ROWS) rows.pop();
            rows.push(active);
        }
    }
    // Counted from the rows that actually survived the injection: an eviction frees a slot, and
    // the overflow line must not count an evicted row as still visible.
    const shownReview = rows.filter((row) => navigation.review.includes(row)).length;
    return { rows, moreReview: Math.max(0, navigation.counts.review - shownReview) };
}
