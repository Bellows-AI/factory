import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { countActive, SECRET_STATE_LABEL, secretState } from './env-draft.js';
import type { EnvRowState, RowFieldErrors } from './env-draft.js';

/**
 * The presentational half of `EnvVarsPanel.tsx`: the tablist, the .env disclosure, the panel
 * banner, and the row/table rendering — every piece that only takes props and renders markup.
 * Split into its own file so the stateful panel stays under the per-file line limit; these carry
 * no state of their own and no fetching.
 */

export type TabKey = 'variables' | 'secrets';
export type EnvRowKind = 'variable' | 'secret';

/**
 * The rows of one kind (variable or secret), each paired with its 1-based ordinal — assigned
 * only to active rows, so a pending-removed row keeps its position without occupying a number
 * "the N variables" would otherwise count it among.
 */
export function rowsWithOrdinal(
    rows: readonly EnvRowState[],
    kind: EnvRowKind
): { row: EnvRowState; ordinal: number }[] {
    const isSecret = kind === 'secret';
    let ordinal = 0;
    const entries: { row: EnvRowState; ordinal: number }[] = [];
    for (const row of rows) {
        if (row.isSecret !== isSecret) continue;
        if (!row.pendingRemove) ordinal += 1;
        entries.push({ row, ordinal });
    }
    return entries;
}

/** The pending-removal strip: a row's name plus Undo, spanning every column. Split out so the
 * table's map callback stays trivial. */
export function PendingRemoveRow({
    row,
    locked,
    onUndo,
    undoRef,
}: {
    row: EnvRowState;
    locked: boolean;
    onUndo: () => void;
    undoRef: (el: HTMLButtonElement | null) => void;
}) {
    return (
        <tr>
            <td colSpan={3}>
                <div className="env-pending">
                    <span>{row.name.trim() || 'Row'} will be removed when you save.</span>
                    <button type="button" onClick={onUndo} disabled={locked} ref={undoRef}>
                        Undo
                    </button>
                </div>
            </td>
        </tr>
    );
}

/**
 * One editable variable or secret row: name, value (a secret's is masked, defaults to the
 * keep-what-is-stored placeholder, and carries its State line), and Remove. Split out of
 * `EnvVarsPanel` so the table's map callback stays under the complexity limit.
 */
export function EnvEditableRow({
    row,
    kind,
    ordinal,
    fieldErrors,
    locked,
    onUpdate,
    onRemove,
    nameRef,
}: {
    row: EnvRowState;
    kind: EnvRowKind;
    ordinal: number;
    fieldErrors: RowFieldErrors;
    locked: boolean;
    onUpdate: (id: string, patch: Partial<EnvRowState>) => void;
    onRemove: () => void;
    nameRef: (el: HTMLInputElement | null) => void;
}) {
    const nameInvalid = fieldErrors.name.length > 0;
    const valueInvalid = fieldErrors.value.length > 0;
    const nameErrorsId = `${row.id}-name-errors`;
    const valueErrorsId = `${row.id}-value-errors`;
    const label = kind === 'variable' ? 'Variable' : 'Secret';
    return (
        <tr>
            <td data-label="Name">
                <input
                    aria-label={`${label} ${ordinal} name`}
                    value={row.name}
                    disabled={locked}
                    aria-invalid={nameInvalid}
                    aria-describedby={nameInvalid ? nameErrorsId : undefined}
                    ref={nameRef}
                    onChange={(event) => onUpdate(row.id, { name: event.target.value })}
                />
                {nameInvalid ? (
                    <p id={nameErrorsId} className="env-errors error">
                        {fieldErrors.name.join(' ')}
                    </p>
                ) : null}
            </td>
            <td data-label={kind === 'variable' ? 'Value' : 'State / new value'}>
                <input
                    aria-label={`${label} ${ordinal} ${kind === 'variable' ? 'value' : 'new value'}`}
                    type={kind === 'variable' ? 'text' : 'password'}
                    autoComplete={kind === 'secret' ? 'off' : undefined}
                    value={row.value ?? ''}
                    placeholder={kind === 'secret' ? 'Leave blank to keep the current secret' : undefined}
                    disabled={locked}
                    aria-invalid={valueInvalid}
                    aria-describedby={valueInvalid ? valueErrorsId : undefined}
                    onChange={(event) => onUpdate(row.id, { value: event.target.value })}
                />
                {kind === 'secret' ? <p className="muted">{SECRET_STATE_LABEL[secretState(row)]}</p> : null}
                {valueInvalid ? (
                    <p id={valueErrorsId} className="env-errors error">
                        {fieldErrors.value.join(' ')}
                    </p>
                ) : null}
            </td>
            <td data-label="Actions">
                <button
                    type="button"
                    className="env-row-remove"
                    onClick={onRemove}
                    disabled={locked}
                    aria-label={`Remove ${row.name.trim() || kind}`}
                >
                    ✕
                </button>
            </td>
        </tr>
    );
}

/**
 * One kind's whole table: the "nothing configured" line while there are no rows of it (pending
 * removals included — their strip is still a row), or the table with one row per entry. Split
 * out of `EnvVarsPanel` for the same reason as `EnvEditableRow`.
 */
const NO_FIELD_ERRORS: RowFieldErrors = { name: [], value: [] };

export function EnvTable({
    rows,
    kind,
    errors,
    locked,
    onUpdate,
    onRemove,
    onUndoRemove,
    nameRefs,
    undoRefs,
}: {
    rows: readonly EnvRowState[];
    kind: EnvRowKind;
    errors: Map<string, RowFieldErrors>;
    locked: boolean;
    onUpdate: (id: string, patch: Partial<EnvRowState>) => void;
    onRemove: (row: EnvRowState) => void;
    onUndoRemove: (row: EnvRowState) => void;
    nameRefs: { current: Map<string, HTMLInputElement | null> };
    undoRefs: { current: Map<string, HTMLButtonElement | null> };
}) {
    const entries = rowsWithOrdinal(rows, kind);
    if (entries.length === 0) {
        return <p className="muted">No {kind === 'variable' ? 'variables' : 'secrets'} configured.</p>;
    }
    return (
        <table className="env-vars">
            <thead>
                <tr>
                    <th scope="col">Name</th>
                    <th scope="col">{kind === 'variable' ? 'Value' : 'State / new value'}</th>
                    <th scope="col">Actions</th>
                </tr>
            </thead>
            <tbody>
                {entries.map(({ row, ordinal }) =>
                    row.pendingRemove ? (
                        <PendingRemoveRow
                            key={row.id}
                            row={row}
                            locked={locked}
                            onUndo={() => onUndoRemove(row)}
                            undoRef={(el) => undoRefs.current.set(row.id, el)}
                        />
                    ) : (
                        <EnvEditableRow
                            key={row.id}
                            row={row}
                            kind={kind}
                            ordinal={ordinal}
                            fieldErrors={errors.get(row.id) ?? NO_FIELD_ERRORS}
                            locked={locked}
                            onUpdate={onUpdate}
                            onRemove={() => onRemove(row)}
                            nameRef={(el) => nameRefs.current.set(row.id, el)}
                        />
                    )
                )}
            </tbody>
        </table>
    );
}

/** The tablist switching Variables and Secrets, with live counts. Split out of `EnvVarsPanel` so
 * its own markup does not add to the panel's line count. */
export function EnvTabsBar({
    uid,
    tab,
    rows,
    tabRefs,
    onSelect,
    onKeyDown,
}: {
    uid: string;
    tab: TabKey;
    rows: readonly EnvRowState[];
    tabRefs: { current: (HTMLButtonElement | null)[] };
    onSelect: (key: TabKey) => void;
    onKeyDown: (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
    return (
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
                    onClick={() => onSelect(key)}
                    onKeyDown={(event) => onKeyDown(index, event)}
                >
                    {key === 'variables'
                        ? `Variables (${countActive(rows, false)})`
                        : `Secrets (${countActive(rows, true)})`}
                </button>
            ))}
        </div>
    );
}

/**
 * The .env disclosure: replaces the variable draft only, explicitly, through Apply — secrets
 * never round-trip through text. Split out of `EnvVarsPanel` for the same reason as `EnvTabsBar`.
 */
export function AdvancedEnvEditor({
    uid,
    text,
    errors,
    locked,
    onTextChange,
    onApply,
    onCancel,
    containerRef,
}: {
    uid: string;
    text: string;
    errors: readonly string[];
    locked: boolean;
    onTextChange: (value: string) => void;
    onApply: () => void;
    onCancel: () => void;
    containerRef: (el: HTMLDivElement | null) => void;
}) {
    return (
        <div className="env-raw" id={`${uid}-advanced`} ref={containerRef}>
            <p className="env-advanced-note">
                This replaces the variable draft for this scope. Secrets are never shown here.
            </p>
            <textarea
                aria-label="Variables in .env format"
                placeholder={'NAME=value\n# one pair per line; a deleted line deletes the variable'}
                value={text}
                disabled={locked}
                onChange={(event) => onTextChange(event.target.value)}
            />
            <p className="muted">Strict parser: one NAME=value per line, surrounding quotes stripped, no escapes.</p>
            {errors.length > 0 ? (
                <p className="status env-errors error" role="alert">
                    {errors.join('\n')}
                </p>
            ) : null}
            <div className="panel-actions">
                <button type="button" onClick={onApply} disabled={locked}>
                    Apply .env draft
                </button>
                <button type="button" onClick={onCancel} disabled={locked}>
                    Cancel .env changes
                </button>
            </div>
        </div>
    );
}

/** The panel's title, Save button, and the hint/error/status lines beneath it. Split out of
 * `EnvVarsPanel` so its own markup does not add to the panel's line count. */
export function EnvPanelBanner({
    title,
    hint,
    scopeMsg,
    saveError,
    saveErrorRef,
    statusText,
    saving,
    canSave,
    onSave,
}: {
    title: string;
    hint: string;
    scopeMsg: string | null;
    saveError: string | null;
    saveErrorRef: (el: HTMLParagraphElement | null) => void;
    statusText: string;
    saving: boolean;
    canSave: boolean;
    onSave: () => void;
}) {
    return (
        <>
            <div className="panel-head">
                <h2>{title}</h2>
                <div className="panel-actions">
                    <button type="button" className="primary" onClick={onSave} disabled={!canSave}>
                        {saving ? 'Saving changes…' : 'Save changes'}
                    </button>
                </div>
            </div>
            {hint ? <p className="muted">{hint}</p> : null}
            {scopeMsg ? (
                <p className="status env-errors error" role="alert">
                    {scopeMsg}
                </p>
            ) : null}
            {saveError ? (
                <p ref={saveErrorRef} tabIndex={-1} className="status env-errors error" role="alert">
                    {saveError}
                </p>
            ) : null}
            <p className="muted" role="status">
                {statusText}
            </p>
        </>
    );
}

/**
 * The Variables tabpanel: the Add button, the .env disclosure toggle and its editor, and the
 * table. Split out of `EnvVarsPanel` for the same reason as `EnvPanelBanner`.
 */
export function VariablesTabPanel({
    uid,
    tab,
    rows,
    errors,
    locked,
    onAdd,
    addButtonRef,
    advancedOpen,
    advancedText,
    advancedErrors,
    onToggleAdvanced,
    onAdvancedTextChange,
    onApplyAdvanced,
    onCancelAdvanced,
    advancedContainerRef,
    advancedToggleRef,
    onUpdate,
    onRemove,
    onUndoRemove,
    nameRefs,
    undoRefs,
}: {
    uid: string;
    tab: TabKey;
    rows: readonly EnvRowState[];
    errors: Map<string, RowFieldErrors>;
    locked: boolean;
    onAdd: () => void;
    addButtonRef: (el: HTMLButtonElement | null) => void;
    advancedOpen: boolean;
    advancedText: string;
    advancedErrors: readonly string[];
    onToggleAdvanced: () => void;
    onAdvancedTextChange: (value: string) => void;
    onApplyAdvanced: () => void;
    onCancelAdvanced: () => void;
    advancedContainerRef: (el: HTMLDivElement | null) => void;
    advancedToggleRef: (el: HTMLButtonElement | null) => void;
    onUpdate: (id: string, patch: Partial<EnvRowState>) => void;
    onRemove: (row: EnvRowState) => void;
    onUndoRemove: (row: EnvRowState) => void;
    nameRefs: { current: Map<string, HTMLInputElement | null> };
    undoRefs: { current: Map<string, HTMLButtonElement | null> };
}) {
    return (
        <div
            role="tabpanel"
            id={`${uid}-panel-variables`}
            aria-labelledby={`${uid}-tab-variables`}
            hidden={tab !== 'variables'}
        >
            {/* The table holds the pending-removal strips too, so it renders while ANY row of
                this type exists — removing the last active row must leave its strip and Undo
                visible, not an empty scope claiming nothing is configured. */}
            <EnvTable
                rows={rows}
                kind="variable"
                errors={errors}
                locked={locked}
                onUpdate={onUpdate}
                onRemove={onRemove}
                onUndoRemove={onUndoRemove}
                nameRefs={nameRefs}
                undoRefs={undoRefs}
            />
            <div className="env-row-actions">
                <button type="button" className="env-add" onClick={onAdd} disabled={locked} ref={addButtonRef}>
                    Add variable
                </button>
                <button
                    type="button"
                    className="env-advanced-toggle"
                    aria-expanded={advancedOpen}
                    aria-controls={`${uid}-advanced`}
                    onClick={onToggleAdvanced}
                    disabled={locked}
                    ref={advancedToggleRef}
                >
                    Edit variables as .env
                </button>
            </div>
            {advancedOpen ? (
                <AdvancedEnvEditor
                    uid={uid}
                    text={advancedText}
                    errors={advancedErrors}
                    locked={locked}
                    onTextChange={onAdvancedTextChange}
                    onApply={onApplyAdvanced}
                    onCancel={onCancelAdvanced}
                    containerRef={advancedContainerRef}
                />
            ) : null}
        </div>
    );
}

/**
 * The Secrets tabpanel: the Add button and the table — no .env disclosure, since secrets never
 * round-trip through text. Split out of `EnvVarsPanel` for the same reason as `EnvPanelBanner`.
 */
export function SecretsTabPanel({
    uid,
    tab,
    rows,
    errors,
    locked,
    onAdd,
    addButtonRef,
    onUpdate,
    onRemove,
    onUndoRemove,
    nameRefs,
    undoRefs,
}: {
    uid: string;
    tab: TabKey;
    rows: readonly EnvRowState[];
    errors: Map<string, RowFieldErrors>;
    locked: boolean;
    onAdd: () => void;
    addButtonRef: (el: HTMLButtonElement | null) => void;
    onUpdate: (id: string, patch: Partial<EnvRowState>) => void;
    onRemove: (row: EnvRowState) => void;
    onUndoRemove: (row: EnvRowState) => void;
    nameRefs: { current: Map<string, HTMLInputElement | null> };
    undoRefs: { current: Map<string, HTMLButtonElement | null> };
}) {
    return (
        <div
            role="tabpanel"
            id={`${uid}-panel-secrets`}
            aria-labelledby={`${uid}-tab-secrets`}
            hidden={tab !== 'secrets'}
        >
            <EnvTable
                rows={rows}
                kind="secret"
                errors={errors}
                locked={locked}
                onUpdate={onUpdate}
                onRemove={onRemove}
                onUndoRemove={onUndoRemove}
                nameRefs={nameRefs}
                undoRefs={undoRefs}
            />
            <div className="env-row-actions">
                <button type="button" className="env-add" onClick={onAdd} disabled={locked} ref={addButtonRef}>
                    Add secret
                </button>
            </div>
        </div>
    );
}
