import { useEffect, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { EXECUTOR_TYPES, type ExecutorType } from '@factory-ai/core';
import {
    EXECUTOR_TYPE_META,
    executorTypeLabel,
    mergeExecutors,
    validateExecutorConfig,
    validateExecutorPayload,
    type ExecutorRow,
} from '../workspace/executors.js';

/**
 * Add an executor, or edit an existing one.
 *
 * The Headless-UI bargain: the `Dialog` buys the top layer, focus
 * trapping, focus restoration, the backdrop and Escape without a hand-rolled trap; no `<form>`
 * submits because CSP sends `form-action 'none'`. The one difference in body is a textarea for
 * the pasted JSON, re-validated on every keystroke by the pure validator — cheap, and the message
 * under the field is what makes raw JSON pasteable at all. Issue 183 makes the help tell the
 * truth per type (EXECUTOR_TYPE_META): what the config is stored for and what consumes it. The
 * note under the Type select says that the type selects the runner for tasks using this profile.
 * Both helps are tied to their fields
 * with `aria-describedby`, and the textarea's parse error is `aria-invalid` plus a described-by
 * error, the content itself retained.
 *
 * The dialog receives the whole list as it opened — configs included, fetched on demand — because
 * the PUT is a whole-list replace: add appends to it, edit folds the changed row back in
 * (`mergeExecutors`), and the untouched rows travel through unchanged. A failed save keeps the
 * dialog and everything typed in it; a successful one closes and Headless restores focus to the
 * trigger (the page-header Add or the row's Edit — an edit that renames the row unmounts that
 * trigger mid-save, where restore no-ops, the same cosmetic edge any dialog-over-a-list has).
 */

/** The save action's copy — "Add executor" on add, "Save executor" on edit (issue 183). */
export const ADD_LABEL = 'Add executor';
export const SAVE_LABEL = 'Save executor';

/** What choosing a Type does; tied to the select with aria-describedby. */
export const TYPE_CONFIG_NOTE = 'Tasks using this executor run with the selected type: Claude Code or OpenCode.';

export interface ExecutorDialogProps {
    open: boolean;
    /** The whole executor list as the dialog opened it, configs included. */
    existing: readonly ExecutorRow[];
    /** The name of the row being edited, matched as it was when the dialog opened; null to add. */
    editing: string | null;
    onClose: () => void;
    onSave: (executors: { name: string; type: string; config: object; isDefault: boolean }[]) => Promise<string | null>;
    saving: boolean;
}

export function ExecutorDialog({ open, existing, editing, onClose, onSave, saving }: ExecutorDialogProps) {
    const [type, setType] = useState<ExecutorType>(EXECUTOR_TYPES[0]);
    const [name, setName] = useState('');
    const [config, setConfig] = useState('');
    const [failure, setFailure] = useState<string | null>(null);

    // Add opens blank; edit opens pre-filled from the row it is editing. Re-keyed off `editing`
    // too, so switching rows without closing still lands on the right one.
    useEffect(() => {
        if (open) {
            const row = editing === null ? undefined : existing.find((executor) => executor.name === editing);
            setType(row ? (row.type as ExecutorType) : EXECUTOR_TYPES[0]);
            setName(row?.name ?? '');
            setConfig(row ? JSON.stringify(row.config, null, 2) : '');
            setFailure(null);
        }
        // `existing` is deliberately not a dependency: it is captured at open time and stays put
        // while the dialog is up, and re-seeding the fields mid-edit would discard typing.
    }, [open, editing]);

    const payload = validateExecutorPayload(config, type);
    const validation = validateExecutorConfig(config, name, type);
    // The textarea's live error is the payload's — parse, object, size — never the name's: a
    // blank name is announced against the name field, not as the config field's problem.
    const parseError: string | null = config.trim() && !payload.ok ? payload.error : null;

    const save = async () => {
        if (!validation.ok) {
            setFailure(validation.error);
            return;
        }
        const merged = mergeExecutors(existing, editing, validation.value);
        if (!merged.ok) {
            setFailure(merged.error);
            return;
        }
        const message = await onSave(merged.value);
        setFailure(message);
        if (!message) onClose();
    };

    return (
        <Dialog open={open} onClose={onClose} className="dialog-layer" aria-labelledby="executor-title">
            <div className="dialog-backdrop" aria-hidden="true" />
            <div className="dialog-position">
                <DialogPanel className="picker">
                    <DialogTitle as="h2" id="executor-title">
                        {editing ? 'Edit executor' : 'Add executor'}
                    </DialogTitle>
                    <p className="muted">
                        An executor is what runs your agents' work. Paste its configuration as raw JSON.
                    </p>

                    <label className="picker-search">
                        <span className="muted">type</span>
                        <select
                            value={type}
                            aria-describedby="executor-type-help"
                            onChange={(event) => setType(event.target.value as ExecutorType)}
                        >
                            {/* Rendered from the shared list, so a future type needs no JSX change. */}
                            {EXECUTOR_TYPES.map((value) => (
                                <option key={value} value={value}>
                                    {executorTypeLabel(value)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <p className="muted" id="executor-type-help">
                        {TYPE_CONFIG_NOTE}
                    </p>

                    <label className="picker-search">
                        <span className="muted">name</span>
                        <input
                            type="text"
                            value={name}
                            placeholder="main"
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>

                    <label className="picker-search">
                        <span className="muted">config (JSON)</span>
                        <textarea
                            rows={8}
                            value={config}
                            placeholder={EXECUTOR_TYPE_META[type].example}
                            aria-invalid={parseError ? true : undefined}
                            aria-describedby={['executor-config-help', parseError ? 'executor-config-error' : null]
                                .filter(Boolean)
                                .join(' ')}
                            onChange={(event) => setConfig(event.target.value)}
                        />
                    </label>
                    <p className="muted" id="executor-config-help">
                        {EXECUTOR_TYPE_META[type].configHelp}
                    </p>
                    {/* Re-validated per keystroke; rendered live, before Save is even pressed, and
                        tied back to the textarea so a screen reader hears it as its error. */}
                    {parseError ? (
                        <p className="status" id="executor-config-error">
                            {parseError}
                        </p>
                    ) : null}

                    {failure ? (
                        <p className="status" role="alert">
                            {failure}
                        </p>
                    ) : null}

                    {/* type="button" throughout: a submitting form would be blocked by form-action 'none'. */}
                    <div className="picker-actions">
                        <button type="button" onClick={onClose}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="primary"
                            onClick={() => void save()}
                            disabled={saving || !validation.ok}
                        >
                            {saving ? 'Saving…' : editing ? SAVE_LABEL : ADD_LABEL}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
