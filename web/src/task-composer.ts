/**
 * The task composer's pure layer: the draft-state shapes, the client mirror of the board's
 * parameter check, and the plain-language derivations the guided composer renders — per-field
 * verdicts, the preflight sentence, the start-blocker matrix. No React and no fetching: every
 * function here is testable without a DOM, which is what lets the offline suite pin the launch
 * contract the board enforces.
 */

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

/**
 * The one sentence before Start: what will run, where, guided by what — from the ACTUAL choices,
 * never claiming the workflow's interpolation has already happened. No workflow chosen is its
 * own sentence: the prompt runs as written.
 */
export function preflightSentence(input: {
    /** `owner/name` of the chosen repository, or null for none. */
    repo: string | null;
    /** The chosen executor's name, or null while no configured executor can be selected. */
    executor: string | null;
    /** The chosen workflow's name, or null for no process. */
    workflow: string | null;
}): string {
    const where = input.repo === null ? 'Will run without a repository' : `Will run in ${input.repo}`;
    const who = input.executor === null ? 'after you configure an executor' : `using ${input.executor} executor`;
    const what =
        input.workflow === null ? '. Your prompt will run as written.' : `, with the ${input.workflow} workflow.`;
    return `${where} ${who}${what}`;
}

/** The one reason Start is dark, in precedence order: in flight, executor, prompt, workflow params. */
export type StartBlocker = 'in-flight' | 'missing-executor' | 'empty-prompt' | 'invalid-params';

/**
 * Why Start cannot start, or null when it can. The order is the message the member needs: an
 * in-flight queue must not be re-entered, a task cannot run without an executor profile, an empty
 * prompt is the missing task itself, and workflow details come last.
 */
export function startBlocker(input: {
    sending: boolean;
    executorMissing: boolean;
    promptEmpty: boolean;
    paramsInvalid: boolean;
}): StartBlocker | null {
    if (input.sending) return 'in-flight';
    if (input.executorMissing) return 'missing-executor';
    if (input.promptEmpty) return 'empty-prompt';
    if (input.paramsInvalid) return 'invalid-params';
    return null;
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
