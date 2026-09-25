import { ADMIN_ROLE, type Role } from '@factory-ai/core';
import { useCallback, useEffect, useState } from 'react';
import { refusalOf } from './refusal.js';

export interface Session {
    /** The `/api/auth/me` union's signed-in arm; the anonymous answer is `{ authenticated: false }`. */
    authenticated: true;
    user: {
        id: string;
        login: string;
        name: string | null;
        /** GitHub's numeric id — 0 for the AUTH_MODE=none stand-in, a value GitHub never issues. */
        githubUserId: number;
        avatarUrl: string | null;
    };
    role: Role;
    membership: { invitedAt: string | null; claimedAt: string | null };
    account: { createdAt: string | null; lastLoginAt: string | null };
    organization: { id: string; name: string };
    /** Every org the account could switch to — the installations GitHub reported at sign-in. */
    organizations: { id: string; name: string }[];
    /** The member's checkout root, or null when workspaces are switched off for the deployment. */
    workspacePath: string | null;
    /** 'none' means the server is running open, so there is no session to end and no button. */
    mode: 'github' | 'none';
}

/** The role as the settings pages print it. */
export const roleLabel = (role: Role): string => (role === ADMIN_ROLE ? 'Admin' : 'Member');

/**
 * How an expired session reaches the gate.
 *
 * `useStats` polls every two seconds while a fetch is running, so a session expiring in the
 * middle of a poll is not an edge case — any tab left open overnight meets an expired session on
 * its next request. The
 * 401 arrives at the data layer, but the thing that has to react to it is the gate, and they have no
 * component relationship: the gate renders the tree that contains the poll.
 *
 * A Set rather than a single slot, because more than one `useSession` instance can be mounted at
 * once (the shell reads the session for the user menu, and the settings and environment pages read
 * it for themselves). A single slot let the second mount steal it and the first unmount silence the
 * gate for both.
 */
const listeners = new Set<() => void>();

/** The status code that means "the session is gone" — every data hook checks for it and hands the
 * gate the news via {@link reportUnauthenticated} rather than rendering it as its own error. */
export const HTTP_STATUS_UNAUTHORIZED = 401;

export function reportUnauthenticated(): void {
    for (const listener of listeners) listener();
}

/** Registers a 401 listener; returns the unsubscribe. The effect below is one caller of it. */
export function subscribeUnauthenticated(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Signs the caller out: POSTs the logout route — never GET, which the server refuses as CSRF-able —
 * then fires the same broadcast a 401 does, so every mounted `useSession` re-checks `/api/auth/me`,
 * hears "nobody", and the gate returns. Fired even when the POST itself fails: the re-check is what
 * decides what the screen shows, and a dead network re-checks into an error, not a stale session.
 */
export async function signOut(): Promise<void> {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
        // The POST only fails when the network itself is down; the re-check below reports that as
        // an error rather than this promise rejecting into an unhandled one.
    } finally {
        reportUnauthenticated();
    }
}

export interface UseSession {
    session: Session | null;
    /** True only before the first answer; a re-check does not blank the screen. */
    loading: boolean;
    /** The server was unreachable — distinct from a clean "you are not signed in". */
    error: string | null;
}

/** What `/api/auth/me` answers: the session, or an explicit "nobody". Both are 200s — a 401 here
 * would be logged as a console error by the browser of everybody who has not signed in yet. */
type MeResponse = Session | { authenticated: false };

export function useSession(): UseSession {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const check = useCallback(async () => {
        try {
            // No `credentials: 'include'`: the default `same-origin` already sends the cookie, and
            // 'include' would drag CORS into a same-origin app for nothing.
            const response = await fetch('/api/auth/me');
            if (!response.ok) {
                setError((await refusalOf(response, 'Could not check the session')).error);
            } else {
                const payload = (await response.json()) as MeResponse;
                setSession(payload.authenticated ? payload : null);
                setError(null);
            }
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void check();
        return subscribeUnauthenticated(() => void check());
    }, [check]);

    return { session, loading, error };
}
