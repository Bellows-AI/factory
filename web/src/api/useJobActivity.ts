import { useEffect, useState } from 'react';
import type { Job } from './useJobs.js';

/**
 * One bucket of a run's wall clock, as `GET /api/jobs/:id/activity` answers it: the tokens the
 * run processed and the edit decisions it made inside the bucket. Copied from the route's
 * payload, the same rule every client-side row shape follows.
 */
export interface JobActivityBucket {
    start: string;
    tokens: number;
    edits: number;
}

/** The activity route's whole answer, for one run. */
export interface JobActivity {
    jobId: string;
    sessionId: string | null;
    from: string | null;
    to: string | null;
    bucketMs: number | null;
    buckets: JobActivityBucket[];
}

/**
 * The head run's progress-over-time payload (issue 339), from the activity route, fetched for
 * the HEAD run by its own id — never the URL-named task: any member's id resolves to the same
 * conversation, so a follow-up URL would otherwise chart the root's run while the page reads
 * the follow-up's. Refetched when the head run changes, when its session is first reported,
 * when it starts, and when it finishes (`finishedAt` lands, the final fetch) — never on a
 * timer: a chart that redraws itself every two seconds is noise, not information. An HTTP
 * refusal answers null — an unreadable answer is not "keep a stale chart"; a network failure
 * keeps the last answer for THIS run on screen. A head change clears immediately, so the
 * previous run's chart never renders under the new one.
 */
export function useJobActivity(head: Job | null): JobActivity | null {
    const [activity, setActivity] = useState<JobActivity | null>(null);
    const headId = head?.id ?? null;
    const sessionId = head?.sessionId ?? null;
    const startedAt = head?.startedAt ?? null;
    const finishedAt = head?.finishedAt ?? null;

    // A different head run is a different question: the previous run's answer must not render
    // under the new one while its first fetch is in flight.
    useEffect(() => {
        setActivity(null);
    }, [headId]);

    useEffect(() => {
        if (headId === null || sessionId === null) {
            setActivity(null);
            return;
        }
        const controller = new AbortController();
        void (async () => {
            try {
                const response = await fetch(`/api/jobs/${headId}/activity`, { signal: controller.signal });
                // A refusal — a 404 whose task just left the board, a 500 — is no answer: the
                // panel falls back to its muted state rather than drawing a stale chart.
                setActivity(response.ok ? ((await response.json()) as JobActivity) : null);
            } catch {
                // Aborted mid-flight (a task change won the race): the new fetch owns the state.
                // A network failure that is not an abort keeps the run's last answer.
            }
        })();
        return () => controller.abort();
    }, [headId, sessionId, startedAt, finishedAt]);

    return activity;
}
