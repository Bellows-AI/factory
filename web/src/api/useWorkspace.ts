import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecutorScope } from '@factory-ai/core';
import { JSON_HEADERS } from '@factory-ai/core';
import { usePersonalExecutorWrites } from './usePersonalExecutorWrites.js';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

export type CloneStatus = 'queued' | 'cloning' | 'ready' | 'failed' | 'purging';

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

/** A deselected checkout that is still on disk (issue #92): measurable, and manually deletable. */
export interface OrphanedRepo {
    owner: string;
    name: string;
    status: CloneStatus;
    error: string | null;
    sizeBytes: number | null;
}

export interface WorkspaceExecutor {
    /** The row's id: the by-id remove and suspend routes address it (issue 440). */
    id: string;
    name: string;
    /** Suspended (issue 440): listed and configured, but not selectable and cannot launch a run. */
    suspended: boolean;
    type: string;
    createdAt: string;
    /** The default workflow's gate-repair round limit tasks on this executor launch with (#49). */
    gateFixRounds: number;
    /** Deliberately absent from the payload: it may hold credentials, and this is polled. */
}

/**
 * An organization profile as the poll carries it (issue 391): selection metadata only. The
 * configuration may hold provider credentials, and this payload is fetched by a poll every
 * member's browser runs — the full organization configuration answers to the admin list
 * (`listOrgExecutorConfigs`), never to the poll.
 */
export interface OrgExecutor {
    name: string;
    type: string;
    createdAt: string;
    suspended: boolean;
}

/** The member's default-executor preference as the poll resolves it (issue 391). */
export interface DefaultExecutor {
    scope: ExecutorScope;
    name: string;
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
    /** Deselected, still on disk. Now with sizes, and with a delete of one's own. */
    orphaned: OrphanedRepo[];
    /**
     * The member's checkout usage: selected and orphaned clones summed. Null until every
     * INCLUDED checkout has a measurement — a partial sum would read as the whole truth. The
     * driver's `.worktrees/` and other workspace files are not checkouts and are not counted.
     */
    checkoutTotalBytes: number | null;
    executors: WorkspaceExecutor[];
    /** The organization's profiles, selection metadata only (issue 391). */
    orgExecutors: OrgExecutor[];
    /**
     * The member's resolved default: their stored preference while it still resolves, else the
     * server's deterministic fallback. Null when nothing is selectable.
     */
    defaultExecutor: DefaultExecutor | null;
}

export interface UseWorkspace {
    data: WorkspacePayload | null;
    loading: boolean;
    error: string | null;
    saving: boolean;
    save: (repos: { owner: string; name: string }[]) => Promise<string | null>;
    saveExecutors: (
        executors: { name: string; type: string; config: object; gateFixRounds: number; suspended?: boolean }[]
    ) => Promise<string | null>;
    /** Removes ONE personal profile by id (issue 440); the by-id route cannot clobber other rows. */
    removeExecutor: (id: string) => Promise<string | null>;
    /** Suspends or resumes ONE personal profile by id (issue 440). */
    suspendExecutor: (id: string, suspended: boolean) => Promise<string | null>;
    /**
     * Stores the member's default-executor preference (issue 391): names a profile by scope and
     * name, either scope, without touching the shared profile or anyone else's default.
     */
    setDefaultExecutor: (scope: ExecutorScope, name: string) => Promise<string | null>;
    /** Deletes ONE orphaned checkout from disk, after its confirmation (issue #92). */
    purge: (owner: string, name: string) => Promise<string | null>;
    /**
     * The whole executor list with configs — the read the dialog opens with. Never part of the
     * poll: the payload holds the credentials the member pasted, so it is fetched once per dialog
     * open instead.
     */
    listExecutorConfigs: () => Promise<{ ok: true; executors: WorkspaceExecutorFull[] } | { ok: false; error: string }>;
    refresh: () => void;
}

/**
 * The two executor/workspace PUT bodies, module-level like the reads above: the hook hands them
 * its URLs and payloads and keeps only the poll re-arm.
 */
async function putJson(
    url: string,
    body: unknown,
    fallbackError: string
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        const response = await fetch(url, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false as const, error: 'Your session expired' };
        }
        if (!response.ok) {
            return { ok: false as const, error: (await refusalOf(response, fallbackError)).error };
        }
        return { ok: true as const };
    } catch (e) {
        return { ok: false as const, error: (e as Error).message };
    }
}

/**
 * Whether the poll can stand down: every repo settled AND no checkout being deleted. A `purging`
 * orphan keeps the poll armed — the UI shows "Deleting…" until the row either comes back `failed`
 * or disappears, and disappearance IS the completion.
 */
export const payloadSettled = (data: WorkspacePayload | null): boolean =>
    !data ||
    (data.repos.every((repo) => repo.status === 'ready' || repo.status === 'failed') &&
        data.orphaned.every((orphan) => orphan.status !== 'purging'));

const POLL_BACKOFF_FAST_WINDOW_MS = 60_000;
const POLL_BACKOFF_FAST_DELAY_MS = 2_000;
const POLL_BACKOFF_SLOW_WINDOW_MS = 300_000;
const POLL_BACKOFF_SLOW_DELAY_MS = 5_000;
const POLL_BACKOFF_MAX_DELAY_MS = 15_000;
const HTTP_STATUS_NO_CONTENT = 204;

/**
 * How long to wait before polling again, given how long we have been waiting already.
 *
 * A pure function, and exported, so the offline suite can assert the shape of the back-off without
 * fake timers. Two seconds matches the dashboard while somebody is watching a clone start; a clone
 * that has been running for five minutes is a big repository, and asking every two seconds for the
 * next twenty minutes is a query per member per tick for a value that changes once.
 */
export function pollDelay(elapsedMs: number): number {
    if (elapsedMs < POLL_BACKOFF_FAST_WINDOW_MS) return POLL_BACKOFF_FAST_DELAY_MS;
    if (elapsedMs < POLL_BACKOFF_SLOW_WINDOW_MS) return POLL_BACKOFF_SLOW_DELAY_MS;
    return POLL_BACKOFF_MAX_DELAY_MS;
}

/**
 * Re-arms the poll unless every repo has settled, in which case the back-off clock resets so the
 * next `save()` starts counting from zero rather than picking up wherever the last run left off.
 */
function scheduleNextPoll(
    body: WorkspacePayload,
    waitingSince: { current: number | null },
    scheduleTimeout: (delay: number) => void
): void {
    if (payloadSettled(body)) {
        waitingSince.current = null;
        return;
    }
    waitingSince.current ??= Date.now();
    // Nothing to see while the tab is hidden, and a background tab polling forever is the most
    // common way a dashboard becomes somebody's battery complaint.
    const delay = document.hidden ? POLL_BACKOFF_MAX_DELAY_MS : pollDelay(Date.now() - waitingSince.current);
    scheduleTimeout(delay);
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
    typeof (row as WorkspaceExecutorFull).gateFixRounds === 'number' &&
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
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false as const, error: 'Your session expired' };
        }
        if (!response.ok) {
            return {
                ok: false as const,
                error: (await refusalOf(response, 'Could not load the executors')).error,
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

/**
 * The default-executor preference (issue 391). A refusal is the dialog's error message; a
 * preference naming no accessible profile is the route's 404. Module-level like the other
 * on-demand fetches above: it captures no hook state.
 */
export const putDefaultExecutor = async (
    scope: ExecutorScope,
    name: string
): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
        const response = await fetch('/api/workspace/executors/default', {
            method: 'PUT',
            headers: JSON_HEADERS,
            body: JSON.stringify({ executor: name, executorScope: scope }),
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false as const, error: 'Your session expired' };
        }
        if (!response.ok) {
            return {
                ok: false as const,
                error: (await refusalOf(response, 'Could not save the default executor')).error,
            };
        }
        return { ok: true as const };
    } catch (e) {
        return { ok: false as const, error: (e as Error).message };
    }
};

/**
 * Deletes one orphaned checkout from disk (issue #92). 202 (removal running) and 204 (nothing to
 * remove) are both success: the poll decides what the member sees — "Deleting…", the failure, or
 * the row gone. A refusal (selected, still cloning, tasks in flight, already deleting) is the
 * dialog's error message.
 */
export const purgeOrphan = async (
    owner: string,
    name: string
): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
        const response = await fetch(`/api/workspace/repos/${owner}/${name}`, { method: 'DELETE' });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false as const, error: 'Your session expired' };
        }
        if (!response.ok && response.status !== HTTP_STATUS_NO_CONTENT) {
            return { ok: false as const, error: (await refusalOf(response, 'Could not delete the checkout')).error };
        }
        return { ok: true as const };
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
            if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                reportUnauthenticated();
                setLoading(false);
                return;
            }
            if (!response.ok) {
                // Deliberately does not clear `data`: what is on screen is still the last true
                // answer, and blanking the page on one failed poll is worse than being stale.
                setError((await refusalOf(response)).error);
                setLoading(false);
                return;
            }

            const body = (await response.json()) as WorkspacePayload;
            setData(body);
            setError(null);
            setLoading(false);

            // This list only changes when the member acts, and they act through `save`, which
            // re-arms the poll itself — so a settled answer stops the chain entirely.
            scheduleNextPoll(body, waitingSince, (delay) => {
                timer.current = window.setTimeout(() => void poll(signal), delay);
            });
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
                const result = await putJson('/api/workspace/repos', { repos }, 'Could not save the selection');
                if (!result.ok) return result.error;
                // 202: the clones have not started yet. Re-arm the poll immediately so the page
                // shows them go from queued to cloning rather than waiting out a back-off.
                waitingSince.current = Date.now();
                start();
                return null;
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
        async (
            executors: { name: string; type: string; config: object; gateFixRounds: number; suspended?: boolean }[]
        ): Promise<string | null> => {
            setSaving(true);
            try {
                const result = await putJson('/api/workspace/executors', { executors }, 'Could not save the executors');
                if (!result.ok) return result.error;
                start();
                return null;
            } finally {
                setSaving(false);
            }
        },
        [start]
    );

    const { removeExecutor, suspendExecutor } = usePersonalExecutorWrites(start);

    /** The preference write, with the poll re-arm the other writes share. */
    const setDefaultExecutor = useCallback(
        async (scope: ExecutorScope, name: string): Promise<string | null> => {
            const result = await putDefaultExecutor(scope, name);
            if (result.ok) {
                start();
                return null;
            }
            return result.error;
        },
        [start]
    );

    /**
     * The manual purge. The answer is 202 or 204 and the row does the talking from here — the
     * poll rides through `purging` ("Deleting…") to `failed` or disappearance, which is the
     * completion the page shows.
     */
    const purge = useCallback(
        async (owner: string, name: string): Promise<string | null> => {
            const result = await purgeOrphan(owner, name);
            if (result.ok) {
                waitingSince.current = Date.now();
                start();
                return null;
            }
            return result.error;
        },
        [start]
    );

    return {
        data,
        loading,
        error,
        saving,
        save,
        saveExecutors,
        removeExecutor,
        suspendExecutor,
        setDefaultExecutor,
        purge,
        listExecutorConfigs,
        refresh: start,
    };
}
