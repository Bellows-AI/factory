import { isTerminal, type Job } from '../api/useJobs.js';
import { PageHeader } from '../components/PageHeader.js';
import { wallClock } from '../format.js';
import { taskSummary } from '../task-tree.js';

/**
 * The page-level head of `/tasks/:id`, derived from the loaded thread: the task's name — the
 * root command's first line — as the page's one `h1`, its status, wall clock and live activity
 * in the meta slots, and every action the task can take in the actions slot. Prop-driven, like
 * every panel: the poll and the mutation guards live in the page, so a static render of a loaded
 * thread is a complete render.
 */
export function TaskHeader({
    jobs,
    stoppingId,
    removingId,
    doneId,
    onStop,
    onRemove,
    onDone,
}: {
    /** The task's whole chain, oldest first — null until the thread poll lands. */
    jobs: Job[] | null;
    /** The page's in-flight guards: an action mid-request renders disabled, once. */
    stoppingId: string | null;
    removingId: string | null;
    doneId: string | null;
    onStop: (id: string) => Promise<void>;
    onRemove: (id: string) => Promise<void>;
    onDone: (id: string) => Promise<void>;
}) {
    if (jobs === null || jobs.length === 0) {
        // No task yet, so there is nothing to name — the detail poll has not landed. No eyebrow:
        // "Tasks" over "Tasks" says the same thing twice.
        return <PageHeader title="Tasks" />;
    }

    // The early return above guarantees a non-empty chain; its newest member is the run the
    // composer and the verdicts act on, and its first member is the ROOT — the task's stable
    // name is what was asked, and the head carries the command's first line so multi-line prose
    // does not swallow the title.
    const latestTask = jobs[jobs.length - 1]!;
    const rootTask = jobs[0]!;
    const open = isTerminal(latestTask.status) && latestTask.doneAt === null;
    // The task's live summary — the newest run's activity line, while there is one — beside the
    // title, the same line the sidebar's "Task" row and the sidenav read.
    const summary = taskSummary(latestTask.id, jobs);

    return (
        <PageHeader
            eyebrow="Tasks"
            title={rootTask.command.split('\n')[0]!.trim()}
            meta={
                <>
                    <span className="pill">{latestTask.status}</span>
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
                    {/* Every control the task can take, at the very top — the turns are a
                    transcript and carry none. The conditions are the ones the turn UI had:
                    Stop (or its landed pill) on the moving run, Done on an open task, Remove
                    whenever the thread is not running. */}
                    {latestTask.status === 'running' ? (
                        latestTask.cancelRequestedAt !== null ? (
                            <span className="pill chat-stop">Stopping…</span>
                        ) : (
                            <button
                                type="button"
                                className="chat-resume chat-stop"
                                disabled={stoppingId === latestTask.id}
                                onClick={() => void onStop(latestTask.id)}
                            >
                                Stop
                            </button>
                        )
                    ) : null}
                    {open ? (
                        <button
                            type="button"
                            className="chat-resume"
                            disabled={doneId === latestTask.id}
                            onClick={() => void onDone(latestTask.id)}
                        >
                            Done
                        </button>
                    ) : null}
                    {latestTask.status !== 'running' ? (
                        <button
                            type="button"
                            className="chat-remove"
                            disabled={removingId === latestTask.id}
                            onClick={() => void onRemove(latestTask.id)}
                        >
                            Remove
                        </button>
                    ) : null}
                </div>
            }
        />
    );
}
