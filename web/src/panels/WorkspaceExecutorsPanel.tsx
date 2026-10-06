import type { DefaultExecutor, WorkspaceExecutor } from '../api/useWorkspace.js';
import { commitDate } from '../format.js';
import { EXECUTOR_GUIDANCE, executorTypeLabel } from '../workspace/executors.js';

/**
 * One row per configured personal executor — each with the Edit action that reopens the dialog on
 * it, and the Make default action that stores the member's preference naming it (issue 391) — and
 * the empty state that makes "none" a sentence rather than a blank panel. The section's heading
 * and its Add action are the page header's; this panel is the list plus its scope context
 * (issue 183): "My workspace", and the guidance that explains the task-scoped runner choice.
 */

/** The row action that flags an executor as the default (issue 215, re-cut as a preference by 391). */
export const MAKE_DEFAULT_LABEL = 'Make default';

/** The row the member's preference resolves to — the composer autoselects it. */
export const DEFAULT_CAPTION = 'Default — selected on new tasks';

/** The lifecycle actions and status (issue 440), here so the e2e specs assert the strings the DOM renders. */
export const SUSPENDED_LABEL = 'Suspended';
export const SUSPEND_LABEL = 'Suspend';
export const RESUME_LABEL = 'Resume';
export const REMOVE_LABEL = 'Remove';
/** The empty state once every profile is suspended: configured, but nothing a task can select. */
export const ALL_SUSPENDED_NOTE = 'Every executor is suspended. Resume one, or select an organization executor.';

export function WorkspaceExecutorsPanel({
    executors,
    defaultExecutor,
    onEdit,
    onMakeDefault,
    onSuspend,
    onRemove,
    saving,
}: {
    executors: readonly WorkspaceExecutor[];
    /** The member's resolved default, from the same poll; null when nothing is selectable. */
    defaultExecutor: DefaultExecutor | null;
    onEdit: (name: string) => void;
    onMakeDefault: (name: string) => void;
    /** Suspends (true) or resumes (false) the row, by id. */
    onSuspend: (id: string, suspended: boolean) => void;
    /** Opens the removal confirmation for the row; nothing is deleted from the click itself. */
    onRemove: (name: string) => void;
    saving: boolean;
}) {
    return (
        <section className="panel">
            <h2>My workspace</h2>
            <p className="muted">{EXECUTOR_GUIDANCE}</p>
            {executors.length > 0 && executors.every((executor) => executor.suspended) ? (
                <p className="muted">{ALL_SUSPENDED_NOTE}</p>
            ) : null}
            {executors.length === 0 ? (
                <p className="muted">
                    No personal executors configured. Add one, or select an organization executor for a new task.
                </p>
            ) : (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable
                <section className="table-wrap" tabIndex={0} aria-label="Executors">
                    <table className="data">
                        <thead>
                            <tr>
                                <th scope="col">Name</th>
                                <th scope="col">Type</th>
                                <th scope="col">Gate repair</th>
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
                                        {executor.suspended ? <span className="pill">{SUSPENDED_LABEL}</span> : null}
                                        {defaultExecutor !== null &&
                                        defaultExecutor.scope === 'user' &&
                                        defaultExecutor.name === executor.name ? (
                                            <p className="muted">{DEFAULT_CAPTION}</p>
                                        ) : null}
                                    </td>
                                    <td>
                                        <span className="pill">{executorTypeLabel(executor.type)}</span>
                                    </td>
                                    <td>
                                        {/* The default-workflow repair budget tasks on this executor
                                            launch with (#49); 0 means automatic repair is off. */}
                                        {executor.gateFixRounds}
                                    </td>
                                    <td>{commitDate(executor.createdAt)}</td>
                                    <td>
                                        <button type="button" onClick={() => onEdit(executor.name)}>
                                            Edit
                                        </button>
                                        {/* A suspended row cannot be a default (issue 440): resume it first. */}
                                        {!executor.suspended &&
                                        (defaultExecutor === null ||
                                            defaultExecutor.name !== executor.name ||
                                            defaultExecutor.scope !== 'user') ? (
                                            <button
                                                type="button"
                                                disabled={saving}
                                                onClick={() => onMakeDefault(executor.name)}
                                            >
                                                {MAKE_DEFAULT_LABEL}
                                            </button>
                                        ) : null}
                                        <button
                                            type="button"
                                            disabled={saving}
                                            onClick={() => onSuspend(executor.id, !executor.suspended)}
                                        >
                                            {executor.suspended ? RESUME_LABEL : SUSPEND_LABEL}
                                        </button>
                                        <button type="button" disabled={saving} onClick={() => onRemove(executor.name)}>
                                            {REMOVE_LABEL}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
        </section>
    );
}
