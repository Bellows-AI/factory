import { useCallback, useEffect, useRef, useState } from 'react';
import { reportUnauthenticated } from './useSession.js';

/**
 * The client's copy of the job board's row. List responses omit `output` (it is unbounded), so it
 * is null until a `useJob` detail poll fills it in. Copied rather than imported: `core` does not
 * know the job board exists, and the pattern `useWorkspace.ts` established is to own the shape the
 * page renders.
 */
export type JobStatus = 'queued' | 'running' | 'standby' | 'succeeded' | 'failed' | 'dead';

export interface Job {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    exitCode: number | null;
    output: string | null;
    /** The repository tab the task was queued from, or null for one queued before the chat. */
    repo: string | null;
    /** The member's executor name the task was stamped with, or null. Display metadata. */
    executor: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    sessionId: string | null;
    remoteSessionId: string | null;
}

/**
 * Pure, and exported, so the offline suite can pin what stops the polls without fake timers: a
 * finished job is never going to grow an output, and polling it forever is a request nobody needs.
 */
export function isTerminal(status: JobStatus): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'dead';
}

const LIST_LIMIT = 50;

/**
 * The task list for one tab, polled until nothing on it can change any more.
 *
 * Same discipline as `useWorkspace`: one abortable polling chain, the last good answer stays on
 * screen through a failed tick, 401s are handed to the gate rather than bannered (every later poll
 * would 401 too), and a hidden tab slows to a crawl. `queue` and `resume` re-arm the chain, which
 * is also how a member sees their own task appear.
 */
export function useJobs(repo: string | null): {
    jobs: Job[] | null;
    loading: boolean;
    error: string | null;
    queue: (command: string, executor: string | null) => Promise<string | null>;
    resume: (id: string) => Promise<string | null>;
} {
    const [jobs, setJobs] = useState<Job[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const timer = useRef<number | null>(null);
    const controller = useRef<AbortController | null>(null);
    /** Bound at the latest render, so the callbacks below re-arm the current tab's chain. */
    const repoRef = useRef(repo);
    repoRef.current = repo;

    const poll = useCallback(async (signal: AbortSignal) => {
        if (signal.aborted) return;
        const tab = repoRef.current;
        const url = `/api/jobs?limit=${LIST_LIMIT}${tab ? `&repo=${encodeURIComponent(tab)}` : ''}`;
        try {
            const response = await fetch(url, { signal });
            if (response.status === 401) {
                reportUnauthenticated();
                setLoading(false);
                return;
            }
            if (!response.ok) {
                if (signal.aborted) return;
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                setError(body.error ?? `Request failed (${response.status})`);
                setLoading(false);
                // A failed tick must not end the chain: the board is shared, and a transient 503
                // during a deploy would otherwise freeze the chat until somebody acts. The error
                // stays visible; the quiet floor is the retry pace.
                timer.current = window.setTimeout(() => void poll(signal), document.hidden ? 60_000 : 30_000);
                return;
            }
            const body = (await response.json()) as { jobs: Job[] };
            // The body can complete after a tab switch aborted the chain; landing it would paint
            // the previous tab's tasks under the new one.
            if (signal.aborted) return;
            // As served: newest first. The panel owns the chat order, like every other display
            // concern.
            setJobs(body.jobs);
            setError(null);
            setLoading(false);

            // While anything can still move — queued, running, parked — keep watching. A quiet
            // board drops to a slow floor rather than stopping outright, because this board is
            // shared: another member's queued task must eventually appear without anybody here
            // acting first.
            const quiet = body.jobs.every((task) => isTerminal(task.status));
            const delay = document.hidden ? (quiet ? 60_000 : 15_000) : quiet ? 30_000 : 3_000;
            timer.current = window.setTimeout(() => void poll(signal), delay);
        } catch (e) {
            if (signal.aborted) return;
            setError((e as Error).message);
            setLoading(false);
            // Same as a failed response above: visible, and still coming back.
            timer.current = window.setTimeout(() => void poll(signal), document.hidden ? 60_000 : 30_000);
        }
    }, []);

    const start = useCallback(() => {
        controller.current?.abort();
        if (timer.current !== null) window.clearTimeout(timer.current);
        const own = new AbortController();
        controller.current = own;
        void poll(own.signal);
    }, [poll]);

    useEffect(() => {
        // A tab switch is a different question, not a refresh of the old answer: the previous
        // tab's tasks — and its error — must not sit under the new tab until the fetch lands.
        setJobs(null);
        setError(null);
        setLoading(true);
        start();
        return () => {
            controller.current?.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [start, repo]);

    const queue = useCallback(
        async (command: string, executor: string | null): Promise<string | null> => {
            try {
                const response = await fetch('/api/jobs', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ command, repo: repoRef.current, executor }),
                });
                if (response.status === 401) {
                    reportUnauthenticated();
                    return 'Your session expired';
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    return body.error ?? `Could not queue the task (${response.status})`;
                }
                start();
                return null;
            } catch (e) {
                return (e as Error).message;
            }
        },
        [start],
    );

    const resume = useCallback(
        async (id: string): Promise<string | null> => {
            try {
                const response = await fetch(`/api/jobs/${id}/resume`, { method: 'POST' });
                if (response.status === 401) {
                    reportUnauthenticated();
                    return 'Your session expired';
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    return body.error ?? `Could not resume the task (${response.status})`;
                }
                start();
                return null;
            } catch (e) {
                return (e as Error).message;
            }
        },
        [start],
    );

    return { jobs, loading, error, queue, resume };
}

/**
 * One task, whole, until it is finished. The list projection carries no output, so the thread's
 * transcript only ever comes from here — polled while the task can still move, stopped the moment
 * it cannot.
 *
 * A failed tick says so and stops, the way `useWorkspace`'s poll does: the last good answer stays
 * on screen, an error line takes the place of the spinner, and re-selecting the task re-arms the
 * poll. What it must never do is go quiet — a transcript that silently stops growing reads as a
 * finished run.
 */
export function useJob(id: string | null): { job: Job | null; error: string | null } {
    const [job, setJob] = useState<Job | null>(null);
    const [error, setError] = useState<string | null>(null);
    const timer = useRef<number | null>(null);
    const controller = useRef<AbortController | null>(null);
    const idRef = useRef(id);
    idRef.current = id;

    const poll = useCallback(async (signal: AbortSignal) => {
        if (signal.aborted) return;
        const current = idRef.current;
        if (current === null) return;
        try {
            const response = await fetch(`/api/jobs/${current}`, { signal });
            if (response.status === 401) {
                reportUnauthenticated();
                return;
            }
            if (!response.ok) {
                // Mirror the list poll: a stale answer from an aborted chain must not land on the
                // newly selected task.
                if (signal.aborted) return;
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                setError(body.error ?? `Request failed (${response.status})`);
                return;
            }
            const body = (await response.json()) as Job;
            if (signal.aborted) return;
            setJob(body);
            setError(null);
            if (isTerminal(body.status)) return;
            timer.current = window.setTimeout(() => void poll(signal), document.hidden ? 15_000 : 2_000);
        } catch (e) {
            if (signal.aborted) return;
            setError((e as Error).message);
        }
    }, []);

    useEffect(() => {
        controller.current?.abort();
        if (timer.current !== null) window.clearTimeout(timer.current);
        // Every id change is a different question: the previous task's answer must not render
        // under the new one while its first fetch is in flight.
        setJob(null);
        setError(null);
        if (id === null) return;
        const own = new AbortController();
        controller.current = own;
        void poll(own.signal);
        return () => {
            own.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [id, poll]);

    return { job, error };
}
