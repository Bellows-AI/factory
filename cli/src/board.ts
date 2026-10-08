import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from './http.js';

/**
 * The board client for the person routes the CLI speaks to: the two reads
 * (`GET /api/jobs`, `GET /api/jobs/:id[/thread]`, the second doubling as the settle long-poll)
 * and the five writes (`POST /api/jobs` and the `follow-up`, `stop`, `done` and `remove` actions
 * on a job). A plain HTTP client that depends on nothing,
 * core included — the driver's rule and its reason apply word for word: this is a client of an
 * HTTP board, and importing the server's types would hand a process that needs only `fetch` the
 * whole server dependency tree, plus a build order.
 *
 * The credential is `Authorization: Bearer fat_…` — a personal access token minted from the
 * settings page (docs/auth.md), which acts as its user through the same join a session uses, so
 * `POST /api/jobs` keeps a real `created_by`. An `oat_` org token also authenticates, but only
 * the two reads: a write answers 403 with the board's own message, which is surfaced as-is.
 */

/** Everything the board refused with: the status, the error code when the body named one. */
export class BoardError extends Error {
    readonly status: number;
    readonly code: string | null;

    constructor(message: string, status: number, code: string | null) {
        super(message);
        this.name = 'BoardError';
        this.status = status;
        this.code = code;
    }
}

/** The 201 body of a create: two fields, the new id and its initial status. */
export interface JobCreated {
    id: string;
    status: string;
}

/**
 * The fields of a job row the CLI renders. A display client's view of the board's job record —
 * the server owns the full shape; anything added there renders as "not shown" rather than
 * breaking this cast. Every nullable field is rendered with a `-` fallback.
 */
export interface BoardJobRecord {
    id: string;
    command: string;
    status: string;
    author: { login: string } | null;
    repo: string | null;
    executor: string | null;
    /** The scope `executor` names (issue 391), as the board's read model normalizes it. */
    executorScope?: string | null;
    /** The task's stored execution mode (issue 543): `objective`, or `workflow`. */
    mode: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    sessionId: string | null;
    exitCode: number | null;
    failureKind: string | null;
    summary: string | null;
    gates: readonly { name: string; status: string }[] | null;
    output: string | null;
}

/**
 * The 200/202 body of a stop. A queued row, or a running one whose lease already expired, is
 * settled `stopped` on the spot; a running row under a live lease is only STAMPED — the worker
 * settles it at its next heartbeat — and that answer carries `cancelRequestedAt` instead.
 */
export interface JobStopped {
    id: string;
    status: string;
    cancelRequestedAt?: string | null;
}

/** The 200 body of a done: the run's own verdict is untouched, and `doneAt` is the user's. */
export interface JobDone {
    id: string;
    status: string;
    doneAt: string | null;
}

/** The 200 body of a remove. The whole thread is gone; there is nothing left to render. */
export interface JobRemoved {
    id: string;
    removed: boolean;
}

/**
 * The statuses a run never leaves. `done` is not among them — it is a person's verdict on a
 * finished task, orthogonal to how the run ended (docs/jobs.md), and a task can be marked done
 * only once its last run already reached one of these.
 */
export const TERMINAL_STATUSES: readonly string[] = ['succeeded', 'failed', 'dead', 'stopped'];

export function isTerminal(status: string): boolean {
    return TERMINAL_STATUSES.includes(status);
}

export interface BoardClient {
    createJob(input: {
        command: string;
        repo?: string | undefined;
        executor?: string | undefined;
        /** The scope `executor` names (issue 391); absent lets the board default to personal. */
        executorScope?: 'user' | 'org' | undefined;
    }): Promise<JobCreated>;
    listJobs(filters: {
        status?: string | undefined;
        limit?: number | undefined;
        repo?: string | undefined;
    }): Promise<BoardJobRecord[]>;
    getJob(id: string): Promise<BoardJobRecord>;
    /**
     * One settle long-poll: the board holds the read until the thread's chain head is terminal or
     * `timeoutSeconds` elapses, then answers the usual row either way. A timeout is an ordinary
     * 200 with no marker of its own, so the caller decides from the row whether to re-issue.
     */
    waitForJob(id: string, timeoutSeconds: number): Promise<BoardJobRecord>;
    thread(id: string): Promise<BoardJobRecord[]>;
    followUp(id: string, command: string): Promise<JobCreated>;
    stopJob(id: string): Promise<JobStopped>;
    markDone(id: string): Promise<JobDone>;
    removeJob(id: string): Promise<JobRemoved>;
}

type Fetch = typeof globalThis.fetch;

/** How much of a non-JSON error body is quoted before the message is cut off. */
const ERROR_BODY_PREVIEW_LENGTH = 200;

/**
 * One job's route prefix, with the id ENCODED. The board validates ids as uuids, but routing
 * happens first: an unencoded `a/../b` normalizes to another job's route before anyone looks at
 * it, and a `?` in an id starts a query string. Encoding keeps a mistyped id a 404 about what was
 * typed rather than an action against whatever it resolved to — and every path goes through here
 * so none can be left out.
 */
const jobPath = (id: string): string => `/api/jobs/${encodeURIComponent(id)}`;

/** A fetch that never got an answer — the board could not be reached at all. */
function unreachable(url: string, error: unknown): BoardError {
    const reason = error instanceof Error ? error.message : String(error);
    return new BoardError(`cannot reach ${url}: ${reason}`, 0, null);
}

/**
 * The refusal a non-2xx answer carries: the board's one envelope is `{ error, code }` — the human
 * message is what the board said, and the code rides beside it for scripting. A body that is not
 * JSON keeps the status line with a raw preview, which is the honest message.
 */
function refusalFrom(path: string, status: number, text: string): { message: string; code: string | null } {
    let message = `${path} answered ${status}`;
    if (text) message += `: ${text.slice(0, ERROR_BODY_PREVIEW_LENGTH)}`;
    let code: string | null = null;
    try {
        const body = JSON.parse(text) as { error?: unknown; code?: unknown };
        if (typeof body.error === 'string') message = body.error;
        if (typeof body.code === 'string') code = body.code;
    } catch {
        // Not JSON — keep the status line.
    }
    return { message, code };
}

export function createBoardClient({
    url,
    token,
    fetch = globalThis.fetch,
}: {
    url: string;
    /** The personal access token, when the board requires one. Empty against AUTH_MODE=none. */
    token?: string | undefined;
    fetch?: Fetch | undefined;
}): BoardClient {
    const authHeaders = (): Record<string, string> =>
        // Omitted rather than sent empty: a board with no auth would otherwise see a Bearer
        // header with nothing in it, which is a credential that failed rather than one that was
        // never offered.
        token ? { authorization: `Bearer ${token}` } : {};

    const request = async (path: string, init: RequestInit): Promise<unknown> => {
        let response: Response;
        try {
            response = await fetch(`${url}${path}`, init);
        } catch (error) {
            throw unreachable(url, error);
        }
        if (!response.ok) {
            const refusal = refusalFrom(path, response.status, await response.text());
            throw new BoardError(refusal.message, response.status, refusal.code);
        }
        return response.json();
    };

    return {
        async createJob(input) {
            // Optional fields are omitted from the body when absent — the board is the validator,
            // and a key that is not there is not a value it has to refuse.
            const body: Record<string, unknown> = {
                command: input.command,
                ...(input.repo !== undefined ? { repo: input.repo } : {}),
                ...(input.executor !== undefined ? { executor: input.executor } : {}),
                ...(input.executorScope !== undefined ? { executorScope: input.executorScope } : {}),
            };
            const payload = (await request('/api/jobs', {
                method: 'POST',
                headers: { ...authHeaders(), [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE },
                body: JSON.stringify(body),
            })) as JobCreated;
            return payload;
        },

        async listJobs(filters) {
            const params = new URLSearchParams();
            if (filters.status !== undefined) params.set('status', filters.status);
            if (filters.limit !== undefined) params.set('limit', String(filters.limit));
            if (filters.repo !== undefined) params.set('repo', filters.repo);
            const query = params.toString();
            const payload = (await request(`/api/jobs${query ? `?${query}` : ''}`, {
                headers: authHeaders(),
            })) as { jobs: BoardJobRecord[] };
            return payload.jobs;
        },

        async getJob(id) {
            return (await request(`${jobPath(id)}`, { headers: authHeaders() })) as BoardJobRecord;
        },

        async waitForJob(id, timeoutSeconds) {
            // The wait is a parameter of the job read, not a route of its own — and only of the
            // job read: the thread read takes no wait parameters at all.
            const query = new URLSearchParams({ waitFor: 'terminal', timeout: String(timeoutSeconds) });
            return (await request(`${jobPath(id)}?${query}`, { headers: authHeaders() })) as BoardJobRecord;
        },

        async thread(id) {
            const payload = (await request(`${jobPath(id)}/thread`, { headers: authHeaders() })) as {
                jobs: BoardJobRecord[];
            };
            return payload.jobs;
        },

        async followUp(id, command) {
            // The command is the whole body: the repo, the executor and the session are copied
            // from the parent at insert, and sending them here would be a second opinion the
            // board does not ask for.
            return (await request(`${jobPath(id)}/follow-up`, {
                method: 'POST',
                headers: { ...authHeaders(), [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE },
                body: JSON.stringify({ command }),
            })) as JobCreated;
        },

        // The three actions take no body, so they send no content-type either.
        async stopJob(id) {
            return (await request(`${jobPath(id)}/stop`, { method: 'POST', headers: authHeaders() })) as JobStopped;
        },

        async markDone(id) {
            return (await request(`${jobPath(id)}/done`, { method: 'POST', headers: authHeaders() })) as JobDone;
        },

        async removeJob(id) {
            return (await request(`${jobPath(id)}/remove`, { method: 'POST', headers: authHeaders() })) as JobRemoved;
        },
    };
}
