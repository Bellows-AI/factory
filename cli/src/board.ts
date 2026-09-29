import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from './http.js';

/**
 * The board client for the three person routes the CLI speaks to: `POST /api/jobs`,
 * `GET /api/jobs` and `GET /api/jobs/:id[/thread]`. A plain HTTP client that depends on nothing,
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

export interface BoardClient {
    createJob(input: {
        command: string;
        repo?: string | undefined;
        executor?: string | undefined;
    }): Promise<JobCreated>;
    listJobs(filters: {
        status?: string | undefined;
        limit?: number | undefined;
        repo?: string | undefined;
    }): Promise<BoardJobRecord[]>;
    getJob(id: string): Promise<BoardJobRecord>;
    thread(id: string): Promise<BoardJobRecord[]>;
}

type Fetch = typeof globalThis.fetch;

/** How much of a non-JSON error body is quoted before the message is cut off. */
const ERROR_BODY_PREVIEW_LENGTH = 200;

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
            return (await request(`/api/jobs/${id}`, { headers: authHeaders() })) as BoardJobRecord;
        },

        async thread(id) {
            const payload = (await request(`/api/jobs/${id}/thread`, { headers: authHeaders() })) as {
                jobs: BoardJobRecord[];
            };
            return payload.jobs;
        },
    };
}
