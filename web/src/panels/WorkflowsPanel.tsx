import { useState } from 'react';
import type { WorkflowResult, WorkflowSummaryView } from '../api/useWorkflows.js';
import { taskTime } from '../format.js';

/** A create draft: the name, the scope (repo is curl-only from this panel — see `useWorkflowsManagement`),
 * and the definition as raw JSON text, the way a member would paste it against the API directly. */
interface CreateDraft {
    name: string;
    scope: 'org' | 'user';
    definitionText: string;
}

const EMPTY_CREATE: CreateDraft = { name: '', scope: 'user', definitionText: '' };

/** An open edit: the record's id, its editable fields, and the JSON text the textarea holds. */
interface EditDraft {
    id: string;
    name: string;
    definitionText: string;
}

/** `code: message` when the refusal named one (a validator code), the message alone otherwise. */
function refusalText(result: { error: string; code?: string }): string {
    return result.code ? `${result.code}: ${result.error}` : result.error;
}

/** The definition textarea's own JSON.parse, kept local: a malformed paste is a form error, never
 * a request the server has to refuse. */
function parseDefinition(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (e) {
        return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
    }
}

/** Whether the caller can act on this row at all — the list only ever carries org rows and the
 * caller's OWN user rows (never another member's, never repo scope), so the one gate needed
 * client-side is the org row's admin-only edit/delete, matching `canModify` server-side. Rendering
 * Edit/Delete on a row the caller cannot touch would only teach them that by way of a 403. */
function canActOn(workflow: WorkflowSummaryView, isAdmin: boolean): boolean {
    return workflow.scope !== 'org' || isAdmin;
}

/** One row: name, scope badge, timestamps, Edit and Delete. Split out of `WorkflowsPanel` so its
 * own conditional actions do not add to the panel's cognitive complexity. */
function WorkflowRow({
    workflow,
    busy,
    isAdmin,
    onEdit,
    onDelete,
}: {
    workflow: WorkflowSummaryView;
    busy: boolean;
    isAdmin: boolean;
    onEdit: () => void;
    onDelete: () => void;
}) {
    return (
        <tr>
            <td>{workflow.name}</td>
            <td>
                <span className="pill">{workflow.scope}</span>
            </td>
            <td>{taskTime(workflow.createdAt)}</td>
            <td>{taskTime(workflow.updatedAt)}</td>
            <td>
                {canActOn(workflow, isAdmin) ? (
                    <>
                        <button type="button" disabled={busy} onClick={onEdit}>
                            Edit
                        </button>{' '}
                        <button type="button" disabled={busy} onClick={onDelete}>
                            Delete
                        </button>
                    </>
                ) : null}
            </td>
        </tr>
    );
}

/** The list: loading/empty states and the table. Split out of `WorkflowsPanel` for the same
 * reason as `WorkflowRow`. */
function WorkflowList({
    workflows,
    loading,
    busy,
    isAdmin,
    onEdit,
    onDelete,
}: {
    workflows: WorkflowSummaryView[] | null;
    loading: boolean;
    busy: boolean;
    isAdmin: boolean;
    onEdit: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    if (loading) return <p className="muted">Loading…</p>;
    // Null post-load means the fetch failed — the panel's own error line already covers it above,
    // so "No workflows yet." (a positive, successfully-empty answer) must not also render here.
    if (workflows === null) return null;
    if (workflows.length === 0) return <p className="muted">No workflows yet.</p>;
    return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable
        <section className="table-wrap" tabIndex={0} aria-label="Workflows">
            <table className="data">
                <thead>
                    <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Scope</th>
                        <th scope="col">Created</th>
                        <th scope="col">Updated</th>
                        <th scope="col">
                            <span className="visually-hidden">Actions</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {workflows.map((workflow) => (
                        <WorkflowRow
                            key={workflow.id}
                            workflow={workflow}
                            busy={busy}
                            isAdmin={isAdmin}
                            onEdit={() => onEdit(workflow.id)}
                            onDelete={() => onDelete(workflow.id)}
                        />
                    ))}
                </tbody>
            </table>
        </section>
    );
}

/** The open edit form: name and definition, Save and Cancel. Split out of `WorkflowsPanel` for
 * the same reason as `WorkflowRow`. */
function WorkflowEditForm({
    edit,
    saving,
    error,
    onChange,
    onSave,
    onCancel,
}: {
    edit: EditDraft;
    saving: boolean;
    error: string | null;
    onChange: (next: EditDraft) => void;
    onSave: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="env-raw">
            <h3>Edit {edit.name}</h3>
            {error ? (
                <p className="status" role="alert">
                    {error}
                </p>
            ) : null}
            <p>
                <input
                    aria-label="Workflow name"
                    value={edit.name}
                    disabled={saving}
                    onChange={(e) => onChange({ ...edit, name: e.target.value })}
                />
            </p>
            <textarea
                aria-label="Workflow definition"
                rows={16}
                value={edit.definitionText}
                disabled={saving}
                onChange={(e) => onChange({ ...edit, definitionText: e.target.value })}
            />
            <p>
                <button type="button" className="primary" disabled={saving} onClick={onSave}>
                    {saving ? 'Saving…' : 'Save changes'}
                </button>{' '}
                <button type="button" disabled={saving} onClick={onCancel}>
                    Cancel
                </button>
            </p>
        </div>
    );
}

/** The create form: name, scope and definition. Split out of `WorkflowsPanel` for the same
 * reason as `WorkflowRow`. */
function WorkflowCreateForm({
    draft,
    creating,
    error,
    isAdmin,
    onChange,
    onSubmit,
}: {
    draft: CreateDraft;
    creating: boolean;
    error: string | null;
    isAdmin: boolean;
    onChange: (next: CreateDraft) => void;
    onSubmit: () => void;
}) {
    const disabled = creating || draft.name.trim() === '' || draft.definitionText.trim() === '';
    return (
        <div className="env-raw">
            <h3>New workflow</h3>
            {error ? (
                <p className="status" role="alert">
                    {error}
                </p>
            ) : null}
            <p>
                <input
                    aria-label="Workflow name"
                    placeholder="name"
                    value={draft.name}
                    disabled={creating}
                    onChange={(e) => onChange({ ...draft, name: e.target.value })}
                />{' '}
                <select
                    aria-label="Workflow scope"
                    value={draft.scope}
                    disabled={creating}
                    onChange={(e) => onChange({ ...draft, scope: e.target.value as CreateDraft['scope'] })}
                >
                    <option value="user">My own</option>
                    {isAdmin ? <option value="org">Organization</option> : null}
                </select>
            </p>
            <textarea
                aria-label="Workflow definition"
                rows={16}
                placeholder='{"entry": "…", "nodes": [...], "edges": [...]}'
                value={draft.definitionText}
                disabled={creating}
                onChange={(e) => onChange({ ...draft, definitionText: e.target.value })}
            />
            <p>
                <button type="button" className="primary" disabled={disabled} onClick={onSubmit}>
                    {creating ? 'Creating…' : 'Create workflow'}
                </button>
            </p>
        </div>
    );
}

export interface WorkflowsPanelProps {
    workflows: WorkflowSummaryView[] | null;
    loading: boolean;
    error: string | null;
    /** Org-level creation is admin-gated server-side; the panel offers the option only then. */
    isAdmin: boolean;
    fetchOne: (id: string) => Promise<WorkflowResult>;
    onCreate: (input: { name: string; scope: 'org' | 'user'; definition: unknown }) => Promise<WorkflowResult>;
    onUpdate: (id: string, input: { name: string; definition: unknown }) => Promise<WorkflowResult>;
    onRemove: (id: string) => Promise<string | null>;
}

/**
 * The workflow management panel (issue 131): list, create, edit and delete a member's reusable
 * workflow definitions. The definition editor is a plain JSON textarea — the grammar is closed and
 * `workflow-schema.ts`'s validator already returns named, renderable errors, so a form-based graph
 * builder is a different issue (issue 132), not this one.
 *
 * Editing fetches the full record (`fetchOne`) on demand: the list carries summaries only, never
 * the (up to 64 KiB compiled) definition, matching `GET /api/workflows`' own shape.
 */
export function WorkflowsPanel(props: WorkflowsPanelProps) {
    const { workflows, loading, error, isAdmin, fetchOne, onCreate, onUpdate, onRemove } = props;

    const [creating, setCreating] = useState(false);
    const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE);
    const [createError, setCreateError] = useState<string | null>(null);

    const [edit, setEdit] = useState<EditDraft | null>(null);
    const [editLoading, setEditLoading] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);

    const [busyId, setBusyId] = useState<string | null>(null);
    const [rowError, setRowError] = useState<string | null>(null);

    const busy = creating || editLoading || busyId !== null;

    const submitCreate = async () => {
        const parsed = parseDefinition(createDraft.definitionText);
        if (!parsed.ok) {
            setCreateError(parsed.error);
            return;
        }
        setCreating(true);
        setCreateError(null);
        try {
            const input = { name: createDraft.name.trim(), scope: createDraft.scope, definition: parsed.value };
            const result = await onCreate(input);
            if (!result.ok) {
                setCreateError(refusalText(result));
            } else {
                setCreateDraft(EMPTY_CREATE);
            }
        } finally {
            setCreating(false);
        }
    };

    const openEdit = async (id: string) => {
        setRowError(null);
        setEditError(null);
        setEditLoading(true);
        const result = await fetchOne(id);
        setEditLoading(false);
        if (!result.ok) {
            setRowError(refusalText(result));
            return;
        }
        setEdit({ id, name: result.record.name, definitionText: JSON.stringify(result.record.definition, null, 2) });
    };

    const submitEdit = async () => {
        if (!edit) return;
        const parsed = parseDefinition(edit.definitionText);
        if (!parsed.ok) {
            setEditError(parsed.error);
            return;
        }
        setBusyId(edit.id);
        setEditError(null);
        try {
            const result = await onUpdate(edit.id, { name: edit.name.trim(), definition: parsed.value });
            if (!result.ok) {
                setEditError(refusalText(result));
            } else {
                setEdit(null);
            }
        } finally {
            // Only clear `busyId` if it is still this save's own id: a concurrent delete of a
            // DIFFERENT row shares the same `busyId` state and must not clear this one out from
            // under it (or the reverse — see `remove`, below).
            setBusyId((current) => (current === edit.id ? null : current));
        }
    };

    const remove = async (id: string) => {
        setRowError(null);
        setBusyId(id);
        try {
            const reason = await onRemove(id);
            if (reason) {
                setRowError(reason);
            } else if (edit?.id === id) {
                // The row just removed is the one open in the edit form below — left open, Save
                // would only 404 against a row that no longer exists.
                setEdit(null);
            }
        } finally {
            setBusyId((current) => (current === id ? null : current));
        }
    };

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>Reusable workflows</h2>
            </div>
            <p className="muted">
                Custom processes a task can walk instead of the default prompt → gates → publish spine.
            </p>
            {error ? <p className="status">{error}</p> : null}
            {rowError ? <p className="status">{rowError}</p> : null}

            <WorkflowList
                workflows={workflows}
                loading={loading}
                busy={busy}
                isAdmin={isAdmin}
                onEdit={(id) => void openEdit(id)}
                onDelete={(id) => void remove(id)}
            />

            {edit ? (
                <WorkflowEditForm
                    edit={edit}
                    saving={busyId === edit.id}
                    error={editError}
                    onChange={setEdit}
                    onSave={() => void submitEdit()}
                    onCancel={() => setEdit(null)}
                />
            ) : (
                <WorkflowCreateForm
                    draft={createDraft}
                    creating={creating}
                    error={createError}
                    isAdmin={isAdmin}
                    onChange={setCreateDraft}
                    onSubmit={() => void submitCreate()}
                />
            )}
        </section>
    );
}
