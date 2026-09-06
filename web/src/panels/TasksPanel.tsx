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
}) {
    const [draft, setDraft] = useState('');
    const [executor, setExecutor] = useState('');
    const [resumingId, setResumingId] = useState<string | null>(null);

    // A configured executor can be deleted on the Workspace page while a draft sits here; the
    // select would go blank while `send` still submitted the stale name. Clamp to what exists.
    useEffect(() => {
        if (executor !== '' && !executors.some((candidate) => candidate.name === executor)) {
            setExecutor('');
        }
    }, [executors, executor]);

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
                            <article key={task.id} className="chat-exchange">
                                <p className="msg-user">{task.command}</p>
                                <p className="msg-meta">
                                    <span className="pill">{task.status}</span>
                                    {task.executor !== null ? <span className="pill">{task.executor}</span> : null}
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
                    <textarea
                        className="composer-input"
                        placeholder="Describe the task…"
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
