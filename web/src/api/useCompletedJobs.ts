import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job } from './useJobs.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

const LIST_LIMIT = 8;
const VISIBLE_POLL_DELAY_MS = 30_000;
const HIDDEN_POLL_DELAY_MS = 60_000;

/**
 * One round of the board poll, exported pure for the offline suite: the suite has no DOM, so
 * the hook's body would otherwise be untestable. `land`/`fail` accumulate across rounds — a
 * failed round calls `fail` and never touches `land`, which is what keeps the last good rows
 * on screen — and `rearm` schedules the next round (hidden tabs poll slower).
 */
export async function pollCompletedJobs(
    signal: AbortSignal,
    land: (jobs: Job[]) => void,
    fail: (error: string) => void,
    rearm: (ms: number) => void
): Promise<void> {
    const hiddenDelay = () =>
        typeof document === 'undefined'
            ? VISIBLE_POLL_DELAY_MS
            : document.hidden
              ? HIDDEN_POLL_DELAY_MS
              : VISIBLE_POLL_DELAY_MS;
    if (signal.aborted) return;
    try {
        const response = await fetch(`/api/jobs?status=terminal&limit=${LIST_LIMIT}`, { signal });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return;
        }
        if (!response.ok) {
            if (signal.aborted) return;
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            fail(body.error ?? `Request failed (${response.status})`);
            rearm(hiddenDelay());
            return;
        }
        const body = (await response.json()) as { jobs: Job[] };
        if (signal.aborted) return;
        land(body.jobs);
        rearm(hiddenDelay());
    } catch (e) {
        if (signal.aborted) return;
        fail((e as Error).message);
        rearm(hiddenDelay());
    }
}

/**
 * The board's finished TASKS, for the dashboard's recently-completed view — one row per task, not
 * per run (issue 124): the server groups the terminal rows by thread, so a conversation with
 * follow-ups is one row whose wall clock is the thread's total and whose summary is the newest
 * run's.
 *
 * A second, slower poll of the list the tasks pages use — slower because the dashboard is a
 * report, not a chat: a quiet board's answer barely changes in thirty seconds. The
 * `status=terminal` filter is the SERVER's (the same set the thread-done computation uses),
 * so the limit bounds exactly the rows this hook returns — a busy queue cannot hide finished
 * tasks behind queued ones the way a client-side filter over a newest-N window would. The same
 * discipline as `useJobs`: one abortable chain, the last good answer survives a failed tick,
 * 401s go to the gate, and leaving the dashboard tears the chain down. The limit is EIGHT
 * because eight rows is what the dashboard's bounded board section renders (issue 168).
 */
export function useCompletedJobs(): { jobs: Job[] | null; error: string | null } {
    const [jobs, setJobs] = useState<Job[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const timer = useRef<number | null>(null);
    const controller = useRef<AbortController | null>(null);

    const poll = useCallback(async (signal: AbortSignal) => {
        await pollCompletedJobs(
            signal,
            (landed) => {
                setJobs(landed);
                setError(null);
            },
            setError,
            (ms) => {
                timer.current = window.setTimeout(() => void poll(signal), ms);
            }
        );
    }, []);

    useEffect(() => {
        const own = new AbortController();
        controller.current = own;
        void poll(own.signal);
        return () => {
            controller.current?.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [poll]);

    return { jobs, error };
}
