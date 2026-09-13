import { useCallback, useEffect, useRef, useState } from 'react';
import type { DateRange, OrganizationMeta, Stats, TelemetryStats } from '@factory-ai/core';
import { reportUnauthenticated } from './useSession.js';

export interface RateLimit {
    remaining: number;
    resetAt: string;
}

export interface TelemetryMeta {
    /**
     * 'empty' arrives with a real TelemetryStats so the panels can render their own
     * structure — that is how you see a pipeline that is wired but silent. 'unreachable'
     * and 'disabled' arrive with null.
     */
    status: 'ok' | 'empty' | 'unreachable' | 'disabled';
    reason: string | null;
    source: 'postgres' | 'fixture';
    fetchedAt: string | null;
    ageSeconds: number | null;
    stale: boolean;
    repoFilter: string[];
    otherRepoSessions: number;
    sessionsWithoutHook: number;
}

export interface StatsPayload {
    stats: Stats;
    telemetry: TelemetryStats | null;
    meta: {
        fetchedAt: string;
        ageSeconds: number;
        stale: boolean;
        rateLimit: RateLimit | null;
        revert: { status: 'ok' | 'unavailable'; reason: string | null };
        /**
         * Imported from core rather than restated here, unlike TelemetryMeta above:
         * `current.id` round-trips back to the server as `?org=` and on to a database partition,
         * and a hand-copied key that drifts is a partition mismatch, not a cosmetic difference.
         */
        organization: OrganizationMeta;
        /** Every repo the figures combine. Length 1 is the common case, not a special case. */
        repos: { owner: string; name: string }[];
        baseBranch: string;
        /** The range the server actually aggregated over, presets already resolved. */
        range: DateRange;
        telemetry: TelemetryMeta;
    };
}

export interface FetchState {
    state: 'idle' | 'loading' | 'error';
    phase: 'prs' | 'backfill' | 'history' | null;
    repo: string | null;
    prsFetched: number | null;
    backfillingPr: number | null;
    historyScanned: number | null;
    error: { message: string; code: string } | null;
}

export interface UseStats {
    data: StatsPayload | null;
    /** True only before anything has ever rendered. */
    loading: boolean;
    refreshing: boolean;
    progress: FetchState | null;
    error: string | null;
    refresh: () => void;
}

const POLL_MS = 2000;

/** `query` is the range query string; changing it re-polls without clearing what is on screen. */
export function useStats(query = 'range=all'): UseStats {
    const [data, setData] = useState<StatsPayload | null>(null);
    const [progress, setProgress] = useState<FetchState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(true);
    const timer = useRef<number | null>(null);

    const poll = useCallback(async (signal: AbortSignal) => {
        try {
            // No client-side timeout: aborting a cold fetch would waste the ~243
            // rate-limit points the server already spent.
            const response = await fetch(`/api/stats?${query}`, { signal });

            if (response.status === 202) {
                const body = (await response.json()) as { fetch: FetchState };
                setProgress(body.fetch);
                setPending(true);
                timer.current = window.setTimeout(() => void poll(signal), POLL_MS);
                return;
            }

            // Its own branch, ahead of the generic one below. The poll re-arms every two seconds
            // while a fetch is in progress, so a session expiring mid-poll is not exceptional —
            // and in the generic branch it renders a banner that never clears, because every
            // request that follows 401s too. Handing it to the gate is the only thing that can
            // actually resolve it.
            if (response.status === 401) {
                reportUnauthenticated();
                setPending(false);
                return;
            }

            if (!response.ok) {
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                // Deliberately does not clear `data`: a rate limit or an outage leaves
                // whatever is on screen the most accurate view available.
                setError(body.error ?? `Request failed (${response.status})`);
                setPending(false);
                return;
            }

            const body = (await response.json()) as StatsPayload;
            if (!body?.stats?.meta) throw new Error('Malformed /api/stats response');
            setData(body);
            setProgress(null);
            setError(null);
            setPending(false);
        } catch (e) {
            if (signal.aborted) return;
            setError((e as Error).message);
            setPending(false);
        }
    }, [query]);

    useEffect(() => {
        const controller = new AbortController();
        setPending(true);
        void poll(controller.signal);
        return () => {
            controller.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [poll]);

    const refresh = useCallback(() => {
        const controller = new AbortController();
        setPending(true);
        void fetch('/api/refresh', { method: 'POST' })
            .then(() => poll(controller.signal))
            .catch((e: Error) => {
                setError(e.message);
                setPending(false);
            });
    }, [poll]);

    return {
        data,
        loading: pending && data === null,
        refreshing: pending && data !== null,
        progress,
        error,
        refresh,
    };
}
