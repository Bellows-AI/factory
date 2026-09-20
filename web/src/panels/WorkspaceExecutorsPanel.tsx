import type { WorkspaceExecutor } from '../api/useWorkspace.js';
import { commitDate } from '../format.js';

/**
 * One row per configured executor — each with the Edit action that reopens the dialog on it — and
 * the empty state that makes "none" a sentence rather than a blank panel. The section's heading
 * and its Add action are the page header's; this panel is the list.
 */
export function WorkspaceExecutorsPanel({
    executors,
    onEdit,
}: {
    executors: readonly WorkspaceExecutor[];
    onEdit: (name: string) => void;
}) {
    return (
        <section className="panel">
            {executors.length === 0 ? (
                <p className="muted">No executors configured.</p>
            ) : (
                <table className="table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Type</th>
                            <th>Added</th>
                            <th>
                                <span className="muted">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {executors.map((executor) => (
                            <tr key={executor.name}>
                                <td>{executor.name}</td>
                                <td>
                                    <span className="pill">{executor.type}</span>
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
            )}
        </section>
    );
}
