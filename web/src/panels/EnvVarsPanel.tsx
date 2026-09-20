import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { EnvSaveResult } from '../api/useEnv.js';
import { useGuardedDraft } from '../components/UnsavedChangesDialog.js';
import {
    advancedUnapplied,
    countActive,
    envPayload,
    hasErrors,
    isDirty,
    nextTabIndex,
    rowErrors,
    scopeError,
    SECRET_STATE_LABEL,
    secretState,
    seedRows,
} from './env-draft.js';
import type { EnvRowState } from './env-draft.js';
import { parseEnvRaw, serializeEnv } from './env-raw.js';

/**
 * One editable row. `value: null` is what the server sends for a secret — the write-only echo —
 * and what a blank secret input turns back into on save, which is the keep-what-is-stored marker.
 */
export interface EnvVarDraft {
    name: string;
    value: string | null;
    isSecret: boolean;
    updatedAt?: string;
}

export interface EnvVarsPanelProps {
    title: string;
    /** One sentence on what this scope is for; rendered under the heading. */
    hint: string;
    initialVars: EnvVarDraft[];
    /** Resolves to the scope's stored rows on success — the panel adopts them as its new draft. */
    onSave: (vars: { name: string; value: string | null; isSecret: boolean }[]) => Promise<EnvSaveResult>;
    /** Rendered read-only while the PUT is in flight or the scope is not the caller's to edit. */
    disabled?: boolean;
    /** The scope's stable id in the settings area's unsaved-change guard — set when editable. */
    draftId?: string;
    /** The scope's label in the guard dialog's body sentence. */
    draftLabel?: string;
    /** Dirty mirror for a page that must ask before swapping the editor (the repository select). */
    onDirtyChange?: (dirty: boolean) => void;
}

type TabKey = 'variables' | 'secrets';

/**
 * The editor for one environment scope: org ("core"), the member's workspace, or one repository.
 *
 * One baseline and one local draft for the scope (env-draft.ts holds the pure decisions): rows
 * carry stable ids for React only, and dirty state compares the API payload shape — additions and
 * effective edits included, pending-removed rows excluded, order ignored, because the store reads
 * back ordered by name. Variables and Secrets are a real tablist with live counts; the tab a row
 * is added in decides its type, and there is deliberately NO control that changes a row's type —
 * a stored secret's value was never here, so the only ways out of the scope's secret set are a
 * typed replacement value or a pending removal. Removal is pending until the whole-list save:
 * the row stays visible as "{name} will be removed when you save." with an Undo, and deletion
 * happens only when the PUT succeeds. Advanced .env editing (env-raw.ts) replaces the variable
 * draft only, explicitly, through Apply; secrets never round-trip through text.
 *
 * Save submits one merged list from both mounted tabs — the PUT replaces the scope's rows, so a
 * retried request changes nothing. A secret left blank saves `null` (keep what is stored); an
 * omitted name deletes. On success the panel adopts the echoed rows as its new baseline WITHOUT
 * remounting, so the "Changes saved." confirmation survives; on failure the draft is retained,
 * the error is an alert that takes focus, and the inputs are untouched. While dirty, the editor
 * is registered with the settings area's guard (useGuardedDraft), which blocks navigation and
 * repository switches behind the one discard confirmation.
 *
 * Both tab panels always render (the inactive one carries `hidden`), because the page is
 * server-render-tested by markup assertions; the interaction states unreachable from props are
 * decided by the pure layer and pinned there and in the browser suite.
 *
 * No `<form>`: the CSP sends `form-action 'none'`, so a submit would be blocked at the browser —
 * the same trap that makes LoginGate an anchor.
 */
export function EnvVarsPanel({
    title,
    hint,
    initialVars,
    onSave,
    disabled = false,
    draftId,
    draftLabel,
    onDirtyChange,
}: EnvVarsPanelProps) {
    // The seed is captured once per mount — initialVars may arrive as a new array on every parent
    // render (an after-save refetch), and adopting one would silently wipe a typing hand's draft.
    const [baseline, setBaseline] = useState<EnvRowState[]>(() => seedRows(initialVars));
    const [rows, setRows] = useState<EnvRowState[]>(() => seedRows(initialVars));
    const [tab, setTab] = useState<TabKey>('variables');
    const [saving, setSaving] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [saveError, setSaveError] = useState<string | null>(null);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [advancedText, setAdvancedText] = useState('');
    const [advancedErrors, setAdvancedErrors] = useState<string[]>([]);
    const nextIdCounter = useRef(0);
    const uid = useId();

    const nextId = () => {
        nextIdCounter.current += 1;
        return `r${nextIdCounter.current}`;
    };

    const dirty = useMemo(() => isDirty(baseline, rows), [baseline, rows]);
    const errors = useMemo(() => rowErrors(rows), [rows]);
    const scopeMsg = useMemo(() => scopeError(rows), [rows]);
    const invalid = hasErrors(errors, scopeMsg);
    const unapplied = advancedOpen && advancedUnapplied(advancedText, rows);
    const locked = disabled || saving;
    const canSave = !disabled && !saving && dirty && !invalid && !unapplied;

    // Focus routing after add/remove/undo: requests recorded during the state update, resolved
    // once the rows (and their inputs) exist. A no-op on the server, where effects never run.
    const pendingFocus = useRef<{ id: string; kind: 'name' | 'undo' | 'add' } | null>(null);
    const nameRefs = useRef(new Map<string, HTMLInputElement | null>());
    const undoRefs = useRef(new Map<string, HTMLButtonElement | null>());
    const addRefs = useRef<{ variables: HTMLButtonElement | null; secrets: HTMLButtonElement | null }>({
        variables: null,
        secrets: null,
    });
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const saveErrorRef = useRef<HTMLParagraphElement | null>(null);

    useEffect(() => {
        const request = pendingFocus.current;
        if (!request) return;
        pendingFocus.current = null;
        if (request.kind === 'add') {
            addRefs.current[request.id as 'variables' | 'secrets']?.focus();
        } else if (request.kind === 'name') {
            nameRefs.current.get(request.id)?.focus();
        } else {
            undoRefs.current.get(request.id)?.focus();
        }
    }, [rows]);

    useEffect(() => {
        if (saveError) saveErrorRef.current?.focus();
    }, [saveError]);

    useEffect(() => {
        onDirtyChange?.(dirty);
    }, [onDirtyChange, dirty]);

    const clearConfirmation = () => {
        setStatusText('');
        setSaveError(null);
    };

    const updateRow = (id: string, patch: Partial<EnvRowState>) => {
        clearConfirmation();
        setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    };

    const addRow = (isSecret: boolean) => {
        clearConfirmation();
        const id = nextId();
        setRows((current) => [...current, { id, name: '', value: '', isSecret, isNew: true, pendingRemove: false }]);
        pendingFocus.current = { id, kind: 'name' };
    };

    const removeRow = (row: EnvRowState) => {
        clearConfirmation();
        if (row.isNew && row.name.trim() === '' && (row.value === '' || row.value === null)) {
            // An untouched blank addition never made it into the draft's meaning: it may vanish
            // without ceremony, and focus returns to the Add button that created it.
            setRows((current) => current.filter((candidate) => candidate.id !== row.id));
            pendingFocus.current = { id: row.isSecret ? 'secrets' : 'variables', kind: 'add' };
            return;
        }
        setRows((current) =>
            current.map((candidate) => (candidate.id === row.id ? { ...candidate, pendingRemove: true } : candidate))
        );
        pendingFocus.current = { id: row.id, kind: 'undo' };
    };

    const undoRemove = (row: EnvRowState) => {
        clearConfirmation();
        setRows((current) =>
            current.map((candidate) => (candidate.id === row.id ? { ...candidate, pendingRemove: false } : candidate))
        );
        pendingFocus.current = { id: row.id, kind: 'name' };
    };

    const closeAdvanced = () => {
        setAdvancedOpen(false);
        setAdvancedText('');
        setAdvancedErrors([]);
    };

    const openAdvanced = () => {
        // Entering is a context switch: seed once from the active variable rows and clear a stale
        // error. Secrets are never serialized — their values are write-only and cannot round-trip
        // through text — and pending-removed variables stay out of the seed: applying the
        // untouched text must not resurrect a row the reader is deleting.
        setAdvancedErrors([]);
        setAdvancedText(serializeEnv(rows.filter((row) => !row.isSecret && !row.pendingRemove)));
        setAdvancedOpen(true);
    };

    const applyAdvanced = () => {
        const secretNames = rows.filter((row) => row.isSecret && !row.pendingRemove).map((row) => row.name);
        const result = parseEnvRaw(advancedText, secretNames);
        if (!result.ok) {
            // Invalid text is never silently discarded: the errors render, the text and the
            // disclosure stay open, and the table draft is untouched.
            setAdvancedErrors(result.errors);
            return;
        }
        clearConfirmation();
        const applied: EnvRowState[] = result.vars.map((row) => ({
            id: nextId(),
            name: row.name,
            value: row.value,
            isSecret: false,
            isNew: false,
            pendingRemove: false,
        }));
        // The text is the WHOLE truth for variables — a pending-removal of a variable dissolves
        // here, superseded by the explicit list; secret rows (and their pending states) pass
        // around untouched.
        setRows([...applied, ...rows.filter((row) => row.isSecret)]);
        closeAdvanced();
        setStatusText('Variables applied from .env.');
    };

    const save = async () => {
        if (!canSave) return;
        setSaving(true);
        setSaveError(null);
        try {
            const result = await onSave(envPayload(rows));
            if (result.error) {
                setStatusText('');
                setSaveError(result.error);
            } else {
                // Adopt the stored rows the PUT echoed back — a typed secret value becomes the
                // blank "leave blank to keep" input, and the draft is exactly the store. The
                // confirmation survives because nothing remounts to deliver it.
                const adopted = seedRows(result.vars);
                setBaseline(adopted);
                setRows(adopted);
                closeAdvanced();
                setStatusText('Changes saved.');
            }
        } finally {
            setSaving(false);
        }
    };

    const discard = useCallback(() => setRows(baseline), [baseline]);
    const guarded = !disabled && draftId !== undefined && draftLabel !== undefined;
    const guardedDraft = useMemo(
        () =>
            guarded && draftId !== undefined && draftLabel !== undefined
                ? { id: draftId, label: draftLabel, dirty, discard }
                : null,
        [guarded, draftId, draftLabel, dirty, discard]
    );
    useGuardedDraft(guardedDraft);

    const selectTab = (key: TabKey) => setTab(key);
    const onTabKeyDown = (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
        const next = nextTabIndex(index, 2, event.key);
        if (next === null) return;
        event.preventDefault();
        selectTab(next === 0 ? 'variables' : 'secrets');
        tabRefs.current[next]?.focus();
    };

    // Ordinals count active rows only — a pending-removed row keeps its position but is no longer
    // one of "the N variables" its inputs would otherwise be numbered among.
    let variableOrdinal = 0;
    let secretOrdinal = 0;

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>{title}</h2>
                <div className="panel-actions">
                    <button type="button" className="primary" onClick={() => void save()} disabled={!canSave}>
                        {saving ? 'Saving changes…' : 'Save changes'}
                    </button>
                </div>
            </div>
            {hint ? <p className="muted">{hint}</p> : null}
            {scopeMsg ? (
                <p className="status env-errors" role="alert">
                    {scopeMsg}
                </p>
            ) : null}
            {saveError ? (
                <p ref={saveErrorRef} tabIndex={-1} className="status env-errors" role="alert">
                    {saveError}
                </p>
            ) : null}
            <p className="muted" role="status">
                {statusText}
            </p>

            <div role="tablist" aria-label="Environment variable categories" className="env-tabs">
                {(['variables', 'secrets'] as const).map((key, index) => (
                    <button
                        key={key}
                        type="button"
                        role="tab"
                        id={`${uid}-tab-${key}`}
                        aria-selected={tab === key}
                        aria-controls={`${uid}-panel-${key}`}
                        tabIndex={tab === key ? 0 : -1}
                        className="env-tab"
                        ref={(el) => {
                            tabRefs.current[index] = el;
                        }}
                        onClick={() => selectTab(key)}
                        onKeyDown={(event) => onTabKeyDown(index, event)}
                    >
                        {key === 'variables'
                            ? `Variables (${countActive(rows, false)})`
                            : `Secrets (${countActive(rows, true)})`}
                    </button>
                ))}
            </div>

            <div
                role="tabpanel"
                id={`${uid}-panel-variables`}
                aria-labelledby={`${uid}-tab-variables`}
                hidden={tab !== 'variables'}
            >
                <div className="panel-actions">
                    <button
                        type="button"
                        className="primary"
                        onClick={() => addRow(false)}
                        disabled={locked}
                        ref={(el) => {
                            addRefs.current.variables = el;
                        }}
                    >
                        Add variable
                    </button>
                    <button
                        type="button"
                        aria-expanded={advancedOpen}
                        aria-controls={`${uid}-advanced`}
                        onClick={() => (advancedOpen ? closeAdvanced() : openAdvanced())}
                        disabled={locked}
                    >
                        Edit variables as .env
                    </button>
                </div>
                {advancedOpen ? (
                    <div className="env-raw" id={`${uid}-advanced`}>
                        <p className="env-advanced-note">
                            This replaces the variable draft for this scope. Secrets are never shown here.
                        </p>
                        <textarea
                            aria-label="Variables in .env format"
                            placeholder={'NAME=value\n# one pair per line; a deleted line deletes the variable'}
                            value={advancedText}
                            disabled={locked}
                            onChange={(event) => setAdvancedText(event.target.value)}
                        />
                        <p className="muted">
                            Strict parser: one NAME=value per line, surrounding quotes stripped, no escapes.
                        </p>
                        {advancedErrors.length > 0 ? (
                            <p className="status env-errors" role="alert">
                                {advancedErrors.join('\n')}
                            </p>
                        ) : null}
                        <div className="panel-actions">
                            <button type="button" className="primary" onClick={() => applyAdvanced()} disabled={locked}>
                                Apply .env draft
                            </button>
                            <button type="button" onClick={() => closeAdvanced()} disabled={locked}>
                                Cancel .env changes
                            </button>
                        </div>
                    </div>
                ) : null}
                {/* The table holds the pending-removal strips too, so it renders while ANY row of
                    this type exists — removing the last active row must leave its strip and Undo
                    visible, not an empty scope claiming nothing is configured. */}
                {!rows.some((row) => !row.isSecret) ? <p className="muted">No variables configured.</p> : null}
                {rows.some((row) => !row.isSecret) ? (
                    <table className="env-vars">
                        <thead>
                            <tr>
                                <th scope="col">Name</th>
                                <th scope="col">Value</th>
                                <th scope="col">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => {
                                if (row.isSecret) return null;
                                if (row.pendingRemove) {
                                    return (
                                        <tr key={row.id}>
                                            <td colSpan={3}>
                                                <div className="env-pending">
                                                    <span>
                                                        {row.name.trim() || 'Row'} will be removed when you save.
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={() => undoRemove(row)}
                                                        disabled={locked}
                                                        ref={(el) => {
                                                            undoRefs.current.set(row.id, el);
                                                        }}
                                                    >
                                                        Undo
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                }
                                variableOrdinal += 1;
                                const ordinal = variableOrdinal;
                                const rowErrorList = errors.get(row.id) ?? [];
                                return (
                                    <tr key={row.id}>
                                        <td data-label="Name">
                                            <input
                                                aria-label={`Variable ${ordinal} name`}
                                                value={row.name}
                                                disabled={locked}
                                                aria-invalid={rowErrorList.length > 0}
                                                aria-describedby={
                                                    rowErrorList.length > 0 ? `${row.id}-errors` : undefined
                                                }
                                                ref={(el) => {
                                                    nameRefs.current.set(row.id, el);
                                                }}
                                                onChange={(event) => updateRow(row.id, { name: event.target.value })}
                                            />
                                        </td>
                                        <td data-label="Value">
                                            <input
                                                aria-label={`Variable ${ordinal} value`}
                                                type="text"
                                                value={row.value ?? ''}
                                                disabled={locked}
                                                aria-invalid={rowErrorList.length > 0}
                                                aria-describedby={
                                                    rowErrorList.length > 0 ? `${row.id}-errors` : undefined
                                                }
                                                onChange={(event) => updateRow(row.id, { value: event.target.value })}
                                            />
                                            {rowErrorList.length > 0 ? (
                                                <p id={`${row.id}-errors`} className="env-errors">
                                                    {rowErrorList.join(' ')}
                                                </p>
                                            ) : null}
                                        </td>
                                        <td data-label="Actions">
                                            <button
                                                type="button"
                                                onClick={() => removeRow(row)}
                                                disabled={locked}
                                                aria-label={`Remove ${row.name.trim() || 'variable'}`}
                                            >
                                                ✕
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                ) : null}
            </div>

            <div
                role="tabpanel"
                id={`${uid}-panel-secrets`}
                aria-labelledby={`${uid}-tab-secrets`}
                hidden={tab !== 'secrets'}
            >
                <div className="panel-actions">
                    <button
                        type="button"
                        className="primary"
                        onClick={() => addRow(true)}
                        disabled={locked}
                        ref={(el) => {
                            addRefs.current.secrets = el;
                        }}
                    >
                        Add secret
                    </button>
                </div>
                {!rows.some((row) => row.isSecret) ? <p className="muted">No secrets configured.</p> : null}
                {rows.some((row) => row.isSecret) ? (
                    <table className="env-vars">
                        <thead>
                            <tr>
                                <th scope="col">Name</th>
                                <th scope="col">State / new value</th>
                                <th scope="col">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => {
                                if (!row.isSecret) return null;
                                if (row.pendingRemove) {
                                    return (
                                        <tr key={row.id}>
                                            <td colSpan={3}>
                                                <div className="env-pending">
                                                    <span>
                                                        {row.name.trim() || 'Row'} will be removed when you save.
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={() => undoRemove(row)}
                                                        disabled={locked}
                                                        ref={(el) => {
                                                            undoRefs.current.set(row.id, el);
                                                        }}
                                                    >
                                                        Undo
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                }
                                secretOrdinal += 1;
                                const ordinal = secretOrdinal;
                                const state = secretState(row);
                                const rowErrorList = errors.get(row.id) ?? [];
                                return (
                                    <tr key={row.id}>
                                        <td data-label="Name">
                                            <input
                                                aria-label={`Secret ${ordinal} name`}
                                                value={row.name}
                                                disabled={locked}
                                                aria-invalid={rowErrorList.length > 0}
                                                aria-describedby={
                                                    rowErrorList.length > 0 ? `${row.id}-errors` : undefined
                                                }
                                                ref={(el) => {
                                                    nameRefs.current.set(row.id, el);
                                                }}
                                                onChange={(event) => updateRow(row.id, { name: event.target.value })}
                                            />
                                        </td>
                                        <td data-label="State / new value">
                                            <input
                                                aria-label={`Secret ${ordinal} new value`}
                                                type="password"
                                                autoComplete="off"
                                                value={row.value ?? ''}
                                                placeholder="Leave blank to keep the current secret"
                                                disabled={locked}
                                                aria-invalid={rowErrorList.length > 0}
                                                aria-describedby={
                                                    rowErrorList.length > 0 ? `${row.id}-errors` : undefined
                                                }
                                                onChange={(event) => updateRow(row.id, { value: event.target.value })}
                                            />
                                            <p className="muted">{SECRET_STATE_LABEL[state]}</p>
                                            {rowErrorList.length > 0 ? (
                                                <p id={`${row.id}-errors`} className="env-errors">
                                                    {rowErrorList.join(' ')}
                                                </p>
                                            ) : null}
                                        </td>
                                        <td data-label="Actions">
                                            <button
                                                type="button"
                                                onClick={() => removeRow(row)}
                                                disabled={locked}
                                                aria-label={`Remove ${row.name.trim() || 'secret'}`}
                                            >
                                                ✕
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                ) : null}
            </div>

            {invalid && !scopeMsg ? <p className="env-errors">Fix the highlighted rows to save.</p> : null}
        </section>
    );
}
