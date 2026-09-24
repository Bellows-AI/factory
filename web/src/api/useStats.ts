import { useCallback, useEffect, useRef, useState } from 'react';
import type { DateRange, OrganizationMeta, TaskUsageStats, TelemetryStats } from '@factory-ai/core';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

export interface TelemetryMeta {
    /**
     * 'empty' arrives with a real TelemetryStats so the panels can render their own
     * structure — that is how you see a pipeline that is wired but silent. The union keeps
     * 'unreachable' and 'disabled' for completeness of the API's vocabulary, but those two
     * answer 503 before a body is ever sent, so a 200 always carries a non-null `telemetry`.
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
    /** Sessions no board task matches — the third exclusion, beside the two setup failures. */
    unattributedSessions: number;
}

export interface StatsPayload {
    telemetry: TelemetryStats | null;
    /** What a task costs over the same range and scope. Null exactly when telemetry is. */
    tasks: TaskUsageStats | null;
    meta: {
        fetchedAt: string;
        ageSeconds: number;
        stale: boolean;
        /**
         * Imported from core rather than restated here, unlike TelemetryMeta above:
         * `current.id` round-trips back to the server as `?org=` and on to a database partition,
         * and a hand-copied key that drifts is a partition mismatch, not a cosmetic difference.
         */
        organization: OrganizationMeta;
        /** Every repo the figures combine. Length 1 is the common case, not a special case. */
        repos: { owner: string; name: string }[];
        /** The range the server actually aggregated over, presets already resolved. */
        range: DateRange;
        /** The scope the figures were computed under, and the member `mine` resolved to. */
        scope: 'org' | 'mine';
        scopeLogin: string | null;
        telemetry: TelemetryMeta;
    };
}

export interface FetchState {
    state: 'idle' | 'loading' | 'error';
    startedAt: string | null;
    finishedAt: string | null;
    error: { message: string; code: string } | null;
}

export interface UseStats {
    data: StatsPayload | null;
    /** True only before anything has ever rendered. */
    loading: boolean;
    progress: FetchState | null;
    error: string | null;
}

const POLL_MS = 2000;
/** The board's "still fetching from GitHub" status — distinct from a completed 200. */
const HTTP_STATUS_ACCEPTED = 202;

/** `query` is the range query string; changing it re-polls without clearing what is on screen. */
export function useStats(query = 'range=all'): UseStats {
    const [data, setData] = useState<StatsPayload | null>(null);
    const [progress, setProgress] = useState<FetchState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(true);
    const timer = useRef<number | null>(null);

    const poll = useCallback(
        async (signal: AbortSignal) => {
            try {
                const response = await fetch(`/api/stats?${query}`, { signal });

                if (response.status === HTTP_STATUS_ACCEPTED) {
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
                if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                    reportUnauthenticated();
                    setPending(false);
                    return;
                }

                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    // Deliberately does not clear `data`: an outage leaves
                    // whatever is on screen the most accurate view available.
                    setError(body.error ?? `Request failed (${response.status})`);
                    setPending(false);
                    return;
                }

                const body = (await response.json()) as StatsPayload;
                if (!body?.telemetry?.totals || !body?.meta) throw new Error('Malformed /api/stats response');
                setData(body);
                setProgress(null);
                setError(null);
                setPending(false);
            } catch (e) {
                if (signal.aborted) return;
                setError((e as Error).message);
                setPending(false);
            }
        },
        [query]
    );

    useEffect(() => {
        const controller = new AbortController();
        setPending(true);
        void poll(controller.signal);
        return () => {
            controller.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [poll]);

    return {
        data,
        loading: pending && data === null,
        progress,
        error,
    };
}
