import { useState } from 'react';
import {
    ORG_CONNECTION_SCOPE,
    type ConnectionScope,
    type ConnectionView,
    type NewConnectionInput,
} from '../api/connections.js';
import { JiraConnectionDialog } from '../components/JiraConnectionDialog.js';
import { commitDate } from '../format.js';

/**
 * The Jira connections list for one scope: org-wide on the Organization page, the member's own on
 * the Workspace page. Presentational, like `MembersPanel` — the section owns the list and the
 * writes; the add form is `JiraConnectionDialog`, opened from the panel head. No row has a place
 * to show a token.
 */

export const ADD_CONNECTION_LABEL = 'Add Jira connection';
export const DEFAULT_CONNECTION_CAPTION = 'default for tasks';
export const NO_CONNECTIONS_NOTE = 'No Jira connections yet.';

export function JiraConnectionsPanel({
    scope,
    hint,
    connections,
    canManage,
    saving,
    onCreate,
    onDelete,
}: {
    scope: ConnectionScope;
    hint: string;
    /** Only this scope's rows, newest first; the first is the one a task gets by default. */
    connections: readonly ConnectionView[];
    /** Admin for the org scope, always for the personal one; the server's 403 is the real gate. */
    canManage: boolean;
    saving: boolean;
    /** Resolves to the refusal message, or null when the connection saved. */
    onCreate: (input: NewConnectionInput) => Promise<string | null>;
    onDelete: (connection: ConnectionView) => void;
}) {
    const [adding, setAdding] = useState(false);
    return (
        <section
            className="panel"
            aria-label={scope === ORG_CONNECTION_SCOPE ? 'Organization Jira connections' : 'Personal Jira connections'}
        >
            <div className="panel-head">
                <h2>Jira connection</h2>
                {canManage ? (
                    <button type="button" className="primary" disabled={saving} onClick={() => setAdding(true)}>
                        {ADD_CONNECTION_LABEL}
                    </button>
                ) : null}
            </div>
            <p className="muted">{hint}</p>
            {connections.length === 0 ? (
                <p className="muted">{NO_CONNECTIONS_NOTE}</p>
            ) : (
                <section className="table-wrap">
                    <table className="data table-cards">
                        <thead>
                            <tr>
                                <th scope="col">Site</th>
                                <th scope="col">Email</th>
                                <th scope="col">Access</th>
                                <th scope="col">Created</th>
                                {canManage ? (
                                    <th scope="col">
                                        <span className="visually-hidden">Delete</span>
                                    </th>
                                ) : null}
                            </tr>
                        </thead>
                        <tbody>
                            {connections.map((connection, index) => (
                                <tr key={connection.id}>
                                    <td data-label="Site">
                                        {connection.site}
                                        {index === 0 ? (
                                            <span className="muted"> · {DEFAULT_CONNECTION_CAPTION}</span>
                                        ) : null}
                                    </td>
                                    <td data-label="Email">{connection.email}</td>
                                    <td data-label="Access">{connection.access}</td>
                                    <td data-label="Created">{commitDate(connection.createdAt)}</td>
                                    {canManage ? (
                                        <td>
                                            <button
                                                type="button"
                                                disabled={saving}
                                                aria-label={`Delete ${connection.site} connection for ${connection.email}`}
                                                onClick={() => onDelete(connection)}
                                            >
                                                Delete
                                            </button>
                                        </td>
                                    ) : null}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
            {canManage ? (
                <JiraConnectionDialog
                    open={adding}
                    scope={scope}
                    saving={saving}
                    onClose={() => setAdding(false)}
                    onCreate={onCreate}
                />
            ) : null}
        </section>
    );
}
