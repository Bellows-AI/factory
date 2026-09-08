import { useState } from 'react';

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
 * The whole list is the unit of save — the PUT replaces the scope's rows, so a retried request
 * changes nothing. A row whose name is cleared is dropped from the payload entirely, which is how
 * a deletion looks; a secret left blank keeps whatever is stored, because the panel never had the
 * value to send back.
 *
 * No `<form>`: the CSP sends `form-action 'none'`, so a submit would be blocked at the browser —
 * the same trap that makes LoginGate an anchor.
 */
export function EnvVarsPanel({ title, hint, initialVars, onSave, disabled = false }: EnvVarsPanelProps) {
    const [rows, setRows] = useState<EnvVarDraft[]>(() => initialVars.map((row) => ({ ...row })));
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [saving, setSaving] = useState(false);

    const update = (index: number, patch: Partial<EnvVarDraft>) => {
        setSaved(false);
        setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    };

    const addRow = () => {
        setSaved(false);
        setRows((current) => [...current, { name: '', value: '', isSecret: false }]);
    };

    const removeRow = (index: number) => {
        setSaved(false);
        setRows((current) => current.filter((_, i) => i !== index));
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
                    // Blank on a secret is the keep marker; blank on a readable value is an
                    // honest empty string.
                    value: row.isSecret && row.value === '' ? null : (row.value ?? ''),
                    isSecret: row.isSecret,
                }));
            const failure = await onSave(payload);
            if (failure) setError(failure);
            else setSaved(true);
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>{title}</h2>
                <button type="button" className="primary" onClick={() => void addRow()} disabled={disabled || saving}>
                    Add variable
                </button>
            </div>
            {hint ? <p className="muted">{hint}</p> : null}
            {error ? <p className="status">{error}</p> : null}
            {saved ? <p className="muted">Saved.</p> : null}

            {rows.length === 0 ? <p className="muted">No variables configured.</p> : null}
            {rows.length > 0 ? (
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
                        {rows.map((row, index) => (
                            <tr key={index}>
                                <td>
                                    <input
                                        aria-label="Variable name"
                                        value={row.name}
                                        disabled={disabled || saving}
                                        onChange={(e) => update(index, { name: e.target.value })}
                                    />
                                </td>
                                <td>
                                    <input
                                        aria-label={row.isSecret ? 'Secret value' : 'Value'}
                                        type={row.isSecret ? 'password' : 'text'}
                                        autoComplete={row.isSecret ? 'off' : undefined}
                                        value={row.value ?? ''}
                                        placeholder={row.isSecret ? 'set — leave blank to keep' : ''}
                                        disabled={disabled || saving}
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
                                            disabled={disabled || saving || (row.isSecret && row.value === null)}
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
                                        disabled={disabled || saving}
                                        aria-label={`Remove ${row.name || 'variable'}`}
                                    >
                                        ✕
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}

            <button type="button" onClick={() => void save()} disabled={disabled || saving}>
                {saving ? 'Saving…' : 'Save'}
            </button>
        </section>
    );
}
