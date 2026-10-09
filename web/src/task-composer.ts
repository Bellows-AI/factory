/**
 * The task composer's pure layer: the draft-state shapes, the client mirror of the board's
 * parameter check, and the plain-language derivations the guided composer renders — per-field
 * verdicts, the start-blocker matrix. No React and no fetching: every
 * function here is testable without a DOM, which is what lets the offline suite pin the launch
 * contract the board enforces.
 */
import { COMMAND_LIMIT, USER_SCOPE } from '@factory-ai/core';
import type { ComposerDraftInput } from './composer-draft.js';
import type { CloneStatus } from './api/useWorkspace.js';
import { selectionExists, type ExecutorChoice } from './workspace/executors.js';

/**
 * One declared launch parameter of a workflow, as the list route serves it: the name the prompts
 * reference, the optional regex SOURCE the value must fully match, and — once Slice C 1/4's
 * guidance lands on the board — the author's plain-language description and example. Both are
 * optional because a board without that slice serves neither; the composer renders them only
 * when present and falls back to its own copy otherwise.
 */
export interface WorkflowParamChoice {
    name: string;
    pattern?: string;
    description?: string;
    example?: string;
}

/**
 * `owner/name` of the first selected repository, or `''` for none — the select's value shape.
 */
export function firstRepo(repos: readonly { owner: string; name: string }[] | null): string {
    const first = repos?.[0];
    return first ? `${first.owner}/${first.name}` : '';
}

/**
 * Repo over user over org — the one precedence rule a name matching several visible scopes
 * resolves with, the same tie-break `findByName` walks on the board.
 */
const DEFAULT_PRECEDENCE: Record<'org' | 'user' | 'repo', number> = { repo: 0, user: 1, org: 2 };

/**
 * The workflow the composer shows inputs for: the member's chosen NAME resolved through the
 * answered list with the board's repo-over-user-over-org precedence — never the list's
 * alphabetical accident. Null when the name is unchosen or serves nothing.
 */
export function resolveWorkflowChoice<T extends { name: string; scope: 'org' | 'user' | 'repo' }>(
    workflows: readonly T[],
    name: string
): T | null {
    return (
        workflows
            .filter((choice) => choice.name === name)
            .sort((a, b) => DEFAULT_PRECEDENCE[a.scope] - DEFAULT_PRECEDENCE[b.scope])[0] ?? null
    );
}

/**
 * The workflows the composer offers: one row per effective NAME, at the scope the launch would
 * resolve. A name is unique per scope only, so the visible list can hold the same name at several
 * scopes — and a Listbox row is clickable in a way a native `<option>` duplicate never was. The
 * options therefore collapse to the same repo-over-user-over-org winner `resolveWorkflowChoice`
 * (and the board's `findByName`) resolves with, in the order the list offered the names; picking a
 * row and picking its name can no longer mean two different definitions.
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
 * The value cap the board enforces (workflow-schema.ts `PARAM_VALUE_LIMIT`), mirrored so Start
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

/** Whether every declared param has a valid value — the Start gate. */
export function paramsComplete(params: readonly WorkflowParamChoice[], values: Record<string, string>): boolean {
    return params.every((param) => paramValueMatches(param, values[param.name]));
}

/**
 * `issue_number` → "Issue number". A declaration's name is written for the machine — the prompts
 * reference it as `{{param.NAME}}` — so the field label splits on the separators and reads as a
 * sentence rather than showing the identifier raw.
 */
export function humanizeParamName(name: string): string {
    const words = name
        .split(/[_-]/)
        .filter((word) => word !== '')
        .join(' ');
    return words === '' ? '' : words[0]!.toUpperCase() + words.slice(1);
}

/** What one parameter field has to say, classified. */
export type ParamFieldKind = 'ok' | 'untouched' | 'required' | 'too-long' | 'mismatch' | 'uncompilable';

export interface ParamFieldVerdict {
    kind: ParamFieldKind;
    /**
     * The final on-screen copy; null for `ok` and `untouched` — the untouched field says
     * "Required" through its placeholder instead, because it is a hint, not a failure.
     */
    message: string | null;
}

/**
 * One field's state, checked in the board's order — trim, empty, length, compile, full-match —
 * so the composer's words never contradict its gate. A regex source never reaches a message:
 * the mismatch either reuses the author's own guidance (Slice C 1/4) or points at Format
 * details, the disclosure that holds the raw rule.
 */
export function paramFieldVerdict(
    param: WorkflowParamChoice,
    value: string | undefined,
    touched: boolean
): ParamFieldVerdict {
    const label = humanizeParamName(param.name);
    const trimmed = value?.trim() ?? '';
    if (!trimmed) {
        return touched ? { kind: 'required', message: `${label} is required.` } : { kind: 'untouched', message: null };
    }
    if (trimmed.length > PARAM_VALUE_LIMIT) {
        return { kind: 'too-long', message: `${label} must be 512 characters or fewer.` };
    }
    if (param.pattern !== undefined) {
        let rule: RegExp;
        try {
            rule = new RegExp(`^(?:${param.pattern})$`);
        } catch {
            return {
                kind: 'uncompilable',
                message: "This workflow's format rule could not be checked. Ask an administrator to fix the workflow.",
            };
        }
        if (!rule.test(trimmed)) {
            return {
                kind: 'mismatch',
                message:
                    // Truthy, not merely present: an empty description is no guidance to reuse.
                    param.description ||
                    `${label} does not match the required format. Open Format details for the technical rule.`,
            };
        }
    }
    return { kind: 'ok', message: null };
}

/** A repository option as the composer judges it: its name and its clone status (issue 263). */
export interface RepoOption {
    owner: string;
    name: string;
    status: CloneStatus;
}

/**
 * Whether the draft's repository can run a task: only a selected repository whose checkout is
 * `ready` qualifies. `none-synced` is checked first — no ready repository at all is the modal's
 * case, whatever is chosen — and another ready repository never satisfies the chosen one.
 */
export type RepoReadiness = 'ready' | 'none-synced' | 'unselected' | 'not-ready';

export function repoReadiness(repo: string, repos: readonly RepoOption[]): RepoReadiness {
    if (!repos.some(({ status }) => status === 'ready')) return 'none-synced';
    const chosen = repos.find(({ owner, name }) => `${owner}/${name}` === repo);
    if (!chosen) return 'unselected';
    return chosen.status === 'ready' ? 'ready' : 'not-ready';
}

/** The one reason Start is dark, in precedence order: in flight, executor, prompt, length, repository, workflow list, workflow params. */
export type StartBlocker =
    | 'in-flight'
    | 'missing-executor'
    | 'empty-prompt'
    | 'too-long'
    | 'no-synced-repos'
    | 'repo-required'
    | 'repo-not-ready'
    | 'workflow-loading'
    | 'invalid-params';

/**
 * Why Start cannot start, or null when it can. The order is the message the member needs: an
 * in-flight queue must not be re-entered, a task cannot run without an executor profile, an empty
 * prompt is the missing task itself, a request over the board's command limit is refused before
 * anything about its workflow matters. A named workflow whose list has not answered comes next —
 * a restored draft can hold one, and until the list says what it declares, the params gate would
 * pass vacuously and launch it without its values; a named workflow's own field validation comes
 * last. The unresolved flag defaults to false: it means nothing beside no workflow at all.
 */
export function startBlocker(input: {
    sending: boolean;
    executorMissing: boolean;
    promptEmpty: boolean;
    promptTooLong?: boolean;
    /** Defaults to ready: the verdict means nothing to a caller that has no repository list. */
    repoReadiness?: RepoReadiness;
    workflowUnresolved?: boolean;
    paramsInvalid: boolean;
}): StartBlocker | null {
    if (input.sending) return 'in-flight';
    if (input.executorMissing) return 'missing-executor';
    if (input.promptEmpty) return 'empty-prompt';
    if (input.promptTooLong) return 'too-long';
    if (input.repoReadiness === 'none-synced') return 'no-synced-repos';
    if (input.repoReadiness === 'unselected') return 'repo-required';
    if (input.repoReadiness === 'not-ready') return 'repo-not-ready';
    if (input.workflowUnresolved) return 'workflow-loading';
    if (input.paramsInvalid) return 'invalid-params';
    return null;
}

/**
 * How a blocker is said: `bad` is the red banner, only for what the member must go and fix;
 * `info` is the waiting banner; `quiet` is the status text beside Start — an empty prompt is where
 * every task starts, so a fresh composer never opens red.
 */
export function blockerTone(blocker: StartBlocker | null): 'bad' | 'info' | 'quiet' | null {
    switch (blocker) {
        case 'missing-executor':
        case 'invalid-params':
        case 'too-long':
        case 'no-synced-repos':
        case 'repo-required':
        case 'repo-not-ready':
            return 'bad';
        case 'workflow-loading':
            return 'info';
        case 'empty-prompt':
        case 'in-flight':
            return 'quiet';
        default:
            return null;
    }
}

/** The grouping the counter reads in — fixed, so the copy never follows the browser's locale. */
const COUNT_LOCALE = 'en-US';

/** The board's command limit as the composer prints it: `16,384`. */
export const COMMAND_LIMIT_TEXT = COMMAND_LIMIT.toLocaleString(COUNT_LOCALE);

/** `1,234 / 16,384` — the request against the board's limit, in the UTF-16 units the board counts. */
export function commandCount(draft: string): string {
    return `${draft.length.toLocaleString(COUNT_LOCALE)} / ${COMMAND_LIMIT_TEXT}`;
}

/** Whether the board would refuse this request for its length alone. */
export function commandTooLong(draft: string): boolean {
    return draft.length > COMMAND_LIMIT;
}

/** One blur: the field's touched mark, set without disturbing its siblings. */
export function markTouched(touched: Readonly<Record<string, boolean>>, name: string): Record<string, boolean> {
    return { ...touched, [name]: true };
}

/** Every field touched at once — what an invalid keyboard submission owes the member. */
export function touchAll(names: readonly string[]): Record<string, boolean> {
    return Object.fromEntries(names.map((name) => [name, true]));
}

/**
 * The workflow draft as a repository change leaves it — and as the composer mounts: the choice
 * back to unchosen, the stored values back to none, no field left touched. One named shape for
 * both moments keeps the reset provably the no-op on mount it must be, and hands the offline
 * suite (which runs no effects) the exact state Start sees after a repo switch to pin.
 */
export function freshWorkflowDraft(): {
    workflow: string;
    storedParams: { workflowId: string | null; values: Record<string, string> };
    paramTouched: Record<string, boolean>;
} {
    return { workflow: '', storedParams: { workflowId: null, values: {} }, paramTouched: {} };
}

/**
 * The stored parameter values, read back scoped to the workflow they were typed for. A value is
 * handed over only while that same workflow is STILL the chosen one: a select or repo switch
 * changes the list's context, so a clear-on-select alone would let `#12` typed for one process
 * sit valid for another — and launch it with a foreign issue. Keying the read to the identity
 * makes that carry impossible, with no gap for the stale values to be shown or sent through. A
 * repository change is handled one layer up, where the whole draft resets (the repo effect in
 * the composer).
 */
export function valuesForWorkflow(
    stored: { workflowId: string | null; values: Record<string, string> },
    workflowId: string | null
): Record<string, string> {
    return stored.workflowId === workflowId ? stored.values : {};
}

/**
 * The workflow select's value, clamped to the choices the ANSWERED list offers: a chosen name the
 * current context no longer serves must not survive invisibly in the draft — its parameter inputs
 * are gone, the vacuous gate lights Start, and the launch carries a name the board refuses with
 * UNKNOWN_WORKFLOW. A fetch still in flight (`null`) says nothing about the coming context, so a
 * choice survives the wait and is judged the moment the list lands.
 */
export function clampedWorkflow(workflow: string, workflows: readonly { name: string }[] | null): string {
    if (workflow === '' || workflows === null || workflows.some((choice) => choice.name === workflow)) {
        return workflow;
    }
    return '';
}

/** The workspace lists a composer draft is measured against. */
interface DraftLists {
    repos: readonly { owner: string; name: string }[] | null;
    /** The combined options, both scopes, as `composerExecutorOptions` builds them. */
    executors: readonly ExecutorChoice[];
    /**
     * The poll's resolved default — the server's own fallback chain (stored preference, first
     * personal row, first org row), handed over whole. Null when nothing is selectable.
     */
    defaultExecutor: ExecutorChoice | null;
}

/**
 * The composer's state at mount: the held draft exactly as it was saved, or the fresh shape the
 * lists imply — default executor, first repository, no workflow. `workflowRepo` is the repository
 * the workflow choice was made under; starting it equal to `repo` is what makes the repo-reset a
 * no-op on mount, for a fresh composer and a restored one alike.
 */
export function initialComposerState(restored: ComposerDraftInput | null, lists: DraftLists): ComposerDraftInput {
    if (restored !== null) return restored;
    const repo = firstRepo(lists.repos);
    return {
        draft: '',
        executor: lists.defaultExecutor?.name ?? '',
        executorScope: lists.defaultExecutor?.scope ?? USER_SCOPE,
        repo,
        repoTouched: false,
        workflowRepo: repo,
        ...freshWorkflowDraft(),
    };
}

/**
 * Whether the member has put anything into this composer that a fresh one would not hold — the
 * test for keeping a draft at all, and for offering Discard. Touched marks are not input: they
 * only say where the member has been. Nor are stored parameter values: they show only beside a
 * chosen workflow, and a chosen workflow is already not fresh.
 */
export function draftIsFresh(state: ComposerDraftInput, lists: DraftLists): boolean {
    const fresh = initialComposerState(null, lists);
    return (
        state.draft === fresh.draft &&
        state.executor === fresh.executor &&
        state.executorScope === fresh.executorScope &&
        state.repo === fresh.repo &&
        state.workflow === fresh.workflow
    );
}

/**
 * What the composer says when the draft's executor stops being selectable — removed, moved or
 * suspended (issue 440) — whether the draft was restored or was open when it happened. One
 * sentence, so the two paths dedupe.
 */
export function executorUnavailableNotice(name: string, next: ExecutorChoice | null): string {
    return `Executor ‘${name}’ is no longer available — ${next === null ? 'add one to continue' : `${next.name} selected`}.`;
}

/**
 * What a restored draft lost while the member was away, in words — one sentence per choice that
 * no longer exists. The composer's own clamps do the reselecting; this only says it happened, and
 * never touches the request text. A deselected repository resets the workflow choice anyway, so
 * the workflow is judged only under the repository it was chosen for, and only once its list has
 * answered: null means "not yet" — the one verdict still waits on that list.
 */
export function restoredDraftNotices(
    restored: ComposerDraftInput,
    lists: DraftLists & {
        repos: readonly { owner: string; name: string }[];
        workflows: readonly { name: string }[] | null;
    }
): string[] | null {
    const notices: string[] = [];
    // The choice is the PAIR: a personal and an org profile may share a name, and a draft that
    // chose one must never be clamped onto — or stand in for — the other (issue 391).
    const choseExecutor =
        restored.executor !== '' &&
        !selectionExists(lists.executors, { name: restored.executor, scope: restored.executorScope });
    if (choseExecutor) notices.push(executorUnavailableNotice(restored.executor, lists.defaultExecutor));
    const repoKept =
        restored.repo === '' || lists.repos.some(({ owner, name }) => `${owner}/${name}` === restored.repo);
    if (!repoKept) {
        const next = firstRepo(lists.repos);
        notices.push(
            `Repository ‘${restored.repo}’ is no longer selected — ${next === '' ? 'the task will run without a repository' : `${next} selected`}.`
        );
    }
    if (repoKept && restored.workflow !== '') {
        if (lists.workflows === null) return null;
        if (clampedWorkflow(restored.workflow, lists.workflows) !== restored.workflow) {
            notices.push(`Workflow ‘${restored.workflow}’ is no longer offered — no workflow selected.`);
        }
    }
    return notices;
}
