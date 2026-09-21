/**
 * The environment draft editor's pure layer — no React. The `task-composer.ts` precedent: the
 * panel's decisions live here so the offline suite can pin them without a DOM. It imports
 * `env-raw.ts`, the other pure module, for the advanced editor's serializer.
 *
 * Three contracts the server forces, each mirrored from `server/src/routes/env.ts` (whose
 * `parseVars` stays the sole authority; the copy is UX-only early feedback):
 *
 * - The WHOLE list is the unit of save, and the only shape dirty comparison looks at is the API
 *   payload — `{ name, value, isSecret }` rows. React row ids never reach it, so a re-keyed table
 *   is not a change; row order is not either, because every scope read comes back
 *   `order by name asc` (env-var-store.ts) and the store's order is the only one a future read
 *   could return.
 * - A secret's `value: null` is the keep-what-is-stored marker and `''` is a typed replacement
 *   input. The distinction lives at row level — `secretState` and the new-row validation —
 *   because the wire has only one keep form: a blank input (typed or untouched) PUTs null, and
 *   clearing a typed value returns the editor to clean, which is what blank promised.
 * - The scope cap, name rules and value bounds here are the server's own; a validation error only
 *   disables Save early, never redefines legality.
 */

import { serializeEnv } from './env-raw.js';

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Mirrors NAME_LIMIT in server/src/routes/env.ts — and env-raw.ts, which serializes for .env. */
export const NAME_LIMIT = 255;

/** Mirrors VALUE_LIMIT in server/src/routes/env.ts. */
export const VALUE_LIMIT = 32 * 1024;

/** Mirrors MAX_ENV_VARS_PER_SCOPE in server/src/routes/env.ts. */
export const MAX_ENV_VARS_PER_SCOPE = 100;

/** Mirrors RESERVED_ENV_NAMES in server/src/routes/env.ts. */
export const RESERVED_ENV_NAMES: readonly string[] = [
    'WORKDIR',
    'TRUST_WORKDIR',
    'BELLOWS_GATE_URL',
    'BELLOWS_GATE_TOKEN',
    'CRED_HELPER',
    'RESTORE',
    'FACTORY_TRANSCRIPT_DIR',
    'FACTORY_STATS_URL',
    'RUNNER_JOB_ID',
    'RUNNER_LEASE_TOKEN',
    'BELLOWS_SESSION_ID',
    'OPENCODE_CONFIG_CONTENT',
];

/** One editable row in the panel's draft state. `id` is a React key only — never in a payload. */
export interface EnvRowState {
    id: string;
    name: string;
    /** null = untouched stored secret (keep); '' = typed empty; any other string = typed text. */
    value: string | null;
    isSecret: boolean;
    /** false for rows seeded from the server echo; a new row may vanish without Undo. */
    isNew: boolean;
    /** Existing rows only: kept visible as "{name} will be removed when you save." until save. */
    pendingRemove: boolean;
}

export type EnvPayloadRow = { name: string; value: string | null; isSecret: boolean };

/** The seed rows a panel starts from: the stored truth, nothing pending, nothing new. */
export function seedRows(initialVars: readonly EnvPayloadRow[]): EnvRowState[] {
    return initialVars.map((row, index) => ({
        id: `seed-${index}`,
        name: row.name,
        value: row.value,
        isSecret: row.isSecret,
        isNew: false,
        pendingRemove: false,
    }));
}

/**
 * The API payload the draft would save: active rows only (pending-removed rows are excluded —
 * an omitted name is how the whole-list PUT deletes), names trimmed, a secret's blank input
 * turned back into the keep marker. Unfinished rows are INCLUDED — a blank-name addition must
 * read as dirty — and save runs only after validation passes, so one is never actually sent.
 */
export function envPayload(rows: readonly EnvRowState[]): EnvPayloadRow[] {
    return rows
        .filter((row) => !row.pendingRemove)
        .map((row) => ({
            name: row.name.trim(),
            value: row.isSecret && (row.value === '' || row.value === null) ? null : (row.value ?? ''),
            isSecret: row.isSecret,
        }));
}

/** Order-insensitive deep equality of two payloads — the store's read order is name asc. */
export function payloadEquals(a: readonly EnvPayloadRow[], b: readonly EnvPayloadRow[]): boolean {
    const key = (row: EnvPayloadRow) => JSON.stringify(row);
    const left = a.map(key).sort();
    const right = b.map(key).sort();
    return left.length === right.length && left.every((row, i) => row === right[i]);
}

/** Canonical dirty state: the baseline payload against the draft's, nothing else consulted. */
export function isDirty(baseline: readonly EnvRowState[], draft: readonly EnvRowState[]): boolean {
    return !payloadEquals(envPayload(baseline), envPayload(draft));
}

/** The tab count for one type: additions included, pending removals excluded. */
export function countActive(rows: readonly EnvRowState[], isSecret: boolean): number {
    return rows.filter((row) => row.isSecret === isSecret && !row.pendingRemove).length;
}

/**
 * One message per broken rule, keyed by row id. Pending-removed rows are never flagged — they
 * are on their way out and a red error under a row the user is deleting reads as a second
 * opinion they did not ask for. Mirrors parseVars in server/src/routes/env.ts.
 */
export function rowErrors(rows: readonly EnvRowState[]): Map<string, string[]> {
    const active = rows.filter((row) => !row.pendingRemove);
    const nameCounts = new Map<string, number>();
    for (const row of active) nameCounts.set(row.name.trim(), (nameCounts.get(row.name.trim()) ?? 0) + 1);

    const errors = new Map<string, string[]>();
    for (const row of active) {
        const rowId = row.id;
        const name = row.name.trim();
        const list: string[] = [];
        if (name === '') {
            list.push('Name is required.');
        } else {
            if (name.length > NAME_LIMIT) list.push(`Name exceeds ${NAME_LIMIT} characters.`);
            if (!ENV_NAME.test(name)) list.push(`"${name}" is not a legal environment variable name.`);
            if (RESERVED_ENV_NAMES.includes(name)) list.push(`"${name}" is reserved by the runner.`);
            if ((nameCounts.get(name) ?? 0) > 1) {
                list.push(`Duplicate name "${name}" — names must be unique in this scope.`);
            }
        }
        const value = row.value ?? '';
        if (row.isSecret && row.isNew && (row.value === '' || row.value === null)) {
            list.push('Enter a value or remove the row.');
        }
        if (value.includes('\n') || value.includes('\r')) list.push('Value contains a newline.');
        if (value.length > VALUE_LIMIT) list.push(`Value exceeds ${VALUE_LIMIT} characters.`);
        if (list.length > 0) errors.set(rowId, list);
    }
    return errors;
}

/** The save-level scope rule the row checks cannot see: the whole scope's size. */
export function scopeError(rows: readonly EnvRowState[]): string | null {
    const active = rows.filter((row) => !row.pendingRemove).length;
    if (active > MAX_ENV_VARS_PER_SCOPE) {
        return `At most ${MAX_ENV_VARS_PER_SCOPE} variables can be configured per scope.`;
    }
    return null;
}

export function hasErrors(errors: Map<string, string[]>, scope: string | null): boolean {
    return scope !== null || errors.size > 0;
}

export type SecretState = 'set' | 'replace' | 'not-set';

export const SECRET_STATE_LABEL: Record<SecretState, string> = {
    set: 'Set',
    replace: 'Will replace when saved',
    'not-set': 'Not set',
};

/**
 * What the State column says about one secret row. A stored secret with a blank input is Set —
 * blank means keep, whatever the user typed and deleted before that. A new row with nothing
 * typed is Not set. Any typed text is a replacement staged for the next save.
 */
export function secretState(row: EnvRowState): SecretState {
    if (!row.isSecret) return 'set';
    if (row.value !== null && row.value !== '') return 'replace';
    return row.isNew ? 'not-set' : 'set';
}

/**
 * Whether the advanced textarea holds text the draft has not absorbed: the seed text is the
 * serialization of the ACTIVE variable rows, so an untouched disclosure never blocks Save, and
 * neither does one whose text matches the table again after an Apply.
 */
export function advancedUnapplied(text: string, rows: readonly EnvRowState[]): boolean {
    return text !== serializeEnv(rows.filter((row) => !row.isSecret && !row.pendingRemove));
}

export type TabNavKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/** The roving-tabindex step for a keydown on the tab strip: the next tab, or null to ignore. */
export function nextTabIndex(current: number, count: number, key: string): number | null {
    if (count === 0) return null;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const step = key === 'ArrowLeft' ? -1 : 1;
        return (current + step + count) % count;
    }
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return null;
}
