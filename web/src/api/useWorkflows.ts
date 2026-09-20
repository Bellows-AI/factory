import { useCallback, useEffect, useRef, useState } from 'react';
import { reportUnauthenticated } from './useSession.js';

/**
 * One workflow the composer can offer: the id and name a `POST /api/jobs` body names, the scope it
 * sits in, and the launch parameters it DECLARES — one explicit composer input each, all required
 * at launch. Deliberately not the 16 KiB definition — the composer offers a process by name; the
 * board freezes the resolved definition onto the task.
 */
export interface WorkflowChoice {
    id: string;
    name: string;
    scope: 'org' | 'user' | 'repo';
    params: { name: string; pattern?: string; description?: string; example?: string }[];
}

export interface UseWorkflows {
    /**
     * The caller-visible workflows for the requested repository context. Null while the fetch has
     * not answered — "not known" is a different sentence from "known empty", and the composer
     * hides the select entirely until there is an answer to show.
     */
    workflows: WorkflowChoice[] | null;
    error: string | null;
    refresh: () => void;
}

/**
 * The workflow list the task composer's dropdown is fed by (`GET /api/workflows`), refetched when
 * the repository context changes — repo-scoped workflows exist per repository, so a change of repo
 * is a different list. No polling, unlike `useWorkspace`: the list only changes when somebody
 * creates or deletes a definition, and the composer's dropdown is not a live surface. 401s are
 * handed to the gate like every other read.
 */
export function useWorkflows(repo: string | null): UseWorkflows {
    const [workflows, setWorkflows] = useState<WorkflowChoice[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [nonce, setNonce] = useState(0);
    const controller = useRef<AbortController | null>(null);

    const refresh = useCallback(() => setNonce((n) => n + 1), []);

    useEffect(() => {
        controller.current?.abort();
        const ack = new AbortController();
        controller.current = ack;
        const url = repo === null ? '/api/workflows' : `/api/workflows?repo=${encodeURIComponent(repo)}`;
        (async () => {
            try {
                const response = await fetch(url, { signal: ack.signal });
                if (response.status === 401) {
                    reportUnauthenticated();
                    return;
                }
                if (!response.ok) {
                    setError(`Could not load the workflows (${response.status})`);
                    return;
                }
                const body = (await response.json()) as { workflows?: WorkflowChoice[] };
                setWorkflows(body.workflows ?? []);
                setError(null);
            } catch {
                // Aborted on repo change or unmount — the newer fetch answers instead.
            }
        })();
        return () => ack.abort();
    }, [repo, nonce]);

    return { workflows, error, refresh };
}
