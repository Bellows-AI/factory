import { useCallback, useEffect, useRef, useState } from 'react';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';
import type { WorkflowParamChoice } from '../task-composer.js';

/**
 * One workflow the composer can offer: the id and name a `POST /api/jobs` body names, the scope it
 * sits in, and the launch parameters it DECLARES — one explicit composer input each, all required
 * at launch, with the author's plain-language guidance when the board serves it. Deliberately not
 * the 16 KiB definition — the composer offers a process by name; the board freezes the resolved
 * definition onto the task.
 */
export interface WorkflowChoice {
    id: string;
    name: string;
    scope: 'org' | 'user' | 'repo';
    params: WorkflowParamChoice[];
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

/** One repository context's answered workflow list: the list, and the context it belongs to. */
export interface WorkflowAnswer {
    /** The repository the list was fetched for — null for the no-repository context. */
    repo: string | null;
    /** What that context answered with. */
    workflows: WorkflowChoice[];
}

/**
 * The workflow list the composer may offer for `repo`: one the SAME context answered. An answer
 * is keyed by the repository it was fetched for, so switching the repository makes the previous
 * list invisible the moment the new request STARTS — not only when the response lands. A list
 * held over from another context while its successor is pending is exactly how a workflow picked
 * for one repository gets selected and submitted under another; the composer's own reset clears
 * the choice, but the stale list must not sit there offering it back.
 */
export function answeredWorkflows(answer: WorkflowAnswer | null, repo: string | null): WorkflowChoice[] | null {
    return answer !== null && answer.repo === repo ? answer.workflows : null;
}

/**
 * The workflow list the task composer's dropdown is fed by (`GET /api/workflows`), refetched when
 * the repository context changes — repo-scoped workflows exist per repository, and the previous
 * context's list reads as null for the whole duration of the new request. No polling, unlike
 * `useWorkspace`: the list only changes when somebody creates or deletes a definition, and the
 * composer's dropdown is not a live surface. 401s are handed to the gate like every other read.
 */
export function useWorkflows(repo: string | null): UseWorkflows {
    const [answer, setAnswer] = useState<WorkflowAnswer | null>(null);
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
                if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                    reportUnauthenticated();
                    return;
                }
                if (!response.ok) {
                    setError(`Could not load the workflows (${response.status})`);
                    return;
                }
                const body = (await response.json()) as { workflows?: WorkflowChoice[] };
                setAnswer({ repo, workflows: body.workflows ?? [] });
                setError(null);
            } catch {
                // Aborted on repo change or unmount — the newer fetch answers instead.
            }
        })();
        return () => ack.abort();
    }, [repo, nonce]);

    return { workflows: answeredWorkflows(answer, repo), error, refresh };
}
