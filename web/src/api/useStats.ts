import { useCallback, useEffect, useRef, useState } from 'react';
import type { DateRange, OrganizationMeta, TaskUsageStats, TelemetryStats } from '@factory-ai/core';
import { refusalOf } from './refusal.js';
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

export const POLL_MS = 2000;
export const VISIBLE_REFRESH_MS = 30_000;
export const HIDDEN_REFRESH_MS = 60_000;
/** The board's "still fetching from GitHub" status — distinct from a completed 200. */
const HTTP_STATUS_ACCEPTED = 202;

/** What one request answered, as far as the next one is concerned. */
export type StatsPollOutcome = 'progress' | 'stale' | 'fresh' | 'error';

/**
 * When to ask again, or null to stop. A 200 used to end the chain, so a dashboard opened before
 * a run's telemetry landed kept showing the empty snapshot until somebody changed the range.
 * While the dashboard is open (`live`) the chain never ends: a stale snapshot is being refreshed
 * server-side, so it is asked for again at the progress pace; a fresh one or a failed read waits
 * the quiet pace, slower in a hidden tab. Off the dashboard only a cold read keeps polling — the
 * other pages read `meta`, not the figures, and a refresh nobody looks at is wasted.
 */
export function nextStatsPollDelay(outcome: StatsPollOutcome, live: boolean, hidden: boolean): number | null {
    if (outcome === 'progress') return POLL_MS;
    if (!live) return null;
    if (outcome === 'stale' && !hidden) return POLL_MS;
    return hidden ? HIDDEN_REFRESH_MS : VISIBLE_REFRESH_MS;
}

function settledOutcome(stale: boolean): StatsPollOutcome {
    return stale ? 'stale' : 'fresh';
}

/**
 * Whether a tab coming back to the front should ask now instead of waiting out its armed tick. A
 * tick armed while hidden waits the hidden pace, so an open dashboard would otherwise show its old
 * snapshot for up to a minute. `armed` is false while a request is in flight — that one re-arms
 * itself at the visible pace, and asking again would overlap it.
 */
export function refetchOnVisible(live: boolean, hidden: boolean, armed: boolean): boolean {
    return live && !hidden && armed;
}

function armNext(timer: { current: number | null }, delay: number | null, tick: () => void): void {
    if (delay === null) return;
    timer.current = window.setTimeout(() => {
        timer.current = null;
        tick();
    }, delay);
}

/**
 * `query` is the range query string; changing it re-polls without clearing what is on screen.
 * `live` is whether the dashboard is open: turning it on fetches immediately — opening the
 * dashboard always shows current figures — and keeps the chain running while it stays on.
 */
export function useStats(query: string, live: boolean): UseStats {
    const [data, setData] = useState<StatsPayload | null>(null);
    const [progress, setProgress] = useState<FetchState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(true);
    const timer = useRef<number | null>(null);

    const poll = useCallback(
        async (signal: AbortSignal) => {
            // No abort guard needed: a tick armed on an aborted signal rejects in fetch and ends
            // in the catch's own `signal.aborted` return, without a request.
            const rearm = (outcome: StatsPollOutcome) =>
                armNext(timer, nextStatsPollDelay(outcome, live, document.hidden), () => void poll(signal));
            try {
                const response = await fetch(`/api/stats?${query}`, { signal });

                if (response.status === HTTP_STATUS_ACCEPTED) {
                    const body = (await response.json()) as { fetch: FetchState };
                    setProgress(body.fetch);
                    setPending(true);
                    rearm('progress');
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
                    // Deliberately does not clear `data`: an outage leaves
                    // whatever is on screen the most accurate view available.
                    setError((await refusalOf(response)).error);
                    setPending(false);
                    rearm('error');
                    return;
                }

                const body = (await response.json()) as StatsPayload;
                if (!body?.telemetry?.totals || !body?.meta) throw new Error('Malformed /api/stats response');
                setData(body);
                setProgress(null);
                setError(null);
                setPending(false);
                rearm(settledOutcome(body.meta.stale));
            } catch (e) {
                if (signal.aborted) return;
                setError((e as Error).message);
                setPending(false);
                rearm('error');
            }
        },
        [query, live]
    );

    useEffect(() => {
        const controller = new AbortController();
        setPending(true);
        void poll(controller.signal);
        const onVisibilityChange = () => {
            if (!refetchOnVisible(live, document.hidden, timer.current !== null)) return;
            window.clearTimeout(timer.current!);
            timer.current = null;
            void poll(controller.signal);
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            controller.abort();
            document.removeEventListener('visibilitychange', onVisibilityChange);
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [poll, live]);

    return {
        data,
        loading: pending && data === null,
        progress,
        error,
    };
}
