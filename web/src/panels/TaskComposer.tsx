import { useEffect, useState } from 'react';

/** `owner/name` of the first selected repository, or `''` for none — the select's value shape. */
const firstRepo = (repos: readonly { owner: string; name: string }[] | null): string => {
    const first = repos?.[0];
    return first ? `${first.owner}/${first.name}` : '';
};

/**
 * The new-task composer, the default right pane of the tasks area.
 *
 * Props in, markup out — every fetch lives in the hooks the pages own (`useWorkspace`,
 * `useJobs`), so this panel is testable in the offline suite: `renderToStaticMarkup` runs no
 * effects, the page hands it finished props and the suite asserts markup.
 *
 * The repository is a stamp the member chooses per task — the old repo tabs collapsed into this
 * select, with `none` (null) carrying the same meaning the All tab had. The first selected
 * repository is the default, exactly like the first configured executor.
 */
export function TaskComposer({
    repos,
    workspaceError,
    onRetryWorkspace,
    executors,
    actionError,
    sending,
    onSend,
}: {
    /**
     * The member's selected repositories, one option each. Null while the workspace poll has not
     * answered yet — "not known" is a different sentence from "known empty", and merging them
     * would blame the member's selection for a request that never landed.
     */
    repos: readonly { owner: string; name: string }[] | null;
    /** Why `repos` is null, when it is. */
    workspaceError: string | null;
    onRetryWorkspace: () => void;
    executors: readonly { name: string; type: string }[];
    /** Why the last Send did not queue anything. Said in place, never silently. */
    actionError: string | null;
    sending: boolean;
    onSend: (command: string, repo: string | null, executor: string | null) => Promise<string | null>;
}) {
    const [draft, setDraft] = useState('');
    const [executor, setExecutor] = useState(() => executors[0]?.name ?? '');
    const [executorTouched, setExecutorTouched] = useState(false);
    const [repo, setRepo] = useState(() => firstRepo(repos));
    const [repoTouched, setRepoTouched] = useState(false);

    // The FIRST selected repository is the default — the executor precedent: a member who picked
    // repositories means their tasks to be stamped with one, not with nothing. Explicit `none`
    // wins the moment they pick it — `repoTouched` is what stops this autoselect from stomping
    // their choice back on the next workspace poll. The initializer above covers the mount that
    // already knows the list (and the offline suite, which runs no effects); this covers the poll
    // that fills the list in afterwards.
    useEffect(() => {
        if (!repoTouched && repo === '' && repos !== null && repos.length > 0) {
            setRepo(firstRepo(repos));
        }
    }, [repos, repo, repoTouched]);

    // The FIRST configured executor is the default: a member who set one up means their tasks to
    // run on it, not on an unlabelled runner. Explicit `none` wins the moment they pick it —
    // `executorTouched` is what stops this autoselect from stomping their choice back on the
    // next workspace poll.
    useEffect(() => {
        if (!executorTouched && executor === '' && executors.length > 0) {
            setExecutor(executors[0]!.name);
        }
    }, [executors, executor, executorTouched]);

    // A configured executor can be deleted on the Workspace page while a draft sits here; the
    // select would go blank while `send` still submitted the stale name. Clamp to what exists —
    // back to the first executor, or none when the list is empty.
    useEffect(() => {
        if (executor !== '' && !executors.some((candidate) => candidate.name === executor)) {
            setExecutor(executors.length > 0 ? executors[0]!.name : '');
        }
    }, [executors, executor]);

    // Same for the repository: a deselection must not survive invisibly in the draft and stamp a
    // task with a repository the member no longer works in. Clamp to what exists — the first
    // repository, or none when the list is empty.
    useEffect(() => {
        if (repos !== null && repo !== '' && !repos.some(({ owner, name }) => `${owner}/${name}` === repo)) {
            setRepo(firstRepo(repos));
        }
    }, [repos, repo]);

    const send = async () => {
        if (!draft.trim() || sending) return;
        const chosenExecutor = executor === '' ? null : executor;
        const chosenRepo = repo === '' ? null : repo;
        if ((await onSend(draft, chosenRepo, chosenExecutor)) === null) setDraft('');
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
        <section className="panel task-compose">
            <div className="panel-head">
                <h2>Tasks</h2>
            </div>
            {actionError !== null ? <p className="status">{actionError}</p> : null}
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
                        Repository{' '}
                        <select
                            className="composer-select"
                            value={repo}
                            onChange={(e) => {
                                setRepoTouched(true);
                                setRepo(e.target.value);
                            }}
                        >
                            <option value="">none</option>
                            {repos.map(({ owner, name }) => {
                                const full = `${owner}/${name}`;
                                return (
                                    <option key={full} value={full}>
                                        {full}
                                    </option>
                                );
                            })}
                        </select>
                    </label>
                    <label className="composer-label">
                        Executor{' '}
                        <select
                            className="composer-select"
                            value={executor}
                            onChange={(e) => {
                                setExecutorTouched(true);
                                setExecutor(e.target.value);
                            }}
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
        </section>
    );
}
