import type { ExecutorType } from '@factory-ai/core';

/**
 * Client-side structural validation for the pasted executor config.
 *
 * UX only — the server re-validates authoritatively. Exported as a pure function so the offline
 * suite can assert it, the way `pollDelay` is in api/useWorkspace.ts.
 */

/**
 * What each type minimally requires inside `config`, beyond being an object. Empty for now: the
 * contract is "raw JSON the member pastes", and field rules belong to the day an actual consumer
 * exists and can be wrong about them. Adding a type's requirements is one line here.
 */
export const REQUIRED_FIELDS: Record<ExecutorType, readonly string[]> = {
    'claude-code': [],
    opencode: [],
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
export const EXECUTOR_TYPE_META: Record<ExecutorType, { label: string; configHelp: string; example: string }> = {
    'claude-code': {
        label: 'Claude Code',
        configHelp:
            'This JSON is merged into the runner settings.json. hooks, enabledPlugins and extraKnownMarketplaces are stripped to preserve the runner guard hook and plugin install; everything else — model, env, permissions.allow — applies, except that the baked telemetry env (CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_*) always wins over anything pasted here.',
        example: '{}',
    },
    opencode: {
        label: 'OpenCode',
        configHelp:
            'Tasks using this executor run OpenCode. This object is merged over its baked configuration; model and provider settings apply, while permission rules are ignored to preserve the runner fence.',
        example:
            '{ "model": "<provider-id>/<model-id>", "provider": { "api_key": "<from your provider, not stored here>" } }',
    },
};

/** The human label for a row's stored type; the raw string falls through for an unknown wire value. */
export function executorTypeLabel(type: string): string {
    return EXECUTOR_TYPE_META[type as ExecutorType]?.label ?? type;
}

/** Half the 64 KiB body budget, so the serialized envelope cannot blow the server limit. */
export const MAX_CONFIG_BYTES = 32 * 1024;

export type ValidExecutor = {
    name: string;
    type: ExecutorType;
    config: object;
};

export type ExecutorValidation = { ok: true; value: ValidExecutor } | { ok: false; error: string };

/**
 * The config half of the validation, on its own: JSON that parses to an object, whatever the type
 * requires inside it, under the size limit. The dialog's LIVE error under the textarea is this —
 * and only this — so a missing name can never arrive attributed to the config field (issue 183
 * review): the name is a different field with its own problem, and Save still runs the full
 * `validateExecutorConfig` regardless.
 */
export type ExecutorPayloadValidation = { ok: true; value: object } | { ok: false; error: string };

export function validateExecutorPayload(raw: string, type: ExecutorType): ExecutorPayloadValidation {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: 'Paste the executor config as JSON.' };

    // Before the parse, on purpose: this validator runs on every keystroke, and an oversized
    // paste should be refused for its size, not parsed first and rejected after.
    if (new TextEncoder().encode(trimmed).length > MAX_CONFIG_BYTES) {
        return { ok: false, error: 'The config is too large (limit 32 KiB).' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (e) {
        return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: 'The config must be a JSON object, not a list or a scalar.' };
    }

    for (const field of REQUIRED_FIELDS[type]) {
        if (!(field in parsed)) {
            return { ok: false, error: `The config for "${type}" must set "${field}".` };
        }
    }

    return { ok: true, value: parsed };
}

export function validateExecutorConfig(raw: string, name: string, type: ExecutorType): ExecutorValidation {
    const payload = validateExecutorPayload(raw, type);
    if (!payload.ok) return payload;

    const trimmedName = name.trim();
    if (!trimmedName) return { ok: false, error: 'Give the executor a name.' };
    if (/[/\\]/.test(trimmedName)) return { ok: false, error: 'The name cannot contain "/" or "\\".' };
    if (/^[-.]/.test(trimmedName)) return { ok: false, error: 'The name cannot start with "-" or ".".' };

    return { ok: true, value: { name: trimmedName, type, config: payload.value } };
}

/**
 * One executor row as the API carries it — the config read returns `type` as the string it stored,
 * not the narrowed union, so the merge works on rows straight off the wire.
 */
export type ExecutorRow = {
    name: string;
    type: string;
    config: object;
};

/**
 * Folds one dialog save back into the whole list the PUT takes.
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

    if (editing === null) return { ok: true, value: [...existing, next] };

    const index = existing.findIndex((row) => row.name === editing);
    if (index === -1) {
        return { ok: false, error: `"${editing}" no longer exists — refresh and try again.` };
    }
    const value = existing.slice();
    value[index] = next;
    return { ok: true, value };
}
