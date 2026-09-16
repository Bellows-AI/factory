import type { Job } from '../api/useJobs.js';
import { taskTime, tokens, wallClock } from '../format.js';

/** The task's one-line identity: the summary when the agent gave one, the command when not. */
function title(job: Job): string {
    if (job.summary) return job.summary;
    const first = job.command.split('\n')[0] ?? '';
    return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

/**
 * The board's recently completed runs, newest first — what the agent says it did, beside who
 * asked for it and what the run cost in context and banked execution time. This is the board's
 * own audit rows, not the telemetry above: it counts only runs the board ran, and it says so.
 */
export function RecentTasksPanel({ jobs, error }: { jobs: Job[] | null; error: string | null }) {
    return (
        <section className="panel">
            <h2>Recently completed</h2>
            <p className="muted">
                The board's finished runs, newest first — the agent's own closing words beside the run's cost. A run the
                board never held (a local session, a backfilled transcript) has no row here.
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
                                    <td>{wallClock(job.wallClockMs, null)}</td>
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
