import { useCallback, useEffect, useRef, useState } from 'react';
import { reportUnauthenticated } from './useSession.js';

export type CloneStatus = 'queued' | 'cloning' | 'ready' | 'failed';

export interface WorkspaceRepo {
    owner: string;
    name: string;
    status: CloneStatus;
    /** Why a clone failed, in git's own words. Null unless `status` is 'failed'. */
    error: string | null;
    selectedAt: string;
    readyAt: string | null;
    /**
     * On-disk facts. All three are null until the checkout exists AND has been measured — never
     * zero. A repository that is still cloning has no size, and `0 B` would be a claim.
     */
    branch: string | null;
    lastCommit: { sha: string; at: string; headline: string } | null;
    sizeBytes: number | null;
}

export interface WorkspaceExecutor {
    name: string;
    type: string;
    createdAt: string;
    /** Deliberately absent from the payload: it may hold credentials, and this is polled. */
}

/**
 * The same row as the poll returns, with the config back — the shape of the on-demand read the
 * executor dialog opens with, never of the poll.
 */
export interface WorkspaceExecutorFull extends WorkspaceExecutor {
    config: object;
}

export interface WorkspacePayload {
    /** Null when this deployment has no workspace root, which is a supported way to run. */
    root: string | null;
    repos: WorkspaceRepo[];
    /** Deselected, still on disk. Nothing prunes them; showing them is what makes that visible. */
    orphaned: { owner: string; name: string }[];
    executors: WorkspaceExecutor[];
}

export interface UseWorkspace {
    data: WorkspacePayload | null;
    loading: boolean;
    error: string | null;
    saving: boolean;
    save: (repos: { owner: string; name: string }[]) => Promise<string | null>;
    saveExecutors: (executors: { name: string; type: string; config: object }[]) => Promise<string | null>;
    /**
     * The whole executor list with configs — the read the dialog opens with. Never part of the
     * poll: the payload holds the credentials the member pasted, so it is fetched once per dialog
     * open instead.
     */
    listExecutorConfigs: () => Promise<{ ok: true; executors: WorkspaceExecutorFull[] } | { ok: false; error: string }>;
    refresh: () => void;
}

const settled = (data: WorkspacePayload | null): boolean =>
    !data || data.repos.every((repo) => repo.status === 'ready' || repo.status === 'failed');

/**
 * How long to wait before polling again, given how long we have been waiting already.
 *
 * A pure function, and exported, so the offline suite can assert the shape of the back-off without
 * fake timers. Two seconds matches the dashboard while somebody is watching a clone start; a clone
 * that has been running for five minutes is a big repository, and asking every two seconds for the
 * next twenty minutes is a query per member per tick for a value that changes once.
 */
export function pollDelay(elapsedMs: number): number {
    if (elapsedMs < 60_000) return 2_000;
    if (elapsedMs < 5 * 60_000) return 5_000;
    return 15_000;
}

/**
 * What a full executor row must look like for the dialog to be safe: it pre-fills from these rows
 * and the page calls `.some()` on the list, so a 2xx body that is not that shape is refused as an
 * error result, never handed on to throw in the render.
 */
const isExecutorFull = (row: unknown): row is WorkspaceExecutorFull =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as WorkspaceExecutorFull).name === 'string' &&
    typeof (row as WorkspaceExecutorFull).type === 'string' &&
    typeof (row as WorkspaceExecutorFull).createdAt === 'string' &&
    typeof (row as WorkspaceExecutorFull).config === 'object' &&
    (row as WorkspaceExecutorFull).config !== null;

/**
 * The one on-demand executor read — the dialog's only fetch. Module-level because it captures no
 * hook state: exported so the offline suite can pin the wire shape and its error handling, the
 * way `pollDelay` and `pollCompletedJobs` are.
 */
export const listExecutorConfigs = async (): Promise<
    { ok: true; executors: WorkspaceExecutorFull[] } | { ok: false; error: string }
> => {
    try {
        const response = await fetch('/api/workspace/executors');
        if (response.status === 401) {
            reportUnauthenticated();
            return { ok: false as const, error: 'Your session expired' };
        }
        if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            return {
                ok: false as const,
                error: body.error ?? `Could not load the executors (${response.status})`,
            };
        }
        const rows: unknown = ((await response.json()) as { executors?: unknown }).executors;
        if (!Array.isArray(rows) || !rows.every(isExecutorFull)) {
            return { ok: false as const, error: 'Could not load the executors: unexpected response shape.' };
        }
        return { ok: true as const, executors: rows };
    } catch (e) {
        return { ok: false as const, error: (e as Error).message };
    }
};

export function useWorkspace(): UseWorkspace {
    const [data, setData] = useState<WorkspacePayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const timer = useRef<number | null>(null);
    /** When the current run of unsettled polling began, for the back-off above. */
    const waitingSince = useRef<number | null>(null);

    const poll = useCallback(async (signal: AbortSignal) => {
        // A timer that fired between the abort and this call would otherwise start a fetch nothing
        // can stop.
        if (signal.aborted) return;
        try {
            const response = await fetch('/api/workspace', { signal });

            // Handed to the gate rather than rendered as a banner, for the reason useStats gives:
            // every later poll would 401 too, so a banner would never clear.
            if (response.status === 401) {
                reportUnauthenticated();
                setLoading(false);
                return;
            }
            if (!response.ok) {
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                // Deliberately does not clear `data`: what is on screen is still the last true
                // answer, and blanking the page on one failed poll is worse than being stale.
                setError(body.error ?? `Request failed (${response.status})`);
                setLoading(false);
                return;
            }

            const body = (await response.json()) as WorkspacePayload;
            setData(body);
            setError(null);
            setLoading(false);

            // Everything settled: stop entirely. This list only changes when the member acts, and
            // they act through `save`, which re-arms the poll itself.
            if (settled(body)) {
                waitingSince.current = null;
                return;
            }
            waitingSince.current ??= Date.now();
            // Nothing to see while the tab is hidden, and a background tab polling forever is the
            // most common way a dashboard becomes somebody's battery complaint.
            const delay = document.hidden ? 15_000 : pollDelay(Date.now() - waitingSince.current);
            timer.current = window.setTimeout(() => void poll(signal), delay);
        } catch (e) {
            if (signal.aborted) return;
            setError((e as Error).message);
            setLoading(false);
        }
    }, []);

    /*
     * One live polling chain, enforced by aborting the previous one.
     *
     * `refresh()` used to start a poll without cancelling the fetch already in flight. Both chains
     * would then complete and both would call `setTimeout`, but only the last id landed in
     * `timer.current` — so the other became an orphan that polled every two seconds until the page
     * was closed. `save()` calls `refresh()`, which made every save that raced a tick permanently
     * double the request rate.
     */
    const controller = useRef<AbortController | null>(null);
    const start = useCallback(() => {
        controller.current?.abort();
        if (timer.current !== null) window.clearTimeout(timer.current);
        const own = new AbortController();
        controller.current = own;
        void poll(own.signal);
    }, [poll]);

    useEffect(() => {
        start();
        return () => {
            controller.current?.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [start]);

    /** Returns an error message, or null on success. The dialog shows it in place. */
    const save = useCallback(
        async (repos: { owner: string; name: string }[]): Promise<string | null> => {
            setSaving(true);
            try {
                const response = await fetch('/api/workspace/repos', {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ repos }),
                });
                if (response.status === 401) {
                    reportUnauthenticated();
                    return 'Your session expired';
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    return body.error ?? `Could not save the selection (${response.status})`;
                }
                // 202: the clones have not started yet. Re-arm the poll immediately so the page
                // shows them go from queued to cloning rather than waiting out a back-off.
                waitingSince.current = Date.now();
                start();
                return null;
            } catch (e) {
                return (e as Error).message;
            } finally {
                setSaving(false);
            }
        },
        [start]
    );

    /**
     * The executor PUT is not asynchronous — nothing clones — so no re-arm timing is needed.
     */
    const saveExecutors = useCallback(
        async (executors: { name: string; type: string; config: object }[]): Promise<string | null> => {
            setSaving(true);
            try {
                const response = await fetch('/api/workspace/executors', {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ executors }),
                });
                if (response.status === 401) {
                    reportUnauthenticated();
                    return 'Your session expired';
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    return body.error ?? `Could not save the executors (${response.status})`;
                }
                start();
                return null;
            } catch (e) {
                return (e as Error).message;
            } finally {
                setSaving(false);
            }
        },
        [start]
    );

    return { data, loading, error, saving, save, saveExecutors, listExecutorConfigs, refresh: start };
}
