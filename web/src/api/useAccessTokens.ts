import { useCallback, useEffect, useRef, useState } from 'react';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/** A list-row view of an access token. A token's secret — or its hash — is never in a list. */
export interface AccessTokenView {
    id: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
}

/** The one-time answer of a successful mint: the plaintext, or why it was refused. */
export type MintResult = { ok: true; token: string } | { ok: false; error: string };

export interface UseAccessTokens {
    tokens: AccessTokenView[] | null;
    loading: boolean;
    error: string | null;
    create: (label: string) => Promise<MintResult>;
    revoke: (id: string) => Promise<string | null>;
}

/**
 * One scope of access tokens — the caller's personal list, or the organization's.
 *
 * No polling, like `useEnv`: the list only changes when the page holding it mints or revokes, and
 * each success refetches so the table shows exactly what is stored.
 */
export function useAccessTokens(scope: 'personal' | 'org'): UseAccessTokens {
    // The org scope is the same routes under one prefix; the admin gate lives on the server.
    const base = scope === 'org' ? '/api/tokens/org' : '/api/tokens';
    const [tokens, setTokens] = useState<AccessTokenView[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);

    const load = useCallback(
        async (signal: AbortSignal) => {
            try {
                const response = await fetch(base, { signal });
                if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                    // Handed to the gate rather than rendered as a banner — every later request
                    // would 401 too, so a banner would never clear.
                    reportUnauthenticated();
                    setLoading(false);
                    return;
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    setError(body.error ?? `Request failed (${response.status})`);
                    setLoading(false);
                    return;
                }
                const body = (await response.json()) as { tokens: AccessTokenView[] };
                setTokens(body.tokens);
                setError(null);
            } catch (e) {
                if (signal.aborted) return;
                setError((e as Error).message);
            } finally {
                setLoading(false);
            }
        },
        [base]
    );

    const refresh = useCallback(() => {
        controller.current?.abort();
        const own = new AbortController();
        controller.current = own;
        void load(own.signal);
    }, [load]);

    useEffect(() => {
        refresh();
        return () => controller.current?.abort();
    }, [refresh]);

    const create = useCallback(
        async (label: string): Promise<MintResult> => {
            try {
                const response = await fetch(base, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ label }),
                });
                if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                    reportUnauthenticated();
                    return { ok: false, error: 'Your session expired' };
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    return { ok: false, error: body.error ?? `Could not create the token (${response.status})` };
                }
                const body = (await response.json()) as { token: string };
                refresh();
                return { ok: true, token: body.token };
            } catch (e) {
                return { ok: false, error: (e as Error).message };
            }
        },
        [base, refresh]
    );

    const revoke = useCallback(
        async (id: string): Promise<string | null> => {
            try {
                const response = await fetch(`${base}/${id}/revoke`, { method: 'POST' });
                if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                    reportUnauthenticated();
                    return 'Your session expired';
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    return body.error ?? `Could not revoke the token (${response.status})`;
                }
                refresh();
                return null;
            } catch (e) {
                return (e as Error).message;
            }
        },
        [base, refresh]
    );

    return { tokens, loading, error, create, revoke };
}
