import { describe, expect, it } from 'vitest';
import { createBoard } from '../src/board.js';

interface Call {
    url: string;
    headers: Record<string, string>;
    body: unknown;
}

function recorder(respond: () => Response) {
    const calls: Call[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
        calls.push({
            url,
            headers: init.headers as Record<string, string>,
            body: init.body ? JSON.parse(init.body as string) : undefined,
        });
        return respond();
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
}

const claimed = (extra: Record<string, unknown> = {}) =>
    new Response(
        JSON.stringify({
            id: 'job-1',
            command: 'echo hi',
            attempts: 1,
            leaseToken: 'token-1',
            leaseExpiresAt: '2026-08-21T12:05:00.000Z',
            ...extra,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );

describe('the worker token', () => {
    it('is sent as a bearer header when the board requires one', async () => {
        const { calls, fetch } = recorder(() => claimed());
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, token: 'fwt_abc', fetch });

        await board.claim('driver-1');

        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
    });

    it('is OMITTED entirely against an open board, not sent empty', async () => {
        // An empty Bearer header is a credential that failed; no header at all is one that was
        // never offered. Only the second keeps AUTH_MODE=none working unchanged.
        const { calls, fetch } = recorder(() => claimed());
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });

        await board.claim('driver-1');

        expect(calls[0]!.headers).not.toHaveProperty('authorization');
    });

    it('travels on every write, not only the claim', async () => {
        const { calls, fetch } = recorder(() => new Response('{}', { status: 200 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, token: 'fwt_abc', fetch });
        const job = {
            id: 'job-1',
            command: 'echo hi',
            attempts: 1,
            leaseToken: 'token-1',
            leaseExpiresAt: '2026-08-21T12:05:00.000Z',
            resumeSessionId: null,
            userId: null,
        };

        await board.heartbeat(job);
        await board.session(job, 'session-1', null);
        await board.progress(job, 'a tail of the output');
        await board.suspend(job);
        await board.complete(job, { status: 'succeeded', exitCode: 0, output: '' });

        expect(calls).toHaveLength(5);
        for (const call of calls) expect(call.headers.authorization).toBe('Bearer fwt_abc');
    });

    // The one write whose purpose is the dashboard: the tail travels on its own route so a reader
    // can watch the work while it happens.
    it('streams the output tail to the job it belongs to', async () => {
        const { calls, fetch } = recorder(() => new Response('{}', { status: 200 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });
        const job = {
            id: 'job-1',
            command: 'echo hi',
            attempts: 1,
            leaseToken: 'token-1',
            leaseExpiresAt: '2026-08-21T12:05:00.000Z',
            resumeSessionId: null,
            userId: null,
        };

        await board.progress(job, 'partial output');

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/output');
        expect(calls[0]!.body).toEqual({ leaseToken: 'token-1', output: 'partial output' });
    });
});

describe('the claimed job', () => {
    it('carries the account that queued it', async () => {
        const { fetch } = recorder(() => claimed({ userId: 'user-7' }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });

        expect((await board.claim('driver-1'))?.userId).toBe('user-7');
    });

    it('reads a missing userId as null rather than undefined', async () => {
        // Defensive for the same reason resumeSessionId is: a board that predates the field simply
        // omits it, and `undefined` would flow into a docker argument as the string "undefined".
        const { fetch } = recorder(() => claimed());
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });

        expect((await board.claim('driver-1'))?.userId).toBeNull();
    });

    it('reads a missing followUp flag as false rather than undefined', async () => {
        const { fetch } = recorder(() => claimed());
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });

        expect((await board.claim('driver-1'))?.followUp).toBe(false);
    });

    it('carries the follow-up flag when the board sets it', async () => {
        const { fetch } = recorder(() => claimed({ followUp: true, resumeSessionId: 'session-1' }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });

        const job = await board.claim('driver-1');
        expect(job?.followUp).toBe(true);
        expect(job?.resumeSessionId).toBe('session-1');
    });

    it('carries the environment the board resolved, reading a missing one as empty', async () => {
        const { fetch } = recorder(() => claimed({ env: { CORE: 'value' } }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });
        expect((await board.claim('driver-1'))?.env).toEqual({ CORE: 'value' });

        // A board that predates the field omits it; `{}` keeps the runner spawn honest.
        const { fetch: bare } = recorder(() => claimed());
        const oldBoard = createBoard({ url: 'http://board', leaseSeconds: 300, fetch: bare });
        expect((await oldBoard.claim('driver-1'))?.env).toEqual({});
    });
});

describe('rereading the gates after the startup sync', () => {
    const job = {
        id: 'job-1',
        command: 'echo hi',
        attempts: 1,
        leaseToken: 'token-1',
        leaseExpiresAt: '2026-08-21T12:05:00.000Z',
        resumeSessionId: null,
        userId: null,
    };

    it('asks the board with the lease token and carries the fresh answer', async () => {
        const { calls, fetch } = recorder(() =>
            Response.json(
                { gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] }, gateError: null },
                { status: 200 },
            ),
        );
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, token: 'fwt_abc', fetch });

        const fresh = await board.rereadGates(job);

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/gates-reread');
        expect(calls[0]!.body).toEqual({ leaseToken: 'token-1' });
        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(fresh).toEqual({
            gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            gateError: null,
        });
    });

    it('answers null — keep the claim’s decision — when the board refuses or fails', async () => {
        const lost = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        expect(await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: lost.fetch }).rereadGates(job)).toBeNull();

        const dead = recorder(() => Response.json({ error: 'No such job' }, { status: 404 }));
        expect(await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: dead.fetch }).rereadGates(job)).toBeNull();

        const broken = recorder(() => {
            throw new Error('board unreachable');
        });
        expect(await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: broken.fetch }).rereadGates(job)).toBeNull();
    });
});

describe('reading the thread terminality after a verdict', () => {
    const job = {
        id: 'job-1',
        command: 'echo hi',
        attempts: 1,
        leaseToken: 'token-1',
        leaseExpiresAt: '2026-08-21T12:05:00.000Z',
        resumeSessionId: null,
        userId: null,
    };

    const thread = (statuses: string[]) =>
        Response.json({ jobs: statuses.map((status) => ({ id: `job-${statuses.indexOf(status)}`, status })) }, { status: 200 });

    it('reads the thread as a GET on the job, with the worker token', async () => {
        const { calls, fetch } = recorder(() => thread(['succeeded']));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, token: 'fwt_abc', fetch });

        expect(await board.threadTerminal(job)).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/thread');
        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
    });

    it('is true only when EVERY job of the thread is terminal', async () => {
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch: recorder(() => thread(['succeeded'])).fetch });
        expect(await board.threadTerminal(job)).toBe(true);

        const failed = createBoard({ url: 'http://board', leaseSeconds: 300, fetch: recorder(() => thread(['failed', 'succeeded'])).fetch });
        expect(await failed.threadTerminal(job)).toBe(true);

        const dead = createBoard({ url: 'http://board', leaseSeconds: 300, fetch: recorder(() => thread(['dead'])).fetch });
        expect(await dead.threadTerminal(job)).toBe(true);

        // Any non-terminal member — a follow-up still queued, parked, or running — keeps it false.
        const queued = createBoard({ url: 'http://board', leaseSeconds: 300, fetch: recorder(() => thread(['succeeded', 'queued'])).fetch });
        expect(await queued.threadTerminal(job)).toBe(false);

        const standby = createBoard({ url: 'http://board', leaseSeconds: 300, fetch: recorder(() => thread(['standby'])).fetch });
        expect(await standby.threadTerminal(job)).toBe(false);
    });

    it('answers false — keep the tree — when the board refuses or fails', async () => {
        // Best-effort by contract, like rereadGates: the verdict is already on the board, so the
        // reclaim must never wait on a board that will not answer the child question.
        const broken = recorder(() => {
            throw new Error('board unreachable');
        });
        expect(await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: broken.fetch }).threadTerminal(job)).toBe(false);

        const refused = recorder(() => Response.json({ error: 'gone' }, { status: 404 }));
        expect(await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: refused.fetch }).threadTerminal(job)).toBe(false);

        const empty = recorder(() => Response.json({ jobs: [] }, { status: 200 }));
        expect(await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: empty.fetch }).threadTerminal(job)).toBe(false);
    });
});
