import { useCallback, useEffect, useState } from 'react';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

export interface InstallationRepo {
    owner: string;
    name: string;
    private: boolean;
    defaultBranch: string | null;
    pushedAt: string | null;
}

export interface ReposPayload {
    repos: InstallationRepo[];
    installation: { id: string; account: string | null; repositorySelection: 'all' | 'selected' | null } | null;
    meta: {
        fetchedAt: string | null;
        /** Named, so the picker can say "GitHub is unreachable" rather than "no repositories". */
        error: string | null;
    };
}

export interface UseRepos {
    data: ReposPayload | null;
    loading: boolean;
    error: string | null;
}

/**
 * The installation's repositories, fetched once.
 *
 * No polling, unlike `useWorkspace`: the answer changes when a human installs the App on another
 * repository, which is not something worth asking about every two seconds while somebody stares at
 * a list. `enabled` keeps the request from firing until the dialog is actually open.
 */
export function useRepos(enabled: boolean): UseRepos {
    const [data, setData] = useState<ReposPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async (signal: AbortSignal) => {
        setLoading(true);
        try {
            const response = await fetch('/api/repos', { signal });
            if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                reportUnauthenticated();
                return;
            }
            if (!response.ok) {
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                setError(body.error ?? `Request failed (${response.status})`);
                return;
            }
            setData((await response.json()) as ReposPayload);
            setError(null);
        } catch (e) {
            if (signal.aborted) return;
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [enabled, load]);

    return { data, loading, error };
}
