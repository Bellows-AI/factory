import { useCallback, useEffect, useRef, useState } from 'react';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';
import type { WorkflowParamChoice } from '../task-composer.js';
import { JSON_HEADERS } from '@factory-ai/core';

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

/** One row of the management panel's list — `GET /api/workflows`' summary shape, definition
 * omitted (issue 131): the panel fetches a record's `definition` only when an edit opens it. */
export interface WorkflowSummaryView {
    id: string;
    name: string;
    scope: 'org' | 'user' | 'repo';
    userId: string | null;
    repo: string | null;
    createdAt: string;
    updatedAt: string;
}

/** The full record a `GET /api/workflows/:id` or a write answers with. */
export interface WorkflowDetailView extends WorkflowSummaryView {
    definition: unknown;
}

/** A read or write that named its own refusal, `code` included — the panel renders `code: error`
 * so a validator refusal (UNKNOWN_KEY, NO_PUBLISH_PATH, …) is diagnosable, not just a sentence. */
export type WorkflowResult = { ok: true; record: WorkflowDetailView } | { ok: false; error: string; code?: string };

export interface UseWorkflowsManagement {
    /** Null while the first fetch has not answered. */
    workflows: WorkflowSummaryView[] | null;
    loading: boolean;
    error: string | null;
    fetchOne: (id: string) => Promise<WorkflowResult>;
    create: (input: { name: string; scope: 'org' | 'user'; definition: unknown }) => Promise<WorkflowResult>;
    update: (id: string, input: { name: string; definition: unknown }) => Promise<WorkflowResult>;
    remove: (id: string) => Promise<string | null>;
}

/** A failed response's body, best-effort: never throws on a non-JSON or empty body. */
async function refusalOf(response: Response): Promise<{ error: string; code?: string }> {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    const error = body.error ?? `Request failed (${response.status})`;
    return body.code ? { error, code: body.code } : { error };
}

/**
 * The settings management panel's CRUD surface (issue 131): the caller-visible list — org-level
 * and the caller's own user-level workflows, the same no-repo-context list `DefaultWorkflowPanel`'s
 * page already sits beside — plus fetch-one, create, update and delete. No polling, like
 * `useAccessTokens`: the list only changes when this panel writes to it, and each write refetches
 * so the table shows exactly what is stored.
 *
 * Repo-scoped workflows stay out of this list on purpose: `GET /api/workflows` with no `repo`
 * query answers org and own-user rows only (`listVisible`'s own degrade-away rule), and a repo
 * context this settings page has no reason to hold is not worth adding just to show a scope this
 * panel does not offer creating anyway — repo-scoped definitions stay the API's own surface.
 */
export function useWorkflowsManagement(): UseWorkflowsManagement {
    const [workflows, setWorkflows] = useState<WorkflowSummaryView[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);

    const load = useCallback(async (signal: AbortSignal) => {
        try {
            const response = await fetch('/api/workflows', { signal });
            if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                reportUnauthenticated();
                setLoading(false);
                return;
            }
            if (!response.ok) {
                const refusal = await refusalOf(response);
                setError(refusal.error);
                setLoading(false);
                return;
            }
            const body = (await response.json()) as { workflows: WorkflowSummaryView[] };
            setWorkflows(body.workflows);
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

    const fetchOne = useCallback(async (id: string): Promise<WorkflowResult> => {
        try {
            const response = await fetch(`/api/workflows/${id}`);
            if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                reportUnauthenticated();
                return { ok: false, error: 'Your session expired' };
            }
            if (!response.ok) return { ok: false, ...(await refusalOf(response)) };
            return { ok: true, record: (await response.json()) as WorkflowDetailView };
        } catch (e) {
            return { ok: false, error: (e as Error).message };
        }
    }, []);

    const create = useCallback(
        async (input: { name: string; scope: 'org' | 'user'; definition: unknown }): Promise<WorkflowResult> => {
            try {
                const response = await fetch('/api/workflows', {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify(input),
                });
                if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                    reportUnauthenticated();
                    return { ok: false, error: 'Your session expired' };
                }
                if (!response.ok) return { ok: false, ...(await refusalOf(response)) };
                const record = (await response.json()) as WorkflowDetailView;
                refresh();
                return { ok: true, record };
            } catch (e) {
                return { ok: false, error: (e as Error).message };
            }
        },
        [refresh]
    );

    const update = useCallback(
        async (id: string, input: { name: string; definition: unknown }): Promise<WorkflowResult> => {
            try {
                const response = await fetch(`/api/workflows/${id}`, {
                    method: 'PUT',
                    headers: JSON_HEADERS,
                    body: JSON.stringify(input),
                });
                if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                    reportUnauthenticated();
                    return { ok: false, error: 'Your session expired' };
                }
                if (!response.ok) return { ok: false, ...(await refusalOf(response)) };
                const record = (await response.json()) as WorkflowDetailView;
                refresh();
                return { ok: true, record };
            } catch (e) {
                return { ok: false, error: (e as Error).message };
            }
        },
        [refresh]
    );

    const remove = useCallback(
        async (id: string): Promise<string | null> => {
            try {
                const response = await fetch(`/api/workflows/${id}`, { method: 'DELETE' });
                if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                    reportUnauthenticated();
                    return 'Your session expired';
                }
                if (!response.ok) return (await refusalOf(response)).error;
                refresh();
                return null;
            } catch (e) {
                return (e as Error).message;
            }
        },
        [refresh]
    );

    return { workflows, loading, error, fetchOne, create, update, remove };
}
