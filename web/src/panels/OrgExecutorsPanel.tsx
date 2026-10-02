import { commitDate } from '../format.js';
import { EXECUTOR_GUIDANCE, executorTypeLabel } from '../workspace/executors.js';
import type { OrgExecutor } from '../api/useWorkspace.js';

/** The org row the member's resolved default names — the composer autoselects it (issue 391). */
export const ORG_DEFAULT_CAPTION = 'Default — selected on new tasks';

/**
 * The organization's executor profiles (issue 391): managed by administrators, selectable by
 * every member. A member's view is read-only selection metadata — the configuration may hold
 * provider credentials and travels to admins only — and an administrator's view carries the
 * management actions: Add (the page's concern here), Edit, Delete, and Demote (the one route a
 * profile's scope moves through, landing the row in the calling admin's personal list).
 */

/** The demote action: the shared profile becomes the calling admin's own personal row. */
export const DEMOTE_LABEL = 'Make personal';

/** The row's action cell: Make default for every member, the management actions for admins only. */
function OrgExecutorActions({
    executor,
    isAdmin,
    saving,
    isDefault,
    onEdit,
    onDelete,
    onDemote,
    onMakeDefault,
}: {
    executor: OrgExecutor;
    isAdmin: boolean;
    saving: boolean;
    /** True when this row is the member's resolved default — no click may rewrite it to itself. */
    isDefault: boolean;
    onEdit: ((name: string) => void) | undefined;
    onDelete: ((name: string) => void) | undefined;
    onDemote: ((name: string) => void) | undefined;
    onMakeDefault: (name: string) => void;
}) {
    return (
        <td>
            {isDefault ? null : (
                <button type="button" disabled={saving} onClick={() => onMakeDefault(executor.name)}>
                    Make default
                </button>
            )}
            {isAdmin && onEdit ? (
                <button type="button" disabled={saving} onClick={() => onEdit(executor.name)}>
                    Edit
                </button>
            ) : null}
            {isAdmin && onDemote ? (
                <button type="button" disabled={saving} onClick={() => onDemote(executor.name)}>
                    {DEMOTE_LABEL}
                </button>
            ) : null}
            {isAdmin && onDelete ? (
                <button type="button" disabled={saving} onClick={() => onDelete(executor.name)}>
                    Delete
                </button>
            ) : null}
        </td>
    );
}

export function OrgExecutorsPanel({
    executors,
    isAdmin,
    saving,
    defaultName,
    onAdd,
    onEdit,
    onDelete,
    onDemote,
    onMakeDefault,
}: {
    executors: readonly OrgExecutor[];
    isAdmin: boolean;
    saving: boolean;
    /** The org profile the member's resolved default names, or null. */
    defaultName: string | null;
    onAdd: (() => void) | undefined;
    onEdit: ((name: string) => void) | undefined;
    onDelete: ((name: string) => void) | undefined;
    onDemote: ((name: string) => void) | undefined;
    onMakeDefault: (name: string) => void;
}) {
    return (
        <section className="panel">
            <h2>Organization</h2>
            <p className="muted">
                {EXECUTOR_GUIDANCE}{' '}
                {isAdmin
                    ? 'As an admin you manage these profiles for everyone in the organization.'
                    : 'These are managed by your organization admins and available to every member.'}
            </p>
            {onAdd ? (
                <p>
                    <button type="button" onClick={onAdd}>
                        Add organization executor
                    </button>
                </p>
            ) : null}
            {executors.length === 0 ? (
                <p className="muted">
                    {isAdmin
                        ? 'No organization executors configured. Add one to offer it to every member.'
                        : 'No organization executors yet — an administrator can add ones for everyone.'}
                </p>
            ) : (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable
                <section className="table-wrap" tabIndex={0} aria-label="Organization executors">
                    <table className="data">
                        <thead>
                            <tr>
                                <th scope="col">Name</th>
                                <th scope="col">Type</th>
                                <th scope="col">Added</th>
                                <th scope="col">
                                    <span className="muted">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {executors.map((executor) => (
                                <tr key={executor.name}>
                                    <td>
                                        {executor.name}
                                        {defaultName === executor.name ? (
                                            <p className="muted">{ORG_DEFAULT_CAPTION}</p>
                                        ) : null}
                                    </td>
                                    <td>
                                        <span className="pill">{executorTypeLabel(executor.type)}</span>
                                    </td>
                                    <td>{commitDate(executor.createdAt)}</td>
                                    <OrgExecutorActions
                                        executor={executor}
                                        isAdmin={isAdmin}
                                        saving={saving}
                                        isDefault={defaultName === executor.name}
                                        onEdit={onEdit}
                                        onDelete={onDelete}
                                        onDemote={onDemote}
                                        onMakeDefault={onMakeDefault}
                                    />
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
        </section>
    );
}
