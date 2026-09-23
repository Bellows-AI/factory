import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { isTerminal, type Job } from '../api/useJobs.js';
import { PageHeader } from '../components/PageHeader.js';
import { wallClock } from '../format.js';
import { taskSummary, taskTitleFromCommand } from '../task-tree.js';

/**
 * The page-level head of `/tasks/:id`, derived from the loaded thread: the task's name — the
 * root command's first line — as the page's one `h1`, its status, wall clock and live activity
 * in the meta slots, and the state's actions in the actions slot. Prop-driven, like every panel:
 * the poll, the mutations and the removal dialog live in the page, so a static render of a loaded
 * thread is a complete render.
 *
 * The action matrix is state-specific (issue 178): every not-terminal state offers **Stop run**
 * — the board lands queued and standby stops as readily as a moving run's — with the request in
 * flight and the request landed both reading **Stopping…**; a terminal task that nobody has
 * closed offers **Mark done** as the page's one primary action; and a closed task shows its
 * closure as attribution text — **Done by <login>**, or **Marked done** when no actor is on
 * record — never as a disabled control. Remove task exists only in the **More task actions**
 * overflow, in the destructive voice, and only while no member of the thread is running — the
 * board's 409 TASK_RUNNING stays the authority on any race the UI cannot see.
 */
export function TaskHeader({
    jobs,
    stoppingId,
    doneId,
    onStop,
    onDone,
    onRemoveRequest,
}: {
    /** The task's whole chain, oldest first — null until the thread poll lands. */
    jobs: Job[] | null;
    /** The page's in-flight guards: a mutation mid-request relabels its control, once. */
    stoppingId: string | null;
    doneId: string | null;
    onStop: (id: string) => Promise<void>;
    onDone: (id: string) => Promise<void>;
    /** Opens the page's remove confirmation — the menu item never mutates by itself. */
    onRemoveRequest: () => void;
}) {
    if (jobs === null || jobs.length === 0) {
        // No task yet, so there is nothing to name — the detail poll has not landed. No eyebrow:
        // "Tasks" over "Tasks" says the same thing twice.
        return <PageHeader title="Tasks" />;
    }

    // The early return above guarantees a non-empty chain; its newest member is the run the
    // actions act on, and its first member is the ROOT — the task's stable name is what was
    // asked, and the head carries the command's first line so multi-line prose does not swallow
    // the title.
    const latestTask = jobs[jobs.length - 1]!;
    const rootTask = jobs[0]!;
    const open = isTerminal(latestTask.status) && latestTask.doneAt === null;
    const closed = latestTask.doneAt !== null;
    const stoppable = !isTerminal(latestTask.status);
    // Both halves of a stop that has not settled yet read the same: the request this click sent,
    // and the one the board has stamped while the worker has not parked the run.
    const stopping = stoppingId === latestTask.id || latestTask.cancelRequestedAt !== null;
    // Remove is hidden while any member is running — not merely the newest. Queued and standby
    // members do not block it; nothing on the board is executing them.
    const removeAvailable = !jobs.some((task) => task.status === 'running');
    // The task's live summary — the newest run's activity line, while there is one — beside the
    // title, the same line the sidebar's "Task" row and the sidenav read.
    const summary = taskSummary(latestTask.id, jobs);
    // An open PR-review wait (206), straight off the structured contract — never inferred from
    // output or a node name. A terminal wait carries no special weight here: the pill stays the
    // ordinary status word, the same as a thread that never waited.
    const waiting = latestTask.waitReason !== null && latestTask.waitTerminalReason === null;

    return (
        <PageHeader
            eyebrow="Tasks"
            title={taskTitleFromCommand(rootTask.command)}
            meta={
                <>
                    {/* Polite, not assertive: a poll that lands the same text announces nothing —
                    the live region only speaks when the status word itself actually changes. */}
                    <span className="pill" aria-live="polite">
                        {waiting ? 'Waiting for review' : latestTask.status}
                    </span>
                    {/* The overall wall clock: everything the board has banked for the task,
                    plus the head run's live segment while it is going — the 2s poll is the
                    ticker. A task that has never run says so with a dash, not a zero. */}
                    <span className="task-clock">
                        Wall clock{' '}
                        {wallClock(
                            latestTask.taskWallClockMs,
                            latestTask.status === 'running' ? latestTask.startedAt : null
                        )}
                    </span>
                    {summary !== null ? <p className="task-summary">{summary}</p> : null}
                </>
            }
            actions={
                <div className="task-actions">
                    {stoppable ? (
                        stopping ? (
                            stoppingId === latestTask.id ? (
                                <button type="button" className="chat-resume chat-stop" disabled>
                                    Stopping…
                                </button>
                            ) : (
                                // The request has landed; the worker has not parked the run yet.
                                // Pending is not terminal — this is a status, not a control.
                                <span className="pill chat-stop">Stopping…</span>
                            )
                        ) : (
                            <button
                                type="button"
                                className="chat-resume chat-stop"
                                onClick={() => void onStop(latestTask.id)}
                            >
                                Stop run
                            </button>
                        )
                    ) : null}
                    {stoppable && waiting ? (
                        <p className="muted">
                            Stopping cancels remaining automation. It does not close or merge the pull request.
                        </p>
                    ) : null}
                    {open ? (
                        <button
                            type="button"
                            className="primary"
                            disabled={doneId === latestTask.id}
                            onClick={() => void onDone(latestTask.id)}
                        >
                            {doneId === latestTask.id ? 'Marking done…' : 'Mark done'}
                        </button>
                    ) : null}
                    {closed ? (
                        <span className="pill chat-done">
                            {latestTask.doneBy !== null ? `Done by ${latestTask.doneBy.login}` : 'Marked done'}
                        </span>
                    ) : null}
                    {removeAvailable ? (
                        <Menu>
                            <MenuButton className="chat-resume">More task actions</MenuButton>
                            {/* The anchored menu is the destructive overflow: Remove task lives
                            here and nowhere else. Focus lands back on this trigger — the menu
                            restores it on close, and the dialog the item opens restores it to
                            the element focused before it captured the caret. */}
                            <MenuItems anchor="bottom end" className="popover">
                                <MenuItem>
                                    <button
                                        type="button"
                                        className="popover-option chat-remove"
                                        onClick={onRemoveRequest}
                                    >
                                        Remove task
                                    </button>
                                </MenuItem>
                            </MenuItems>
                        </Menu>
                    ) : null}
                </div>
            }
        />
    );
}
