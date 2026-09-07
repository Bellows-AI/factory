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
    /** The finished task this one asks for adjustments on, when it is a follow-up. */
    followUpTo: string | null;
    /** When the user declared the task done, or null while they have not. */
    doneAt: string | null;
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

/** What a queueing call answers: the created task's id to navigate to, or why nothing was created. */
export interface QueueResult {
    id: string | null;
    error: string | null;
}

/** What `useJobs` returns — published through the shell's outlet context, like the stats poll. */
export interface UseJobs {
    jobs: Job[] | null;
    error: string | null;
    queue: (command: string, repo: string | null, executor: string | null) => Promise<QueueResult>;
    resume: (id: string) => Promise<string | null>;
    followUp: (id: string, command: string) => Promise<QueueResult>;
    markDone: (id: string) => Promise<string | null>;
}

/**
 * The task list for the sidenav tree and the tasks pages, polled until nothing on it can change any
 * more.
 *
 * Same discipline as `useWorkspace`: one abortable polling chain, the last good answer stays on
 * screen through a failed tick, 401s are handed to the gate rather than bannered (every later poll
 * would 401 too), and a hidden tab slows to a crawl. There is ONE instance, owned by the shell, and
 * `enabled` gates it to the tasks area — off `/tasks*` the chain is torn down and `start` refuses to
 * run, so a mutation resolving after the member navigated away cannot leak a poll onto another page.
 * Entering the area is a fresh question: the previous answer is dropped rather than shown stale.
 */
export function useJobs(enabled: boolean): UseJobs {
    const [jobs, setJobs] = useState<Job[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const timer = useRef<number | null>(null);
    const controller = useRef<AbortController | null>(null);
    /** Bound at the latest render, so the callbacks below re-arm the current chain. */
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;

    const poll = useCallback(async (signal: AbortSignal) => {
        if (signal.aborted) return;
        const url = `/api/jobs?limit=${LIST_LIMIT}`;
        try {
            const response = await fetch(url, { signal });
            if (response.status === 401) {
                reportUnauthenticated();
                return;
            }
            if (!response.ok) {
                if (signal.aborted) return;
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                setError(body.error ?? `Request failed (${response.status})`);
                // A failed tick must not end the chain: the board is shared, and a transient 503
                // during a deploy would otherwise freeze the list until somebody acts. The error
                // stays visible; the quiet floor is the retry pace.
                timer.current = window.setTimeout(() => void poll(signal), document.hidden ? 60_000 : 30_000);
                return;
            }
            const body = (await response.json()) as { jobs: Job[] };
            // The body can complete after the area was left and the chain aborted; landing it would
            // paint tasks into a shell that asked for nothing.
            if (signal.aborted) return;
            // As served: newest first. The sidenav reads them in this order; the detail page does
            // not list at all.
            setJobs(body.jobs);
            setError(null);

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
            // Same as a failed response above: visible, and still coming back.
            timer.current = window.setTimeout(() => void poll(signal), document.hidden ? 60_000 : 30_000);
        }
    }, []);

    const start = useCallback(() => {
        if (!enabledRef.current) return;
        controller.current?.abort();
        if (timer.current !== null) window.clearTimeout(timer.current);
        const own = new AbortController();
        controller.current = own;
        void poll(own.signal);
    }, [poll]);

    useEffect(() => {
        if (!enabled) {
            // Leaving the tasks area stops the question: no chain, no timer, no stale answer held
            // in wait for the next visit.
            controller.current?.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
            setJobs(null);
            setError(null);
            return;
        }
        // Entering it is a fresh question, not a refresh of the old answer.
        setJobs(null);
        setError(null);
        start();
        return () => {
            controller.current?.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [start, enabled]);

    const queue = useCallback(
        async (command: string, repo: string | null, executor: string | null): Promise<QueueResult> => {
            try {
                const response = await fetch('/api/jobs', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ command, repo, executor }),
                });
                if (response.status === 401) {
                    reportUnauthenticated();
                    return { id: null, error: 'Your session expired' };
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    return { id: null, error: body.error ?? `Could not queue the task (${response.status})` };
                }
                const body = (await response.json()) as { id: string };
                start();
                return { id: body.id, error: null };
            } catch (e) {
                return { id: null, error: (e as Error).message };
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

    // Both of these are a person's verdict on a finished task — an adjustment to ask for, or the
    // declaration that it is done — so both re-arm the poll exactly as queue and resume do: the
    // member sees the follow-up appear, or the done state land, on the next tick. The follow-up
    // creates a NEW row and answers with ITS id: the conversation continues on the child's page.
    // No executor on the body: the board binds the adjustment to the executor that ran the task.
    const followUp = useCallback(
        async (id: string, command: string): Promise<QueueResult> => {
            try {
                const response = await fetch(`/api/jobs/${id}/follow-up`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ command }),
                });
                if (response.status === 401) {
                    reportUnauthenticated();
                    return { id: null, error: 'Your session expired' };
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    return { id: null, error: body.error ?? `Could not queue the follow-up (${response.status})` };
                }
                const body = (await response.json()) as { id: string };
                start();
                return { id: body.id, error: null };
            } catch (e) {
                return { id: null, error: (e as Error).message };
            }
        },
        [start],
    );

    const markDone = useCallback(
        async (id: string): Promise<string | null> => {
            try {
                const response = await fetch(`/api/jobs/${id}/done`, { method: 'POST' });
                if (response.status === 401) {
                    reportUnauthenticated();
                    return 'Your session expired';
                }
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { error?: string };
                    return body.error ?? `Could not mark the task done (${response.status})`;
                }
                start();
                return null;
            } catch (e) {
                return (e as Error).message;
            }
        },
        [start],
    );

    return { jobs, error, queue, resume, followUp, markDone };
}

/**
 * One task's whole conversation — the root job and every follow-up after it, oldest first — from
 * `GET /api/jobs/:id/thread`. ANY member's id resolves to the same chain, which is what lets the
 * detail page keep one URL per task while follow-ups keep arriving as new rows underneath.
 *
 * A failed tick says so and stops, the way the other polls do: the last good answer stays on
 * screen, an error line takes the place of the spinner, and re-selecting the task re-arms the
 * poll. What it must never do is go quiet — a transcript that silently stops growing reads as a
 * finished run.
 *
 * The poll stops when EVERY member is terminal: a finished thread can still grow, but only by the
 * member's own follow-up, and `refresh` re-arms for exactly that.
 */
export function useThread(id: string | null): { jobs: Job[] | null; error: string | null; refresh: () => void } {
    const [jobs, setJobs] = useState<Job[] | null>(null);
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
            const response = await fetch(`/api/jobs/${current}/thread`, { signal });
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
            const body = (await response.json()) as { jobs: Job[] };
            if (signal.aborted) return;
            setJobs(body.jobs);
            setError(null);
            if (body.jobs.every((task) => isTerminal(task.status))) return;
            timer.current = window.setTimeout(() => void poll(signal), document.hidden ? 15_000 : 2_000);
        } catch (e) {
            if (signal.aborted) return;
            setError((e as Error).message);
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
        // Every id change is a different question: the previous task's answer must not render
        // under the new one while its first fetch is in flight.
        setJobs(null);
        setError(null);
        if (id === null) return;
        start();
        return () => {
            controller.current?.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [id, start]);

    return { jobs, error, refresh: start };
}
