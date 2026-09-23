import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, SetStateAction } from 'react';
import type { EnvSaveResult } from '../api/useEnv.js';
import { useGuardedDraft } from '../components/UnsavedChangesDialog.js';
import {
    advancedUnapplied,
    envPayload,
    hasErrors,
    isDirty,
    nextTabIndex,
    rowErrors,
    scopeError,
    seedRows,
} from './env-draft.js';
import type { EnvRowState } from './env-draft.js';
import { parseEnvRaw, serializeEnv } from './env-raw.js';
import { EnvPanelBanner, EnvTabsBar, SecretsTabPanel, VariablesTabPanel } from './env-vars-panel-parts.js';
import type { TabKey } from './env-vars-panel-parts.js';

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

/** Focus routing after add/remove/undo: a request recorded during the state update, resolved
 * once the rows (and their inputs) exist. Split out so the effect that runs it stays a one-liner. */
function resolvePendingFocus(
    request: { id: string; kind: 'name' | 'undo' | 'add' } | null,
    refs: {
        addRefs: { current: { variables: HTMLButtonElement | null; secrets: HTMLButtonElement | null } };
        nameRefs: { current: Map<string, HTMLInputElement | null> };
        undoRefs: { current: Map<string, HTMLButtonElement | null> };
    }
): void {
    if (!request) return;
    if (request.kind === 'add') {
        refs.addRefs.current[request.id as 'variables' | 'secrets']?.focus();
    } else if (request.kind === 'name') {
        refs.nameRefs.current.get(request.id)?.focus();
    } else {
        refs.undoRefs.current.get(request.id)?.focus();
    }
}

/**
 * The scope's rows: the baseline and the local draft, add/update/remove/undo, and the focus
 * routing they trigger. Split out of `EnvVarsPanel` so its own state and effect do not add to
 * the panel's line count.
 */
function useEnvRows(initialVars: EnvVarDraft[], clearConfirmation: () => void) {
    // The seed is captured once per mount — initialVars may arrive as a new array on every parent
    // render (an after-save refetch), and adopting one would silently wipe a typing hand's draft.
    const [baseline, setBaseline] = useState<EnvRowState[]>(() => seedRows(initialVars));
    const [rows, setRows] = useState<EnvRowState[]>(() => seedRows(initialVars));
    const nextIdCounter = useRef(0);
    const nextId = () => {
        nextIdCounter.current += 1;
        return `r${nextIdCounter.current}`;
    };

    const pendingFocus = useRef<{ id: string; kind: 'name' | 'undo' | 'add' } | null>(null);
    const nameRefs = useRef(new Map<string, HTMLInputElement | null>());
    const undoRefs = useRef(new Map<string, HTMLButtonElement | null>());
    const addRefs = useRef<{ variables: HTMLButtonElement | null; secrets: HTMLButtonElement | null }>({
        variables: null,
        secrets: null,
    });

    useEffect(() => {
        const request = pendingFocus.current;
        pendingFocus.current = null;
        resolvePendingFocus(request, { addRefs, nameRefs, undoRefs });
    }, [rows]);

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

    const dirty = useMemo(() => isDirty(baseline, rows), [baseline, rows]);

    return {
        baseline,
        setBaseline,
        rows,
        setRows,
        nextId,
        nameRefs,
        undoRefs,
        addRefs,
        dirty,
        updateRow,
        addRow,
        removeRow,
        undoRemove,
    };
}

/** The save-confirmation state: status text, the error and its focus, and clearing both on any
 * further edit. Split out of `EnvVarsPanel` for the same reason as `useEnvRows`. */
function useEnvSaveState() {
    const [saving, setSaving] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [saveError, setSaveError] = useState<string | null>(null);
    const saveErrorRef = useRef<HTMLParagraphElement | null>(null);

    useEffect(() => {
        if (saveError) saveErrorRef.current?.focus();
    }, [saveError]);

    const clearConfirmation = () => {
        setStatusText('');
        setSaveError(null);
    };

    return { saving, setSaving, statusText, setStatusText, saveError, setSaveError, saveErrorRef, clearConfirmation };
}

/**
 * The .env disclosure: open/closed, its own text and errors, and Apply — which replaces the
 * variable draft only, explicitly; secrets never round-trip through text. Split out of
 * `EnvVarsPanel` for the same reason as `useEnvRows`.
 */
function useAdvancedEnvEditor(input: {
    rows: EnvRowState[];
    setRows: Dispatch<SetStateAction<EnvRowState[]>>;
    nextId: () => string;
    clearConfirmation: () => void;
    setStatusText: (value: string) => void;
}) {
    const { rows, setRows, nextId, clearConfirmation, setStatusText } = input;
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [advancedText, setAdvancedText] = useState('');
    const [advancedErrors, setAdvancedErrors] = useState<string[]>([]);
    const advancedRef = useRef<HTMLDivElement | null>(null);
    const advancedToggleRef = useRef<HTMLButtonElement | null>(null);

    const closeAdvanced = () => {
        // Closing unmounts the disclosure's own controls; when the dismissal came from inside
        // (Apply, Cancel), focus returns to the disclosure's toggle instead of dropping to the
        // document. A dismissal from outside — the save button adopting the echo — leaves focus
        // where it is.
        const active = typeof document === 'undefined' ? null : document.activeElement;
        const fromInside = advancedRef.current !== null && active !== null && advancedRef.current.contains(active);
        setAdvancedOpen(false);
        setAdvancedText('');
        setAdvancedErrors([]);
        if (fromInside) advancedToggleRef.current?.focus();
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

    const unapplied = advancedOpen && advancedUnapplied(advancedText, rows);

    return {
        advancedOpen,
        advancedText,
        setAdvancedText,
        advancedErrors,
        advancedRef,
        advancedToggleRef,
        unapplied,
        openAdvanced,
        closeAdvanced,
        applyAdvanced,
    };
}

/** The whole-list save: adopts the echoed rows as the new baseline on success, an alert on
 * failure. Split out of `EnvVarsPanel` for the same reason as `useEnvRows`. */
function useEnvSaveAction(
    rows: EnvRowState[],
    onSave: EnvVarsPanelProps['onSave'],
    ctx: {
        setBaseline: (rows: EnvRowState[]) => void;
        setRows: (rows: EnvRowState[]) => void;
        setSaving: (value: boolean) => void;
        setStatusText: (value: string) => void;
        setSaveError: (value: string | null) => void;
        closeAdvanced: () => void;
    }
) {
    return async () => {
        ctx.setSaving(true);
        ctx.setSaveError(null);
        try {
            const result = await onSave(envPayload(rows));
            if (result.error) {
                ctx.setStatusText('');
                ctx.setSaveError(result.error);
            } else {
                // Adopt the stored rows the PUT echoed back — a typed secret value becomes the
                // blank "leave blank to keep" input, and the draft is exactly the store. The
                // confirmation survives because nothing remounts to deliver it.
                const adopted = seedRows(result.vars);
                ctx.setBaseline(adopted);
                ctx.setRows(adopted);
                ctx.closeAdvanced();
                ctx.setStatusText('Changes saved.');
            }
        } finally {
            ctx.setSaving(false);
        }
    };
}

/** The tablist's own state: which tab is active, and the roving-tabindex keyboard step. Split
 * out of `EnvVarsPanel` for the same reason as `useEnvRows`. */
function useEnvTabs() {
    const [tab, setTab] = useState<TabKey>('variables');
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

    const selectTab = (key: TabKey) => setTab(key);
    const onTabKeyDown = (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
        const next = nextTabIndex(index, 2, event.key);
        if (next === null) return;
        event.preventDefault();
        selectTab(next === 0 ? 'variables' : 'secrets');
        tabRefs.current[next]?.focus();
    };

    return { tab, tabRefs, selectTab, onTabKeyDown };
}

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
    const uid = useId();
    const tabs = useEnvTabs();
    const saveState = useEnvSaveState();
    const rowsState = useEnvRows(initialVars, saveState.clearConfirmation);
    const advanced = useAdvancedEnvEditor({
        rows: rowsState.rows,
        setRows: rowsState.setRows,
        nextId: rowsState.nextId,
        clearConfirmation: saveState.clearConfirmation,
        setStatusText: saveState.setStatusText,
    });
    const save = useEnvSaveAction(rowsState.rows, onSave, {
        setBaseline: rowsState.setBaseline,
        setRows: rowsState.setRows,
        setSaving: saveState.setSaving,
        setStatusText: saveState.setStatusText,
        setSaveError: saveState.setSaveError,
        closeAdvanced: advanced.closeAdvanced,
    });

    const errors = useMemo(() => rowErrors(rowsState.rows), [rowsState.rows]);
    const scopeMsg = useMemo(() => scopeError(rowsState.rows), [rowsState.rows]);
    const invalid = hasErrors(errors, scopeMsg);
    const locked = disabled || saveState.saving;
    const canSave = !disabled && !saveState.saving && rowsState.dirty && !invalid && !advanced.unapplied;

    useEffect(() => {
        onDirtyChange?.(rowsState.dirty);
    }, [onDirtyChange, rowsState.dirty]);

    const discard = useCallback(() => rowsState.setRows(rowsState.baseline), [rowsState.setRows, rowsState.baseline]);
    const guarded = !disabled && draftId !== undefined && draftLabel !== undefined;
    const guardedDraft = useMemo(
        () =>
            guarded && draftId !== undefined && draftLabel !== undefined
                ? { id: draftId, label: draftLabel, dirty: rowsState.dirty, discard }
                : null,
        [guarded, draftId, draftLabel, rowsState.dirty, discard]
    );
    useGuardedDraft(guardedDraft);

    return (
        <section className="panel">
            <EnvPanelBanner
                title={title}
                hint={hint}
                scopeMsg={scopeMsg}
                saveError={saveState.saveError}
                saveErrorRef={(el) => {
                    saveState.saveErrorRef.current = el;
                }}
                statusText={saveState.statusText}
                saving={saveState.saving}
                canSave={canSave}
                onSave={() => {
                    if (canSave) void save();
                }}
            />

            <EnvTabsBar
                uid={uid}
                tab={tabs.tab}
                rows={rowsState.rows}
                tabRefs={tabs.tabRefs}
                onSelect={tabs.selectTab}
                onKeyDown={tabs.onTabKeyDown}
            />

            <VariablesTabPanel
                uid={uid}
                tab={tabs.tab}
                rows={rowsState.rows}
                errors={errors}
                locked={locked}
                onAdd={() => rowsState.addRow(false)}
                addButtonRef={(el) => {
                    rowsState.addRefs.current.variables = el;
                }}
                advancedOpen={advanced.advancedOpen}
                advancedText={advanced.advancedText}
                advancedErrors={advanced.advancedErrors}
                onToggleAdvanced={() => (advanced.advancedOpen ? advanced.closeAdvanced() : advanced.openAdvanced())}
                onAdvancedTextChange={advanced.setAdvancedText}
                onApplyAdvanced={advanced.applyAdvanced}
                onCancelAdvanced={advanced.closeAdvanced}
                advancedContainerRef={(el) => {
                    advanced.advancedRef.current = el;
                }}
                advancedToggleRef={(el) => {
                    advanced.advancedToggleRef.current = el;
                }}
                onUpdate={rowsState.updateRow}
                onRemove={rowsState.removeRow}
                onUndoRemove={rowsState.undoRemove}
                nameRefs={rowsState.nameRefs}
                undoRefs={rowsState.undoRefs}
            />

            <SecretsTabPanel
                uid={uid}
                tab={tabs.tab}
                rows={rowsState.rows}
                errors={errors}
                locked={locked}
                onAdd={() => rowsState.addRow(true)}
                addButtonRef={(el) => {
                    rowsState.addRefs.current.secrets = el;
                }}
                onUpdate={rowsState.updateRow}
                onRemove={rowsState.removeRow}
                onUndoRemove={rowsState.undoRemove}
                nameRefs={rowsState.nameRefs}
                undoRefs={rowsState.undoRefs}
            />

            {invalid && !scopeMsg ? <p className="env-errors">Fix the highlighted rows to save.</p> : null}
        </section>
    );
}
