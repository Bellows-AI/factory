import { useCallback, useEffect, useRef, useState } from 'react';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
/** Foreground/background poll cadence — the value only changes when a member edits it. */
const POLL_MS_VISIBLE = 30_000;
const POLL_MS_HIDDEN = 60_000;

/**
 * The default workflow's two optional steps (issue 208, riding issue 203's frozen settings API): the
 * mandatory prompt → gates → publish spine is not a choice, so only these two travel — in the
 * settings PUT and in a queued task's `defaultWorkflow`.
 */
export interface DefaultWorkflowSteps {
    reviewReconciliation: boolean;
    mergeConflictAutofix: boolean;
}

/** The stored pair the board serves (`GET/PUT /api/workflows/default-settings`, issue 203). */
export interface DefaultWorkflowSettings extends DefaultWorkflowSteps {
    /** ISO 8601 once the member has saved; null over the missing-row defaults. */
    updatedAt: string | null;
}

export type DefaultWorkflowFetchResult =
    | { ok: true; data: DefaultWorkflowSettings }
    /** `unavailable` is the org's store missing entirely (503) — distinct from a transient read failure. */
    | { ok: false; unavailable: boolean; error: string | null };

export type DefaultWorkflowSaveResult =
    | { ok: true; data: DefaultWorkflowSettings }
    | { ok: false; unavailable: boolean; error: string };

/**
 * `GET /api/workflows/default-settings`, pinned at the wire the way `listExecutorConfigs` is: a
 * plain async function the hook below wires state around, so the request/response contract is
 * asserted directly rather than only through a page render that never runs an effect.
 */
export async function fetchDefaultWorkflowSettings(): Promise<DefaultWorkflowFetchResult> {
    try {
        const response = await fetch('/api/workflows/default-settings');
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false, unavailable: false, error: null };
        }
        if (response.status === HTTP_STATUS_SERVICE_UNAVAILABLE) {
            return { ok: false, unavailable: true, error: null };
        }
        if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            return {
                ok: false,
                unavailable: false,
                error: body.error ?? `Could not load the workflow defaults (${response.status})`,
            };
        }
        return { ok: true, data: (await response.json()) as DefaultWorkflowSettings };
    } catch (e) {
        return { ok: false, unavailable: false, error: (e as Error).message };
    }
}

/** `PUT /api/workflows/default-settings` — the complete pair, no partial update. */
export async function putDefaultWorkflowSettings(pair: DefaultWorkflowSteps): Promise<DefaultWorkflowSaveResult> {
    try {
        const response = await fetch('/api/workflows/default-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(pair),
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false, unavailable: false, error: 'Your session expired' };
        }
        if (response.status === HTTP_STATUS_SERVICE_UNAVAILABLE) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            return {
                ok: false,
                unavailable: true,
                error: body.error ?? 'No workflow settings store for this organization',
            };
        }
        if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            return { ok: false, unavailable: false, error: body.error ?? `Could not save (${response.status})` };
        }
        return { ok: true, data: (await response.json()) as DefaultWorkflowSettings };
    } catch (e) {
        return { ok: false, unavailable: false, error: (e as Error).message };
    }
}

export interface UseDefaultWorkflowSettings {
    data: DefaultWorkflowSettings | null;
    loading: boolean;
    /** The org has no settings store at all (503) — distinct from a transient read failure. */
    unavailable: boolean;
    error: string | null;
    saving: boolean;
    refresh: () => void;
    save: (pair: DefaultWorkflowSteps) => Promise<DefaultWorkflowSaveResult>;
}

/**
 * The member's saved default-workflow-step settings (issue 203's frozen API, consumed here for
 * the first time — issue 208). Polled at a fixed, generous interval: the value only changes when the
 * member edits it on the settings page, but this hook is also mounted by the task composer, a
 * SEPARATE page from the one that edits it — a poll is what lets an already-open composer notice
 * a save made on another tab or in an earlier session, which is what "a settings poll refresh
 * updates a pristine draft" (the issue's acceptance criterion) actually needs.
 */
export function useDefaultWorkflowSettings(): UseDefaultWorkflowSettings {
    const [data, setData] = useState<DefaultWorkflowSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [unavailable, setUnavailable] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const timer = useRef<number | null>(null);
    const controller = useRef<AbortController | null>(null);

    const poll = useCallback(async (signal: AbortSignal) => {
        const result = await fetchDefaultWorkflowSettings();
        // A chain `start()` already superseded must not land state or arm its own next tick — the
        // orphaned-timer bug `useWorkspace.ts` documents: two live chains would otherwise both
        // call setTimeout, and only the last id ever lands in `timer.current`, so the other polls
        // forever with nothing left able to cancel it.
        if (signal.aborted) return;
        setLoading(false);
        if (result.ok) {
            setData(result.data);
            setUnavailable(false);
            setError(null);
        } else {
            setUnavailable(result.unavailable);
            setError(result.error);
        }
        timer.current = window.setTimeout(() => void poll(signal), document.hidden ? POLL_MS_HIDDEN : POLL_MS_VISIBLE);
    }, []);

    // One live polling chain, enforced by aborting the previous one before starting the next —
    // mirrors useWorkspace.ts's `start()`.
    const start = useCallback(() => {
        controller.current?.abort();
        if (timer.current !== null) window.clearTimeout(timer.current);
        const own = new AbortController();
        controller.current = own;
        setLoading(true);
        void poll(own.signal);
    }, [poll]);

    const refresh = useCallback(() => start(), [start]);

    useEffect(() => {
        start();
        return () => {
            controller.current?.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [start]);

    const save = useCallback(
        async (pair: DefaultWorkflowSteps) => {
            setSaving(true);
            try {
                const result = await putDefaultWorkflowSettings(pair);
                if (result.ok) {
                    setData(result.data);
                    setUnavailable(false);
                    setError(null);
                    // A poll already in flight when the PUT was sent can still land after it, its
                    // abort signal untouched, and overwrite this write with what it read before
                    // the write committed — restarting the chain aborts that stale generation and
                    // starts the next GET only after the write is known to have landed.
                    start();
                } else {
                    setUnavailable(result.unavailable);
                }
                return result;
            } finally {
                setSaving(false);
            }
        },
        [start]
    );

    return { data, loading, unavailable, error, saving, refresh, save };
}
