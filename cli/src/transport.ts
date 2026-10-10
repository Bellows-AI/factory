/**
 * The board client's transport: one request under a deadline, and the bounded retry of a READ that
 * failed in a way worth another try. Kept apart from the routes (`board.ts`) because everything
 * here is about HOW a request travels, nothing about what it asks.
 *
 * Two kinds of failure are told apart, and only one is retried. An authoritative refusal — the
 * board answered, and the answer is a 4xx or a malformed 2xx — is final. An uncertain one — no
 * answer, a stalled header or body, a 408/429/502/503/504 — says nothing about the board's verdict
 * and is worth re-asking, for a read only: a write that got no answer may have been applied, and
 * replaying it is a decision this client does not make. A local interrupt is neither: it ends
 * the request and the backoff at once and never touches the task.
 */

/** The status a `BoardError` carries when no answer ever arrived — the board was unreachable. */
export const NO_RESPONSE_STATUS = 0;
/** The code of a 2xx answer this client could not read as the shape the route promises. */
export const MALFORMED_RESPONSE_CODE = 'MALFORMED_RESPONSE';
/** The code of an attempt that outlived its deadline — headers or body never finished arriving. */
export const REQUEST_TIMEOUT_CODE = 'REQUEST_TIMEOUT';

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

/** The clock and the pause the deadlines and backoff run on — injected so tests spend no real time. */
export interface BoardClock {
    now(): number;
    /** Resolves after `ms`, or as soon as `signal` aborts. */
    sleep(ms: number, signal?: AbortSignal | undefined): Promise<void>;
}

export const realClock: BoardClock = {
    now: () => Date.now(),
    sleep: (ms, signal) =>
        new Promise((resolve) => {
            if (signal?.aborted) return resolve();
            const done = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', done);
                resolve();
            };
            const timer = setTimeout(done, ms);
            signal?.addEventListener('abort', done, { once: true });
        }),
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Retries after the first attempt, for reads only. */
export const DEFAULT_READ_RETRIES = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 5_000;
/** How far past the total budget a retry may run: the board answers after its hold ends. */
const BUDGET_GRACE_MS = 2_000;
const MS_PER_SECOND = 1000;
const MIN_TIMEOUT_MS = 1;
/** How much of a non-JSON error body is quoted before the message is cut off. */
const ERROR_BODY_PREVIEW_LENGTH = 200;

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_GATEWAY_TIMEOUT = 504;
/** Answers that say "try again" — everything else the board says is final. */
const RETRYABLE_STATUSES: readonly number[] = [
    HTTP_REQUEST_TIMEOUT,
    HTTP_TOO_MANY_REQUESTS,
    HTTP_BAD_GATEWAY,
    HTTP_SERVICE_UNAVAILABLE,
    HTTP_GATEWAY_TIMEOUT,
];
/** The statuses whose `Retry-After` hint is honored. */
const HINTED_STATUSES: readonly number[] = [HTTP_TOO_MANY_REQUESTS, HTTP_SERVICE_UNAVAILABLE];

export interface TransportOptions {
    url: string;
    fetch: typeof globalThis.fetch;
    /** Aborts every in-flight request and backoff — a local interrupt, which never touches the task. */
    signal: AbortSignal | undefined;
    /** One attempt's deadline, headers and body read included. */
    requestTimeoutMs: number;
    /** How many times a failed READ is re-issued; a write is never replayed. */
    readRetries: number;
    /** The total wait budget's end on `clock`: no retry or backoff runs past it (plus a grace). */
    deadlineAt: number | undefined;
    clock: BoardClock;
}

/** Where one attempt goes: the path, and how long the board is asked to hold the read. */
export interface Target {
    path: string;
    holdMs: number;
}

export interface Transport {
    /** Issues the request; `target` is asked again, with `retry` set, before every re-issue. */
    request(target: (retry: boolean) => Target, init: RequestInit): Promise<unknown>;
    /** What is left of the total budget — infinite when there is none. */
    remainingMs(): number;
}

type AttemptResult = { payload: unknown } | { error: BoardError; retryAfter: number | null };

/** A fetch that never got an answer — the board could not be reached at all. */
function unreachable(url: string, error: unknown): BoardError {
    const reason = error instanceof Error ? error.message : String(error);
    return new BoardError(`cannot reach ${url}: ${reason}`, NO_RESPONSE_STATUS, null);
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

/** A `Retry-After` header as milliseconds: delta-seconds or an HTTP date; anything else is no hint. */
function retryAfterMs(header: string | null, clock: BoardClock): number | null {
    if (header === null) return null;
    const seconds = Number(header);
    if (header.trim() !== '' && Number.isFinite(seconds)) return Math.max(0, seconds * MS_PER_SECOND);
    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, date - clock.now());
}

/** What the answer says, the body read included — a stall in either throws into the deadline. */
async function readAnswer(
    path: string,
    response: Response,
    clock: BoardClock,
    aborted: () => boolean
): Promise<AttemptResult> {
    if (!response.ok) {
        const refusal = refusalFrom(path, response.status, await response.text());
        return {
            error: new BoardError(refusal.message, response.status, refusal.code),
            // The clock is read for a hint only: a success never touches it.
            retryAfter: retryAfterMs(response.headers.get('retry-after'), clock),
        };
    }
    try {
        return { payload: await response.json() };
    } catch (error) {
        if (aborted()) throw error;
        const message = `${path} answered ${response.status} with a body that is not JSON`;
        return { error: new BoardError(message, response.status, MALFORMED_RESPONSE_CODE), retryAfter: null };
    }
}

/** A failure with no answer behind it: a deadline that fired, or a fetch that threw. */
function transportFailure(url: string, error: unknown, timedOutAfterMs: number | null, isRead: boolean): BoardError {
    // A write that got no answer may or may not have landed — the message says so.
    const maybe = isRead ? '' : '; the request may have been applied';
    const failure =
        timedOutAfterMs === null
            ? unreachable(url, error)
            : new BoardError(
                  `no answer from ${url} within ${Math.ceil(timedOutAfterMs / MS_PER_SECOND)}s`,
                  NO_RESPONSE_STATUS,
                  REQUEST_TIMEOUT_CODE
              );
    failure.message += maybe;
    return failure;
}

/** How long to pause before the next read, or null when the failure is not worth one. */
function pauseBefore(result: { error: BoardError; retryAfter: number | null }, attemptNo: number): number | null {
    const { error, retryAfter } = result;
    if (error.status !== NO_RESPONSE_STATUS && !RETRYABLE_STATUSES.includes(error.status)) return null;
    const hint = HINTED_STATUSES.includes(error.status) ? retryAfter : null;
    return hint ?? Math.min(BACKOFF_BASE_MS * 2 ** (attemptNo - 1), BACKOFF_MAX_MS);
}

export function createTransport(options: TransportOptions): Transport {
    const { url, signal, clock } = options;
    const remainingMs = (): number => (options.deadlineAt === undefined ? Infinity : options.deadlineAt - clock.now());

    /**
     * An attempt's deadline. The first is bounded by what the caller already measured (a wait's
     * hold never exceeds its remaining budget); the clock is read only once something has failed,
     * and a retry may not run past what is left of the budget.
     */
    const timeoutFor = (holdMs: number, retry: boolean): number => {
        const capMs = retry ? remainingMs() + BUDGET_GRACE_MS : Infinity;
        return Math.max(MIN_TIMEOUT_MS, Math.min(holdMs + options.requestTimeoutMs, capMs));
    };

    /** One attempt under its own deadline, which covers the body read: a stalled body aborts too. */
    const attempt = async (
        path: string,
        init: RequestInit,
        timeoutMs: number,
        isRead: boolean
    ): Promise<AttemptResult> => {
        const deadline = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            deadline.abort();
        }, timeoutMs);
        const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
        try {
            const response = await options.fetch(`${url}${path}`, { ...init, signal: combined });
            return await readAnswer(path, response, clock, () => combined.aborted);
        } catch (error) {
            // An interrupt aborts the same fetch a deadline does; the caller's signal tells them apart.
            const stalled = timedOut && !signal?.aborted ? timeoutMs : null;
            return { error: transportFailure(url, error, stalled, isRead), retryAfter: null };
        } finally {
            clearTimeout(timer);
        }
    };

    /**
     * Pauses before the next read and says whether to make it. Backoff is exponential and capped,
     * a `Retry-After` hint replaces it, and neither may run past the total budget — when the next
     * pause would, or an interrupt landed, the last failure is what the caller gets.
     */
    const backOff = async (failed: AttemptResult, retriesLeft: boolean, attemptNo: number): Promise<boolean> => {
        if (!('error' in failed) || !retriesLeft || signal?.aborted) return false;
        const pause = pauseBefore(failed, attemptNo);
        if (pause === null || pause >= remainingMs()) return false;
        await clock.sleep(pause, signal);
        return !signal?.aborted;
    };

    const request: Transport['request'] = async (target, init) => {
        const isRead = (init.method ?? 'GET') === 'GET';
        const attempts = isRead ? options.readRetries + 1 : 1;
        for (let n = 1; ; n++) {
            const { path, holdMs } = target(n > 1);
            const result = await attempt(path, init, timeoutFor(holdMs, n > 1), isRead);
            if ('payload' in result) return result.payload;
            if (!(await backOff(result, n < attempts, n))) throw result.error;
        }
    };

    return { request, remainingMs };
}
