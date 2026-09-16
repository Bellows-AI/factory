import { useState } from 'react';
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
    onSave: (vars: { name: string; value: string | null; isSecret: boolean }[]) => Promise<string | null>;
    /** Rendered read-only while the PUT is in flight or the scope is not the caller's to edit. */
    disabled?: boolean;
}

/**
 * The editor for one environment scope: org ("core"), the member's workspace, or one repository.
 *
 * Two tabs split the scope's rows by `isSecret`. Variables edits through a `raw` toggle: on, the
 * table is replaced by a textarea holding the scope's non-secret variables one `NAME=value` per
 * line (env-raw.ts), and toggling off parses it with the same strict rules the server enforces —
 * valid text replaces the draft's variable rows (a deleted line deletes the variable), invalid
 * text shows the line errors and stays in the editor. Secrets keeps the old masked flow verbatim:
 * no raw editor, blank means keep what is stored, and the flag of a stored secret stays locked
 * because its value was never sent here. Draft state spans tabs; Save submits one merged list
 * exactly as before.
 *
 * The whole list is the unit of save — the PUT replaces the scope's rows, so a retried request
 * changes nothing. A row whose name is cleared is dropped from the payload entirely, which is how
 * a deletion looks; a secret left blank keeps whatever is stored, because the panel never had the
 * value to send back.
 *
 * Both tab panels always render (the inactive one carries `hidden`), because the page is
 * server-render-tested by markup assertions, not by clicking.
 *
 * No `<form>`: the CSP sends `form-action 'none'`, so a submit would be blocked at the browser —
 * the same trap that makes LoginGate an anchor.
 */
export function EnvVarsPanel({ title, hint, initialVars, onSave, disabled = false }: EnvVarsPanelProps) {
    const [rows, setRows] = useState<EnvVarDraft[]>(() => initialVars.map((row) => ({ ...row })));
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [saving, setSaving] = useState(false);
    const [tab, setTab] = useState<'variables' | 'secrets'>('variables');
    const [rawOpen, setRawOpen] = useState(false);
    const [rawText, setRawText] = useState('');

    const update = (index: number, patch: Partial<EnvVarDraft>) => {
        setSaved(false);
        setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    };

    const addRow = (isSecret: boolean) => {
        setSaved(false);
        setRows((current) => [...current, { name: '', value: '', isSecret }]);
    };

    const removeRow = (index: number) => {
        setSaved(false);
        setRows((current) => current.filter((_, i) => i !== index));
    };

    const toggleRaw = () => {
        if (!rawOpen) {
            // Entering the editor is a context switch: seed once from the current draft and clear
            // a stale error, exactly as the old cancel did. Secrets are never serialized — their
            // values are write-only and cannot round-trip through text.
            setError(null);
            setRawText(serializeEnv(rows));
            setRawOpen(true);
            return;
        }
        const result = parseEnvRaw(
            rawText,
            rows.filter((row) => row.isSecret).map((row) => row.name)
        );
        if (!result.ok) {
            // Invalid text is never silently discarded: the errors render and the panel stays in
            // raw mode with the entered text intact.
            setError(result.errors.join('\n'));
            return;
        }
        setSaved(false);
        setError(null);
        setRows([...result.vars, ...rows.filter((row) => row.isSecret)]);
        setRawOpen(false);
        setRawText('');
    };

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            // A blank name is a row somebody added and never filled in — dropped, not saved.
            const payload = rows
                .filter((row) => row.name.trim() !== '')
                .map((row) => ({
                    name: row.name.trim(),
                    // Blank on a secret is the keep marker — and so is the untouched null the
                    // write-only echo delivered: either way the panel never held a value to send
                    // back, and a '' here would overwrite the stored credential. Blank on a
                    // readable value is an honest empty string.
                    value: row.isSecret && (row.value === '' || row.value === null) ? null : (row.value ?? ''),
                    isSecret: row.isSecret,
                }));
            const failure = await onSave(payload);
            if (failure) setError(failure);
            else setSaved(true);
        } finally {
            setSaving(false);
        }
    };

    const locked = disabled || saving;
    const variableRows = rows.filter((row) => !row.isSecret);
    const secretRows = rows.filter((row) => row.isSecret);

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>{title}</h2>
                <div className="panel-actions">
                    {tab === 'variables' ? (
                        <>
                            <button type="button" aria-pressed={rawOpen} onClick={() => toggleRaw()} disabled={locked}>
                                raw
                            </button>
                            {!rawOpen ? (
                                <button
                                    type="button"
                                    className="primary"
                                    onClick={() => addRow(false)}
                                    disabled={locked}
                                >
                                    Add variable
                                </button>
                            ) : null}
                        </>
                    ) : (
                        <button type="button" className="primary" onClick={() => addRow(true)} disabled={locked}>
                            Add secret
                        </button>
                    )}
                </div>
            </div>
            {hint ? <p className="muted">{hint}</p> : null}
            {error ? <p className="status env-errors">{error}</p> : null}
            {saved ? <p className="muted">Saved.</p> : null}

            <div className="env-tabs">
                <button
                    type="button"
                    className={tab === 'variables' ? 'env-tab active' : 'env-tab'}
                    aria-pressed={tab === 'variables'}
                    onClick={() => setTab('variables')}
                >
                    Variables
                </button>
                <button
                    type="button"
                    className={tab === 'secrets' ? 'env-tab active' : 'env-tab'}
                    aria-pressed={tab === 'secrets'}
                    onClick={() => setTab('secrets')}
                >
                    Secrets
                </button>
            </div>

            <div hidden={tab !== 'variables'}>
                {rawOpen ? (
                    <div className="env-raw">
                        <textarea
                            aria-label="Raw .env editor"
                            placeholder={'KEY=value\n# one pair per line; a deleted line deletes the variable'}
                            value={rawText}
                            disabled={locked}
                            onChange={(e) => {
                                setSaved(false);
                                setRawText(e.target.value);
                            }}
                        />
                    </div>
                ) : (
                    <>
                        {variableRows.length === 0 ? <p className="muted">No variables configured.</p> : null}
                        {variableRows.length > 0 ? (
                            <table className="env-vars">
                                <thead>
                                    <tr>
                                        <th scope="col">Name</th>
                                        <th scope="col">Value</th>
                                        <th scope="col">
                                            <span className="visually-hidden">Remove</span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((row, index) =>
                                        row.isSecret ? null : (
                                            <tr key={index}>
                                                <td>
                                                    <input
                                                        aria-label="Variable name"
                                                        value={row.name}
                                                        disabled={locked}
                                                        onChange={(e) => update(index, { name: e.target.value })}
                                                    />
                                                </td>
                                                <td>
                                                    <input
                                                        aria-label="Value"
                                                        type="text"
                                                        value={row.value ?? ''}
                                                        disabled={locked}
                                                        onChange={(e) => update(index, { value: e.target.value })}
                                                    />
                                                </td>
                                                <td>
                                                    <button
                                                        type="button"
                                                        onClick={() => removeRow(index)}
                                                        disabled={locked}
                                                        aria-label={`Remove ${row.name || 'variable'}`}
                                                    >
                                                        ✕
                                                    </button>
                                                </td>
                                            </tr>
                                        )
                                    )}
                                </tbody>
                            </table>
                        ) : null}
                    </>
                )}
            </div>

            <div hidden={tab !== 'secrets'}>
                {secretRows.length === 0 ? <p className="muted">No secrets configured.</p> : null}
                {secretRows.length > 0 ? (
                    <table className="env-vars">
                        <thead>
                            <tr>
                                <th scope="col">Name</th>
                                <th scope="col">Value</th>
                                <th scope="col">Secret</th>
                                <th scope="col">
                                    <span className="visually-hidden">Remove</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, index) =>
                                row.isSecret ? (
                                    <tr key={index}>
                                        <td>
                                            <input
                                                aria-label="Variable name"
                                                value={row.name}
                                                disabled={locked}
                                                onChange={(e) => update(index, { name: e.target.value })}
                                            />
                                        </td>
                                        <td>
                                            <input
                                                aria-label="Secret value"
                                                type="password"
                                                autoComplete="off"
                                                value={row.value ?? ''}
                                                placeholder="set — leave blank to keep"
                                                disabled={locked}
                                                onChange={(e) => update(index, { value: e.target.value })}
                                            />
                                        </td>
                                        <td>
                                            <label>
                                                <input
                                                    type="checkbox"
                                                    checked={row.isSecret}
                                                    // A stored secret's value was never sent here, so
                                                    // unchecking would save an empty string over a
                                                    // credential nobody can see. Re-entering the value
                                                    // unlocks the flag.
                                                    disabled={locked || (row.isSecret && row.value === null)}
                                                    title={
                                                        row.isSecret && row.value === null
                                                            ? 'The stored value is hidden; type a new value to change this'
                                                            : undefined
                                                    }
                                                    onChange={(e) => update(index, { isSecret: e.target.checked })}
                                                />{' '}
                                                secret
                                            </label>
                                        </td>
                                        <td>
                                            <button
                                                type="button"
                                                onClick={() => removeRow(index)}
                                                disabled={locked}
                                                aria-label={`Remove ${row.name || 'secret'}`}
                                            >
                                                ✕
                                            </button>
                                        </td>
                                    </tr>
                                ) : null
                            )}
                        </tbody>
                    </table>
                ) : null}
            </div>

            <button type="button" onClick={() => void save()} disabled={locked}>
                {saving ? 'Saving…' : 'Save'}
            </button>
        </section>
    );
}
