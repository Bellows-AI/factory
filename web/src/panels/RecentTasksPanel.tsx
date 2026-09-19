import type { Job } from '../api/useJobs.js';
import { taskTime, tokens, wallClock } from '../format.js';
import { taskTitleFromCommand } from '../task-tree.js';

/** The task's one-line identity: the summary when the agent gave one, the command's first line when not. */
function title(job: Job): string {
    if (job.summary) return job.summary;
    const first = taskTitleFromCommand(job.command);
    return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

/**
 * The board's recently completed tasks, newest first — what the agent says it did, beside who
 * asked for it and what the task cost in context and banked execution time. The terminal list is
 * grouped server-side as one row per task (issue 124): a thread's follow-up turns fold into their
 * root, the present tense (status, summary, context) is the newest run's, and the wall clock is
 * the thread's total — the figure the task view's head clock shows. This is the board's own
 * audit rows, not the telemetry above: it counts only runs the board ran, and it says so.
 */
export function RecentTasksPanel({ jobs, error }: { jobs: Job[] | null; error: string | null }) {
    return (
        <section className="panel">
            <h2>Recently completed</h2>
            <p className="muted">
                The board's finished tasks, newest first — the agent's own closing words beside the task's cost. A run
                the board never held (a local session, a backfilled transcript) has no row here.
            </p>
            {error !== null ? (
                <p className="alert">The board could not be read — {error}.</p>
            ) : jobs === null ? (
                <p className="muted">Loading…</p>
            ) : jobs.length === 0 ? (
                <p className="muted">No completed tasks yet.</p>
            ) : (
                <div className="chart-wrap">
                    <table className="by-user">
                        <thead>
                            <tr>
                                <th>Task</th>
                                <th>Status</th>
                                <th>Author</th>
                                <th>Context</th>
                                <th>Wall clock</th>
                                <th>Finished</th>
                            </tr>
                        </thead>
                        <tbody>
                            {jobs.map((job) => (
                                <tr key={job.id}>
                                    <td>{title(job)}</td>
                                    <td>{job.status}</td>
                                    <td>
                                        {job.author ? (
                                            <span className="by-user-user">
                                                {job.author.avatarUrl !== null ? (
                                                    <img className="task-avatar" src={job.author.avatarUrl} alt="" />
                                                ) : null}
                                                {job.author.name ?? job.author.login}
                                            </span>
                                        ) : (
                                            'unknown'
                                        )}
                                    </td>
                                    <td>{tokens(job.runtime?.contextTokens ?? null)}</td>
                                    <td>{wallClock(job.taskWallClockMs, null)}</td>
                                    <td>{taskTime(job.finishedAt)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
