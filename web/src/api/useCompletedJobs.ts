import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job } from './useJobs.js';
import { reportUnauthenticated } from './useSession.js';

const LIST_LIMIT = 30;

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
 * 401s go to the gate, and leaving the dashboard tears the chain down.
 */
export function useCompletedJobs(): { jobs: Job[] | null; error: string | null } {
    const [jobs, setJobs] = useState<Job[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const timer = useRef<number | null>(null);
    const controller = useRef<AbortController | null>(null);

    const poll = useCallback(async (signal: AbortSignal) => {
        if (signal.aborted) return;
        try {
            const response = await fetch(`/api/jobs?status=terminal&limit=${LIST_LIMIT}`, { signal });
            if (response.status === 401) {
                reportUnauthenticated();
                return;
            }
            if (!response.ok) {
                if (signal.aborted) return;
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                setError(body.error ?? `Request failed (${response.status})`);
                timer.current = window.setTimeout(() => void poll(signal), document.hidden ? 60_000 : 30_000);
                return;
            }
            const body = (await response.json()) as { jobs: Job[] };
            if (signal.aborted) return;
            setJobs(body.jobs);
            setError(null);
            timer.current = window.setTimeout(() => void poll(signal), document.hidden ? 60_000 : 30_000);
        } catch (e) {
            if (signal.aborted) return;
            setError((e as Error).message);
            timer.current = window.setTimeout(() => void poll(signal), document.hidden ? 60_000 : 30_000);
        }
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
