import type { WorkspaceExecutor } from '../api/useWorkspace.js';
import { commitDate } from '../format.js';
import { defaultExecutorName, executorTypeLabel } from '../workspace/executors.js';

/**
 * One row per configured executor — each with the Edit action that reopens the dialog on it, and
 * the Make default action that flags it as the one new task drafts autoselect (issue 215) — and
 * the empty state that makes "none" a sentence rather than a blank panel. The section's heading
 * and its Add action are the page header's; this panel is the list plus its scope context
 * (issue 183): "My workspace", and the guidance that explains the task-scoped runner choice.
 */

/** The same sentence the page's root-null refusal reuses — one truth about scope, two contexts. */
export const EXECUTOR_GUIDANCE =
    'Each task runs with its selected executor. The executor type chooses Claude Code or OpenCode, and its JSON config is applied to that runner.';

/** The row action that flags an executor as the default (issue 215). */
export const MAKE_DEFAULT_LABEL = 'Make default';

/** The flagged row's caption, replacing the pre-215 "Selected first on new tasks" fallback. */
export const DEFAULT_CAPTION = 'Default — selected on new tasks';

/** The fallback caption when no row is flagged: describes the composer, not a stored preference. */
export const FIRST_ROW_CAPTION = 'Selected first on new tasks';

export function WorkspaceExecutorsPanel({
    executors,
    onEdit,
    onMakeDefault,
    saving,
}: {
    executors: readonly WorkspaceExecutor[];
    onEdit: (name: string) => void;
    onMakeDefault: (name: string) => void;
    saving: boolean;
}) {
    const defaultName = defaultExecutorName(executors);
    return (
        <section className="panel">
            <h2>My workspace</h2>
            <p className="muted">{EXECUTOR_GUIDANCE}</p>
            {executors.length === 0 ? (
                <p className="muted">No personal executors configured. Add one before starting a task.</p>
            ) : (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable
                <section className="table-wrap" tabIndex={0} aria-label="Executors">
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
                                        {/*
                                            The flagged row names itself; with none flagged, the
                                            first row keeps the pre-215 caption describing what the
                                            composer's autoselect already does, not a stored
                                            preference (issue 183).
                                        */}
                                        {executor.name === defaultName ? (
                                            <p className="muted">
                                                {executor.isDefault ? DEFAULT_CAPTION : FIRST_ROW_CAPTION}
                                            </p>
                                        ) : null}
                                    </td>
                                    <td>
                                        <span className="pill">{executorTypeLabel(executor.type)}</span>
                                    </td>
                                    <td>{commitDate(executor.createdAt)}</td>
                                    <td>
                                        <button type="button" onClick={() => onEdit(executor.name)}>
                                            Edit
                                        </button>
                                        {!executor.isDefault ? (
                                            <button
                                                type="button"
                                                disabled={saving}
                                                onClick={() => onMakeDefault(executor.name)}
                                            >
                                                {MAKE_DEFAULT_LABEL}
                                            </button>
                                        ) : null}
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
