import { describe, expect, it } from 'vitest';
import { createBoardClient } from '../src/board.js';
import { BoardError, NO_RESPONSE_STATUS, REQUEST_TIMEOUT_CODE } from '../src/transport.js';

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

function recorder(respond: (index: number) => Response) {
    const calls: Call[] = [];
    const fetch = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
        const index = calls.length;
        calls.push({
            url: String(url),
            method: init?.method ?? 'GET',
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        return respond(index);
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
}

const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

const waitBody = {
    result: 'terminal',
    rootJobId: 'job-1',
    headJobId: 'job-1',
    headStatus: 'succeeded',
    waitReason: null,
    job: { id: 'job-1', status: 'succeeded' },
};

const client = (fetch: typeof globalThis.fetch, token = 'fat_abc') =>
    createBoardClient({ url: 'http://board', token, fetch });

describe('the board client', () => {
    it('posts the command to /api/jobs with the bearer and a json content-type', async () => {
        const { calls, fetch } = recorder(() => json({ id: 'job-1', status: 'queued' }, 201));
        const created = await client(fetch).createJob({
            command: 'fix the bug',
            repo: 'owner/name',
            executor: 'my-claude',
        });

        expect(created).toEqual({ id: 'job-1', status: 'queued' });
        expect(calls[0]!.url).toBe('http://board/api/jobs');
        expect(calls[0]!.method).toBe('POST');
        expect(calls[0]!.headers.authorization).toBe('Bearer fat_abc');
        expect(calls[0]!.headers['content-type']).toBe('application/json');
        expect(calls[0]!.body).toEqual({ command: 'fix the bug', repo: 'owner/name', executor: 'my-claude' });
    });

    it('omits optional create fields from the body when not given', async () => {
        const { calls, fetch } = recorder(() => json({ id: 'job-1', status: 'queued' }, 201));

        await client(fetch).createJob({ command: 'echo hi' });

        expect(calls[0]!.body).toEqual({ command: 'echo hi' });
    });

    it('omits the authorization header entirely when no token is configured', async () => {
        // An empty Bearer header is a credential that failed; no header at all is one that was
        // never offered. Only the second keeps AUTH_MODE=none working with just FACTORY_URL.
        const { calls, fetch } = recorder(() => json({ jobs: [] }));

        await createBoardClient({ url: 'http://board', fetch }).listJobs({});

        expect(calls[0]!.headers).not.toHaveProperty('authorization');
    });

    it('builds the list query only from the provided filters', async () => {
        const { calls, fetch } = recorder(() => json({ jobs: [] }));

        await client(fetch).listJobs({});
        await client(fetch).listJobs({ status: 'running', limit: 5, repo: 'owner/name' });

        expect(calls[0]!.url).toBe('http://board/api/jobs');
        expect(calls[1]!.url).toBe('http://board/api/jobs?status=running&limit=5&repo=owner%2Fname');
    });

    it('hits the detail and thread routes with the bearer', async () => {
        const { calls, fetch } = recorder(() => json({ id: 'job-1' }));

        await client(fetch).getJob('job-1');
        await client(fetch).thread('job-1');

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1');
        expect(calls[0]!.headers.authorization).toBe('Bearer fat_abc');
        expect(calls[1]!.url).toBe('http://board/api/jobs/job-1/thread');
        expect(calls[1]!.headers.authorization).toBe('Bearer fat_abc');
    });

    it('asks the settle long-poll for the seconds it was given, on the job read itself', async () => {
        // `waitFor=terminal` is a parameter of GET /api/jobs/:id — there is no separate wait
        // route, and the thread read takes no wait parameters at all.
        const { calls, fetch } = recorder(() => json(waitBody));

        const wait = await client(fetch).waitForJob('job-1', 45);

        expect(wait).toEqual(waitBody);
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1?waitFor=terminal&timeout=45');
        expect(calls[0]!.method).toBe('GET');
        expect(calls[0]!.headers.authorization).toBe('Bearer fat_abc');
    });

    it.each([
        ['the bare job row of the old shape', { id: 'job-1', status: 'succeeded' }],
        ['an unknown result', { ...waitBody, result: 'finished' }],
        ['a missing head identity', { ...waitBody, headJobId: undefined }],
        ['a missing job row', { ...waitBody, job: undefined }],
    ])('refuses a wait answer with %s rather than guessing from it', async (_label, payload) => {
        const { fetch } = recorder(() => json(payload));

        const error = await client(fetch)
            .waitForJob('job-1', 5)
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BoardError);
        expect((error as BoardError).code).toBe('MALFORMED_RESPONSE');
    });

    it('turns a 2xx body that is not JSON into a malformed-response BoardError', async () => {
        const { fetch } = recorder(() => new Response('<html>', { status: 200 }));

        const error = await client(fetch)
            .listJobs({})
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BoardError);
        expect((error as BoardError).code).toBe('MALFORMED_RESPONSE');
    });

    it('hands the abort signal to every request', async () => {
        const seen: (AbortSignal | null | undefined)[] = [];
        const fetch = (async (_url: unknown, init?: RequestInit) => {
            seen.push(init?.signal);
            return json({ jobs: [] });
        }) as unknown as typeof globalThis.fetch;
        const controller = new AbortController();

        await createBoardClient({ url: 'http://board', fetch, signal: controller.signal }).listJobs({});

        // The request's own signal follows the caller's: aborting one aborts the other.
        expect(seen[0]!.aborted).toBe(false);
        controller.abort();
        expect(seen[0]!.aborted).toBe(true);
    });

    it('posts a follow-up with the command alone — repo, executor and session are inherited', async () => {
        const { calls, fetch } = recorder(() => json({ id: 'job-2', status: 'queued' }, 201));

        const created = await client(fetch).followUp('job-1', 'now add a test');

        expect(created).toEqual({ id: 'job-2', status: 'queued' });
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/follow-up');
        expect(calls[0]!.method).toBe('POST');
        expect(calls[0]!.body).toEqual({ command: 'now add a test' });
    });

    it('posts the bodiless lifecycle actions and returns what each one answered', async () => {
        const { calls, fetch } = recorder(
            (index) =>
                [
                    json({ id: 'job-1', status: 'running', cancelRequestedAt: '2026-09-29T13:01:00.000Z' }, 202),
                    json({ id: 'job-1', status: 'succeeded', doneAt: '2026-09-29T13:02:00.000Z' }),
                    json({ id: 'job-1', removed: true }),
                ][index]!
        );
        const board = client(fetch);

        const stopped = await board.stopJob('job-1');
        const done = await board.markDone('job-1');
        const removed = await board.removeJob('job-1');

        expect(stopped).toEqual({
            id: 'job-1',
            status: 'running',
            cancelRequestedAt: '2026-09-29T13:01:00.000Z',
        });
        expect(done).toEqual({ id: 'job-1', status: 'succeeded', doneAt: '2026-09-29T13:02:00.000Z' });
        expect(removed).toEqual({ id: 'job-1', removed: true });
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'POST http://board/api/jobs/job-1/stop',
            'POST http://board/api/jobs/job-1/done',
            'POST http://board/api/jobs/job-1/remove',
        ]);
        // No body at all, so no content-type either: these three routes take none.
        expect(calls.map((call) => call.body)).toEqual([undefined, undefined, undefined]);
    });

    it('encodes the id into every path, so a typo cannot become a different route', async () => {
        // The board validates ids as uuids, but that happens after routing: `a/../b` normalizes
        // to another job's route and `a?x` starts a query string. Encoding keeps a mistyped id a
        // 404 about the id typed, rather than an action against whatever it normalized to.
        const { calls, fetch } = recorder((index) => json(index === 1 ? waitBody : { id: 'job-1' }));
        const board = client(fetch);
        const id = 'a/../b?x';

        await board.getJob(id);
        await board.waitForJob(id, 30);
        await board.thread(id);
        await board.followUp(id, 'again');
        await board.stopJob(id);
        await board.markDone(id);
        await board.removeJob(id);

        const encoded = 'a%2F..%2Fb%3Fx';
        expect(calls.map((call) => call.url)).toEqual([
            `http://board/api/jobs/${encoded}`,
            `http://board/api/jobs/${encoded}?waitFor=terminal&timeout=30`,
            `http://board/api/jobs/${encoded}/thread`,
            `http://board/api/jobs/${encoded}/follow-up`,
            `http://board/api/jobs/${encoded}/stop`,
            `http://board/api/jobs/${encoded}/done`,
            `http://board/api/jobs/${encoded}/remove`,
        ]);
    });

    it('turns a non-2xx {error, code} body into a BoardError carrying both', async () => {
        const { fetch } = recorder(() => json({ error: 'No such job', code: 'NOT_FOUND' }, 404));

        const error = await client(fetch)
            .getJob('job-1')
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BoardError);
        const boardError = error as BoardError;
        expect(boardError.status).toBe(404);
        expect(boardError.code).toBe('NOT_FOUND');
        expect(boardError.message).toBe('No such job');
    });

    it('still fails clearly when the error body is not JSON', async () => {
        const { fetch } = recorder(() => new Response('gateway timeout', { status: 502 }));

        const error = await client(fetch)
            .listJobs({})
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BoardError);
        expect((error as BoardError).status).toBe(502);
        expect((error as BoardError).message).toContain('502');
    });

    it('wraps a network failure as a BoardError with status 0 and the cannot-reach message', async () => {
        const fetch = (async () => {
            throw new Error('fetch failed');
        }) as unknown as typeof globalThis.fetch;

        const error = await createBoardClient({ url: 'http://board', fetch, readRetries: 0 })
            .listJobs({})
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BoardError);
        expect((error as BoardError).status).toBe(0);
        expect((error as BoardError).message).toBe('cannot reach http://board: fetch failed');
    });
});

/** A fake clock: time moves only when something sleeps, by exactly the slept amount. */
function fakeClock() {
    let now = 0;
    const sleeps: number[] = [];
    return {
        sleeps,
        clock: {
            now: () => now,
            sleep: async (ms: number) => {
                sleeps.push(ms);
                now += ms;
            },
        },
    };
}

/** A fetch that never answers until its signal aborts, then fails the way a real one does. */
const stalled = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof globalThis.fetch;

const TEST_TIMEOUT_MS = 15;

describe('deadlines, retries and interruption', () => {
    const resilient = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof createBoardClient>[0]> = {}) =>
        createBoardClient({ url: 'http://board', fetch, requestTimeoutMs: TEST_TIMEOUT_MS, ...extra });
    const outcome = (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught as BoardError);

    it('aborts a request whose headers never arrive and reports an uncertain timeout', async () => {
        const { clock } = fakeClock();

        const error = await outcome(resilient(stalled, { readRetries: 0, clock }).listJobs({}));

        expect(error).toMatchObject({ status: NO_RESPONSE_STATUS, code: REQUEST_TIMEOUT_CODE });
    });

    it('aborts a response whose body stalls after the headers', async () => {
        const { clock } = fakeClock();
        const fetch = (async (_url: unknown, init?: RequestInit) => {
            const body = new ReadableStream({
                start(controller) {
                    init?.signal?.addEventListener('abort', () => controller.error(new Error('body aborted')));
                },
            });
            return new Response(body, { status: 200 });
        }) as unknown as typeof globalThis.fetch;

        const error = await outcome(resilient(fetch, { readRetries: 0, clock }).listJobs({}));

        expect(error).toMatchObject({ status: NO_RESPONSE_STATUS, code: REQUEST_TIMEOUT_CODE });
    });

    it('retries a transient read failure with doubling backoff, then succeeds', async () => {
        const { sleeps, clock } = fakeClock();
        const { calls, fetch } = recorder((index) =>
            index < 2 ? new Response('down', { status: 503 }) : json({ jobs: [] })
        );

        await expect(resilient(fetch, { clock }).listJobs({})).resolves.toEqual([]);

        expect(calls).toHaveLength(3);
        expect(sleeps).toEqual([250, 500]);
    });

    it('stops after the configured number of retries and surfaces the last failure', async () => {
        const { clock } = fakeClock();
        const { calls, fetch } = recorder(() => new Response('down', { status: 502 }));

        const error = await outcome(resilient(fetch, { clock, readRetries: 2 }).getJob('job-1'));

        expect(calls).toHaveLength(3);
        expect(error).toMatchObject({ status: 502 });
    });

    it.each([400, 401, 403, 404, 409, 422, 500])('does not retry an authoritative %s refusal', async (status) => {
        const { clock } = fakeClock();
        const { calls, fetch } = recorder(() => json({ error: 'no', code: 'NOPE' }, status));

        const error = await outcome(resilient(fetch, { clock }).getJob('job-1'));

        expect(calls).toHaveLength(1);
        expect(error).toMatchObject({ status, code: 'NOPE' });
    });

    it('never replays a write, and says an unanswered one may have been applied', async () => {
        const { clock } = fakeClock();
        let sent = 0;
        const fetch = (async (_url: unknown, init?: RequestInit) => {
            sent++;
            return stalled('', init);
        }) as unknown as typeof globalThis.fetch;

        const error = await outcome(resilient(fetch, { clock }).createJob({ command: 'echo hi' }));

        expect(sent).toBe(1);
        expect(error).toMatchObject({ status: NO_RESPONSE_STATUS, code: REQUEST_TIMEOUT_CODE });
        expect((error as BoardError).message).toContain('may have been applied');
    });

    it('honors Retry-After in seconds on a 429, and as an HTTP date on a 503', async () => {
        const { sleeps, clock } = fakeClock();
        const { fetch } = recorder((index) =>
            index === 0
                ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
                : index === 1
                  ? new Response('busy', { status: 503, headers: { 'retry-after': new Date(3_000).toUTCString() } })
                  : json({ jobs: [] })
        );

        await resilient(fetch, { clock }).listJobs({});

        // The date hint is read against the injected clock, which has slept 2000ms by then.
        expect(sleeps).toEqual([2_000, 1_000]);
    });

    it('does not sleep past the total budget: a hint that cannot fit ends the retries', async () => {
        const { sleeps, clock } = fakeClock();
        const { calls, fetch } = recorder(
            () => new Response('slow down', { status: 429, headers: { 'retry-after': '60' } })
        );

        const error = await outcome(resilient(fetch, { clock, deadlineAt: 10_000 }).listJobs({}));

        expect(sleeps).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(error).toMatchObject({ status: 429 });
    });

    it('stops backing off once the budget is spent, however many retries remain', async () => {
        const { sleeps, clock } = fakeClock();
        const { calls, fetch } = recorder(() => new Response('down', { status: 503 }));

        await outcome(resilient(fetch, { clock, readRetries: 10, deadlineAt: 1_000 }).listJobs({}));

        // 250 + 500 fit in 1000ms; the next 1000ms pause would reach the deadline.
        expect(sleeps).toEqual([250, 500]);
        expect(calls).toHaveLength(3);
    });

    it('re-asks a wait retry for only what is left of the budget', async () => {
        const { clock } = fakeClock();
        const { calls, fetch } = recorder((index) =>
            index === 0 ? new Response('down', { status: 503 }) : json(waitBody)
        );

        await resilient(fetch, { clock, deadlineAt: 10_000 }).waitForJob('job-1', 60);

        expect(calls[0]!.url).toContain('timeout=60');
        expect(calls[1]!.url).toContain('timeout=10');
    });

    it('ends an interrupted backoff at once and never touches the task', async () => {
        const controller = new AbortController();
        const { calls, fetch } = recorder(() => new Response('down', { status: 503 }));
        const clock = {
            now: () => 0,
            sleep: async () => controller.abort(),
        };

        const error = await outcome(resilient(fetch, { clock, signal: controller.signal }).listJobs({}));

        expect(calls).toHaveLength(1);
        expect(calls.every((call) => call.method === 'GET' && !call.url.endsWith('/stop'))).toBe(true);
        expect(error).toBeInstanceOf(BoardError);
    });

    it('does not retry, or report a timeout, when the caller aborts mid-request', async () => {
        const controller = new AbortController();
        const { clock } = fakeClock();
        const pending = resilient(stalled, { clock, signal: controller.signal }).listJobs({});
        controller.abort();

        const error = await outcome(pending);

        expect(error).toBeInstanceOf(BoardError);
        expect((error as BoardError).code).not.toBe(REQUEST_TIMEOUT_CODE);
    });
});
