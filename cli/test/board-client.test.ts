import { describe, expect, it } from 'vitest';
import { BoardError, createBoardClient } from '../src/board.js';

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

        const error = await client(fetch)
            .listJobs({})
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BoardError);
        expect((error as BoardError).status).toBe(0);
        expect((error as BoardError).message).toBe('cannot reach http://board: fetch failed');
    });
});
