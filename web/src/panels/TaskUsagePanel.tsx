import type { TaskUsageDistribution, TaskUsageStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { num, tokens } from '../format.js';
import { TelemetryFrame } from './TelemetryFrame.js';

/**
 * One distribution's three figures, labeled with the kind it means.
 *
 * The terminology rule is enforced here in markup: a job turn is a RUN (one board task run), an
 * agent turn is one assistant response cycle — and no label ever says a bare "turns". The task
 * count N renders beside every distribution, because a p95 over five tasks must never masquerade
 * as a settled statistic.
 */
function Distribution({
    label,
    note,
    d,
    format,
}: {
    label: string;
    note?: string;
    d: TaskUsageDistribution;
    format: (value: number) => string;
}) {
    return (
        <div className="card">
            <h3>{label}</h3>
            {d.tasks === 0 ? (
                <p className="card-figure muted">—</p>
            ) : (
                <p className="card-figure">
                    {format(d.avg ?? 0)} <span className="muted">avg</span> · {format(d.p50 ?? 0)} p50 ·{' '}
                    {format(d.p95 ?? 0)} p95
                </p>
            )}
            <p className="muted">
                {d.tasks} task{d.tasks === 1 ? '' : 's'} measured{note ? ` — ${note}` : ''}
            </p>
        </div>
    );
}

/** What a task costs: three distributions over the job threads the range and scope put in play. */
export function TaskUsagePanel({ tasks, meta }: { tasks: TaskUsageStats | null; meta: TelemetryMeta }) {
    if (tasks === null) return null;
    // The task set is what job turns counts — every in-scope task, measured or not. It empty
    // means the range holds no attributed tasks at all, which is the explicit empty state.
    const empty = tasks.jobTurnsPerTask.tasks === 0;
    return (
        <TelemetryFrame
            title="Per-task usage"
            blurb={
                <>
                    Average, median and 95th percentile per task — a task is one board thread, first run and follow-ups
                    together. Tokens are input + output over the task's sessions; runs count the task's board runs;
                    agent turns count assistant responses in each run's own conversation.
                </>
            }
            meta={meta}
        >
            {empty ? (
                <p className="muted">No attributed tasks in this range yet.</p>
            ) : (
                <div className="cards">
                    <Distribution label="Tokens per task" d={tasks.tokensPerTask} format={(v) => tokens(v)} />
                    <Distribution
                        label="Runs per task"
                        d={tasks.jobTurnsPerTask}
                        format={(v) => num(v, 1)}
                        note="a run is one delivered prompt, follow-ups included"
                    />
                    <Distribution
                        label="Agent turns per task"
                        d={tasks.agentTurnsPerTask}
                        format={(v) => num(v, 1)}
                        note="a task with any unmeasured run is left out, never counted as zero"
                    />
                </div>
            )}
        </TelemetryFrame>
    );
}
