import { useEffect, useState } from 'react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';

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
 * Repo over user over org — the one precedence rule a name matching several visible scopes
 * resolves with, the same tie-break `findByName` walks on the board.
 */
const DEFAULT_PRECEDENCE: Record<'org' | 'user' | 'repo', number> = { repo: 0, user: 1, org: 2 };

/**
 * The workflows the composer offers: one row per effective NAME, at the scope the launch would
 * resolve. A name is unique per scope only, so the visible list can hold the same name at several
 * scopes — and a Listbox row is clickable in a way a native `<option>` duplicate never was. The
 * options therefore collapse to the same repo-over-user-over-org winner `chosenWorkflow` (and the
 * board's `findByName`) resolves with, in the order the list offered the names; picking a row and
 * picking its name can no longer mean two different definitions.
 */
export function effectiveWorkflows<T extends { name: string; scope: 'org' | 'user' | 'repo' }>(
    workflows: readonly T[]
): T[] {
    const best = new Map<string, T>();
    for (const choice of workflows) {
        const held = best.get(choice.name);
        if (held === undefined || DEFAULT_PRECEDENCE[choice.scope] < DEFAULT_PRECEDENCE[held.scope]) {
            best.set(choice.name, choice);
        }
    }
    return workflows.filter((choice) => best.get(choice.name) === choice);
}

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
 * handed over only while that same workflow is STILL the chosen one: a select or repo switch
 * changes the list's context, so a clear-on-select alone would let `#12` typed for one process
 * sit valid for another — and launch it with a foreign issue. Keying the read to the identity
 * makes that carry impossible, with no gap for the stale values to be shown or sent through. A
 * repository change is handled one layer up, where the whole draft resets (the repo effect below).
 */
export function valuesForWorkflow(
    stored: { workflowId: string | null; values: Record<string, string> },
    workflowId: string | null
): Record<string, string> {
    return stored.workflowId === workflowId ? stored.values : {};
}

/**
 * The workflow draft as a repository change leaves it — and as the composer mounts: the choice
 * back to unchosen, the stored values back to none. One named shape for both moments keeps the
 * reset provably the no-op on mount it must be, and hands the offline suite (which runs no
 * effects) the exact state Send sees after a repo switch to pin.
 */
export function freshWorkflowDraft(): {
    workflow: string;
    storedParams: { workflowId: string | null; values: Record<string, string> };
} {
    return { workflow: '', storedParams: { workflowId: null, values: {} } };
}

/**
 * The workflow select's value, clamped to the choices the ANSWERED list offers: a chosen name the
 * current context no longer serves must not survive invisibly in the draft — its parameter inputs
 * are gone, the vacuous gate lights Send, and the launch carries a name the board refuses with
 * UNKNOWN_WORKFLOW. A fetch still in flight (`null`) says nothing about the coming context, so a
 * choice survives the wait and is judged the moment the list lands.
 */
export function clampedWorkflow(workflow: string, workflows: readonly { name: string }[] | null): string {
    if (workflow === '' || workflows === null || workflows.some((choice) => choice.name === workflow)) {
        return workflow;
    }
    return '';
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
 * beside them: a process the task will walk, offered by name, chosen by hand — an unnamed task
 * runs the member's words verbatim, with no process and no parameters.
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
     * declared launch parameters — choosing one renders an explicit input per param, and Send
     * stays disabled until every one validates. Unchosen, the task runs the member's words
     * verbatim — no workflow, no parameters.
     */
    workflows:
        | readonly {
              id: string;
              name: string;
              scope: 'org' | 'user' | 'repo';
              params?: WorkflowParamChoice[];
          }[]
        | null;
    /** Why the last Send did not queue anything. Said in place, never silently. */
    actionError: string | null;
    sending: boolean;
    /** `workflow` is a chosen name, or null for no process — the raw prompt runs. */
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
    // The workflow starts UNCHOSEN — null, meaning no process: the raw prompt runs. And, unlike
    // repo and executor, nothing autoselects one: a process is the member's call, not the first
    // row's. A repository change returns it to exactly this shape (the repo effect below).
    const [workflow, setWorkflow] = useState(freshWorkflowDraft().workflow);
    // The declared params of the chosen workflow, filled in the explicit inputs below. Stored
    // against the identity of the workflow they were typed for — values typed for one process must
    // never stamp another.
    const [storedParams, setStoredParams] = useState(freshWorkflowDraft().storedParams);

    // The workflow whose inputs the composer shows: exactly the member's explicit choice. Nothing
    // autoselects one — an unnamed task runs the raw prompt, so a process is the member's call,
    // never a silent resolution. A name is unique per SCOPE only, so a name matching several
    // visible definitions resolves with the same repo-over-user-over-org precedence `findByName`
    // uses — never the list's alphabetical accident.
    const chosenWorkflow =
        workflows
            ?.filter((choice) => choice.name === workflow)
            .sort((a, b) => DEFAULT_PRECEDENCE[a.scope] - DEFAULT_PRECEDENCE[b.scope])[0] ?? null;
    const declaredParams = chosenWorkflow?.params ?? [];
    const chosenWorkflowId = chosenWorkflow?.id ?? null;
    const paramValues = valuesForWorkflow(storedParams, chosenWorkflowId);
    const paramsReady = paramsComplete(declaredParams, paramValues);

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

    // A repository change re-fetches the workflow list, and the hook keeps the previous list
    // while the new request is pending — the page hands that stale list straight through, so a
    // choice made against it could ride Send into a task stamped with the NEW repository: a
    // workflow name that may not even exist for the new context, carrying values typed for a
    // process it was not. The draft resets the moment the repository state changes — the
    // member's select, the autoselect, the clamp: every path a change arrives by is this one
    // state — and the member picks again from the list that answers. After the context changed,
    // a process is the member's explicit call again. The reset targets are the mount values, so
    // the effect's mount-time run is a no-op.
    useEffect(() => {
        const reset = freshWorkflowDraft();
        setWorkflow(reset.workflow);
        setStoredParams(reset.storedParams);
    }, [repo]);

    // And the workflow: a repository switch refetches the list for the new context, and a chosen
    // name the answered list does not offer must go the way of a deleted executor — clamped to
    // what exists. Unchosen is the only reset target: nothing autoselects a process, so the
    // member's words run verbatim until one is picked again.
    useEffect(() => {
        const clamped = clampedWorkflow(workflow, workflows);
        if (clamped !== workflow) setWorkflow(clamped);
    }, [workflows, workflow]);

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
        // Values travel trimmed, and only beside an explicit choice — a task with no workflow
        // carries no parameters at all.
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
                    <div className="composer-label">
                        Repository{' '}
                        <Listbox
                            value={repo}
                            onChange={(next) => {
                                setRepoTouched(true);
                                setRepo(next);
                                // Reporting upward is the reporting effect's job — one path.
                            }}
                        >
                            <ListboxButton className="composer-select" aria-label="Repository">
                                {repo === '' ? 'none' : repo}
                            </ListboxButton>
                            <ListboxOptions anchor="bottom start" className="popover">
                                <ListboxOption value="" className="popover-option">
                                    none
                                </ListboxOption>
                                {repos.map(({ owner, name }) => {
                                    const full = `${owner}/${name}`;
                                    return (
                                        <ListboxOption key={full} value={full} className="popover-option">
                                            {full}
                                        </ListboxOption>
                                    );
                                })}
                            </ListboxOptions>
                        </Listbox>
                    </div>
                    <div className="composer-label">
                        Executor{' '}
                        <Listbox
                            value={executor}
                            onChange={(next) => {
                                setExecutorTouched(true);
                                setExecutor(next);
                            }}
                        >
                            <ListboxButton className="composer-select" aria-label="Executor">
                                {executor === '' ? 'none' : executor}
                            </ListboxButton>
                            <ListboxOptions anchor="bottom start" className="popover">
                                <ListboxOption value="" className="popover-option">
                                    none
                                </ListboxOption>
                                {executors.map((candidate) => (
                                    <ListboxOption
                                        key={candidate.name}
                                        value={candidate.name}
                                        className="popover-option"
                                    >
                                        {candidate.name}
                                    </ListboxOption>
                                ))}
                            </ListboxOptions>
                        </Listbox>
                    </div>
                    {workflows !== null ? (
                        <div className="composer-label">
                            Workflow{' '}
                            <Listbox
                                value={workflow}
                                onChange={(next) => {
                                    setWorkflow(next);
                                    // The values reset through the identity-keyed read: the changed
                                    // choice re-resolves the chosen workflow, and stale values
                                    // stop being handed back. A repo switch goes further and resets
                                    // the whole draft — the repo effect below.
                                }}
                            >
                                <ListboxButton className="composer-select" aria-label="Workflow">
                                    {workflow === '' ? '— none —' : workflow}
                                </ListboxButton>
                                <ListboxOptions anchor="bottom start" className="popover">
                                    <ListboxOption value="" className="popover-option">
                                        — none —
                                    </ListboxOption>
                                    {effectiveWorkflows(workflows).map((choice) => (
                                        <ListboxOption key={choice.id} value={choice.name} className="popover-option">
                                            {choice.name}
                                        </ListboxOption>
                                    ))}
                                </ListboxOptions>
                            </Listbox>
                        </div>
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
                {declaredParams.length > 0 ? (
                    <ComposerParamRow
                        params={declaredParams}
                        values={paramValues}
                        onInput={(name, value) =>
                            setStoredParams({
                                workflowId: chosenWorkflowId,
                                values: { ...paramValues, [name]: value },
                            })
                        }
                    />
                ) : null}
            </div>
        </section>
    );
}

/**
 * The chosen workflow's declared parameters: one explicit input per declaration, and the list of
 * the ones still blocking Send, named in words. Each blocking input carries `aria-invalid` and
 * references the message by id, so a screen reader hears WHICH field is dark and why — a disabled
 * button alone says neither. The message's region stays mounted while the row does, because a
 * live region can only announce a change it survives, and speaks politely: it updates per
 * keystroke, not as an alarm.
 */
export function ComposerParamRow({
    params,
    values,
    onInput,
}: {
    /** The declared parameters of the chosen workflow, one input each. */
    params: readonly WorkflowParamChoice[];
    /** The member's typed values so far, keyed by parameter name. */
    values: Record<string, string>;
    /** One keystroke: the parameter's name, and the field's new value. */
    onInput: (name: string, value: string) => void;
}) {
    // The declarations Send is still dark for — empty, over-length or pattern-refused values
    // alike. Named in place below: a disabled button with no reason on screen is a task that
    // cannot start.
    const missing = params.filter((param) => !paramValueMatches(param, values[param.name]));
    return (
        <div className="composer-row">
            {params.map((param) => {
                const invalid = !paramValueMatches(param, values[param.name]);
                return (
                    <label key={param.name} className="composer-label composer-param">
                        {param.name}{' '}
                        <input
                            className="composer-select"
                            placeholder="required"
                            title={param.pattern !== undefined ? `must match ${param.pattern}` : undefined}
                            aria-invalid={invalid || undefined}
                            aria-describedby={invalid ? 'composer-param-error' : undefined}
                            maxLength={512}
                            value={values[param.name] ?? ''}
                            onChange={(e) => onInput(param.name, e.target.value)}
                        />
                    </label>
                );
            })}
            <span id="composer-param-error" className="muted" aria-live="polite">
                {missing.length > 0
                    ? `needs: ${missing
                          .map((param) =>
                              param.pattern !== undefined ? `${param.name} (must match ${param.pattern})` : param.name
                          )
                          .join(', ')}`
                    : ''}
            </span>
        </div>
    );
}
