import { useCallback, useEffect, useState } from 'react';

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
    role: 'admin' | 'member';
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
                setError(`Could not check the session (${response.status})`);
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
