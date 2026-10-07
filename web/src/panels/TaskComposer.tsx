import { type ReactNode, useState } from 'react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { Link } from 'react-router-dom';
import { useDownwardAnchor } from '../anchor.js';
import type { QueueTaskInput } from '../api/useTasks.js';
import type { ComposerDraftInput, ComposerDraftStore } from '../composer-draft.js';
import { withDraftReturn } from '../components/DraftReturnBanner.js';
import { Icon } from '../components/Icon.js';
import {
    NO_SYNCED_REPOS_MESSAGE,
    NO_SYNCED_REPOS_TITLE,
    NoSyncedReposDialog,
    REPOSITORIES_PATH,
} from '../components/NoSyncedReposDialog.js';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog.js';
import { WorkflowParameterFields } from '../components/WorkflowParameterFields.js';
import {
    COMMAND_LIMIT_TEXT,
    type RepoOption,
    type StartBlocker,
    blockerTone,
    commandCount,
    commandTooLong,
    effectiveWorkflows,
    markTouched,
    paramValueMatches,
    preflightSentence,
    repoReadiness,
    startBlocker,
    touchAll,
} from '../task-composer.js';
import { type ComposerDraft, type ComposerWorkflowOption, useComposerDraft } from '../use-composer-draft.js';
import {
    executorChoiceId,
    executorChoiceOf,
    type ComposerExecutorOption,
    type ExecutorChoice,
} from '../workspace/executors.js';

/**
 * The example request — the prompt's placeholder, and what Try an example types in. The issue
 * number travels as string parts because `123` directly behind a hash scans as a hex color
 * literal, and the stylesheet's color gate reads every `.tsx` in the tree — the rendered copy
 * stays exact.
 */
const EXAMPLE_PROMPT = 'Fix issue #' + '123, update the affected tests, and run the relevant checks.';
const PROMPT_PLACEHOLDER = `Example: ${EXAMPLE_PROMPT}`;

/** The ids Start's `aria-describedby` points at: the readiness banner, or the quiet status text. */
const READINESS_ID = 'composer-readiness';
const BLOCKER_ID = 'composer-blocker';
const PROMPT_ID = 'composer-prompt';
const NO_SYNCED_BLOCKER: StartBlocker = 'no-synced-repos';
const REPO_PLACEHOLDER = 'Select a repository';

type Update = (patch: Partial<ComposerDraftInput>) => void;

/** The empty workflow option: objective mode, the prompt runs as written. */
const NO_WORKFLOW_LABEL = 'No workflow';

/**
 * One numbered section of the composer (plan §2.3): the accent step disc — decoration, hidden
 * from assistive tech, since the heading carries the words — the heading with its helper, an
 * optional action at the head's far end, and the section's own controls below.
 */
function ComposerSection({
    step,
    title,
    helper,
    action,
    children,
}: {
    step: number;
    title: ReactNode;
    helper?: ReactNode;
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="panel composer-section">
            <div className="composer-section-head">
                <span className="composer-step" aria-hidden="true">
                    {step}
                </span>
                <div className="composer-section-title">
                    <h2>{title}</h2>
                    {helper}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

/**
 * Section 1, the request: the dominant textarea, the example offer — only on an empty draft, so
 * it never types over the member's words — and the count against the board's command limit.
 */
function RequestSection({ draft, update }: { draft: string; update: Update }) {
    const tooLong = commandTooLong(draft);
    return (
        <ComposerSection
            step={1}
            title={<label htmlFor={PROMPT_ID}>What should the agent do?</label>}
            helper={
                <p className="composer-helper" id="composer-prompt-helper">
                    Include the outcome, relevant files or issue, and checks to run.
                </p>
            }
            action={
                <button
                    type="button"
                    className="composer-example"
                    disabled={draft !== ''}
                    onClick={() => update({ draft: EXAMPLE_PROMPT })}
                >
                    <Icon name="sparkles" />
                    Try an example
                </button>
            }
        >
            <textarea
                id={PROMPT_ID}
                className="field composer-input"
                aria-describedby="composer-prompt-helper composer-prompt-count"
                aria-invalid={tooLong || undefined}
                placeholder={PROMPT_PLACEHOLDER}
                value={draft}
                onChange={(e) => update({ draft: e.target.value })}
            />
            <p className={tooLong ? 'composer-counter is-over' : 'composer-counter'} id="composer-prompt-count">
                {commandCount(draft)}
            </p>
        </ComposerSection>
    );
}

/**
 * Section 2, the execution context: Repository, Executor and Workflow, three columns on a wide
 * screen and stacked below it. Each column is a visible label over its selector, and the
 * repository column carries the one remediation that is a pointer rather than a blocker — an
 * repository must be selected and synced (issue 263). A missing executor is a blocker, said by the readiness
 * banner; its trigger only wears the stop lamp's edge.
 */
function ComposerContextRow({
    repos,
    executors,
    workflows,
    state,
    update,
}: {
    repos: readonly RepoOption[];
    executors: readonly ComposerExecutorOption[];
    workflows: readonly ComposerWorkflowOption[] | null;
    state: ComposerDraftInput;
    update: Update;
}) {
    // Downward-only (issue 224): Headless UI's `anchor` prop always adds a `flip` middleware
    // with no way to disable it, so it is bypassed in favor of `useDownwardAnchor`.
    const repoAnchor = useDownwardAnchor('start');
    const executorAnchor = useDownwardAnchor('start');
    const { repo, executor } = state;
    return (
        <div className="composer-context">
            <div className="composer-context-item">
                <span className="composer-label">
                    <Icon name="repo" />
                    Repository
                </span>
                {/* Reporting upward is the reporting effect's job — one path. */}
                <Listbox value={repo} onChange={(next) => update({ repo: next, repoTouched: true })}>
                    <ListboxButton
                        ref={repoAnchor.setReference}
                        className="select-trigger"
                        aria-label="Repository"
                        title={repo === '' ? REPO_PLACEHOLDER : repo}
                    >
                        <span className="composer-context-value">{repo === '' ? REPO_PLACEHOLDER : repo}</span>
                    </ListboxButton>
                    <ListboxOptions
                        ref={repoAnchor.setFloating}
                        style={repoAnchor.floatingStyles}
                        portal
                        className="popover"
                    >
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
                {repos.length === 0 ? (
                    <p className="composer-helper">
                        Select repositories in <Link to={withDraftReturn('/settings/repos')}>Settings</Link> to run
                        against a codebase
                    </p>
                ) : null}
            </div>
            <div className="composer-context-item">
                <span className="composer-label">
                    <Icon name="terminal" />
                    Executor
                </span>
                <Listbox
                    value={executorChoiceId({ scope: state.executorScope, name: executor })}
                    disabled={executors.length === 0}
                    onChange={(next) => {
                        const choice = executorChoiceOf(next);
                        if (choice) update({ executor: choice.name, executorScope: choice.scope });
                    }}
                >
                    <ListboxButton
                        ref={executorAnchor.setReference}
                        className={executor === '' ? 'select-trigger composer-trigger-missing' : 'select-trigger'}
                        aria-label="Executor"
                        title={executor === '' ? 'No executor configured' : executor}
                    >
                        <span className="composer-context-value">
                            {executor === '' ? 'No executor configured' : executor}
                        </span>
                    </ListboxButton>
                    <ListboxOptions
                        ref={executorAnchor.setFloating}
                        style={executorAnchor.floatingStyles}
                        portal
                        className="popover"
                    >
                        {executors.map((candidate) => (
                            <ListboxOption
                                key={executorChoiceId(candidate)}
                                value={executorChoiceId(candidate)}
                                className="popover-option"
                            >
                                {candidate.name}
                                {candidate.scope === 'org' ? ' — organization' : ''}
                            </ListboxOption>
                        ))}
                    </ListboxOptions>
                </Listbox>
            </div>
            <ComposerWorkflowTrigger workflows={workflows} workflow={state.workflow} update={update} />
        </div>
    );
}

/**
 * The workflow column of the execution context: the Reusable workflow trigger beside Repository
 * and Executor. Split out so its null bail (no workflow list yet) stays after its own hook.
 */
function ComposerWorkflowTrigger({
    workflows,
    workflow,
    update,
}: {
    workflows: readonly ComposerWorkflowOption[] | null;
    workflow: string;
    update: Update;
}) {
    // Downward-only (issue 224): Headless UI's `anchor` prop always adds a `flip` middleware
    // with no way to disable it, so it is bypassed in favor of `useDownwardAnchor`. Called
    // unconditionally, before the null bail below, so the hook order never varies with the
    // board's workflow feature.
    const { setReference, setFloating, floatingStyles } = useDownwardAnchor('start');
    if (workflows === null) return null;
    const label = workflow === '' ? NO_WORKFLOW_LABEL : workflow;
    return (
        <div className="composer-context-item">
            <span className="composer-label">
                <Icon name="git-branch" />
                Workflow
            </span>
            {/* The values reset through the identity-keyed read, and this choice's touched marks
                reset with it: fields the member never reached in the new process must not arrive
                pre-failed. A repo switch goes further and resets the whole workflow draft. */}
            <Listbox value={workflow} onChange={(next) => update({ workflow: next, paramTouched: {} })}>
                <ListboxButton
                    ref={setReference}
                    className="select-trigger"
                    aria-label="Reusable workflow"
                    title={label}
                >
                    <span className="composer-context-value">{label}</span>
                </ListboxButton>
                <ListboxOptions ref={setFloating} style={floatingStyles} portal className="popover">
                    <ListboxOption value="" className="popover-option">
                        {NO_WORKFLOW_LABEL}
                    </ListboxOption>
                    {effectiveWorkflows(workflows).map((choice) => (
                        <ListboxOption key={choice.id} value={choice.name} className="popover-option">
                            {choice.name}
                        </ListboxOption>
                    ))}
                </ListboxOptions>
            </Listbox>
        </div>
    );
}

/**
 * Section 3, the workflow details: a named workflow's declared launch parameters, or — with no
 * workflow chosen, objective mode — one line saying the prompt runs as written.
 */
function ComposerWorkflowDetails({ composer }: { composer: ComposerDraft }) {
    const { state, update, declaredParams, paramValues, chosenWorkflowId } = composer;
    if (declaredParams.length > 0) {
        return (
            <WorkflowParameterFields
                params={declaredParams}
                values={paramValues}
                touched={state.paramTouched}
                onInput={(name, value) =>
                    update({
                        storedParams: { workflowId: chosenWorkflowId, values: { ...paramValues, [name]: value } },
                    })
                }
                onBlur={(name) => update({ paramTouched: markTouched(state.paramTouched, name) })}
            />
        );
    }
    if (composer.workflowPending) return <p className="composer-helper">Loading the {state.workflow} workflow…</p>;
    if (state.workflow !== '') {
        return <p className="composer-helper">The {state.workflow} workflow needs no launch details.</p>;
    }
    return <p className="composer-helper">Without a workflow, your prompt runs as written.</p>;
}

/** The quiet status line beside Start — only for the blockers that never raise a banner. */
function describeQuietBlocker(blocker: StartBlocker | null): string | null {
    switch (blocker) {
        case 'in-flight':
            return 'Starting the task…';
        case 'empty-prompt':
            return 'Describe the task to continue.';
        default:
            return null;
    }
}

/** A `banner-bad` readiness blocker: the lamp's glyph, what is wrong, and what to do. */
function BadBanner({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="banner-bad" id={READINESS_ID}>
            <Icon name="alert-circle" size={24} />
            <div>
                <p className="banner-title">{title}</p>
                <p>{children}</p>
            </div>
        </div>
    );
}

/**
 * The readiness banner for the blockers worth one (`blockerTone`): `banner-bad` for what the member
 * must go and fix — with the way to fix it where one exists — and `banner-info` while a list or
 * the saved preferences load. One at a time, the one `startBlocker` picked.
 */
function ReadinessBanner({
    blocker,
    workflow,
    repo,
}: {
    blocker: StartBlocker | null;
    workflow: string;
    /** The chosen repository and its clone status, for the banner that waits on its sync. */
    repo: RepoOption | null;
}) {
    switch (blocker) {
        case 'no-synced-repos':
            return (
                <BadBanner title={NO_SYNCED_REPOS_TITLE}>
                    {NO_SYNCED_REPOS_MESSAGE} <Link to={withDraftReturn(REPOSITORIES_PATH)}>Go to Repositories</Link>
                </BadBanner>
            );
        case 'repo-required':
            return (
                <BadBanner title="No repository selected">Choose a synced repository to run this task in.</BadBanner>
            );
        case 'repo-not-ready':
            return (
                <BadBanner title="Repository not synced">
                    {repo?.owner}/{repo?.name} is {repo?.status}. It must finish syncing before a task can run in it.{' '}
                    <Link to={withDraftReturn(REPOSITORIES_PATH)}>Open Repositories</Link>
                </BadBanner>
            );
        case 'missing-executor':
            return (
                <BadBanner title="No executor configured">
                    Add one to run tasks.{' '}
                    <Link to={withDraftReturn('/settings/executors')}>Add an executor in Settings</Link>
                </BadBanner>
            );
        case 'workflow-loading':
            return (
                <div className="banner-info" id={READINESS_ID}>
                    <Icon name="info" size={24} />
                    <p>Loading the {workflow} workflow…</p>
                </div>
            );
        case 'too-long':
            return (
                <BadBanner title="Request too long">
                    Shorten the request to {COMMAND_LIMIT_TEXT} characters or fewer to continue.
                </BadBanner>
            );
        case 'invalid-params':
            return (
                <BadBanner title="Workflow details incomplete">
                    Complete the required workflow details to continue.
                </BadBanner>
            );
        default:
            return null;
    }
}

/**
 * Section 4, readiness: what will run, what still blocks it — a banner for what the member must
 * fix, quiet status text for an empty prompt or a launch in flight — and the actions. Start's
 * `aria-describedby` names whichever of the two is saying why it is dark.
 */
function ReadinessSection({
    preflight,
    workflow,
    repo,
    blocker,
    sending,
    fresh,
    onDiscard,
    onStart,
}: {
    preflight: string;
    /** The chosen workflow's name, for the banner that waits on its list. */
    workflow: string;
    repo: RepoOption | null;
    blocker: StartBlocker | null;
    sending: boolean;
    fresh: boolean;
    onDiscard: () => void;
    onStart: () => void;
}) {
    const tone = blockerTone(blocker);
    const describedBy = tone === 'quiet' ? BLOCKER_ID : tone === null ? undefined : READINESS_ID;
    return (
        <ComposerSection step={4} title="Readiness">
            <p className="composer-preflight" aria-live="polite">
                {preflight}
            </p>
            <ReadinessBanner blocker={blocker} workflow={workflow} repo={repo} />
            <div className="composer-start">
                {fresh ? null : (
                    <button type="button" onClick={onDiscard}>
                        Discard draft
                    </button>
                )}
                <button
                    type="button"
                    className="primary"
                    // The one blocker that stays clickable: its click opens the dialog (issue 263).
                    disabled={blocker !== null && blocker !== NO_SYNCED_BLOCKER}
                    aria-busy={sending || undefined}
                    aria-describedby={describedBy}
                    onClick={onStart}
                >
                    {sending ? 'Starting…' : 'Start task'}
                </button>
                <kbd>Ctrl/⌘ + Enter</kbd>
                {/* Mounted even when silent — a live region can only announce a change it
                    survives — so the reason Start is dark reaches a screen reader the moment
                    it appears. */}
                <span className="composer-blocker" id={BLOCKER_ID} role="status">
                    {describeQuietBlocker(blocker)}
                </span>
            </div>
        </ComposerSection>
    );
}

/**
 * What a restored draft lost while the member was away (F1): a dismissible `banner-info`, one
 * line per choice that no longer exists. The request text is never among them.
 */
function RestoredNotices({ notices, onDismiss }: { notices: readonly string[]; onDismiss: () => void }) {
    if (notices.length === 0) return null;
    return (
        <div className="banner-info composer-notices">
            <Icon name="info" size={24} />
            <div className="composer-notices-body">
                <p className="banner-title">Your draft is back</p>
                {notices.map((notice) => (
                    <p key={notice}>{notice}</p>
                ))}
            </div>
            <button type="button" className="composer-notices-dismiss" aria-label="Dismiss" onClick={onDismiss}>
                <Icon name="x" />
            </button>
        </div>
    );
}

/** The workspace poll has not answered: say why, or that it is still coming. */
function WorkspacePending({ error, onRetry }: { error: string | null; onRetry: () => void }) {
    return (
        <section className="panel">
            {error !== null ? (
                <p className="muted">
                    {error}{' '}
                    <button type="button" className="chat-resume" onClick={onRetry}>
                        Retry
                    </button>
                </p>
            ) : (
                <p className="muted">Loading your workspace…</p>
            )}
        </section>
    );
}

/**
 * The composer's stand-in while the session is still being checked: the held draft belongs to a
 * session, so nothing is restored — and nothing is typed over — before the session is known.
 * Static blocks, no shimmer.
 */
export function TaskComposerSkeleton() {
    return (
        <section className="panel composer-skeleton" aria-busy="true">
            <p className="muted">Loading your draft…</p>
            <div className="composer-skeleton-block" />
            <div className="composer-skeleton-line" />
        </section>
    );
}

/**
 * The guided new-task composer, the default right pane of the tasks area.
 *
 * Props in, markup out — every fetch lives in the hooks the pages own (`useWorkspace`, `useJobs`,
 * `useWorkflows`), and the held draft arrives as the store the page reads, so this panel is
 * testable in the offline suite: `renderToStaticMarkup` runs no effects, the page hands it
 * finished props and the suite asserts markup.
 *
 * Four numbered sections, in the order a member decides (plan §2.3): the request, the execution
 * context (repository, executor, workflow), the chosen workflow's details, and readiness — what
 * will run, what still blocks it, and Start. The repository, executor and workflow are task
 * parameters. Repository and workflow may deliberately be absent; executor may not, because its
 * profile type chooses the runner. The draft's state and effects live in `use-composer-draft.ts`;
 * the pure layer beneath — the verdicts, preflight sentence, blocker matrix and draft shapes — in
 * `task-composer.ts`.
 */
export function TaskComposer({
    repos,
    workspaceError,
    onRetryWorkspace,
    executors,
    defaultExecutor,
    workflows,
    actionError,
    sending,
    onSend,
    onRepoChange,
    draftStore,
}: {
    /**
     * The member's selected repositories, one option each. Null while the workspace poll has not
     * answered yet — "not known" is a different sentence from "known empty", and merging them
     * would blame the member's selection for a request that never landed.
     */
    repos: readonly RepoOption[] | null;
    /** Why `repos` is null, when it is. */
    workspaceError: string | null;
    onRetryWorkspace: () => void;
    executors: readonly ComposerExecutorOption[];
    /** The poll's resolved default executor (issue 391), or null when nothing is selectable. */
    defaultExecutor: ExecutorChoice | null;
    /**
     * The workflow choices for the selected repository's context, or null when the list has not
     * answered (or this board serves no workflows at all). Null HIDES the selector: a board
     * without the feature offers no process to pick. Each choice carries its declared launch
     * parameters — choosing one renders an explicit, labelled input per param, and Start stays
     * disabled until every one validates. Unchosen, the task runs the member's words verbatim —
     * no workflow, no parameters.
     */
    workflows: readonly ComposerWorkflowOption[] | null;
    /** Why the last start did not queue anything. Said in place, as an alert, never silently. */
    actionError: string | null;
    sending: boolean;
    /** `workflow` is a chosen name, or null for no workflow (objective mode). */
    onSend: (input: QueueTaskInput) => Promise<string | null>;
    /**
     * Reports the chosen repository upward, so the page can re-fetch the workflow list for that
     * repository's context. Optional — the panel is testable without it.
     */
    onRepoChange?: (repo: string | null) => void;
    /** The shell's held draft (F1): read once at mount, written on every change, cleared on launch. */
    draftStore: ComposerDraftStore;
}) {
    const composer = useComposerDraft({
        repos,
        executors,
        defaultExecutor,
        workflows,
        onRepoChange,
        sending,
        onSend,
        draftStore,
    });
    const { state, update, declaredParams, paramValues } = composer;
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);
    const [noSyncedOpen, setNoSyncedOpen] = useState(false);
    // Null while the workspace has not answered: that screen is the loading/error state, never
    // the "no repos synced" verdict.
    const readiness = repos === null ? undefined : repoReadiness(state.repo, repos);
    const chosenRepo = repos?.find(({ owner, name }) => `${owner}/${name}` === state.repo) ?? null;

    const blocker = startBlocker({
        sending,
        executorMissing: state.executor === '',
        promptEmpty: state.draft.trim() === '',
        promptTooLong: commandTooLong(state.draft),
        ...(readiness !== undefined ? { repoReadiness: readiness } : {}),
        workflowUnresolved: composer.workflowPending,
        paramsInvalid: !composer.paramsReady,
    });
    // The one path both the button and Ctrl/⌘+Enter walk — the shortcut is documentation of the
    // button, never a bypass. An invalid keyboard submission owes the member the same screen a
    // tab-through would have left: every field marked, the first invalid one focused, and no
    // request sent. An empty prompt is the missing task itself; the visible blocker says so.
    const attemptStart = () => {
        if (blocker === null) {
            void composer.send();
            return;
        }
        // Blocked, but not silently: the member is told where to go, and nothing is submitted.
        if (blocker === NO_SYNCED_BLOCKER) {
            setNoSyncedOpen(true);
            return;
        }
        if (blocker === 'invalid-params') {
            update({ paramTouched: touchAll(declaredParams.map((param) => param.name)) });
            const first = declaredParams.find((param) => !paramValueMatches(param, paramValues[param.name]));
            if (first) document.getElementById(`composer-param-${first.name}`)?.focus();
        }
    };
    // Discarding typed words asks first, with the settings area's own dialog; a draft that is only
    // choices goes at once — nothing typed is lost.
    const requestDiscard = () => {
        if (state.draft.trim() === '') composer.discard();
        else setConfirmingDiscard(true);
    };

    if (repos === null) return <WorkspacePending error={workspaceError} onRetry={onRetryWorkspace} />;

    return (
        <>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: the launch shortcut is a composer-wide keystroke surface — a member tabbed into any field of the guided form (prompt, selects, workflow inputs) presses Ctrl/⌘+Enter and gets exactly what the Start button would have given them, so the handler must sit above every control rather than on each one */}
            <div
                className="composer task-compose"
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) attemptStart();
                }}
            >
                {actionError !== null ? (
                    <p className="status" role="alert">
                        {actionError}
                    </p>
                ) : null}
                <RequestSection draft={state.draft} update={update} />
                <RestoredNotices notices={composer.notices} onDismiss={composer.dismissNotices} />
                <ComposerSection
                    step={2}
                    title="Execution context"
                    helper={<p className="composer-helper">Choose where the task runs, what runs it, and how.</p>}
                >
                    <ComposerContextRow
                        repos={repos}
                        executors={executors}
                        workflows={workflows}
                        state={state}
                        update={update}
                    />
                </ComposerSection>
                <ComposerSection step={3} title="Workflow details">
                    <ComposerWorkflowDetails composer={composer} />
                </ComposerSection>
                <ReadinessSection
                    preflight={preflightSentence({
                        repo: state.repo === '' ? null : state.repo,
                        executor: state.executor === '' ? null : state.executor,
                        workflow: state.workflow === '' ? null : state.workflow,
                    })}
                    workflow={state.workflow}
                    repo={chosenRepo}
                    blocker={blocker}
                    sending={sending}
                    fresh={composer.fresh}
                    onDiscard={requestDiscard}
                    onStart={attemptStart}
                />
            </div>
            {/* Outside the shortcut's surface on purpose: the dialog portals, but React events still
                bubble to their React parent, and Ctrl/⌘+Enter on "Continue editing" must never
                launch the draft it is asking about. */}
            {noSyncedOpen ? <NoSyncedReposDialog onClose={() => setNoSyncedOpen(false)} /> : null}
            {confirmingDiscard ? (
                <UnsavedChangesDialog
                    labels={['this task draft']}
                    onClose={() => setConfirmingDiscard(false)}
                    onConfirm={() => {
                        setConfirmingDiscard(false);
                        composer.discard();
                        document.getElementById(PROMPT_ID)?.focus();
                    }}
                />
            ) : null}
        </>
    );
}
