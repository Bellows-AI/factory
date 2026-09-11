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

describe('the heartbeat verdict', () => {
    const job = {
        id: 'job-1',
        command: 'echo hi',
        attempts: 1,
        leaseToken: 'token-1',
        leaseExpiresAt: '2026-08-21T12:05:00.000Z',
        resumeSessionId: null,
        userId: null,
    };

    it('carries the stop flag when the board set it on a held lease', async () => {
        const { calls, fetch } = recorder(() => Response.json({ cancelRequested: true }, { status: 200 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });

        expect(await board.heartbeat(job)).toEqual({ result: 'held', cancelRequested: true });
        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/heartbeat');
        expect(calls[0]!.body).toEqual({ leaseToken: 'token-1', leaseSeconds: 300 });
    });

    it('answers held without the stop flag when the board never set one', async () => {
        const { fetch } = recorder(() => Response.json({}, { status: 200 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });
        expect(await board.heartbeat(job)).toEqual({ result: 'held', cancelRequested: false });
    });

    it('answers lost on a 409, which is a verdict not a failure', async () => {
        const { fetch } = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });
        expect(await board.heartbeat(job)).toBe('lost');
    });

    it('answers removed on a 404 — the thread was deleted while this attempt ran', async () => {
        // The only 404 a heartbeat can see is a Remove; the driver kills the container and
        // reports nothing, so the status has to arrive as a verdict rather than "board broken".
        const { fetch } = recorder(() => Response.json({ error: 'No such job' }, { status: 404 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });
        expect(await board.heartbeat(job)).toBe('removed');
    });
});

describe('the removed-thread reclaim queue', () => {
    it('claims a row with the worker and lease, answering null on an empty queue', async () => {
        const row = {
            id: '55555555-5555-4555-8555-555555555555',
            rootJobId: 'job-1',
            repo: 'Bellows-AI/factory',
            workspacePath: 'bellows/user-7',
            leaseExpiresAt: '2026-08-21T12:05:00.000Z',
        };
        const { calls, fetch } = recorder(() => Response.json(row, { status: 200 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });

        expect(await board.claimReclaim('driver-1')).toEqual(row);
        expect(calls[0]!.url).toBe('http://board/api/reclaims/claim');
        expect(calls[0]!.body).toEqual({ worker: 'driver-1', leaseSeconds: 300 });

        const { fetch: idle } = recorder(() => new Response(null, { status: 204 }));
        const idleBoard = createBoard({ url: 'http://board', leaseSeconds: 300, fetch: idle });
        expect(await idleBoard.claimReclaim('driver-1')).toBeNull();
    });

    it('acks a consumed row as ok, and reads 409 and 404 back as their own verdicts', async () => {
        const ok = recorder(() => Response.json({ id: 'row-1' }, { status: 200 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, token: 'fwt_abc', fetch: ok.fetch });
        expect(await board.ackReclaim('row-1', 'driver-1')).toBe('ok');
        expect(ok.calls[0]!.url).toBe('http://board/api/reclaims/row-1/ack');
        expect(ok.calls[0]!.body).toEqual({ worker: 'driver-1' });
        expect(ok.calls[0]!.headers.authorization).toBe('Bearer fwt_abc');

        const lost = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        expect(
            await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: lost.fetch }).ackReclaim('row-1', 'driver-1'),
        ).toBe('lost');

        const gone = recorder(() => Response.json({ error: 'No such reclaim' }, { status: 404 }));
        expect(
            await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: gone.fetch }).ackReclaim('row-1', 'driver-1'),
        ).toBe('missing');
    });

    it('still throws on any other non-ok answer', async () => {
        const { fetch } = recorder(() => Response.json({ error: 'boom' }, { status: 500 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });

        await expect(board.ackReclaim('row-1', 'driver-1')).rejects.toThrow(/500/);
    });
});

describe('the complete verdict', () => {
    const job = {
        id: 'job-1',
        command: 'echo hi',
        attempts: 1,
        leaseToken: 'token-1',
        leaseExpiresAt: '2026-08-21T12:05:00.000Z',
        resumeSessionId: null,
        userId: null,
    };

    it('carries the thread-terminal answer the board computed beside the lease state', async () => {
        // The board computes threadTerminal in the same lease-guarded transaction as the verdict,
        // so the driver reads both from the one complete round trip — no separate thread read to
        // race a follow-up's insertion against.
        const { calls, fetch } = recorder(() =>
            Response.json({ id: 'job-1', status: 'succeeded', threadTerminal: true }, { status: 200 }),
        );
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, token: 'fwt_abc', fetch });

        const verdict = await board.complete(job, { status: 'succeeded', exitCode: 0, output: '' });

        expect(calls[0]!.url).toBe('http://board/api/jobs/job-1/complete');
        expect(calls[0]!.headers.authorization).toBe('Bearer fwt_abc');
        expect(verdict).toEqual({ state: 'held', threadTerminal: true });
    });

    it('reads an absent, false or non-boolean threadTerminal as false — keep the tree', async () => {
        // Defensive on purpose: a board that predates the field, a body without it, or one that
        // lies about its type all mean "a follow-up might still come" — the conservative answer.
        const absent = recorder(() => Response.json({ id: 'job-1', status: 'succeeded' }, { status: 200 }));
        expect(
            await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: absent.fetch }).complete(job, {
                status: 'succeeded',
                exitCode: 0,
                output: '',
            }),
        ).toEqual({ state: 'held', threadTerminal: false });

        const falseBody = recorder(() => Response.json({ id: 'job-1', threadTerminal: false }, { status: 200 }));
        expect(
            await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: falseBody.fetch }).complete(job, {
                status: 'succeeded',
                exitCode: 0,
                output: '',
            }),
        ).toEqual({ state: 'held', threadTerminal: false });

        const lying = recorder(() => Response.json({ id: 'job-1', threadTerminal: 'yes' }, { status: 200 }));
        expect(
            await createBoard({ url: 'http://board', leaseSeconds: 300, fetch: lying.fetch }).complete(job, {
                status: 'succeeded',
                exitCode: 0,
                output: '',
            }),
        ).toEqual({ state: 'held', threadTerminal: false });
    });

    it('answers lost with threadTerminal false when the board refuses the verdict with a 409', async () => {
        const { fetch } = recorder(() => Response.json({ error: 'Lease lost' }, { status: 409 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });

        expect(await board.complete(job, { status: 'failed', exitCode: 1, output: 'boom' })).toEqual({
            state: 'lost',
            threadTerminal: false,
        });
    });

    it('still throws on any other non-ok answer', async () => {
        // 409 is a verdict; everything else is the board being broken or the driver being wrong,
        // and neither is swallowed into a silent no-op.
        const { fetch } = recorder(() => Response.json({ error: 'No such job' }, { status: 404 }));
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });

        await expect(board.complete(job, { status: 'succeeded', exitCode: 0, output: '' })).rejects.toThrow(/404/);
    });

    it('no longer carries a separate thread read — the answer travels on complete', () => {
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch: recorder(() => claimed()).fetch });
        expect('threadTerminal' in board).toBe(false);
    });
});
