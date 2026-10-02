import {
    CLAUDE_CODE,
    DEFAULT_GATE_FIX_ROUNDS,
    EXECUTOR_TYPES,
    type ExecutorScope,
    type ExecutorType,
    MAX_GATE_FIX_ROUNDS,
    OPENCODE,
    ORG_SCOPE,
    RUNNER_MANAGED_KEYS,
    USER_SCOPE,
} from '@factory-ai/core';

/**
 * The executor editor's pure half (issue 261): the draft the dialog holds, its validation, and the JSON
 * helpers the guided controls and the Advanced editor share.
 *
 * UX only — the server re-validates authoritatively. Exported as pure functions so the offline
 * suite can assert them, the way `pollDelay` is in api/useWorkspace.ts.
 */

/**
 * What each type minimally requires inside `config`, beyond being an object. Empty for now: the
 * contract is "whatever object the member configured", and field rules belong to the day an actual consumer
 * exists and can be wrong about them. Adding a type's requirements is one line here.
 */
export const REQUIRED_FIELDS: Record<ExecutorType, readonly string[]> = {
    [CLAUDE_CODE]: [],
    [OPENCODE]: [],
};

/**
 * What each type's config actually does, in the words the dialog and the list show.
 *
 * The copy is contractual, not decorative (issue 183): claude-code configs are merged into the
 * runner's settings.json with `hooks`, `enabledPlugins` and `extraKnownMarketplaces` stripped
 * board-side (the git guard hook and the baked context-mode plugin install), and opencode configs
 * are merged over the runner's baked configuration with `permission` stripped board-side to
 * preserve the runner fence (see docs/workspace.md). The `Record` shape is the same exhaustiveness
 * guard REQUIRED_FIELDS uses: a new EXECUTOR_TYPES entry cannot compile until it declares its own
 * truth.
 */
export const EXECUTOR_TYPE_META: Record<
    ExecutorType,
    { label: string; modelHelp: string; modelExample: string; configHelp: string }
> = {
    [CLAUDE_CODE]: {
        label: 'Claude Code',
        modelHelp: 'A Claude model id or an alias such as sonnet or opus.',
        modelExample: 'claude-sonnet-4-5',
        configHelp:
            'This JSON is merged into the runner settings.json. hooks, enabledPlugins and extraKnownMarketplaces are stripped to preserve the runner guard hook and plugin install; everything else — model, env, permissions.allow — applies, except that the baked telemetry env (CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_*) always wins over anything set here.',
    },
    [OPENCODE]: {
        label: 'OpenCode',
        modelHelp: 'The provider id and the model id, separated by a slash.',
        modelExample: 'anthropic/claude-sonnet-4-5',
        configHelp:
            'Tasks using this executor run OpenCode. This object is merged over its baked configuration; model and provider settings apply, while permission rules are ignored to preserve the runner fence.',
    },
};

/** The human label for a row's stored type; the raw string falls through for an unknown wire value. */
export function executorTypeLabel(type: string): string {
    return EXECUTOR_TYPE_META[type as ExecutorType]?.label ?? type;
}

/** Half the 64 KiB body budget, so the serialized envelope cannot blow the server limit. */
export const MAX_CONFIG_BYTES = 32_768;

export type ValidExecutor = {
    name: string;
    type: ExecutorType;
    config: object;
    /** The default workflow's gate-repair round limit this executor launches tasks with (#49). */
    gateFixRounds: number;
};

/** Which field a draft's failure belongs to, so the dialog shows it beside that field. */
export type ExecutorField = 'name' | 'model' | 'config' | 'rounds';

export type ExecutorValidation =
    | { ok: true; value: ValidExecutor }
    | { ok: false; error: string; field: ExecutorField };

/**
 * The gate-repair round limit field (#49): a bounded nonnegative integer, the code default when
 * the field is left blank. UX only — the server re-validates authoritatively and the database's
 * check constraint is the final word — but the dialog's live error keeps an out-of-range value
 * from ever reaching the PUT.
 */
export function validateGateFixRounds(raw: string): { ok: true; value: number } | { ok: false; error: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, value: DEFAULT_GATE_FIX_ROUNDS };
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_GATE_FIX_ROUNDS) {
        return {
            ok: false,
            error: `Gate repair rounds must be a whole number between 0 and ${MAX_GATE_FIX_ROUNDS}.`,
        };
    }
    return { ok: true, value: parsed };
}

/** A parsed configuration, or why it is not one — with the position when the engine reports it. */
export type ConfigParse =
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; error: string; line?: number; column?: number };

const LINE_COLUMN = /line (\d+) column (\d+)/;
const POSITION = /at position (\d+)/;

/**
 * Where a `JSON.parse` failure happened, read out of the engine's message: V8's
 * `(line L column C)` or bare `at position N`, or Firefox's `at line L column C`. Safari reports no
 * position, and null says so rather than guessing one.
 */
export function locateJsonError(text: string, message: string): { line: number; column: number } | null {
    const lineColumn = LINE_COLUMN.exec(message);
    if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
    const position = POSITION.exec(message);
    if (!position) return null;
    const lines = text.slice(0, Number(position[1])).split('\n');
    return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

/** The engine's reason with its own position and echo of the text removed — the sentence says where. */
function jsonErrorReason(message: string): string {
    const reason = message
        .replace(/^JSON(\.parse:| Parse error:)\s*/, '')
        .replace(/,\s*".*" is not valid JSON$/s, '')
        .replace(/\s*\(line \d+ column \d+\)/, '')
        .replace(/\s*in JSON at position \d+/, '')
        .replace(/\s*at line \d+ column \d+ of the JSON data/, '')
        .trim();
    return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/**
 * The configuration text as the object it saves: blank reads as `{}` — the inherited
 * configuration, so a name and an agent are enough to save — anything else must parse to an
 * object under the size limit. Parsed untrimmed so the engine's positions match the editor's lines.
 */
export function parseExecutorConfig(text: string): ConfigParse {
    const trimmed = text.trim();
    if (!trimmed) return { ok: true, value: {} };

    // Before the parse, on purpose: this runs on every keystroke, and an oversized paste should be
    // refused for its size, not parsed first and rejected after.
    if (new TextEncoder().encode(trimmed).length > MAX_CONFIG_BYTES) {
        return { ok: false, error: 'The configuration is too large (limit 32 KiB).' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        const message = (e as Error).message;
        const at = locateJsonError(text, message);
        const reason = jsonErrorReason(message);
        return at
            ? { ok: false, error: `Not valid JSON at line ${at.line}, column ${at.column}: ${reason}`, ...at }
            : { ok: false, error: `Not valid JSON: ${reason}` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: 'The configuration must be a JSON object, not a list or a single value.' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
}

/** The Format JSON action: the same object, two-space indented; null when the text does not parse. */
export function formatConfig(text: string): string | null {
    const parsed = parseExecutorConfig(text);
    return parsed.ok ? JSON.stringify(parsed.value, null, 2) : null;
}

/** What the guided Model control reads out of a configuration — `unsupported` is a non-string. */
export type ModelSetting = { kind: 'default' } | { kind: 'custom'; model: string } | { kind: 'unsupported' };

export function readModel(config: Record<string, unknown>): ModelSetting {
    if (!('model' in config)) return { kind: 'default' };
    return typeof config.model === 'string' ? { kind: 'custom', model: config.model } : { kind: 'unsupported' };
}

/**
 * The guided Model control's one write into the configuration: every other key survives, in its
 * order — a spread keeps an existing key where it was — and null removes the key, which is what
 * "Use runner default" means.
 */
export function withModel(config: Record<string, unknown>, model: string | null): Record<string, unknown> {
    if (model !== null) return { ...config, model };
    const { model: _model, ...rest } = config;
    return rest;
}

/** The Claude Code runner's baked telemetry env, which wins over any value a config sets. */
const TELEMETRY_ENV_KEY = 'CLAUDE_CODE_ENABLE_TELEMETRY';
const OTEL_ENV_PREFIX = 'OTEL_';

/**
 * The settings in this configuration the runner will not honor: the board-stripped keys
 * (RUNNER_MANAGED_KEYS, the same list the claim strips) and, for Claude Code, the telemetry env
 * the image always overrides. Key paths only, never values — a config may carry credentials, and
 * this list is shown back to the member.
 */
export function runnerManagedSettings(type: ExecutorType, config: Record<string, unknown>): string[] {
    const found = RUNNER_MANAGED_KEYS[type].filter((key) => key in config);
    const env = config.env;
    if (type === CLAUDE_CODE && typeof env === 'object' && env !== null && !Array.isArray(env)) {
        for (const key of Object.keys(env)) {
            if (key === TELEMETRY_ENV_KEY || key.startsWith(OTEL_ENV_PREFIX)) found.push(`env.${key}`);
        }
    }
    return found;
}

/**
 * The Name field's own rules, duplicates included, so the dialog can say so beside the field
 * before Save. The row being edited may keep its name; `mergeExecutors` still refuses a clash at
 * save for anything that slips past.
 */
export function validateExecutorName(
    name: string,
    existing: readonly { name: string }[],
    editing: string | null
): string | null {
    const trimmed = name.trim();
    if (!trimmed) return 'Give the executor a name.';
    if (/[/\\]/.test(trimmed)) return 'The name cannot contain "/" or "\\".';
    if (/^[-.]/.test(trimmed)) return 'The name cannot start with "-" or ".".';
    if (existing.some((row) => row.name === trimmed && row.name !== editing)) {
        return `An executor named "${trimmed}" already exists.`;
    }
    return null;
}

/**
 * Everything the dialog holds while it is open. `configs` keeps one configuration text per agent,
 * so switching agents never reinterprets or discards the other's draft; `customModel` is the
 * Model control's choice per agent, which can be "custom" before an identifier is typed.
 */
export interface ExecutorDraft {
    name: string;
    type: ExecutorType;
    configs: Record<ExecutorType, string>;
    customModel: Record<ExecutorType, boolean>;
    gateFixRounds: string;
}

function perType<T>(value: (type: ExecutorType) => T): Record<ExecutorType, T> {
    return Object.fromEntries(EXECUTOR_TYPES.map((type) => [type, value(type)])) as Record<ExecutorType, T>;
}

/** Add opens blank with every agent inheriting (`{}`); edit seeds the row's own agent from the row. */
export function initialExecutorDraft(row: ExecutorRow | undefined): ExecutorDraft {
    const rowType = row?.type as ExecutorType | undefined;
    const config = (row?.config ?? {}) as Record<string, unknown>;
    return {
        name: row?.name ?? '',
        type: rowType ?? EXECUTOR_TYPES[0],
        configs: perType((type) => (type === rowType ? JSON.stringify(config, null, 2) : '{}')),
        customModel: perType((type) => type === rowType && readModel(config).kind === 'custom'),
        gateFixRounds: row ? String(row.gateFixRounds) : '',
    };
}

/**
 * The Model control's own rule, beside the field: a `model` the configuration holds must be text,
 * and choosing a custom identifier means entering one.
 */
export function validateModelChoice(
    config: Record<string, unknown>,
    custom: boolean,
    type: ExecutorType
): string | null {
    const model = readModel(config);
    if (model.kind === 'unsupported') return `${MODEL_NOT_TEXT}, such as ${EXECUTOR_TYPE_META[type].modelExample}.`;
    if (custom && (model.kind === 'default' || !model.model.trim())) {
        return 'Enter a model identifier, or choose Use runner default.';
    }
    return null;
}

/** The whole draft checked in field order; only the active agent's configuration is carried. */
export function validateExecutorDraft(
    draft: ExecutorDraft,
    existing: readonly { name: string }[],
    editing: string | null
): ExecutorValidation {
    const nameError = validateExecutorName(draft.name, existing, editing);
    if (nameError) return { ok: false, error: nameError, field: 'name' };

    const { type } = draft;
    const parsed = parseExecutorConfig(draft.configs[type]);
    if (!parsed.ok) return { ok: false, error: parsed.error, field: 'config' };
    for (const field of REQUIRED_FIELDS[type]) {
        if (!(field in parsed.value)) {
            return { ok: false, error: `The configuration for "${type}" must set "${field}".`, field: 'config' };
        }
    }

    const modelError = validateModelChoice(parsed.value, draft.customModel[type], type);
    if (modelError) return { ok: false, error: modelError, field: 'model' };

    const rounds = validateGateFixRounds(draft.gateFixRounds);
    if (!rounds.ok) return { ...rounds, field: 'rounds' };

    return {
        ok: true,
        value: { name: draft.name.trim(), type, config: parsed.value, gateFixRounds: rounds.value },
    };
}

/** Key-sorted JSON, so two configurations that differ only in key order or spacing compare equal. */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** What would be saved, compared by meaning: an unparseable config or round count compares as its text. */
function savedShape(draft: ExecutorDraft): string {
    const parsed = parseExecutorConfig(draft.configs[draft.type]);
    const rounds = validateGateFixRounds(draft.gateFixRounds);
    return JSON.stringify([
        draft.name.trim(),
        draft.type,
        parsed.ok ? canonicalJson(parsed.value) : draft.configs[draft.type],
        rounds.ok ? rounds.value : draft.gateFixRounds,
    ]);
}

/**
 * Two answers about a draft against the one the dialog opened with. `payloadChanged` is whether a
 * save would change the row — formatting alone does not, which is what keeps Save disabled on an
 * untouched edit. `anyChanged` is whether closing would lose typing, the other agent's draft
 * included — what raises the discard confirmation.
 */
export function executorDraftChanges(
    baseline: ExecutorDraft,
    draft: ExecutorDraft
): { payloadChanged: boolean; anyChanged: boolean } {
    return {
        payloadChanged: savedShape(baseline) !== savedShape(draft),
        anyChanged: JSON.stringify(baseline) !== JSON.stringify(draft),
    };
}

/**
 * The sentence beside a disabled Save for each field's failure. It points at the field rather than
 * repeating its error, which already sits beside the field — and says where, for the fields
 * inside the collapsed Advanced section.
 */
export const SAVE_HINTS: Record<ExecutorField, string> = {
    name: 'Enter a valid name to save.',
    model: 'Finish the Model choice to save.',
    config: 'Fix the JSON in Advanced configuration to save.',
    rounds: 'Fix the gate repair rounds in Advanced configuration to save.',
};

/** The sentence beside a disabled Save: where the draft's first problem is, or that an edit changed nothing. */
export function saveUnavailableReason(
    validation: ExecutorValidation,
    payloadChanged: boolean,
    isEdit: boolean
): string | null {
    if (!validation.ok) return SAVE_HINTS[validation.field];
    if (isEdit && !payloadChanged) return NO_CHANGES_REASON;
    return null;
}

/** The live announcement after a save closes the dialog. */
export function executorSavedMessage(name: string, isEdit: boolean): string {
    return isEdit ? `Saved changes to “${name}”.` : `Added executor “${name}”.`;
}

export type JsonTokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'space' | 'invalid';

/**
 * One scanner step, sticky: whitespace, a string (unterminated ones included, up to the line end),
 * a number, a literal, punctuation, or a run of anything else — which is what makes the scan
 * lossless on text that is not JSON yet.
 */
const JSON_TOKEN =
    /(\s+)|("(?:[^"\\\n]|\\.)*"?)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)\b|([{}[\]:,])|([^\s"{}[\]:,]+)/y;

/**
 * The Advanced editor's highlighting: the text split into classified pieces that join back to
 * exactly the input. A string followed by `:` is a key.
 */
export function tokenizeJson(text: string): { kind: JsonTokenKind; text: string }[] {
    const tokens: { kind: JsonTokenKind; text: string }[] = [];
    const kinds: JsonTokenKind[] = ['space', 'string', 'number', 'literal', 'punct', 'invalid'];
    JSON_TOKEN.lastIndex = 0;
    while (JSON_TOKEN.lastIndex < text.length) {
        const match = JSON_TOKEN.exec(text)!;
        const group = match.findIndex((value, index) => index > 0 && value !== undefined);
        tokens.push({ kind: kinds[group - 1]!, text: match[0] });
    }
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i]!.kind !== 'string') continue;
        let next = i + 1;
        while (tokens[next]?.kind === 'space') next++;
        if (tokens[next]?.kind === 'punct' && tokens[next]!.text === ':') tokens[i]!.kind = 'key';
    }
    return tokens;
}

/**
 * One personal executor row as the API carries it — the config read returns `type` as the string
 * it stored, not the narrowed union, so the merge works on rows straight off the wire. No
 * `isDefault` since 391: the default is a per-member preference naming a scope, not a flag here.
 */
export type ExecutorRow = {
    name: string;
    type: string;
    config: object;
    gateFixRounds: number;
};

/**
 * Folds one dialog save back into the whole list the personal PUT takes.
 *
 * `existing` is the full list as the dialog opened it, configs included; `editing` is the name of
 * the row being edited, or null to append. The edited row is matched by its ORIGINAL name — a
 * rename changes what is saved under, not what is matched. A pure function, exported, so the
 * offline suite can assert the collision and stale-row rules the server would otherwise say
 * first.
 */
export function mergeExecutors(
    existing: readonly ExecutorRow[],
    editing: string | null,
    next: ValidExecutor
): { ok: true; value: ExecutorRow[] } | { ok: false; error: string } {
    const clash = existing.some((row) => row.name === next.name && row.name !== editing);
    if (clash) return { ok: false, error: `An executor named "${next.name}" already exists.` };

    if (editing === null) return { ok: true, value: [...existing, { ...next }] };

    const index = existing.findIndex((row) => row.name === editing);
    if (index === -1) {
        return { ok: false, error: `"${editing}" no longer exists — refresh and try again.` };
    }
    const value = existing.slice();
    value[index] = { ...next };
    return { ok: true, value };
}

/**
 * A composer's executor choice, scope-qualified (issue 391): a personal and an organization
 * profile may share a name, and the selection — the draft, the queue body, the stored default —
 * names BOTH, so the two rows stay distinguishable and a choice never silently switches scopes.
 */
export interface ExecutorChoice {
    name: string;
    scope: ExecutorScope;
}

/**
 * The scope-qualified identity a composer select values: `${scope}:${name}`. A name may hold any
 * character except the path separators, so `:` is a safe delimiter.
 */
export function executorChoiceId(choice: ExecutorChoice): string {
    return `${choice.scope}:${choice.name}`;
}

/** The choice behind a select value; null for anything that is not one — an old draft, a typo. */
export function executorChoiceOf(id: string): ExecutorChoice | null {
    if (id.startsWith(`${USER_SCOPE}:`)) return { scope: USER_SCOPE, name: id.slice(USER_SCOPE.length + 1) };
    if (id.startsWith(`${ORG_SCOPE}:`)) return { scope: ORG_SCOPE, name: id.slice(ORG_SCOPE.length + 1) };
    return null;
}

/** One row the composer's executor select offers, from either scope. */
export interface ComposerExecutorOption extends ExecutorChoice {
    type: string;
}

/**
 * The composer's options, personal first then the organization's — the member's own rows where
 * they have always been, the team's below. The organization's list stands alone when the member
 * has configured nothing personal: that is the whole point of the shared scope.
 */
export function composerExecutorOptions(
    personal: readonly { name: string; type: string }[],
    org: readonly { name: string; type: string }[]
): ComposerExecutorOption[] {
    return [
        ...personal.map((row) => ({ scope: USER_SCOPE, name: row.name, type: row.type })),
        ...org.map((row) => ({ scope: ORG_SCOPE, name: row.name, type: row.type })),
    ];
}

/** Whether a draft's selection still exists in the answered lists — the clamp's test. */
export function selectionExists(options: readonly ExecutorChoice[], choice: ExecutorChoice): boolean {
    return options.some((option) => option.name === choice.name && option.scope === choice.scope);
}

/**
 * The member-facing copy for the executor surfaces, kept here rather than beside the components
 * that render it: this module is plain TypeScript with no React, so the e2e specs can import these
 * and assert what the DOM must say instead of holding their own copies of the sentences. Three of
 * those copies had already drifted out of sync with the product, and nothing caught it —
 * `verify:ui` needs Playwright and two databases to run at all.
 */

/** The panel-level sentence on both executor surfaces: what an executor decides for a task. */
export const EXECUTOR_GUIDANCE =
    'Each task runs with its selected executor. The executor type chooses Claude Code or OpenCode, and its JSON config is applied to that runner.';

/** The Settings → Executors scope sentence, the page header's description (issue 261). */
export const EXECUTOR_SCOPE = 'Your saved agent settings for running tasks.';

/** The editor's actions (issue 261), here so the e2e specs assert the same strings the dialog renders. */
export const ADD_LABEL = 'Add executor';
export const SAVE_LABEL = 'Save changes';

/** Field helps, each tied to its control with aria-describedby. */
export const NAME_HELP = 'Shown in the task picker when you start a task — for example, Code review.';
export const AGENT_HELP = 'Tasks using this executor run with the selected agent.';
export const MODEL_DEFAULT_LABEL = 'Use runner default';
export const MODEL_CUSTOM_LABEL = 'Custom model identifier';
/** A configuration's `model` that the guided control cannot read — anything but a string. */
export const MODEL_NOT_TEXT = '"model" must be text';
/** Why the guided Model control is disabled: guided values never overwrite a raw draft that does not parse. */
export const MODEL_BLOCKED_NOTE = 'Fix the JSON in Advanced configuration to change the model here.';

/** What saving a name and an agent alone means, and what saving does not check. */
export const INHERITED_NOTE =
    'Anything you leave unset is inherited from this deployment’s runner configuration. Saving checks the form only — not your credentials or whether the model is available.';

/** Where credentials go instead: the member's environment, on the Workspace settings page. */
export const CREDENTIALS_NOTE = 'Keep API keys out of this configuration — set them as environment variables in';

export const ADVANCED_LABEL = 'Advanced configuration';
export const CONFIG_JSON_LABEL = 'Configuration JSON';
/** Valid JSON is not a tested configuration, and the help says so. */
export const CONFIG_TESTED_NOTE = 'Checked here as valid JSON; the runner first uses it when a task starts.';
export const FORMAT_JSON_LABEL = 'Format JSON';
/** The heading over `runnerManagedSettings`: those keys are present, and will not take effect. */
export const RUNNER_MANAGED_NOTE = 'The runner manages these settings, so they will not take effect:';
/** Why Save is disabled on an edit that changed nothing. */
export const NO_CHANGES_REASON = 'No changes to save.';

/** What the gate-repair field decides; tied to the number input with aria-describedby (#49). */
export const GATE_FIX_ROUNDS_HELP =
    'How many rounds a task on this executor may spend automatically repairing a failed gate (0 turns repair off). The limit is fixed when the task is created.';

/**
 * Everything the dialog renders from its draft, derived in one pure pass (issue 261): each field's
 * own error, the Model control's state, the runner-managed keys, and whether and why Save is
 * available. A blank Name is not an error until the field has been left once.
 */
export function executorEditorView({
    draft,
    baseline,
    existing,
    editing,
    nameTouched,
}: {
    draft: ExecutorDraft;
    baseline: ExecutorDraft;
    existing: readonly { name: string }[];
    editing: string | null;
    nameTouched: boolean;
}) {
    const { type } = draft;
    const parsed = parseExecutorConfig(draft.configs[type]);
    const model = parsed.ok ? readModel(parsed.value) : null;
    const custom = draft.customModel[type];
    const validation = validateExecutorDraft(draft, existing, editing);
    const changes = executorDraftChanges(baseline, draft);
    const nameError = validateExecutorName(draft.name, existing, editing);
    const rounds = validateGateFixRounds(draft.gateFixRounds);
    const editable = parsed.ok && model?.kind !== 'unsupported';
    return {
        parsed,
        custom,
        model: model?.kind === 'custom' ? model.model : '',
        modelUnsupported: model?.kind === 'unsupported',
        validation,
        changes,
        unavailable: saveUnavailableReason(validation, changes.payloadChanged, editing !== null),
        nameError: nameError && (nameTouched || draft.name.trim() !== '') ? nameError : null,
        modelError: editable ? validateModelChoice(parsed.value, custom, type) : null,
        jsonError: parsed.ok ? null : parsed.error,
        roundsError: rounds.ok ? null : rounds.error,
        managed: parsed.ok ? runnerManagedSettings(type, parsed.value) : [],
    };
}
