import { Link } from 'react-router-dom';
import type { DataTableColumn } from '../components/DataTable.js';
import { DataTable } from '../components/DataTable.js';
import { RelativeTime } from '../components/RelativeTime.js';
import type { Job } from '../api/useJobs.js';
import { tokens, wallClock } from '../format.js';
import { type TaskTone, taskStatusLabel, taskTone } from '../task-tree.js';

/** Each tone's status pill (plan §1.2): accent is the user's turn, bad a failure, ok a live run,
 * done parked or finished — the label carries the meaning, the tone only reinforces it. */
const STATUS_PILL: Record<TaskTone, string> = {
    none: 'pill',
    queued: 'pill pill-done',
    running: 'pill pill-ok',
    stopping: 'pill pill-done',
    waiting: 'pill pill-done',
    review: 'pill pill-accent',
    failed: 'pill pill-bad',
    stopped: 'pill pill-done',
    done: 'pill pill-done',
};

/** The task's one-line identity: the root command's first non-empty line — the agent's closing
 * summary is outcome text, not task identity. Truncation is visual (a two-line clamp), not a
 * content edit. */
function title(job: Job): string {
    return job.command.split('\n').find((line) => line.trim() !== '') ?? '';
}

/** The columns take the panel's injected `now` so the relative stamps stay pure in tests. */
const columns = (now: Date | undefined): DataTableColumn<Job>[] => [
    {
        key: 'command',
        label: 'Task',
        cell: (job) => (
            <Link className="task-title" to={`/tasks/${job.id}`}>
                {title(job)}
            </Link>
        ),
        sortValue: (job) => title(job),
    },
    {
        key: 'status',
        label: 'Status',
        cell: (job) => <span className={STATUS_PILL[taskTone(job)]}>{taskStatusLabel(job)}</span>,
        sortValue: (job) => taskStatusLabel(job),
    },
    {
        key: 'author',
        label: 'Author',
        cell: (job) =>
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
        sortValue: (job) => job.author?.name ?? job.author?.login ?? '',
    },
    {
        key: 'runtime',
        label: 'Context',
        align: 'end',
        cell: (job) => tokens(job.runtime?.contextTokens ?? null),
        sortValue: (job) => job.runtime?.contextTokens ?? null,
    },
    {
        key: 'taskWallClockMs',
        label: 'Wall clock',
        align: 'end',
        cell: (job) => wallClock(job.taskWallClockMs, null),
        sortValue: (job) => job.taskWallClockMs,
    },
    {
        key: 'finishedAt',
        label: 'Finished',
        align: 'end',
        cell: (job) => <RelativeTime at={job.finishedAt} now={now} />,
        sortValue: (job) => (job.finishedAt === null ? null : Date.parse(job.finishedAt)),
    },
];

/**
 * The board's recently completed tasks, newest first — the dashboard's Recent tasks, marked Task board.
 * This is the board's own audit rows, not the telemetry above: it counts only runs the board
 * ran, it is never filtered by the analytics range or scope, and it says so. The list is
 * bounded at the source — the hook asks the server for eight grouped task rows — and a failed
 * poll keeps the last good rows on screen beside its alert, because a board read failure must
 * not blank a section that was answering a moment ago.
 */
export function RecentTasksPanel({ jobs, error, now }: { jobs: Job[] | null; error: string | null; now?: Date }) {
    return (
        <section className="panel recent-tasks">
            <div className="recent-tasks-head">
                <h2 id="task-board-heading">Recent tasks</h2>
                <span className="pill pill-done">Task board</span>
            </div>
            <p className="muted">Not affected by range or scope</p>
            {error !== null ? <p className="alert">The board could not be read — {error}.</p> : null}
            {jobs === null ? (
                error === null ? (
                    <p className="muted">Loading…</p>
                ) : null
            ) : (
                <>
                    <DataTable
                        labelledBy="task-board-heading"
                        columns={columns(now)}
                        rows={jobs}
                        rowKey={(job) => job.id}
                        initialSort={{ key: 'finishedAt', direction: 'descending' }}
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
