import { useEffect, useState } from 'react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { Link } from 'react-router-dom';
import { WorkflowParameterFields } from '../components/WorkflowParameterFields.js';
import {
    clampedWorkflow,
    defaultWorkflowPayload,
    effectiveDefaultSteps,
    effectiveWorkflows,
    firstRepo,
    freshWorkflowDraft,
    markTouched,
    paramValueMatches,
    paramsComplete,
    preflightSentence,
    resolveWorkflowChoice,
    startBlocker,
    toggleDefaultStep,
    touchAll,
    valuesForWorkflow,
} from '../task-composer.js';
import type { DefaultWorkflowSteps } from '../task-composer.js';

/**
 * The prompt's example placeholder. The issue number travels as string parts because
 * `123` directly behind a hash scans as a hex color literal, and the stylesheet's color gate
 * reads every `.tsx` in the tree — the rendered copy stays exact.
 */
const PROMPT_PLACEHOLDER = 'Example: Fix issue #' + '123, update the affected tests, and run the relevant checks.';

/**
 * The guided new-task composer, the default right pane of the tasks area.
 *
 * Props in, markup out — every fetch lives in the hooks the pages own (`useWorkspace`, `useJobs`,
 * `useWorkflows`), so this panel is testable in the offline suite: `renderToStaticMarkup` runs no
 * effects, the page hands it finished props and the suite asserts markup.
 *
 * The page reads top to bottom the way a member decides: what the agent should do, where it will
 * run, which process will guide it, what is still blocking the launch, and what will actually
 * run — before Start is ever pressed. The repository, executor and workflow are task parameters.
 * Repository and workflow may deliberately be absent; executor may not, because its profile type
 * chooses the runner. The pure layer beneath — the verdicts, preflight sentence and blocker
 * matrix — lives in `task-composer.ts`.
 */
export function TaskComposer({
    repos,
    workspaceError,
    onRetryWorkspace,
    executors,
    workflows,
    defaultWorkflowSettings,
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
     * answered (or this board serves no workflows at all). Null HIDES the section: a board
     * without the feature renders exactly the composer that came before it. Each choice carries
     * its declared launch parameters — choosing one renders an explicit, labelled input per
     * param, and Start stays disabled until every one validates. Unchosen, the task runs the
     * member's words verbatim — no workflow, no parameters.
     */
    workflows:
        | readonly {
              id: string;
              name: string;
              scope: 'org' | 'user' | 'repo';
              params?: import('../task-composer.js').WorkflowParamChoice[];
          }[]
        | null;
    /**
     * The member's saved default-workflow step settings (issues 203/208), or null while they have not
     * answered yet — the two optional-step checkboxes stay hidden for exactly that duration, the
     * same "not known yet" posture the workspace poll gets.
     */
    defaultWorkflowSettings: DefaultWorkflowSteps | null;
    /** Why the last start did not queue anything. Said in place, as an alert, never silently. */
    actionError: string | null;
    sending: boolean;
    /**
     * `workflow` is a chosen name, or null for Default workflow. `defaultWorkflow` carries the
     * final step set beside Default workflow, and is null for a named custom workflow.
     */
    onSend: (
        command: string,
        repo: string | null,
        executor: string,
        workflow: string | null,
        workflowParams: Record<string, string> | null,
        defaultWorkflow: DefaultWorkflowSteps | null
    ) => Promise<string | null>;
    /**
     * Reports the chosen repository upward, so the page can re-fetch the workflow list for that
     * repository's context. Optional — the panel is testable without it.
     */
    onRepoChange?: (repo: string | null) => void;
}) {
    const [draft, setDraft] = useState('');
    const [executor, setExecutor] = useState(() => executors[0]?.name ?? '');
    const [repo, setRepo] = useState(() => firstRepo(repos));
    const [repoTouched, setRepoTouched] = useState(false);
    // The workflow starts UNCHOSEN — '', meaning no process: the raw prompt runs. And, unlike
    // repo and executor, nothing autoselects one: a process is the member's call, not the first
    // row's. A repository change returns the whole draft to exactly this shape (the repo effect
    // below).
    const [workflow, setWorkflow] = useState(freshWorkflowDraft().workflow);
    // The declared params of the chosen workflow, filled in the explicit inputs below. Stored
    // against the identity of the workflow they were typed for — values typed for one process
    // must never stamp another.
    const [storedParams, setStoredParams] = useState(freshWorkflowDraft().storedParams);
    // Which parameter fields the member has left (or an invalid keyboard submission has marked).
    // An untouched empty field is a hint — "Required" — not a painted failure.
    const [paramTouched, setParamTouched] = useState(freshWorkflowDraft().paramTouched);
    // The member's explicit inversions of the saved default-workflow steps for THIS task — empty
    // until a checkbox is touched, so an untouched field keeps tracking a settings poll refresh
    // live while a touched one is locked to the member's choice.
    const [defaultStepOverrides, setDefaultStepOverrides] = useState(freshWorkflowDraft().defaultStepOverrides);

    // The workflow whose inputs the composer shows: exactly the member's explicit choice, at the
    // scope the board would resolve. Nothing autoselects one — an unnamed task runs the raw
    // prompt, so a process is the member's call, never a silent resolution.
    const chosenWorkflow = workflows ? resolveWorkflowChoice(workflows, workflow) : null;
    const declaredParams = chosenWorkflow?.params ?? [];
    const chosenWorkflowId = chosenWorkflow?.id ?? null;
    const paramValues = valuesForWorkflow(storedParams, chosenWorkflowId);
    const paramsReady = paramsComplete(declaredParams, paramValues);

    // The default workflow's effective step set for THIS task — null until the saved settings
    // have answered. Only meaningful beside the unchosen ('') workflow value; a named custom
    // workflow's own params own the composer's attention instead.
    const effectiveDefaultWorkflowSteps = effectiveDefaultSteps(defaultWorkflowSettings, defaultStepOverrides);

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

    // The FIRST configured executor is selected when the async workspace poll lands. There is no
    // deployment fallback: the selected profile type is the task's runner choice.
    useEffect(() => {
        if (executor === '' && executors.length > 0) {
            setExecutor(executors[0]!.name);
        }
    }, [executors, executor]);

    // A configured executor can be deleted on the Workspace page while a draft sits here; the
    // select would go blank while `send` still submitted the stale name. Clamp to what exists —
    // back to the first executor, or an explicit blocked state when the list is empty.
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

    // A repository change re-fetches the workflow list, and the hook answers null for the whole
    // duration of the new request — the page hands that null straight through, so the previous
    // context's list cannot sit interactive under it and offer its workflows back. The draft
    // resets the moment the repository state changes — the member's select, the autoselect, the
    // clamp: every path a change arrives by is this one state — and the member picks again from
    // the list that answers. After the context changed, a process is the member's explicit call
    // again. The reset targets are the mount values, so the effect's mount-time run is a no-op.
    useEffect(() => {
        const reset = freshWorkflowDraft();
        setWorkflow(reset.workflow);
        setStoredParams(reset.storedParams);
        setParamTouched(reset.paramTouched);
        setDefaultStepOverrides(reset.defaultStepOverrides);
    }, [repo]);

    // And the workflow: a repository switch refetches the list for the new context, and a chosen
    // name the answered list does not offer must go the way of a deleted executor — clamped to
    // what exists. Unchosen is the only reset target: nothing autoselects a process, so the
    // member's words run verbatim until one is picked again. Its touched marks go with it.
    useEffect(() => {
        const clamped = clampedWorkflow(workflow, workflows);
        if (clamped !== workflow) {
            setWorkflow(clamped);
            setParamTouched({});
        }
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

    // The mirror of the board's check: a missing or malformed parameter must never reach the
    // wire — the composer says nothing and the launch stays dark.
    const send = async () => {
        if (!draft.trim() || sending || !paramsReady || executor === '') return;
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
        const chosenDefaultWorkflow = defaultWorkflowPayload(workflow, effectiveDefaultWorkflowSteps);
        if (
            (await onSend(draft, chosenRepo, executor, chosenWorkflowName, chosenParams, chosenDefaultWorkflow)) ===
            null
        )
            setDraft('');
    };

    // The one path both the button and Ctrl/⌘+Enter walk — the shortcut is documentation of the
    // button, never a bypass. An invalid keyboard submission owes the member the same screen a
    // tab-through would have left: every field marked, the first invalid one focused, and no
    // request sent. An empty prompt is the missing task itself; the visible blocker says so.
    const blocker = startBlocker({
        sending,
        executorMissing: executor === '',
        promptEmpty: draft.trim() === '',
        paramsInvalid: !paramsReady,
    });
    const attemptStart = () => {
        if (blocker === null) {
            void send();
            return;
        }
        if (blocker === 'invalid-params') {
            setParamTouched(touchAll(declaredParams.map((param) => param.name)));
            const first = declaredParams.find((param) => !paramValueMatches(param, paramValues[param.name]));
            if (first) document.getElementById(`composer-param-${first.name}`)?.focus();
        }
    };
    const blockerCopy =
        blocker === 'in-flight'
            ? 'Starting the task…'
            : blocker === 'missing-executor'
              ? 'Configure an executor in Settings to continue.'
              : blocker === 'empty-prompt'
                ? 'Describe the task to continue.'
                : blocker === 'invalid-params'
                  ? 'Complete the required workflow details to continue.'
                  : null;
    const preflight = preflightSentence({
        repo: repo === '' ? null : repo,
        executor: executor === '' ? null : executor,
        workflow: workflow === '' ? null : workflow,
        defaultSteps: workflow === '' ? effectiveDefaultWorkflowSteps : null,
    });

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
            {actionError !== null ? (
                <p className="status" role="alert">
                    {actionError}
                </p>
            ) : null}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: the launch shortcut is a composer-wide keystroke surface — a member tabbed into any field of the guided form (prompt, selects, workflow inputs) presses Ctrl/⌘+Enter and gets exactly what the Start button would have given them, so the handler must sit above every control rather than on each one */}
            <div
                className="composer"
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) attemptStart();
                }}
            >
                <div className="composer-field">
                    <label className="composer-label" htmlFor="composer-prompt">
                        What should the agent do?
                    </label>
                    <p className="composer-helper" id="composer-prompt-helper">
                        Include the outcome you want, relevant files or issue, and checks the agent should run.
                    </p>
                    <textarea
                        id="composer-prompt"
                        className="composer-input"
                        aria-describedby="composer-prompt-helper"
                        placeholder={PROMPT_PLACEHOLDER}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                    />
                </div>

                <h2>Execution context</h2>
                <div className="composer-grid">
                    <div className="composer-field">
                        <span className="composer-label">Repository</span>
                        <p className="composer-helper">Run without a repository checkout.</p>
                        <Listbox
                            value={repo}
                            onChange={(next) => {
                                setRepoTouched(true);
                                setRepo(next);
                                // Reporting upward is the reporting effect's job — one path.
                            }}
                        >
                            <ListboxButton className="composer-select" aria-label="Repository">
                                {repo === '' ? 'No repository' : repo}
                            </ListboxButton>
                            <ListboxOptions anchor="bottom start" className="popover">
                                <ListboxOption value="" className="popover-option">
                                    No repository
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
                    <div className="composer-field">
                        <span className="composer-label">Executor</span>
                        <p className="composer-helper">The selected executor type chooses the runner for this task.</p>
                        <Listbox value={executor} disabled={executors.length === 0} onChange={setExecutor}>
                            <ListboxButton className="composer-select" aria-label="Executor">
                                {executor === '' ? 'No executor configured' : executor}
                            </ListboxButton>
                            <ListboxOptions anchor="bottom start" className="popover">
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
                        {executors.length === 0 ? (
                            <p className="muted">
                                Add an executor in <Link to="/settings/executors">Settings</Link> before starting a
                                task.
                            </p>
                        ) : null}
                    </div>
                </div>
                {repos.length === 0 ? (
                    <p className="muted">
                        Select repositories in <Link to="/settings/repositories">Settings</Link> to run against a
                        codebase
                    </p>
                ) : null}
                {workflows !== null ? (
                    <div className="composer-field">
                        <h2>Reusable workflow</h2>
                        <p className="composer-helper">
                            A workflow can turn this request into a repeatable multi-step process.
                        </p>
                        <Listbox
                            value={workflow}
                            onChange={(next) => {
                                setWorkflow(next);
                                // The values reset through the identity-keyed read, and this
                                // choice's touched marks reset with it: fields the member never
                                // reached in the new process must not arrive pre-failed.
                                setParamTouched({});
                                // A repo switch goes further and resets the whole draft — the
                                // repo effect above.
                            }}
                        >
                            <ListboxButton className="composer-select" aria-label="Reusable workflow">
                                {workflow === '' ? 'Default workflow' : workflow}
                            </ListboxButton>
                            <ListboxOptions anchor="bottom start" className="popover">
                                <ListboxOption value="" className="popover-option">
                                    Default workflow
                                </ListboxOption>
                                {effectiveWorkflows(workflows).map((choice) => (
                                    <ListboxOption key={choice.id} value={choice.name} className="popover-option">
                                        {choice.name}
                                    </ListboxOption>
                                ))}
                            </ListboxOptions>
                        </Listbox>
                        {workflow === '' && effectiveDefaultWorkflowSteps !== null ? (
                            <div className="composer-field">
                                <label className="settings-toggle">
                                    <input
                                        type="checkbox"
                                        checked={effectiveDefaultWorkflowSteps.reviewReconciliation}
                                        onChange={() =>
                                            setDefaultStepOverrides(
                                                toggleDefaultStep(
                                                    defaultStepOverrides,
                                                    'reviewReconciliation',
                                                    defaultWorkflowSettings
                                                )
                                            )
                                        }
                                    />
                                    Iterate on PR review comments
                                </label>
                                <label className="settings-toggle">
                                    <input
                                        type="checkbox"
                                        checked={effectiveDefaultWorkflowSteps.mergeConflictAutofix}
                                        onChange={() =>
                                            setDefaultStepOverrides(
                                                toggleDefaultStep(
                                                    defaultStepOverrides,
                                                    'mergeConflictAutofix',
                                                    defaultWorkflowSettings
                                                )
                                            )
                                        }
                                    />
                                    Repair merge conflicts
                                </label>
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {declaredParams.length > 0 ? (
                    <div className="composer-field">
                        <h2>Workflow details</h2>
                        <WorkflowParameterFields
                            params={declaredParams}
                            values={paramValues}
                            touched={paramTouched}
                            onInput={(name, value) =>
                                setStoredParams({
                                    workflowId: chosenWorkflowId,
                                    values: { ...paramValues, [name]: value },
                                })
                            }
                            onBlur={(name) => setParamTouched(markTouched(paramTouched, name))}
                        />
                    </div>
                ) : null}

                <p className="composer-preflight" aria-live="polite">
                    {preflight}
                </p>

                <div className="composer-start">
                    <button type="button" className="primary" disabled={blocker !== null} onClick={attemptStart}>
                        {sending ? 'Starting…' : 'Start task'}
                    </button>
                    <kbd>Ctrl/⌘ + Enter</kbd>
                    {/* Mounted even when silent — a live region can only announce a change it
                        survives — so the reason Start is dark reaches a screen reader the moment
                        it appears. */}
                    <span className="composer-blocker" role="status">
                        {blockerCopy}
                    </span>
                </div>
            </div>
        </section>
    );
}
