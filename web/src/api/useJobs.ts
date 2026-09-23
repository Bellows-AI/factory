import { useCallback, useEffect, useRef, useState } from 'react';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/**
 * The client's copy of the job board's row. List responses omit `output` (it is unbounded), so it
 * is null until a `useJob` detail poll fills it in. Copied rather than imported: `core` does not
 * know the job board exists, and the pattern `useWorkspace.ts` established is to own the shape the
 * page renders.
 *
 * On the grouped terminal rows (`GET /api/jobs?status=terminal`, the recently-completed view) one
 * row IS one task (issue 124): identity fields are the thread root's (id, command, author,
 * createdAt), present-tense fields the chain head's (status, summary, runtime, sessionId,
 * startedAt), and the wall clock and completion stamp are the thread's sum and max. The per-run
 * lists (tasks pages, sidenav) carry plain per-run rows and group on the client.
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'stopped';

/** Where one declared verification gate stands. The board stores current/last only — no history. */
export interface GateCheck {
    name: string;
    status: 'running' | 'passed' | 'failed';
    exitCode: number | null;
    output: string | null;
}

/**
 * One declared service of the attempt's `.bellows.yaml`, as the driver's platform reports it:
 * the declared name (the DNS name inside the job), the image, and a lowercase state word —
 * docker's container State, or the pod phase under kubernetes.
 */
export interface ServiceStatus {
    name: string;
    image: string;
    state: string;
}

/**
 * The running attempt's last sampled vitals, from the driver: whether the container is doing work
 * and what the agent says it is doing. The board keeps current/last only — `sampledAt` is how a
 * reader tells a live sample from a stopped run's. Null CPU/memory numbers mean the sample could
 * not read them this round (a cluster with no metrics-server, for one) — honest nulls beside a
 * service fleet that was read, never fabricated zeros.
 */
export interface RuntimeVitals {
    cpuPercent: number | null;
    memUsedMb: number | null;
    memPercent: number | null;
    activity: string | null;
    sampledAt: string;
    /**
     * The context the run reached, scraped from the session database at close — present only on
     * closed runs whose runner reads it, and stored beside the samples rather than inside them
     * (a context-only object with no CPU sample is legal).
     */
    contextTokens?: number | null;
    costUsd?: number | null;
    /**
     * The attempt's declared `.bellows.yaml` services and their current states — present only
     * when the attempt declared any and the driver could read them. Cleared with the numbers on
     * the next claim.
     */
    services?: ServiceStatus[] | null;
}

/**
 * A person, resolved server-side from the board's audit rows at read time. `name` and `avatarUrl`
 * are labels the account may not have; the login is the display fallback. Null means no author is
 * known — a pre-accounts row — and renders as "unknown", never a synthetic name.
 */
export interface AuthorRef {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
}

export interface Job {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    /** Who queued the task, resolved to their account labels; null for a pre-accounts row. */
    author: AuthorRef | null;
    /** Who asked to stop the task — stamped at request time; null when nobody has. */
    stoppedBy: AuthorRef | null;
    /** Who marked the task done; null when nobody has. */
    doneBy: AuthorRef | null;
    exitCode: number | null;
    output: string | null;
    /**
     * What the run did, in the agent's own last words — lifted from the session records at
     * close and reported with the verdict. Null is unmeasured, never empty; the command above
     * records what was asked, this records what was done.
     */
    summary: string | null;
    /**
     * The checks this run has run or is running, from the job's `.bellows.yaml`. Absent on list
     * responses (the list select omits it, like `output`) and null on any run whose repository
     * declares none.
     */
    gates?: GateCheck[] | null;
    /** The attempt's last container vitals, or null until the driver's first sample lands. */
    runtime?: RuntimeVitals | null;
    /** The repository tab the task was queued from, or null for one queued before the chat. */
    repo: string | null;
    /** The member's executor name the task was stamped with, or null. Display metadata. */
    executor: string | null;
    /**
     * The workflow node this run walks, when the task runs a workflow — the graph position, and
     * what the task view labels the turn with. Null on every other row.
     */
    workflowNode: string | null;
    /**
     * The workflow the task's thread was launched under — the name frozen on the thread at create
     * time, inherited by every turn. Null on workflow-less tasks. Distinct from `workflowNode`
     * (this row's graph position); a rename or delete of the source workflow never changes it.
     */
    workflowName: string | null;
    /** The finished task this one asks for adjustments on, when it is a follow-up. */
    followUpTo: string | null;
    /**
     * The id of the thread's ROOT task — the job itself, or the conversation's first run. Served
     * on every row, so any turn resolves to its whole task without climbing parents.
     */
    rootJobId: string;
    /** When the user declared the task done, or null while they have not. */
    doneAt: string | null;
    /**
     * When a stop was requested on this run while it was running — the user's `/stop` landed on a
     * moving run and the driver has not parked it yet. Null on every other job.
     */
    cancelRequestedAt: string | null;
    /**
     * Where the author's checkouts are, relative to the workspace root — board-derived, the same
     * field the claim carries. Null when the job has no author or the board has no workspace root;
     * the task view's status sidebar shows it, or a dash.
     */
    workspacePath: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    /**
     * The wall clock THIS run's own attempts banked — the executed segments the board
     * accumulated at its settle points. Null where nothing was ever banked for the row (a run
     * that never executed); the thread's total is `taskWallClockMs` below. On the grouped
     * terminal rows this is the chain head run's own clock.
     */
    wallClockMs: number | null;
    /**
     * The wall clock the task's whole thread has banked — every executed segment of every run,
     * accumulated by the board and served on the thread read and on the grouped terminal rows
     * of the recently-completed view. Null where nothing has accumulated; the head's clock
     * renders a dash there, never a zero.
     */
    taskWallClockMs: number | null;
    sessionId: string | null;
    /**
     * The thread's durable PR-review wait, when it has one: the block's reason ("review", ...),
     * when the wait began, and — once the wait is terminal — why it ended. The open wait wins
     * over a terminal one, so a thread waiting for review reads waiting and a finished wait reads
     * what exhausted it. All null for a thread that never entered a wait. Carried the same on
     * every member of the thread, never derived from output text or a workflow node name.
     */
    waitReason: string | null;
    waitingSince: string | null;
    waitTerminalReason: string | null;
}

/**
 * Pure, and exported, so the offline suite can pin what stops the polls without fake timers: a
 * finished job is never going to grow an output, and polling it forever is a request nobody needs.
 */
export function isTerminal(status: JobStatus): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'dead' || status === 'stopped';
}

/** What a queueing call answers: the created task's id to navigate to, or why nothing was created. */
export interface QueueResult {
    id: string | null;
    error: string | null;
}

/**
 * This module used to own the 50-run `/api/jobs?limit=50` poll the sidenav grouped browser-side
 * (`taskSections`) and every task action. The task-summary read model (`GET /api/tasks`, via
 * `useTasks.ts`) replaced both: one row per thread root, org-wide counts and previews, server-side
 * filters — the browser never regroups runs again, and there is exactly one task-overview poll.
 * What remains here is the row shape the detail view renders and the thread poll below: the
 * detail page is a DIFFERENT question (one conversation's whole chain) with its own cadence.
 */

const VISIBLE_THREAD_POLL_MS = 2_000;
const HIDDEN_THREAD_POLL_MS = 15_000;

/**
 * One thread poll's answer, kept out of `useThread` itself so the hook only has to react to it:
 * a stale answer from an aborted chain must not land on the newly selected task, which is why
 * an abort mid-fetch resolves to its own outcome rather than falling into `error`.
 */
type ThreadPollOutcome =
    | { kind: 'aborted' }
    | { kind: 'unauthorized' }
    | { kind: 'error'; message: string }
    | { kind: 'ok'; jobs: Job[]; terminal: boolean };

async function pollThreadOnce(id: string, signal: AbortSignal): Promise<ThreadPollOutcome> {
    try {
        const response = await fetch(`/api/jobs/${id}/thread`, { signal });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) return { kind: 'unauthorized' };
        if (!response.ok) {
            if (signal.aborted) return { kind: 'aborted' };
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            return { kind: 'error', message: body.error ?? `Request failed (${response.status})` };
        }
        const body = (await response.json()) as { jobs: Job[] };
        if (signal.aborted) return { kind: 'aborted' };
        return { kind: 'ok', jobs: body.jobs, terminal: body.jobs.every((task) => isTerminal(task.status)) };
    } catch (e) {
        if (signal.aborted) return { kind: 'aborted' };
        return { kind: 'error', message: (e as Error).message };
    }
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
        const outcome = await pollThreadOnce(current, signal);
        if (outcome.kind === 'aborted') return;
        if (outcome.kind === 'unauthorized') {
            reportUnauthenticated();
            return;
        }
        if (outcome.kind === 'error') {
            setError(outcome.message);
            return;
        }
        setJobs(outcome.jobs);
        setError(null);
        if (outcome.terminal) return;
        const delay = document.hidden ? HIDDEN_THREAD_POLL_MS : VISIBLE_THREAD_POLL_MS;
        timer.current = window.setTimeout(() => void poll(signal), delay);
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
