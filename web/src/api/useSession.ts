import { useCallback, useEffect, useState } from 'react';

export interface Session {
    user: { id: string; login: string; name: string | null };
    role: 'admin' | 'member';
    organization: { id: string; name: string };
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
 * One module-level subscriber rather than a context, because there is exactly one gate and exactly
 * one thing to say to it.
 */
let listener: (() => void) | null = null;

export function reportUnauthenticated(): void {
    listener?.();
}

export interface UseSession {
    session: Session | null;
    /** True only before the first answer; a re-check does not blank the screen. */
    loading: boolean;
    /** The server was unreachable — distinct from a clean "you are not signed in". */
    error: string | null;
}

export function useSession(): UseSession {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const check = useCallback(async () => {
        try {
            // No `credentials: 'include'`: the default `same-origin` already sends the cookie, and
            // 'include' would drag CORS into a same-origin app for nothing.
            const response = await fetch('/api/auth/me');
            if (response.status === 401) {
                setSession(null);
                setError(null);
            } else if (response.ok) {
                setSession((await response.json()) as Session);
                setError(null);
            } else {
                setError(`Could not check the session (${response.status})`);
            }
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void check();
        listener = () => void check();
        return () => {
            listener = null;
        };
    }, [check]);

    return { session, loading, error };
}
