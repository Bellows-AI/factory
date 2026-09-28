import { useCallback, useEffect, useState } from 'react';
import type { DefaultWorkflowSteps } from './api/useDefaultWorkflowSettings.js';
import type { QueueTaskInput } from './api/useTasks.js';
import type { ComposerDraftInput, ComposerDraftStore } from './composer-draft.js';
import {
    type WorkflowParamChoice,
    clampedWorkflow,
    commandTooLong,
    defaultWorkflowPayload,
    draftIsFresh,
    effectiveDefaultSteps,
    firstRepo,
    freshWorkflowDraft,
    initialComposerState,
    paramsComplete,
    queueBody,
    resolveWorkflowChoice,
    restoredDraftNotices,
    toggleDefaultStep,
    valuesForWorkflow,
} from './task-composer.js';
import { defaultExecutorName } from './workspace/executors.js';

/** One workflow choice as the composer's props hand it in — the shape `TaskComposer`'s
 * `workflows` prop carries, named so the draft can declare it without repeating it. */
export interface ComposerWorkflowOption {
    id: string;
    name: string;
    scope: 'org' | 'user' | 'repo';
    params?: WorkflowParamChoice[];
}

type Repos = readonly { owner: string; name: string }[] | null;
type Executors = readonly { name: string; type: string; isDefault?: boolean }[];
type Workflows = readonly ComposerWorkflowOption[] | null;
type Update = (patch: Partial<ComposerDraftInput>) => void;

/**
 * Everything the composer's draft owns: the state, the effects that keep it consistent with the
 * workspace and workflow lists as they arrive, and the values Start needs — kept out of
 * `TaskComposer` so the component itself stays a render layer over this.
 */
export interface ComposerDraft {
    /** The member's input, the same shape the shell's store holds. */
    state: ComposerDraftInput;
    update: Update;
    declaredParams: WorkflowParamChoice[];
    chosenWorkflowId: string | null;
    paramValues: Record<string, string>;
    paramsReady: boolean;
    /** A workflow is chosen — a restored draft can hold one — but its list has not answered, so
     * what it declares is not known yet and `paramsReady` would pass vacuously. */
    workflowPending: boolean;
    /** The default workflow's effective step set for THIS task — null until the saved settings
     * have answered. Only meaningful beside the unchosen ('') workflow value. */
    effectiveDefaultSteps: DefaultWorkflowSteps | null;
    /** One checkbox click: flips its effective value into an explicit override for this task. */
    onToggleDefaultStep: (key: keyof DefaultWorkflowSteps) => void;
    /** Whether this composer holds nothing a fresh one would not — Discard is offered otherwise. */
    fresh: boolean;
    /** Back to the fresh composer, and the held draft with it. */
    discard: () => void;
    /** What a restored draft lost while the member was away; empty until there is something to say. */
    notices: string[];
    dismissNotices: () => void;
    send: () => Promise<void>;
}

/**
 * The effects that keep the draft honest against the lists as they arrive — every one of them
 * authoritative over a restored draft too: a newly created executor is selected, a deleted one
 * clamped, a deselected repository clamped, a workflow the context no longer offers unchosen.
 */
function useListClamps(
    state: ComposerDraftInput,
    update: Update,
    lists: { repos: Repos; executors: Executors; workflows: Workflows }
) {
    const { repos, executors, workflows } = lists;
    const { repo, repoTouched, executor, workflow, workflowRepo } = state;

    // The FIRST selected repository is the default — the executor precedent: a member who picked
    // repositories means their tasks to be stamped with one, not with nothing. Explicit `none`
    // wins the moment they pick it — `repoTouched` is what stops this autoselect from stomping
    // their choice back on the next workspace poll. The initializer covers the mount that
    // already knows the list (and the offline suite, which runs no effects); this covers the poll
    // that fills the list in afterwards.
    useEffect(() => {
        if (!repoTouched && repo === '' && repos !== null && repos.length > 0) update({ repo: firstRepo(repos) });
    }, [repos, repo, repoTouched, update]);

    // The persisted default executor (issue 215), or the FIRST configured one when none is
    // flagged, is selected when the async workspace poll lands. There is no deployment fallback:
    // the selected profile type is the task's runner choice.
    useEffect(() => {
        if (executor === '' && executors.length > 0) update({ executor: defaultExecutorName(executors) });
    }, [executors, executor, update]);

    // A configured executor can be deleted in Settings while a draft sits here; the select would
    // go blank while `send` still submitted the stale name. Clamp to what exists — back to the
    // default (or first) executor, or an explicit blocked state when the list is empty. Only
    // against an ANSWERED list: the executors ride the same workspace poll as the repositories,
    // and the empty list the page hands in while that poll is pending would clamp a restored
    // executor away before its list could name it.
    useEffect(() => {
        if (repos !== null && executor !== '' && !executors.some((candidate) => candidate.name === executor)) {
            update({ executor: defaultExecutorName(executors) });
        }
    }, [repos, executors, executor, update]);

    // Same for the repository: a deselection must not survive invisibly in the draft and stamp a
    // task with a repository the member no longer works in. Clamp to what exists — the first
    // repository, or none when the list is empty.
    useEffect(() => {
        if (repos !== null && repo !== '' && !repos.some(({ owner, name }) => `${owner}/${name}` === repo)) {
            update({ repo: firstRepo(repos) });
        }
    }, [repos, repo, update]);

    // A repository change re-fetches the workflow list, and the hook answers null for the whole
    // duration of the new request — the page hands that null straight through, so the previous
    // context's list cannot sit interactive under it and offer its workflows back. The draft
    // resets the moment the repository state leaves the one the workflow was chosen under — the
    // member's select, the autoselect, the clamp: every path a change arrives by is this one
    // state — and the member picks again from the list that answers. After the context changed,
    // a process is the member's explicit call again. The mount starts `workflowRepo` equal to
    // `repo`, a restored draft included, so the mount-time run resets nothing: a workflow, its
    // values and its step overrides chosen before a trip to Settings survive the return.
    useEffect(() => {
        if (repo !== workflowRepo) update({ ...freshWorkflowDraft(), workflowRepo: repo });
    }, [repo, workflowRepo, update]);

    // And the workflow: a repository switch refetches the list for the new context, and a chosen
    // name the answered list does not offer must go the way of a deleted executor — clamped to
    // what exists. Unchosen is the only reset target: nothing autoselects a process, so the
    // member's words run verbatim until one is picked again. Its touched marks go with it.
    useEffect(() => {
        const clamped = clampedWorkflow(workflow, workflows);
        if (clamped !== workflow) update({ workflow: clamped, paramTouched: {} });
    }, [workflows, workflow, update]);
}

/**
 * The workflow list's repo context must track the composer's repo WHEREVER the composer sets it —
 * the mount initializer, the autoselect, the clamp, or the member's own hand — or the page fetches
 * the list for a different context than the launched task resolves against, and repo-scoped
 * workflows (and their parameters) go invisible exactly when they would apply. `reported` starts
 * at null, the "nothing reported yet" sentinel: the mount-time repo is reported exactly once by
 * this effect, and every later change by the guard after it. This is the ONE reporting path; the
 * select's onChange only updates local state.
 */
function useRepoReport(repo: string, onRepoChange: ((repo: string | null) => void) | undefined) {
    const [reported, setReported] = useState<string | null>(null);
    useEffect(() => {
        const value = repo === '' ? null : repo;
        if (value !== reported) {
            setReported(value);
            onRepoChange?.(value);
        }
    }, [repo, reported, onRepoChange]);
}

/**
 * A restored draft is judged once, against the first answered lists: what it chose that no longer
 * exists is said in words. The clamps do the reselecting; this never touches the request text.
 */
function useRestoredNotices(
    restored: ComposerDraftInput | null,
    lists: { repos: Repos; executors: Executors; workflows: Workflows }
): { notices: string[]; dismiss: () => void } {
    const { repos, executors, workflows } = lists;
    // Null until the lists it is judged against have answered, then said once.
    const [notices, setNotices] = useState<string[] | null>(restored === null ? [] : null);
    useEffect(() => {
        if (restored === null || notices !== null || repos === null) return;
        const said = restoredDraftNotices(restored, { repos, executors, workflows });
        if (said !== null) setNotices(said);
    }, [restored, notices, repos, executors, workflows]);
    return { notices: notices ?? [], dismiss: () => setNotices([]) };
}

/** The `POST /api/jobs` body for the draft as it stands. */
function queuedTask(
    state: ComposerDraftInput,
    declaredParams: readonly WorkflowParamChoice[],
    paramValues: Record<string, string>,
    effectiveSteps: DefaultWorkflowSteps | null
): QueueTaskInput {
    // Values travel trimmed, and only beside an explicit choice — a task with no workflow carries
    // no parameters at all.
    const chosenParams =
        declaredParams.length > 0
            ? Object.fromEntries(declaredParams.map((param) => [param.name, (paramValues[param.name] ?? '').trim()]))
            : null;
    return queueBody(
        {
            command: state.draft,
            repo: state.repo === '' ? null : state.repo,
            executor: state.executor,
            workflow: state.workflow === '' ? null : state.workflow,
            workflowParams: chosenParams,
        },
        defaultWorkflowPayload(state.workflow, effectiveSteps)
    );
}

export function useComposerDraft(input: {
    repos: Repos;
    executors: Executors;
    workflows: Workflows;
    /**
     * The member's saved default-workflow step settings (issues 203/208), or null while they have
     * not answered yet — the two optional-step checkboxes stay hidden for exactly that duration,
     * the same "not known yet" posture the workspace poll gets.
     */
    defaultWorkflowSettings: DefaultWorkflowSteps | null;
    onRepoChange: ((repo: string | null) => void) | undefined;
    sending: boolean;
    onSend: (queued: QueueTaskInput) => Promise<string | null>;
    /** The shell's held draft (F1): read once at mount, then kept in step with the state. */
    draftStore: ComposerDraftStore;
}): ComposerDraft {
    const { repos, executors, workflows, defaultWorkflowSettings, onRepoChange, sending, onSend, draftStore } = input;
    const { save, clear } = draftStore;
    // The draft held for this member when the composer mounted — a return from Settings — read
    // exactly once: the state starts from it, and the store follows the state after that.
    const [restored] = useState<ComposerDraftInput | null>(() => {
        if (draftStore.state === null) return null;
        const { owner: _owner, ...held } = draftStore.state;
        return held;
    });
    // One state for the whole draft. The workflow starts UNCHOSEN — '', meaning no process: the
    // raw prompt runs — and nothing autoselects one. `storedParams` holds the declared params'
    // values against the identity of the workflow they were typed for, so values typed for one
    // process never stamp another; `paramTouched` says which fields the member has left, so an
    // untouched empty field is a hint, not a painted failure; `defaultStepOverrides` holds the
    // member's explicit inversions of the saved default-workflow steps for THIS task, so an
    // untouched checkbox keeps tracking a settings refresh live.
    const [state, setState] = useState(() => initialComposerState(restored, { repos, executors }));
    const update = useCallback<Update>((patch) => setState((held) => ({ ...held, ...patch })), []);

    // The workflow whose inputs the composer shows: exactly the member's explicit choice, at the
    // scope the board would resolve. Nothing autoselects one — an unnamed task runs the raw
    // prompt, so a process is the member's call, never a silent resolution.
    const chosenWorkflow = workflows ? resolveWorkflowChoice(workflows, state.workflow) : null;
    const declaredParams = chosenWorkflow?.params ?? [];
    const chosenWorkflowId = chosenWorkflow?.id ?? null;
    const paramValues = valuesForWorkflow(state.storedParams, chosenWorkflowId);
    const paramsReady = paramsComplete(declaredParams, paramValues);
    const workflowPending = state.workflow !== '' && workflows === null;
    const effectiveSteps = effectiveDefaultSteps(defaultWorkflowSettings, state.defaultStepOverrides);

    useListClamps(state, update, { repos, executors, workflows });
    useRepoReport(state.repo, onRepoChange);
    const { notices, dismiss } = useRestoredNotices(restored, { repos, executors, workflows });

    // The store follows the draft, so a trip to Settings and back finds it as it was left. A
    // composer holding nothing a fresh one would not holds no draft at all — which is also what
    // clears the store after a launch or a discard. `fresh` is a boolean on purpose: the page
    // hands in new list arrays on every render, and a dependency on them would save forever.
    const fresh = draftIsFresh(state, { repos, executors });
    useEffect(() => {
        if (fresh) clear();
        else save(state);
    }, [fresh, state, save, clear]);

    /** Back to exactly what a fresh mount would show; the sync above then holds no draft. */
    const discard = () => {
        setState(initialComposerState(null, { repos, executors }));
        clear();
    };

    // The mirror of the board's check: a missing or malformed parameter must never reach the
    // wire — the composer says nothing and the launch stays dark.
    const send = async () => {
        const { draft, executor } = state;
        if (!draft.trim() || commandTooLong(draft) || sending || workflowPending || !paramsReady || executor === '') {
            return;
        }
        // A launched task is no longer a draft; a refusal keeps every field for the retry.
        if ((await onSend(queuedTask(state, declaredParams, paramValues, effectiveSteps))) === null) discard();
    };

    return {
        state,
        update,
        declaredParams,
        chosenWorkflowId,
        paramValues,
        paramsReady,
        workflowPending,
        effectiveDefaultSteps: effectiveSteps,
        onToggleDefaultStep: (key) =>
            update({
                defaultStepOverrides: toggleDefaultStep(state.defaultStepOverrides, key, defaultWorkflowSettings),
            }),
        fresh,
        discard,
        notices,
        dismissNotices: dismiss,
        send,
    };
}
