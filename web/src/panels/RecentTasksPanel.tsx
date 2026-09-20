import { Link } from 'react-router-dom';
import type { Column } from '../components/DataTable.js';
import { DataTable } from '../components/DataTable.js';
import { RelativeTime } from '../components/RelativeTime.js';
import type { Job } from '../api/useJobs.js';
import { tokens, wallClock } from '../format.js';

/** The task's one-line identity: the root command's first non-empty line — the agent's closing
 * summary is outcome text, not task identity. Truncation is visual (a two-line clamp), not a
 * content edit. */
function title(job: Job): string {
    return job.command.split('\n').find((line) => line.trim() !== '') ?? '';
}

/** The columns take the panel's injected `now` so the relative stamps stay pure in tests. */
const columns = (now: Date | undefined): Column<Job>[] => [
    {
        key: 'command',
        label: 'Task',
        render: (job) => (
            <Link className="task-title" to={`/tasks/${job.id}`}>
                {title(job)}
            </Link>
        ),
        sort: (job) => title(job),
    },
    { key: 'status', label: 'Status' },
    {
        key: 'author',
        label: 'Author',
        render: (job) =>
            job.author ? (
                <span className="by-user-user">
                    {job.author.avatarUrl !== null ? (
                        <img className="task-avatar" src={job.author.avatarUrl} alt="" />
                    ) : null}
                    {job.author.name ?? job.author.login}
                </span>
            ) : (
                'unknown'
            ),
        sort: (job) => job.author?.name ?? job.author?.login ?? '',
    },
    {
        key: 'runtime',
        label: 'Context',
        numeric: true,
        render: (job) => tokens(job.runtime?.contextTokens ?? null),
        sort: (job) => job.runtime?.contextTokens ?? null,
    },
    {
        key: 'taskWallClockMs',
        label: 'Wall clock',
        numeric: true,
        render: (job) => wallClock(job.taskWallClockMs, null),
        sort: (job) => job.taskWallClockMs,
    },
    {
        key: 'finishedAt',
        label: 'Finished',
        numeric: true,
        render: (job) => <RelativeTime at={job.finishedAt} now={now} />,
        sort: (job) => (job.finishedAt === null ? null : Date.parse(job.finishedAt)),
    },
];

/**
 * The board's recently completed tasks, newest first — the Task board section of the dashboard.
 * This is the board's own audit rows, not the telemetry above: it counts only runs the board
 * ran, it is never filtered by the analytics range or scope, and it says so. The list is
 * bounded at the source — the hook asks the server for eight grouped task rows — and a failed
 * poll keeps the last good rows on screen beside its alert, because a board read failure must
 * not blank a section that was answering a moment ago.
 */
export function RecentTasksPanel({ jobs, error, now }: { jobs: Job[] | null; error: string | null; now?: Date }) {
    return (
        <section className="panel">
            <h2>Task board</h2>
            <p className="muted">
                Latest finished tasks from the board; analytics range and scope do not filter this list.
            </p>
            {error !== null ? <p className="alert">The board could not be read — {error}.</p> : null}
            {jobs === null ? (
                error === null ? (
                    <p className="muted">Loading…</p>
                ) : null
            ) : (
                <>
                    <DataTable
                        columns={columns(now)}
                        rows={jobs}
                        sortable
                        rowKey={(job) => job.id}
                        ariaLabel="Recently completed tasks"
                        initialSort={{ key: 'finishedAt', descending: true }}
                        empty={<p className="muted">No completed tasks yet.</p>}
                    />
                    {jobs.length > 0 ? (
                        <p>
                            <Link to="/tasks">View all tasks</Link>
                        </p>
                    ) : null}
                </>
            )}
        </section>
    );
}
