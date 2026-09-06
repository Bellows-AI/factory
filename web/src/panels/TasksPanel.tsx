import { useEffect, useState } from 'react';
import { isTerminal, type Job } from '../api/useJobs.js';
import { taskTime } from '../format.js';

/**
 * The tasks chat, props in and markup out.
 *
 * Every fetch lives in the hooks the page owns (`useJobs`, `useJob`, `useWorkspace`); this panel
 * holds only what a reader can see and the composer's own draft. That is also what makes it
 * testable in the offline suite: `renderToStaticMarkup` runs no effects, so the page hands it
 * finished props and the suite asserts markup.
 *
 * Output is rendered as text — a container's stdout is arbitrary bytes, and the Remote Control
 * ones are a captured TUI — so it travels in a `<pre>` and never as markup.
 */
export function TasksPanel({
    repos,
    workspaceError,
    onRetryWorkspace,
    executors,
    repo,
    onRepo,
    jobs,
    detail,
    detailError,
    selectedId,
    onSelect,
    onResume,
    onSend,
    sending,
    followUpTarget,
    onFollowUp,
    onCancelFollowUp,
    onDone,
}: {
    /**
     * The member's selected repositories, one tab each. Null while the workspace poll has not
     * answered yet — "not known" is a different sentence from "known empty", and merging them
     * would blame the member's selection for a request that never landed.
     */
    repos: readonly { owner: string; name: string }[] | null;
    /** Why `repos` is null, when it is. */
    workspaceError: string | null;
    onRetryWorkspace: () => void;
    executors: readonly { name: string; type: string }[];
    /** The active tab; null is All. */
    repo: string | null;
    onRepo: (repo: string | null) => void;
    /** As the board serves them — newest first. Rendered oldest first, because a chat reads down. */
    jobs: readonly Job[] | null;
    /** The selected task, whole — the only place an output comes from. */
    detail: Job | null;
    /** Why there is no detail yet. Said in place, never silently. */
    detailError: string | null;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onResume: (id: string) => Promise<void>;
    onSend: (command: string, executor: string | null) => Promise<string | null>;
    sending: boolean;
    /** The finished task the next Send follows up on, while one is armed. */
    followUpTarget: string | null;
    onFollowUp: (id: string) => void;
    onCancelFollowUp: () => void;
    onDone: (id: string) => Promise<void>;
}) {
    const [draft, setDraft] = useState('');
    const [executor, setExecutor] = useState('');
    const [resumingId, setResumingId] = useState<string | null>(null);
    const [doneId, setDoneId] = useState<string | null>(null);

    // The armed target names itself by its command, or is simply absent when the task is not in
    // the list this panel was handed.
    const target = followUpTarget !== null ? jobs?.find((task) => task.id === followUpTarget) ?? null : null;

    // A configured executor can be deleted on the Workspace page while a draft sits here; the
    // select would go blank while `send` still submitted the stale name. Clamp to what exists.
    useEffect(() => {
        if (executor !== '' && !executors.some((candidate) => candidate.name === executor)) {
            setExecutor('');
        }
    }, [executors, executor]);

    // An armed target the current list no longer carries — a tab switch, or a task that fell out
    // of the served window — cannot be replied to from here, and the composer has already gone
    // back to reading as a fresh one. Disarm rather than let the next Send continue a
    // conversation the member can no longer see.
    useEffect(() => {
        if (followUpTarget !== null && target === null) onCancelFollowUp();
    }, [followUpTarget, target, onCancelFollowUp]);

    const send = async () => {
        if (!draft.trim() || sending) return;
        const chosen = executor === '' ? null : executor;
        if ((await onSend(draft, chosen)) === null) setDraft('');
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

    if (repos === null) {
        return (
            <section className="panel">
                <div className="panel-head">
                    <h2>Tasks</h2>
                </div>
                {workspaceError !== null ? (
                    <p className="muted">
                        {workspaceError}{' '}
                        <button type="button" className="chat-resume" onClick={onRetryWorkspace}>
                            Retry
                        </button>
                    </p>
                ) : (
                    <p className="muted">Loading your workspace…</p>
                )}
            </section>
        );
    }

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>Tasks</h2>
            </div>

            <>
                <div className="tabs" aria-label="Repositories">
                    <button
                        type="button"
                        className={repo === null ? 'tab is-active' : 'tab'}
                        onClick={() => onRepo(null)}
                    >
                        All
                    </button>
                    {repos.map(({ owner, name }) => {
                        const full = `${owner}/${name}`;
                        return (
                            <button
                                key={full}
                                type="button"
                                className={repo === full ? 'tab is-active' : 'tab'}
                                onClick={() => onRepo(full)}
                            >
                                {full}
                            </button>
                        );
                    })}
                </div>

                <div className="chat">
                    {jobs === null ? (
                        <p className="status">Loading tasks…</p>
                    ) : jobs.length === 0 ? (
                        <p className="muted">No tasks here yet. Type one below and it is queued for an executor.</p>
                    ) : (
                        [...jobs].reverse().map((task) => (
                            <article
                                key={task.id}
                                className={task.followUpTo !== null ? 'chat-exchange chat-follow-up' : 'chat-exchange'}
                            >
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
                                    {isTerminal(task.status) && task.doneAt === null ? (
                                        // The run ending is not the task ending: the user can ask
                                        // for an adjustment (the composer arms itself) or close the
                                        // task by hand. Neither exists once they have said done.
                                        <>
                                            <button
                                                type="button"
                                                className="chat-resume"
                                                disabled={doneId === task.id}
                                                onClick={() => void done(task.id)}
                                            >
                                                Done
                                            </button>
                                            <button
                                                type="button"
                                                className="chat-resume"
                                                onClick={() => onFollowUp(task.id)}
                                            >
                                                Follow up
                                            </button>
                                        </>
                                    ) : null}
                                    <button
                                        type="button"
                                        className="chat-toggle"
                                        onClick={() => onSelect(selectedId === task.id ? null : task.id)}
                                    >
                                        {selectedId === task.id ? 'Hide output' : 'Output'}
                                    </button>
                                </p>
                                {selectedId === task.id ? (
                                    <div className="chat-detail">
                                        {detailError !== null ? (
                                            <p className="muted">{detailError}</p>
                                        ) : detail === null || detail.id !== task.id ? (
                                            // Nothing is known yet, so nothing is claimed: a
                                            // finished task's output may simply not have loaded.
                                            <p className="muted">Loading output…</p>
                                        ) : detail.output !== null ? (
                                            <pre className="chat-output">{detail.output}</pre>
                                        ) : (
                                            <p className="muted">
                                                {isTerminal(detail.status) ? 'No output recorded.' : 'Waiting for the executor…'}
                                            </p>
                                        )}
                                    </div>
                                ) : null}
                            </article>
                        ))
                    )}
                </div>

                <div className="composer">
                    {target !== null ? (
                        // The composer says which task the next Send continues, with a way out —
                        // an armed follow-up that reads as a fresh task would queue work nobody
                        // asked for.
                        <p className="composer-target">
                            Replying to “{target.command}”{' '}
                            <button type="button" className="chat-resume" onClick={onCancelFollowUp}>
                                Cancel
                            </button>
                        </p>
                    ) : null}
                    <textarea
                        className="composer-input"
                        placeholder={target !== null ? 'Describe the adjustment…' : 'Describe the task…'}
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
            </>
        </section>
    );
}
