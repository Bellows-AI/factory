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

/**
 * The visible status label: workflow state and execution result as TEXT, never color alone —
 * the dot is supplementary. The issue's table: Running / Queued / Parked / Stopping, then the
 * terminal verdicts, with `· Needs review` marking a result the user has not closed yet. A done
 * task reads Done; `dead` (the board's verdict for a worker that vanished) reads as the failure
 * it is.
 *
 * An OPEN PR-review wait (206) reads as `Waiting for review` ahead of Queued/Parked/Done/the
 * terminal verdicts — never running, queued or done while a human is genuinely the blocker — but
 * behind a live run: `running` stays the loudest state, since the contract never expects the two
 * to hold at once and a stray wait must not paint an executing task as idle. A wait that has gone
 * terminal carries no special weight here; its reason rides beside the ordinary needs-review copy.
 */
export function taskStatusLabel(status: TaskStatus): string {
    if (status.status === null) return '—';
    if (status.status === 'running') return status.cancelRequestedAt !== null ? 'Stopping' : 'Running';
    if (status.waitReason !== null && status.waitTerminalReason === null) return 'Waiting for review';
    if (status.status === 'queued') return 'Queued';
    if (status.status === 'standby') return 'Parked';
    if (status.doneAt !== null) return 'Done';
    switch (status.status) {
        case 'succeeded':
            return withWaitReason(status, 'Succeeded · Needs review');
        case 'failed':
        case 'dead':
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

/**
 * What the dot beside a task wears: a live run breathes, a parked or queued one holds grey, a
 * failed/dead one is red, and anything finished or declared done is solid green. A stopped task
 * stays on the plain dot — the user ended that turn themselves, and neither a failure's red nor
 * a done task's green would say that.
 *
 * An OPEN PR-review wait (206) holds the same grey as parked/queued, ahead of the done/failed
 * reads — waiting is never green or red — but behind a live run, the same precedence
 * `taskStatusLabel` applies and for the same reason.
 */
export function taskDotClass(status: TaskStatus): string {
    if (status.status === 'running')
        return status.cancelRequestedAt !== null ? 'sidenav-dot-stopping' : 'sidenav-dot-running';
    if (status.waitReason !== null && status.waitTerminalReason === null) return 'sidenav-dot-paused';
    if (status.doneAt !== null || status.status === 'succeeded') return 'sidenav-dot-done';
    if (status.status === 'standby' || status.status === 'queued') return 'sidenav-dot-paused';
    if (status.status === 'failed' || status.status === 'dead') return 'sidenav-dot-failed';
    return '';
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
