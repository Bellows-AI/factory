import type { TaskUsageDistribution, TaskUsageStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import type { DataTableColumn } from '../components/DataTable.js';
import { DataTable } from '../components/DataTable.js';
import { duration, num, tokens } from '../format.js';
import { TelemetryFrame } from './TelemetryFrame.js';

/**
 * One row of the per-task table: a distribution and the unit its figures are read in. `median`
 * is READ FROM the payload's `p50` field — the UI word is Median, the field name is the API's.
 */
interface TaskUsageRow {
    kind: string;
    unit: 'tokens' | 'runs' | 'turns' | 'duration';
    avg: number | null;
    median: number | null;
    p95: number | null;
    tasks: number;
}

const MS_PER_HOUR = 3_600_000;

const FORMATS: Record<TaskUsageRow['unit'], (value: number | null) => string> = {
    tokens: (value) => tokens(value),
    runs: (value) => num(value, 1),
    turns: (value) => num(value, 1),
    duration: (value) => (value === null ? '—' : duration(value / MS_PER_HOUR)),
};

/** The semantic order: what a task costs in tokens, then in board runs, agent turns, time. */
const row = (kind: string, unit: TaskUsageRow['unit'], d: TaskUsageDistribution): TaskUsageRow => ({
    kind,
    unit,
    avg: d.avg,
    median: d.p50,
    p95: d.p95,
    tasks: d.tasks,
});

const columns: DataTableColumn<TaskUsageRow>[] = [
    { key: 'kind', label: 'Measurement', cell: (r) => r.kind, sortValue: (r) => r.kind },
    {
        key: 'avg',
        label: 'Average',
        align: 'end',
        cell: (r) => FORMATS[r.unit](r.avg),
        sortValue: (r) => r.avg,
    },
    {
        key: 'median',
        label: 'Median',
        align: 'end',
        cell: (r) => FORMATS[r.unit](r.median),
        sortValue: (r) => r.median,
    },
    {
        key: 'p95',
        label: 'P95',
        align: 'end',
        cell: (r) => FORMATS[r.unit](r.p95),
        sortValue: (r) => r.p95,
    },
    { key: 'tasks', label: 'Measured tasks', align: 'end', cell: (r) => r.tasks, sortValue: (r) => r.tasks },
];

/** What a task costs: four distributions over the job threads the range and scope put in play. */
export function TaskUsagePanel({ tasks, meta }: { tasks: TaskUsageStats | null; meta: TelemetryMeta }) {
    if (tasks === null) return null;
    const rows = [
        row('Tokens per task', 'tokens', tasks.tokensPerTask),
        row('Runs per task', 'runs', tasks.jobTurnsPerTask),
        row('Agent turns per task', 'turns', tasks.agentTurnsPerTask),
        row('Wall clock per task', 'duration', tasks.wallClockPerTask),
    ];
    // The task set is what runs-per-task counts — every in-scope task, measured or not. It empty
    // means the range holds no attributed tasks at all, which is the explicit empty state: one
    // table-region message, not four rows of dashes.
    const empty = rows.every((r) => r.tasks === 0);
    return (
        <TelemetryFrame
            title="Per-task usage"
            titleId="per-task-usage-heading"
            blurb={
                <>
                    Average, median and 95th percentile per task — a task is one board thread, first run and follow-ups
                    together. Tokens are input + output over the task's sessions; runs count the task's board runs;
                    agent turns count assistant responses in each run's own conversation; wall clock is the execution
                    time the board banked for those runs.
                </>
            }
            meta={meta}
        >
            <DataTable
                labelledBy="per-task-usage-heading"
                columns={columns}
                rows={empty ? [] : rows}
                rowKey={(r) => r.kind}
                empty={<p className="muted">No attributed tasks in this range yet.</p>}
            />
            {!empty ? (
                <p className="muted">
                    Agent turns and wall clock are computed over fully measured tasks: a task with any unmeasured run is
                    left out, never counted as zero. A run is one delivered prompt, follow-ups included.
                </p>
            ) : null}
        </TelemetryFrame>
    );
}
