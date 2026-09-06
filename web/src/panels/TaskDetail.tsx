import { useEffect, useState } from 'react';
import { isTerminal, type Job } from '../api/useJobs.js';
import { taskTime } from '../format.js';

/**
 * One task, whole: the command, its run's verdict and output, and — while the task can still take
 * one — the composer for a follow-up.
 *
 * Props in, markup out, like every panel: the detail poll lives in the page (`useJob`), and this
 * component owns only the follow-up draft. There is no "Replying to" banner because there is no
 * arming step any more — the task being continued IS this page.
 *
 * Output is rendered as text — a container's stdout is arbitrary bytes, and the Remote Control
 * ones are a captured TUI — so it travels in a `<pre>` and never as markup.
 */
export function TaskDetail({
    task,
    error,
    executors,
    actionError,
    sending,
    onFollowUp,
    onResume,
    onDone,
}: {
    /** The selected task, whole — the only place an output comes from. Null until the poll lands. */
    task: Job | null;
    /** Why there is no task yet. Said in place, never silently. */
    error: string | null;
    executors: readonly { name: string; type: string }[];
    /** Why the last follow-up did not queue. Said in place, never silently. */
    actionError: string | null;
    sending: boolean;
    onFollowUp: (command: string, executor: string | null) => Promise<string | null>;
    onResume: (id: string) => Promise<void>;
    onDone: (id: string) => Promise<void>;
}) {
    const [draft, setDraft] = useState('');
    const [executor, setExecutor] = useState('');
    const [resumingId, setResumingId] = useState<string | null>(null);
    const [doneId, setDoneId] = useState<string | null>(null);

    // A configured executor can be deleted on the Workspace page while a draft sits here; the
    // select would go blank while `send` still submitted the stale name. Clamp to what exists.
    useEffect(() => {
        if (executor !== '' && !executors.some((candidate) => candidate.name === executor)) {
            setExecutor('');
        }
    }, [executors, executor]);

    const send = async () => {
        if (task === null || !draft.trim() || sending) return;
        const chosen = executor === '' ? null : executor;
        if ((await onFollowUp(draft, chosen)) === null) setDraft('');
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

    if (task === null) {
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
    // task by hand. Neither exists once they have said done.
    const open = isTerminal(task.status) && task.doneAt === null;

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>Tasks</h2>
            </div>
            {actionError !== null ? <p className="status">{actionError}</p> : null}
            <article className="chat-exchange">
                <p className="msg-user">{task.command}</p>
                <p className="msg-meta">
                    <span className="pill">{task.status}</span>
                    {task.executor !== null ? <span className="pill">{task.executor}</span> : null}
                    {task.doneAt !== null ? <span className="pill chat-done">done</span> : null}
                    {task.exitCode !== null ? <span className="chat-exit">exit {task.exitCode}</span> : null}
                    <span className="muted">{taskTime(task.createdAt)}</span>
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
                    {open ? (
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
                    {task.output !== null ? (
                        <pre className="chat-output">{task.output}</pre>
                    ) : isTerminal(task.status) ? (
                        <p className="muted">No output recorded.</p>
                    ) : (
                        <p className="muted">Waiting for the executor…</p>
                    )}
                </div>
            </article>
            {open ? (
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
                        <label className="composer-label">
                            Executor{' '}
                            <select
                                className="composer-select"
                                value={executor}
                                onChange={(e) => setExecutor(e.target.value)}
                            >
                                <option value="">none</option>
                                {executors.map((candidate) => (
                                    <option key={candidate.name} value={candidate.name}>
                                        {candidate.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <button type="button" className="primary" disabled={!draft.trim() || sending} onClick={() => void send()}>
                            Send
                        </button>
                    </div>
                </div>
            ) : null}
        </section>
    );
}
