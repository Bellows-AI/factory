import { useState } from 'react';
import {
    CONNECTION_ACCESS,
    ORG_CONNECTION_SCOPE,
    type ConnectionAccess,
    type ConnectionScope,
    type ConnectionView,
    type NewConnectionInput,
} from '../api/connections.js';
import { commitDate } from '../format.js';

/**
 * The Jira connections list for one scope: org-wide on the Organization page, the member's own on
 * the Workspace page. Presentational, like `MembersPanel` — the section owns the state and the
 * writes. No `<form>` (the CSP sends `form-action 'none'`), and the token field is write-only: it
 * is cleared on a save and no row has a place to show one.
 */

export const ADD_CONNECTION_LABEL = 'Add Jira connection';
export const DEFAULT_CONNECTION_CAPTION = 'default for tasks';
export const SCOPED_TOKEN_HINT =
    'The API token must be a scoped (service-account) token. A classic token is stored without being tried and then answers 401 on every call.';
export const NO_CONNECTIONS_NOTE = 'No Jira connections yet.';

const BLANK_DRAFT = { site: '', email: '', apiToken: '', access: 'read' as ConnectionAccess };

function ConnectionAddRow({
    scope,
    saving,
    onCreate,
}: {
    scope: ConnectionScope;
    saving: boolean;
    onCreate: (input: NewConnectionInput) => Promise<boolean>;
}) {
    const [draft, setDraft] = useState(BLANK_DRAFT);
    const complete = draft.site.trim() !== '' && draft.email.trim() !== '' && draft.apiToken !== '';
    const submit = async () => {
        const saved = await onCreate({ scope, ...draft, site: draft.site.trim(), email: draft.email.trim() });
        if (saved) setDraft(BLANK_DRAFT);
    };
    return (
        <div className="token-create">
            <input
                aria-label="Jira site"
                placeholder="example.atlassian.net"
                value={draft.site}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, site: e.target.value })}
            />{' '}
            <input
                aria-label="Jira email"
                placeholder="service-account email"
                value={draft.email}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            />{' '}
            <input
                aria-label="Jira API token"
                type="password"
                autoComplete="off"
                placeholder="scoped API token"
                value={draft.apiToken}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, apiToken: e.target.value })}
            />{' '}
            <select
                aria-label="Jira access"
                value={draft.access}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, access: e.target.value as ConnectionAccess })}
            >
                {CONNECTION_ACCESS.map((access) => (
                    <option key={access} value={access}>
                        {access}
                    </option>
                ))}
            </select>{' '}
            <button type="button" className="primary" disabled={saving || !complete} onClick={() => void submit()}>
                {ADD_CONNECTION_LABEL}
            </button>
        </div>
    );
}

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
    /** Resolves true when the connection saved, so the draft may clear. */
    onCreate: (input: NewConnectionInput) => Promise<boolean>;
    onDelete: (connection: ConnectionView) => void;
}) {
    return (
        <section
            className="panel"
            aria-label={scope === ORG_CONNECTION_SCOPE ? 'Organization Jira connections' : 'Personal Jira connections'}
        >
            <h2>Jira connection</h2>
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
                <>
                    <p className="muted">{SCOPED_TOKEN_HINT}</p>
                    <ConnectionAddRow scope={scope} saving={saving} onCreate={onCreate} />
                </>
            ) : null}
        </section>
    );
}
