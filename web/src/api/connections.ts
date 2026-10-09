import { JSON_HEADERS } from '@factory-ai/core';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/**
 * The Jira connections' client half: the list, the create and the delete of `/api/connections`.
 * The token goes out on create and is in no response, so no type here has a field for it.
 */

export const CONNECTION_ACCESS = ['read', 'write'] as const;
export type ConnectionAccess = (typeof CONNECTION_ACCESS)[number];

/** `org` is every member's task's; `user` only its owner's. The wire value of `scope` both ways. */
export const ORG_CONNECTION_SCOPE = 'org';
export const USER_CONNECTION_SCOPE = 'user';
export type ConnectionScope = typeof ORG_CONNECTION_SCOPE | typeof USER_CONNECTION_SCOPE;

/** One row of `GET /api/connections`: the org's connections plus the caller's own, newest first. */
export interface ConnectionView {
    id: string;
    site: string;
    email: string;
    access: ConnectionAccess;
    scope: ConnectionScope;
    createdAt: string;
}

export interface NewConnectionInput {
    scope: ConnectionScope;
    site: string;
    email: string;
    apiToken: string;
    access: ConnectionAccess;
}

const isConnectionView = (row: unknown): row is ConnectionView => {
    if (typeof row !== 'object' || row === null) return false;
    const view = row as ConnectionView;
    return (
        typeof view.id === 'string' &&
        typeof view.site === 'string' &&
        typeof view.email === 'string' &&
        CONNECTION_ACCESS.includes(view.access) &&
        (view.scope === ORG_CONNECTION_SCOPE || view.scope === USER_CONNECTION_SCOPE) &&
        typeof view.createdAt === 'string'
    );
};

const SESSION_EXPIRED = 'Your session expired';

/** The caller's visible connections, or the refusal's message. */
export const listConnections = async (): Promise<
    { ok: true; connections: ConnectionView[] } | { ok: false; error: string }
> => {
    try {
        const response = await fetch('/api/connections');
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false, error: SESSION_EXPIRED };
        }
        if (!response.ok) {
            return { ok: false, error: (await refusalOf(response, 'Could not load the connections')).error };
        }
        const rows: unknown = ((await response.json()) as { connections?: unknown }).connections;
        if (!Array.isArray(rows) || !rows.every(isConnectionView)) {
            return { ok: false, error: 'Could not load the connections: unexpected response shape.' };
        }
        return { ok: true, connections: rows };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
};

/** Returns the route's refusal message as-is, or null when the connection was saved. */
export const createConnection = async (input: NewConnectionInput): Promise<string | null> => {
    try {
        const response = await fetch('/api/connections', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(input),
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return SESSION_EXPIRED;
        }
        if (!response.ok) return (await refusalOf(response, 'Could not save the connection')).error;
        return null;
    } catch (e) {
        return (e as Error).message;
    }
};

/** Returns the refusal's message, or null when the connection is gone. */
export const deleteConnection = async (id: string): Promise<string | null> => {
    try {
        const response = await fetch(`/api/connections/${id}`, { method: 'DELETE' });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return SESSION_EXPIRED;
        }
        if (!response.ok) return (await refusalOf(response, 'Could not delete the connection')).error;
        return null;
    } catch (e) {
        return (e as Error).message;
    }
};
