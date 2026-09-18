import { useEffect, useState } from 'react';

/** `owner/name` of the first selected repository, or `''` for none — the select's value shape. */
const firstRepo = (repos: readonly { owner: string; name: string }[] | null): string => {
    const first = repos?.[0];
    return first ? `${first.owner}/${first.name}` : '';
};

/** One declared launch parameter of a workflow, as the list route serves it. */
export interface WorkflowParamChoice {
    name: string;
    pattern?: string;
}

/**
 * The scope stack the board resolves an unnamed workflow's default with: repo over user over org.
 * The client mirrors it to know WHICH default's parameters to ask for before submit.
 */
const DEFAULT_PRECEDENCE: Record<'org' | 'user' | 'repo', number> = { repo: 0, user: 1, org: 2 };

/**
 * The value cap the board enforces (workflow-schema.ts `PARAM_VALUE_LIMIT`), mirrored so Send
 * never lights up for a value the board would refuse.
 */
const PARAM_VALUE_LIMIT = 512;

/**
 * Whether one value satisfies one declaration — the client mirror of the board's
 * `checkWorkflowParams`: trimmed non-empty, within the value cap, full-matched against the
 * declared pattern. A pattern this browser cannot compile answers false — the launch would be
 * refused by the board anyway, and the client never guesses. Stored patterns are a safe,
 * linear-bounded subset (validated at create), so running them here is cheap.
 */
export function paramValueMatches(param: WorkflowParamChoice, value: string | undefined): boolean {
    const trimmed = value?.trim() ?? '';
    if (!trimmed || trimmed.length > PARAM_VALUE_LIMIT) return false;
    if (param.pattern !== undefined) {
        try {
            if (!new RegExp(`^(?:${param.pattern})$`).test(trimmed)) return false;
        } catch {
            return false;
        }
    }
    return true;
}

/** Whether every declared param has a valid value — the Send gate. */
export function paramsComplete(params: readonly WorkflowParamChoice[], values: Record<string, string>): boolean {
    return params.every((param) => paramValueMatches(param, values[param.name]));
}

/**
 * The stored parameter values, read back scoped to the workflow they were typed for. A value is
 * handed over only while that same workflow is STILL the effective one: a repo switch re-resolves
 * the effective default without any select interaction, so a clear-on-select alone would let
 * `#12` typed for repo A's default sit valid for repo B's — and launch B's process with A's
 * issue. Keying the read to the identity makes that carry impossible, with no gap for the stale
 * values to be shown or sent through.
 */
export function valuesForWorkflow(
    stored: { workflowId: string | null; values: Record<string, string> },
    workflowId: string | null
): Record<string, string> {
    return stored.workflowId === workflowId ? stored.values : {};
}

/**
 * The new-task composer, the default right pane of the tasks area.
 *
 * Props in, markup out — every fetch lives in the hooks the pages own (`useWorkspace`,
 * `useJobs`, `useWorkflows`), so this panel is testable in the offline suite:
 * `renderToStaticMarkup` runs no effects, the page hands it finished props and the suite asserts
 * markup.
 *
 * The repository is a stamp the member chooses per task — the old repo tabs collapsed into this
 * select, with `none` (null) carrying the same meaning the All tab had. The first selected
 * repository is the default, exactly like the first configured executor. The workflow select sits
 * beside them: a process the task will walk, offered by name; leaving it unchosen lets the board
 * resolve its default.
 */
export function TaskComposer({
    repos,
    workspaceError,
    onRetryWorkspace,
    executors,
    workflows,
    actionError,
    sending,
    onSend,
    onRepoChange,
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
    /**
     * The workflow choices for the selected repository's context, or null when the list has not
     * answered (or this board serves no workflows at all). Null HIDES the select: a board without
     * the feature renders exactly the composer that came before it. Each choice carries its
     * declared launch parameters — the composer renders one explicit input per param, and Send
     * stays disabled until every one validates.
     */
    workflows:
        | readonly {
              id: string;
              name: string;
              scope: 'org' | 'user' | 'repo';
              isDefault?: boolean;
              params?: WorkflowParamChoice[];
          }[]
        | null;
    /** Why the last Send did not queue anything. Said in place, never silently. */
    actionError: string | null;
    sending: boolean;
    /** `workflow` is a chosen name, or null for "let the board resolve its default". */
    onSend: (
        command: string,
        repo: string | null,
        executor: string | null,
        workflow: string | null,
        workflowParams: Record<string, string> | null
    ) => Promise<string | null>;
    /**
     * Reports the chosen repository upward, so the page can re-fetch the workflow list for that
     * repository's context. Optional — the panel is testable without it.
     */
    onRepoChange?: (repo: string | null) => void;
}) {
    const [draft, setDraft] = useState('');
    const [executor, setExecutor] = useState(() => executors[0]?.name ?? '');
    const [executorTouched, setExecutorTouched] = useState(false);
    const [repo, setRepo] = useState(() => firstRepo(repos));
    const [repoTouched, setRepoTouched] = useState(false);
    // The workflow starts UNCHOSEN — null, the board's own default — and, unlike repo and
    // executor, nothing autoselects one: a process is the member's call, not the first row's.
    const [workflow, setWorkflow] = useState('');
    // The declared params of the effective workflow, filled in the explicit inputs below. Stored
    // against the identity of the workflow they were typed for — values typed for one process must
    // never stamp another, however the effective one came to change.
    const [storedParams, setStoredParams] = useState<{ workflowId: string | null; values: Record<string, string> }>({
        workflowId: null,
        values: {},
    });

    // The workflow whose inputs the composer shows: the member's explicit choice, or — nothing
    // chosen — the board's own default resolution (repo over user over org, the same stack the
    // route walks over the same visible list). A default that declares parameters refuses a
    // launch without them exactly like a chosen one does, so its inputs MUST show before submit,
    // or every bare task launch would 400 with nothing on screen to fix it. A name is unique per
    // SCOPE only, so a chosen name matching several visible definitions resolves with the same
    // repo-over-user-over-org precedence `findByName` uses — never the list's alphabetical accident.
    const chosenWorkflow =
        workflows
            ?.filter((choice) => choice.name === workflow)
            .sort((a, b) => DEFAULT_PRECEDENCE[a.scope] - DEFAULT_PRECEDENCE[b.scope])[0] ?? null;
    const effectiveWorkflow =
        chosenWorkflow ??
        (workflows ?? [])
            .filter((choice) => choice.isDefault === true)
            .sort((a, b) => DEFAULT_PRECEDENCE[a.scope] - DEFAULT_PRECEDENCE[b.scope])[0] ??
        null;
    const declaredParams = effectiveWorkflow?.params ?? [];
    const effectiveWorkflowId = effectiveWorkflow?.id ?? null;
    const paramValues = valuesForWorkflow(storedParams, effectiveWorkflowId);
    const paramsReady = paramsComplete(declaredParams, paramValues);
    // The declarations Send is still dark for — empty, over-length or pattern-refused values
    // alike. Named in place below: a disabled button with no reason on screen is a task that
    // cannot start.
    const missingParams = declaredParams.filter((param) => !paramValueMatches(param, paramValues[param.name]));

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

    // The workflow list's repo context must track the composer's repo WHEREVER the composer sets
    // it — the mount initializer, the autoselect above, the clamp above, or the member's own
    // hand — or the page fetches the list for a different context than the launched task resolves
    // against, and repo-scoped workflows (and their parameters) go invisible exactly when they
    // would apply. `reportedRepo` starts at null, the "nothing reported yet" sentinel: the
    // mount-time repo — already set by the initializer when the workspace poll answered before
    // mount — is reported exactly once by this effect, and every later change by the guard after
    // it. This effect is the ONE reporting path; the select's onChange only updates local state.
    const [reportedRepo, setReportedRepo] = useState<string | null>(null);
    useEffect(() => {
        const value = repo === '' ? null : repo;
        if (value !== reportedRepo) {
            setReportedRepo(value);
            onRepoChange?.(value);
        }
    }, [repo, reportedRepo, onRepoChange]);

    const send = async () => {
        if (!draft.trim() || sending) return;
        // The mirror of the board's check: a missing or malformed parameter must never reach the
        // wire — the composer says nothing and the Send stays dark (this also gates Cmd+Enter).
        if (!paramsReady) return;
        const chosenExecutor = executor === '' ? null : executor;
        const chosenRepo = repo === '' ? null : repo;
        const chosenWorkflowName = workflow === '' ? null : workflow;
        // Values travel trimmed. They ride beside an explicit choice, or — nothing chosen —
        // beside the default the board will resolve for the same repo context this list was
        // fetched for; the board validates them against whatever it resolves and refuses a
        // mismatch loudly.
        const values: Record<string, string> = {};
        for (const param of declaredParams) values[param.name] = (paramValues[param.name] ?? '').trim();
        const chosenParams =
            declaredParams.length > 0
                ? Object.fromEntries(declaredParams.map((param) => [param.name, values[param.name] ?? '']))
                : null;
        if ((await onSend(draft, chosenRepo, chosenExecutor, chosenWorkflowName, chosenParams)) === null) setDraft('');
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
                                // Reporting upward is the reporting effect's job — one path.
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
                    {workflows !== null ? (
                        <label className="composer-label">
                            Workflow{' '}
                            <select
                                className="composer-select"
                                value={workflow}
                                onChange={(e) => {
                                    setWorkflow(e.target.value);
                                    // The values reset through the identity-keyed read: the changed
                                    // choice re-resolves the effective workflow, and stale values
                                    // stop being handed back — select and repo switch alike.
                                }}
                            >
                                <option value="">— none —</option>
                                {workflows.map((choice) => (
                                    <option key={choice.id} value={choice.name}>
                                        {choice.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}
                    <button
                        type="button"
                        className="primary"
                        disabled={!draft.trim() || sending || !paramsReady}
                        onClick={() => void send()}
                    >
                        Send
                    </button>
                </div>
                {effectiveWorkflow !== null && declaredParams.length > 0 ? (
                    <div className="composer-row">
                        {declaredParams.map((param) => (
                            <label key={param.name} className="composer-label composer-param">
                                {chosenWorkflow === null ? `${effectiveWorkflow.name} · ` : ''}
                                {param.name}{' '}
                                <input
                                    className="composer-select"
                                    placeholder="required"
                                    title={param.pattern !== undefined ? `must match ${param.pattern}` : undefined}
                                    maxLength={512}
                                    value={paramValues[param.name] ?? ''}
                                    onChange={(e) =>
                                        setStoredParams({
                                            workflowId: effectiveWorkflowId,
                                            values: { ...paramValues, [param.name]: e.target.value },
                                        })
                                    }
                                />
                            </label>
                        ))}
                        {missingParams.length > 0 ? (
                            <span className="muted">needs: {missingParams.map((param) => param.name).join(', ')}</span>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </section>
    );
}
