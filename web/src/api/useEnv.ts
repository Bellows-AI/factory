import { useCallback, useEffect, useRef, useState } from 'react';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

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

/**
 * What a save resolves to. On success `vars` is the scope's stored rows — the PUT's own response —
 * so the editor can adopt exactly what is stored without a remount wiping its "Saved." confirmation
 * mid-render.
 */
export interface EnvSaveResult {
    error: string | null;
    vars: EnvVarView[];
}

export interface UseEnv {
    data: EnvPayload | null;
    loading: boolean;
    error: string | null;
    saving: boolean;
    refresh: () => void;
    saveOrg: (vars: EnvVarInput[]) => Promise<EnvSaveResult>;
    saveWorkspace: (vars: EnvVarInput[]) => Promise<EnvSaveResult>;
    saveRepo: (repo: { owner: string; name: string }, vars: EnvVarInput[]) => Promise<EnvSaveResult>;
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
            if (response.status === HTTP_STATUS_UNAUTHORIZED) {
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

    const put = useCallback(async (url: string, body: unknown): Promise<EnvSaveResult> => {
        setSaving(true);
        try {
            const response = await fetch(url, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                reportUnauthenticated();
                return { error: 'Your session expired', vars: [] };
            }
            if (!response.ok) {
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                return { error: body.error ?? `Could not save (${response.status})`, vars: [] };
            }
            const saved = (await response.json()) as { vars: EnvVarView[] };
            return { error: null, vars: saved.vars };
        } catch (e) {
            return { error: (e as Error).message, vars: [] };
        } finally {
            setSaving(false);
        }
    }, []);

    // Each save refetches on success, so the page-level data (the repository select's options,
    // in particular) tracks the store. The editor that saved adopts the PUT's own rows instead
    // of waiting on this — a remount here would wipe its "Saved." confirmation.
    const saveOrg = useCallback(
        async (vars: EnvVarInput[]) => {
            const result = await put('/api/env/org', { vars });
            if (result.error === null) refresh();
            return result;
        },
        [put, refresh]
    );

    const saveWorkspace = useCallback(
        async (vars: EnvVarInput[]) => {
            const result = await put('/api/env/workspace', { vars });
            if (result.error === null) refresh();
            return result;
        },
        [put, refresh]
    );

    const saveRepo = useCallback(
        async (repo: { owner: string; name: string }, vars: EnvVarInput[]) => {
            const result = await put('/api/env/repo', { repo, vars });
            if (result.error === null) refresh();
            return result;
        },
        [put, refresh]
    );

    return { data, loading, error, saving, refresh, saveOrg, saveWorkspace, saveRepo };
}
