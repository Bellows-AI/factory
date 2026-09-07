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
            body: JSON.parse(init.body as string),
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
});
