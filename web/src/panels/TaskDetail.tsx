import { useEffect, useRef, useState } from 'react';
import { isTerminal, type GateCheck, type Job, type RuntimeVitals } from '../api/useJobs.js';
import { taskTime } from '../format.js';

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
                                {gate.exitCode !== null ? <span className="chat-exit">exit {gate.exitCode}</span> : null}
                            </summary>
                            {gate.output !== null ? <pre className="chat-output">{gate.output}</pre> : null}
                        </details>
                    </li>
                ))}
            </ul>
        </details>
    );
}

/**
 * The running attempt's vitals, as the driver samples them off its container: CPU, memory, and the
 * agent's current activity line — the "is it stuck or working" answer, rendered above the output
 * while the run is going only. A finished run's last sample is a post-mortem detail; the verdict
 * and the exit code are what the reader wants there, and a stale "cpu 167%" beside them lies about
 * a run that is no longer going.
 */
function Runtime({ runtime }: { runtime: RuntimeVitals }) {
    return (
        <p className="chat-runtime">
            <span className="pill">cpu {Math.round(runtime.cpuPercent)}%</span>
            <span className="pill">
                mem {Math.round(runtime.memUsedMb)} MiB
                {runtime.memPercent !== null ? ` (${Math.round(runtime.memPercent)}%)` : ''}
            </span>
            {runtime.activity !== null ? <span className="chat-activity">{runtime.activity}</span> : null}
        </p>
    );
}

/** `90433` reads as one number, not four; the locale is pinned so the suite can pin the markup. */
const tokenCount = new Intl.NumberFormat('en-US');

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
    onResume,
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
    onResume: (id: string) => Promise<void>;
    onDone: (id: string) => Promise<void>;
}) {
    const [draft, setDraft] = useState('');
    const [resumingId, setResumingId] = useState<string | null>(null);
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
                {error !== null ? (
                    <p className="muted">{error}</p>
                ) : (
                    <p className="muted">Loading the task…</p>
                )}
            </section>
        );
    }

    // The run ending is not the task ending: the member can ask for an adjustment or close the
    // task by hand. Neither exists once they have said done. The assertion is sound: the early
    // return above guarantees a non-empty chain, and `latestTask` is its newest member. (Named
    // apart from the per-run `task` in the map below, which shadows it otherwise.)
    const latestTask = latest as Job;
    const open = isTerminal(latestTask.status) && latestTask.doneAt === null;
    // A follow-up continues the newest run's agent session, and the board refuses one for a run
    // that never reported a session — every run whose driver died before reporting — with 409
    // NO_SESSION. Offering the composer there would be a control that can only fail, so the page
    // says so instead.
    const canFollowUp = open && latestTask.sessionId !== null;
    const sessionless = open && latestTask.sessionId === null;

    const send = async () => {
        if (!draft.trim() || sending) return;
        // No executor choice here: the adjustment is bound to the executor that ran the task —
        // the board copies it from the parent, and a conversation switching executors mid-thread
        // is exactly the cross-CLI resume nothing can do.
        if ((await onFollowUp(draft)) === null) setDraft('');
    };

    const resume = async (id: string) => {
        if (resumingId !== null) return;
        setResumingId(id);
        try {
            await onResume(id);
        } finally {
            setResumingId(null);
        }
    };

    // One in-flight mark at a time, like resume: the button says nothing while the request runs,
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
        <section className="panel">
            <div className="panel-head">
                <h2>Tasks</h2>
            </div>
            {actionError !== null ? <p className="status">{actionError}</p> : null}
            {jobs.map((task) => {
                const taskOpen = isTerminal(task.status) && task.doneAt === null && task.id === latestTask.id;
                return (
                    <article className="chat-exchange" key={task.id}>
                        <p className="msg-user">{task.command}</p>
                        <p className="msg-meta">
                            <span className="pill">{task.status}</span>
                            {task.executor !== null ? <span className="pill">{task.executor}</span> : null}
                            {task.doneAt !== null ? <span className="pill chat-done">done</span> : null}
                            {task.exitCode !== null ? (
                                <span className="chat-exit">exit {task.exitCode}</span>
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
                            {task.status === 'standby' ? (
                                <button
                                    type="button"
                                    className="chat-resume"
                                    disabled={resumingId === task.id}
                                    onClick={() => void resume(task.id)}
                                >
                                    Resume
                                </button>
                            ) : null}
                            {taskOpen ? (
                                <button
                                    type="button"
                                    className="chat-resume"
                                    disabled={doneId === task.id}
                                    onClick={() => void done(task.id)}
                                >
                                    Done
                                </button>
                            ) : null}
                        </p>
                        <div className="chat-detail">
                            {task.status === 'running' && task.runtime ? <Runtime runtime={task.runtime} /> : null}
                            {task.gates !== undefined && task.gates !== null && task.gates.length > 0 ? (
                                <Checks gates={task.gates} />
                            ) : null}
                            {task.output !== null ? (
                                <pre ref={task.id === latestTask.id ? outputRef : undefined} className="chat-output">
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
                        <button type="button" className="primary" disabled={!draft.trim() || sending} onClick={() => void send()}>
                            Send
                        </button>
                    </div>
                </div>
            ) : null}
            {sessionless ? (
                <p className="muted">
                    This run has no agent session to continue, so it cannot take a follow-up. Queue
                    a new task instead.
                </p>
            ) : null}
        </section>
    );
}
