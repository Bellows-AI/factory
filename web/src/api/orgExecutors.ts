import type { ExecutorScope } from '@factory-ai/core';
import { JSON_HEADERS } from '@factory-ai/core';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/**
 * The organization executor profiles' client half (issue 391): the administrators' CRUD over the
 * profiles every member of the organization may select. The list answers WITH configs to an
 * admin — the edit dialog cannot pre-fill without them — and as bare selection metadata to a
 * member, whose only consumer here is read-only.
 */

export interface OrgExecutorFull {
    id: string;
    name: string;
    type: string;
    createdAt: string;
    updatedAt: string;
    gateFixRounds: number;
    /** The administrator who created (or last promoted) the row — an audit fact, not an ownership. */
    createdBy: string | null;
    config: object;
}

/** One validated org-profile payload, the shape POST and PUT take. */
export interface OrgExecutorInput {
    name: string;
    type: string;
    config: object;
    gateFixRounds: number;
}

/**
 * What a full org row must look like for the dialog to be safe: it pre-fills from these rows, so
 * a 2xx body that is not that shape is refused as an error result, never handed on to throw in
 * the render.
 */
const isOrgExecutorFull = (row: unknown): row is OrgExecutorFull =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as OrgExecutorFull).id === 'string' &&
    typeof (row as OrgExecutorFull).name === 'string' &&
    typeof (row as OrgExecutorFull).type === 'string' &&
    typeof (row as OrgExecutorFull).createdAt === 'string' &&
    typeof (row as OrgExecutorFull).gateFixRounds === 'number' &&
    typeof (row as OrgExecutorFull).config === 'object' &&
    (row as OrgExecutorFull).config !== null;

/** The admin list's read — the dialog's opening state, configs included, fetched on demand. */
export const listOrgExecutorConfigs = async (): Promise<
    { ok: true; executors: OrgExecutorFull[] } | { ok: false; error: string }
> => {
    try {
        const response = await fetch('/api/org/executors');
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false as const, error: 'Your session expired' };
        }
        if (!response.ok) {
            return { ok: false as const, error: (await refusalOf(response, 'Could not load the executors')).error };
        }
        const rows: unknown = ((await response.json()) as { executors?: unknown }).executors;
        if (!Array.isArray(rows) || !rows.every(isOrgExecutorFull)) {
            return { ok: false as const, error: 'Could not load the executors: unexpected response shape.' };
        }
        return { ok: true as const, executors: rows };
    } catch (e) {
        return { ok: false as const, error: (e as Error).message };
    }
};

/** One executor write, shared by the org CRUD and the personal by-id routes (issue 440). */
export async function executorWrite(
    url: string,
    method: string,
    body: unknown,
    fallbackError: string
): Promise<string | null> {
    try {
        // A bodyless write (DELETE) sends no content type either: Fastify refuses a request that
        // declares `application/json` and then carries nothing, with a 400 the handler never sees.
        const response = await fetch(
            url,
            body === undefined ? { method } : { method, headers: JSON_HEADERS, body: JSON.stringify(body) }
        );
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return 'Your session expired';
        }
        if (!response.ok) {
            return (await refusalOf(response, fallbackError)).error;
        }
        return null;
    } catch (e) {
        return (e as Error).message;
    }
}

export const createOrgExecutor = (input: OrgExecutorInput): Promise<string | null> =>
    executorWrite('/api/org/executors', 'POST', input, 'Could not save the executor');

export const updateOrgExecutor = (id: string, input: OrgExecutorInput): Promise<string | null> =>
    executorWrite(`/api/org/executors/${id}`, 'PUT', input, 'Could not save the executor');

export const deleteOrgExecutor = (id: string): Promise<string | null> =>
    executorWrite(`/api/org/executors/${id}`, 'DELETE', undefined, 'Could not delete the executor');

/** Suspends or resumes an org profile for every member (issue 440). */
export const suspendOrgExecutor = (id: string, suspended: boolean): Promise<string | null> =>
    executorWrite(
        `/api/org/executors/${id}/suspension`,
        'POST',
        { suspended },
        suspended ? 'Could not suspend the executor' : 'Could not resume the executor'
    );

/** The one route a profile's scope moves through: promote the admin's own row, or demote to it. */
export const changeOrgExecutorScope = (id: string, scope: ExecutorScope): Promise<string | null> =>
    executorWrite(`/api/org/executors/${id}/scope`, 'POST', { scope }, 'Could not move the executor');
