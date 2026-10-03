import type { Role } from '@factory-ai/core';
import { JSON_HEADERS } from '@factory-ai/core';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/**
 * The member roster's client half (issue 410): the administrator's read of the org's memberships
 * and the one write it takes. The GET is admin-gated server-side, so a member's browser never
 * issues it — the section decides that before calling either.
 */

/** One row of an organization's roster, as `GET /api/org/members` serves it. */
export interface MemberView {
    githubLogin: string;
    /** The account's id — the role write addresses a member by it. */
    userId: string;
    role: Role;
    invitedAt: string | null;
    claimedAt: string | null;
    lastLoginAt: string | null;
}

/**
 * What a roster row must look like for the table to be safe: the cells render these fields
 * directly, so a 2xx body that is not that shape is refused as an error result, never handed on
 * to throw in the render. The dates are checked for type too, though `commitDate` would degrade
 * a bad value to an em dash — the guard is about refusing the body, not surviving it.
 */
const isDate = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isMemberView = (row: unknown): row is MemberView =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as MemberView).githubLogin === 'string' &&
    typeof (row as MemberView).userId === 'string' &&
    typeof (row as MemberView).role === 'string' &&
    isDate((row as MemberView).invitedAt) &&
    isDate((row as MemberView).claimedAt) &&
    isDate((row as MemberView).lastLoginAt);

/** The admin's roster read — fetched once per mount and again after each successful write. */
export const listMembers = async (): Promise<{ ok: true; members: MemberView[] } | { ok: false; error: string }> => {
    try {
        const response = await fetch('/api/org/members');
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false as const, error: 'Your session expired' };
        }
        if (!response.ok) {
            return { ok: false as const, error: (await refusalOf(response, 'Could not load the members')).error };
        }
        const rows: unknown = ((await response.json()) as { members?: unknown }).members;
        if (!Array.isArray(rows) || !rows.every(isMemberView)) {
            return { ok: false as const, error: 'Could not load the members: unexpected response shape.' };
        }
        return { ok: true as const, members: rows };
    } catch (e) {
        return { ok: false as const, error: (e as Error).message };
    }
};

/** The role write. Returns the refusal's message, or null when the role stuck. */
export const setMemberRole = async (userId: string, role: Role): Promise<string | null> => {
    try {
        const response = await fetch(`/api/org/members/${userId}/role`, {
            method: 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify({ role }),
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return 'Your session expired';
        }
        if (!response.ok) {
            return (await refusalOf(response, 'Could not set the role')).error;
        }
        return null;
    } catch (e) {
        return (e as Error).message;
    }
};
