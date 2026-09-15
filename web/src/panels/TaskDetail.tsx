import { useEffect, useRef, useState } from 'react';
import { isTerminal, type GateCheck, type Job, type RuntimeVitals } from '../api/useJobs.js';
import { taskTime, wallClock } from '../format.js';
import { taskSummary } from '../task-tree.js';
import { TaskSide } from './TaskSide.js';

/**
 * One run's verification gates, as the reader meets them: a collapsible "Checks" list, one row per
 * gate with its status, each row expanding to the gate's output.
 *
 * Native `<details>`, deliberately: collapsible with zero JavaScript, and visible to the
 * render-to-string suite. There is deliberately no history control — the board stores the
 * current/last state only, so the list is exactly what this run last reported.
 */
function Checks({ gates }: { gates: GateCheck[] }) {
    return (
        <details className="chat-gates">
            <summary>
                Checks{' '}
                <span className="pill gate-passed">{gates.filter((g) => g.status === 'passed').length} passed</span>
                <span className="pill gate-failed">{gates.filter((g) => g.status === 'failed').length} failed</span>
                <span className="pill gate-running">{gates.filter((g) => g.status === 'running').length} running</span>
            </summary>
            <ul className="chat-gate-list">
                {gates.map((gate) => (
                    <li key={gate.name}>
                        <details>
                            <summary>
                                <span>{gate.name}</span>
                                <span className={`pill gate-${gate.status}`}>{gate.status}</span>
                                {gate.exitCode !== null ? (
                                    <span className="chat-exit">exit {gate.exitCode}</span>
                                ) : null}
                            </summary>
                            {gate.output !== null ? <pre className="chat-output">{gate.output}</pre> : null}
                        </details>
                    </li>
                ))}
            </ul>
        </details>
    );
}

/** `90433` reads as one number, not four; the locale is pinned so the suite can pin the markup. */
const tokenCount = new Intl.NumberFormat('en-US');

/**
 * The running attempt's sampled container vitals — CPU and memory — rendered above the output
 * while the run is going only. A finished run's last sample is a post-mortem detail; the verdict
 * and the exit code are what the reader wants there, and a stale "cpu 167%" beside them lies about
 * a run that is no longer going. (The agent's current activity line lives in the status sidebar,
 * the task summary at the top of this view, and the nav's task-tree summary — "currently running
 * task", wherever the task is met.) Null — or absent — numbers mean the sample could not read
 * them this round: a services-only sample renders no pills rather than pills that lie with zeros.
 * Absent is its own case because the board's key-wise merge omits unreadable halves instead of
 * storing nulls.
 */
function Runtime({ runtime }: { runtime: RuntimeVitals }) {
    if (runtime.cpuPercent == null && runtime.memUsedMb == null) return null;
    return (
        <p className="chat-runtime">
            {runtime.cpuPercent != null ? <span className="pill">cpu {Math.round(runtime.cpuPercent)}%</span> : null}
            {runtime.memUsedMb != null ? (
                <span className="pill">
                    mem {Math.round(runtime.memUsedMb)} MiB
                    {runtime.memPercent != null ? ` (${Math.round(runtime.memPercent)}%)` : ''}
                </span>
            ) : null}
        </p>
    );
}

/**
 * One task, whole: the follow-up chain rendered as ONE conversation — the root command first,
 * every adjustment after it, each with its run's verdict and output — and, while the newest run
 * can still take one, the composer to continue it.
 *
 * Props in, markup out, like every panel: the detail poll lives in the page (`useThread`), and
 * this component owns only the follow-up draft. Follow-ups are new rows on the board (it is an
 * audit record of what ran), but they are NOT new tasks here: the chain renders top to bottom in
 * this one view, and sending an adjustment extends it in place.
 *
 * Output is rendered as text — a container's stdout is arbitrary bytes, and the Remote Control
 * ones are a captured TUI — so it travels in a `<pre>` and never as markup.
 */
export function TaskDetail({
    jobs,
    error,
    actionError,
    sending,
    onFollowUp,
    onStop,
    onRemove,
    onDone,
}: {
    /** The task's whole chain, oldest first — null until the thread poll lands. */
    jobs: Job[] | null;
    /** Why there is no task yet. Said in place, never silently. */
    error: string | null;
    /** Why the last follow-up did not queue. Said in place, never silently. */
    actionError: string | null;
    sending: boolean;
    onFollowUp: (command: string) => Promise<string | null>;
    onStop: (id: string) => Promise<void>;
    onRemove: (id: string) => Promise<void>;
    onDone: (id: string) => Promise<void>;
}) {
    const [draft, setDraft] = useState('');
    const [stoppingId, setStoppingId] = useState<string | null>(null);
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [doneId, setDoneId] = useState<string | null>(null);
    const outputRef = useRef<HTMLPreElement | null>(null);

    // The conversation continues on the newest run: the composer, the Done verdict and the
    // live-output scroll all belong to it. Older runs are history — their Done is someone
    // else's to click, and their output never grows again. Computed before the early return,
    // because the scroll effect below needs it on every render.
    const latest = jobs === null || jobs.length === 0 ? null : jobs[jobs.length - 1];

    // The output streams in while the newest run goes (the driver flushes tails to the board, and
    // the thread poll picks them up), and somebody watching a run wants the newest line — so the
    // pane follows the tail while the task can still move. A finished run is history; scrolling
    // it is the reader's.
    const liveStatus = latest?.status;
    const liveOutput = latest?.output;
    useEffect(() => {
        if (liveStatus !== undefined && !isTerminal(liveStatus) && outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [liveStatus, liveOutput]);

    if (jobs === null || jobs.length === 0) {
        return (
            <section className="panel">
                <div className="panel-head">
                    <h2>Tasks</h2>
                </div>
                {error !== null ? <p className="muted">{error}</p> : <p className="muted">Loading the task…</p>}
            </section>
        );
    }

    // The run ending is not the task ending: the member can ask for an adjustment or close the
    // task by hand. Neither exists once they have said done. The assertion is sound: the early
    // return above guarantees a non-empty chain, and `latestTask` is its newest member. (Named
    // apart from the per-run `task` in the map below, which shadows it otherwise.)
    const latestTask = latest as Job;
    const open = isTerminal(latestTask.status) && latestTask.doneAt === null;
    // The thread arrives oldest first, so its first member is the ROOT — the task's stable name
    // is what was asked, and the head carries the command's first line so multi-line prose does
    // not swallow the title. The turn below renders the whole command.
    const rootTask = jobs[0]!;
    const title = rootTask.command.split('\n')[0]!.trim();
    // A follow-up continues the newest run's agent session, and the board refuses one for a run
    // that never reported a session — every run whose driver died before reporting — with 409
    // NO_SESSION. Offering the composer there would be a control that can only fail, so the page
    // says so instead.
    const canFollowUp = open && latestTask.sessionId !== null;
    const sessionless = open && latestTask.sessionId === null;
    // The task's live summary — the newest run's activity line, while there is one — at the top of
    // the view, the same line the sidebar's "Task" row and the sidenav read.
    const summary = taskSummary(latestTask.id, jobs);

    const send = async () => {
        if (!draft.trim() || sending) return;
        // No executor choice here: the adjustment is bound to the executor that ran the task —
        // the board copies it from the parent, and a conversation switching executors mid-thread
        // is exactly the cross-CLI resume nothing can do.
        if ((await onFollowUp(draft)) === null) setDraft('');
    };

    // The board settles the run at the worker's next heartbeat, so the button says "Stop" while
    // the request is in flight and "Stopping…" once the flag has landed but the run has not gone
    // yet — the polls repaint the row the moment the driver has parked it, and the row comes
    // back `stopped`: the turn ended, the composer below is open again.
    const stop = async (id: string) => {
        if (stoppingId !== null) return;
        setStoppingId(id);
        try {
            await onStop(id);
        } finally {
            setStoppingId(null);
        }
    };

    // Remove travels with its own in-flight guard like Done; the confirm lives in the page, which
    // also lands the navigation — after a successful remove the thread is gone and this view has
    // nothing left to render.
    const remove = async (id: string) => {
        if (removingId !== null) return;
        setRemovingId(id);
        try {
            await onRemove(id);
        } finally {
            setRemovingId(null);
        }
    };

    // One in-flight mark at a time, like stop: the button says nothing while the request runs,
    // and the pill arrives with the next poll.
    const done = async (id: string) => {
        if (doneId !== null) return;
        setDoneId(id);
        try {
            await onDone(id);
        } finally {
            setDoneId(null);
        }
    };

    return (
        <div className="task-layout">
            <section className="panel">
                <div className="panel-head">
                    <h2>Task - {title}</h2>
                    <div className="task-actions">
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
                                    onClick={() => void stop(latestTask.id)}
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
                                onClick={() => void done(latestTask.id)}
                            >
                                Done
                            </button>
                        ) : null}
                        {latestTask.status !== 'running' ? (
                            <button
                                type="button"
                                className="chat-remove"
                                disabled={removingId === latestTask.id}
                                onClick={() => void remove(latestTask.id)}
                            >
                                Remove
                            </button>
                        ) : null}
                    </div>
                </div>
                {summary !== null ? <p className="task-summary">{summary}</p> : null}
                {actionError !== null ? <p className="status">{actionError}</p> : null}
                {jobs.map((task) => {
                    // The newest run's statuses live in the sidebar — one status surface for the
                    // whole task, fed by the run the composer and Done act on. History runs keep
                    // theirs inline: the sidebar does not carry their per-run verdicts, and
                    // deleting these would erase what each attempt was.
                    const history = task.id !== latestTask.id;
                    return (
                        <article className="chat-exchange" key={task.id}>
                            <p className="msg-user">{task.command}</p>
                            <p className="msg-meta">
                                {history ? <span className="pill">{task.status}</span> : null}
                                {history && task.workflowNode !== null ? (
                                    <span className="pill">{task.workflowNode}</span>
                                ) : null}
                                {history && task.executor !== null ? (
                                    <span className="pill">{task.executor}</span>
                                ) : null}
                                {history && task.doneAt !== null ? <span className="pill chat-done">done</span> : null}
                                {history && task.exitCode !== null ? (
                                    <span className="chat-exit">exit {task.exitCode}</span>
                                ) : null}
                                {/* The verdict's actor, whenever the row carries one — a fact of the
                                run, not of its liveness, so the newest turn shows it too. The stop
                                is stamped at REQUEST time and outlives the settle (complete clears
                                the flag, never the actor), so the status decides whether the ask
                                landed: "stopped" only on a row that settled stopped, "stop
                                requested" on one still moving or finished on its own. */}
                                {task.stoppedBy !== null ? (
                                    <span className="pill chat-stop">
                                        {task.status === 'stopped' ? 'stopped by' : 'stop requested by'}{' '}
                                        {task.stoppedBy.login}
                                    </span>
                                ) : null}
                                {task.doneBy !== null ? (
                                    <span className="pill chat-done">done by {task.doneBy.login}</span>
                                ) : null}
                                <span className="muted">{taskTime(task.createdAt)}</span>
                                {task.runtime?.contextTokens != null ? (
                                    <span className="chat-activity">
                                        ctx {tokenCount.format(task.runtime.contextTokens)} tok
                                        {task.runtime.costUsd != null && task.runtime.costUsd > 0
                                            ? ` · $${task.runtime.costUsd.toFixed(4)}`
                                            : ''}
                                    </span>
                                ) : null}
                                {task.status === 'standby' ? <span className="pill">parked</span> : null}
                            </p>
                            <div className="chat-detail">
                                {task.status === 'running' && task.runtime ? <Runtime runtime={task.runtime} /> : null}
                                {task.gates !== undefined && task.gates !== null && task.gates.length > 0 ? (
                                    <Checks gates={task.gates} />
                                ) : null}
                                {task.output !== null ? (
                                    <pre
                                        ref={task.id === latestTask.id ? outputRef : undefined}
                                        className="chat-output"
                                    >
                                        {task.output}
                                    </pre>
                                ) : isTerminal(task.status) ? (
                                    <p className="muted">No output recorded.</p>
                                ) : (
                                    <p className="muted">Waiting for the executor…</p>
                                )}
                            </div>
                        </article>
                    );
                })}
                {canFollowUp ? (
                    <div className="composer">
                        <textarea
                            className="composer-input"
                            placeholder="Describe the adjustment…"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
                            }}
                        />
                        <div className="composer-row">
                            <button
                                type="button"
                                className="primary"
                                disabled={!draft.trim() || sending}
                                onClick={() => void send()}
                            >
                                Send
                            </button>
                        </div>
                    </div>
                ) : null}
                {sessionless ? (
                    <p className="muted">
                        This run has no agent session to continue, so it cannot take a follow-up. Queue a new task
                        instead.
                    </p>
                ) : null}
            </section>
            <TaskSide jobs={jobs} />
        </div>
    );
}
