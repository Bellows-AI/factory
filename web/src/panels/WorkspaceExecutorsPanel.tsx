import type { WorkspaceExecutor } from '../api/useWorkspace.js';
import { commitDate } from '../format.js';
import { executorTypeLabel } from '../workspace/executors.js';

/**
 * One row per configured executor — each with the Edit action that reopens the dialog on it — and
 * the empty state that makes "none" a sentence rather than a blank panel. The section's heading
 * and its Add action are the page header's; this panel is the list plus its scope context
 * (issue 183): "My workspace", and the guidance that separates what an executor stores from what
 * the deployment controls.
 */

/** The same sentence the page's root-null refusal reuses — one truth about scope, two contexts. */
export const EXECUTOR_GUIDANCE =
    'The deployment chooses the runner CLI and image. An executor stores your label and config; it does not switch the deployment between Claude Code and OpenCode.';

export function WorkspaceExecutorsPanel({
    executors,
    onEdit,
}: {
    executors: readonly WorkspaceExecutor[];
    onEdit: (name: string) => void;
}) {
    return (
        <section className="panel">
            <h2>My workspace</h2>
            <p className="muted">{EXECUTOR_GUIDANCE}</p>
            {executors.length === 0 ? (
                <p className="muted">
                    No personal executors configured. New tasks use the deployment&#x27;s image default.
                </p>
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
                            {executors.map((executor, index) => (
                                <tr key={executor.name}>
                                    <td>
                                        {executor.name}
                                        {/*
                                            Describes what the task composer already does — its draft
                                            autoselects the first row of the list — not a stored
                                            preference: there is no default, no ordering UI, no make-
                                            default action (issue 183).
                                        */}
                                        {index === 0 ? <p className="muted">Selected first on new tasks</p> : null}
                                    </td>
                                    <td>
                                        <span className="pill">{executorTypeLabel(executor.type)}</span>
                                    </td>
                                    <td>{commitDate(executor.createdAt)}</td>
                                    <td>
                                        <button type="button" onClick={() => onEdit(executor.name)}>
                                            Edit
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
