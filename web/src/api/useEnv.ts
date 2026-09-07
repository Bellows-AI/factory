import { useCallback, useEffect, useRef, useState } from 'react';
import { reportUnauthenticated } from './useSession.js';

/** What a list read echoes. A secret's `value` is null for every caller — the write-only contract. */
export interface EnvVarView {
    name: string;
    value: string | null;
    isSecret: boolean;
    updatedAt: string;
}

export interface EnvRepoScope {
    owner: string;
    name: string;
    vars: EnvVarView[];
}

export interface EnvPayload {
    org: EnvVarView[];
    workspace: EnvVarView[];
    repos: EnvRepoScope[];
}

export interface EnvVarInput {
    name: string;
    value: string | null;
    isSecret: boolean;
}

export interface UseEnv {
    data: EnvPayload | null;
    loading: boolean;
    error: string | null;
    saving: boolean;
    refresh: () => void;
    saveOrg: (vars: EnvVarInput[]) => Promise<string | null>;
    saveWorkspace: (vars: EnvVarInput[]) => Promise<string | null>;
    saveRepo: (repo: { owner: string; name: string }, vars: EnvVarInput[]) => Promise<string | null>;
}

/**
 * The runner environment, fetched once and refetched after each save.
 *
 * No polling, unlike `useWorkspace`: this list only changes when somebody edits it, and the editor
 * that edits it is the page holding this hook. A two-second poll would also race the draft state in
 * the editors, remounting them under a typing hand.
 */
export function useEnv(): UseEnv {
    const [data, setData] = useState<EnvPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const controller = useRef<AbortController | null>(null);

    const load = useCallback(async (signal: AbortSignal) => {
        try {
            const response = await fetch('/api/env', { signal });
            if (response.status === 401) {
                // Handed to the gate rather than rendered as a banner — every later request would
                // 401 too, so a banner would never clear.
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
            setData((await response.json()) as EnvPayload);
            setError(null);
        } catch (e) {
            if (signal.aborted) return;
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

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

    const put = useCallback(
        async (url: string, body: unknown): Promise<string | null> => {
            setSaving(true);
            try {
                const response = await fetch(url, {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (response.status === 401) {
                    reportUnauthenticated();
                    return 'Your session expired';
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    return body.error ?? `Could not save (${response.status})`;
                }
                return null;
            } catch (e) {
                return (e as Error).message;
            } finally {
                setSaving(false);
            }
        },
        [],
    );

    // Each save refetches on success, so the panel remounts showing exactly what is stored —
    // including a secret that just went from null-keep to set.
    const saveOrg = useCallback(
        async (vars: EnvVarInput[]) => {
            const failure = await put('/api/env/org', { vars });
            if (failure === null) refresh();
            return failure;
        },
        [put, refresh],
    );

    const saveWorkspace = useCallback(
        async (vars: EnvVarInput[]) => {
            const failure = await put('/api/env/workspace', { vars });
            if (failure === null) refresh();
            return failure;
        },
        [put, refresh],
    );

    const saveRepo = useCallback(
        async (repo: { owner: string; name: string }, vars: EnvVarInput[]) => {
            const failure = await put('/api/env/repo', { repo, vars });
            if (failure === null) refresh();
            return failure;
        },
        [put, refresh],
    );

    return { data, loading, error, saving, refresh, saveOrg, saveWorkspace, saveRepo };
}
