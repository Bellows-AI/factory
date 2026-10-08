import { describe, expect, it } from 'vitest';
import type { BoardJob, ReviewAnswer, ReviewReport, ReviewRequest } from '../src/board.js';
import { createGateServer } from '../src/gates.js';
import { newJobState } from '../src/loop-attempt.js';
import { createReviewRelay, reviewerQuestionRelay } from '../src/loop-review.js';
import type { LoopRuntime } from '../src/loop-types.js';
import type { ReviewRelay, ReviewVerdict } from '../src/review-control.js';
import type { SnapshotResult } from '../src/review-snapshot.js';

/** The named-reviewer routes on the control endpoint, and the relay behind them (issue #549). */

const OK_STATUS = 200;
const CREATED_STATUS = 201;
const BAD_REQUEST_STATUS = 400;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const CONFLICT_STATUS = 409;
const PAYLOAD_TOO_LARGE_STATUS = 413;
const NOT_IMPLEMENTED_STATUS = 501;

const JOB = {
    id: '00000001-1111-4111-8111-111111111111',
    rootJobId: '00000002-1111-4111-8111-111111111111',
    command: 'job 1',
    leaseToken: '00000001-2222-4222-8222-222222222222',
} as BoardJob;

const REVIEW: ReviewReport = {
    id: '99999999-9999-4999-8999-999999999999',
    key: 'sec-1',
    profile: 'security',
    status: 'running',
    verdict: 'none',
    revision: 'abc:def',
    findings: null,
    failureKind: null,
    evidence: { state: 'incomplete' },
};

const manager = { acquire: async () => {}, runGate: async () => ({ exitCode: 0, output: '' }) };

describe('the control server: POST /review and GET /review/:key', () => {
    const request = (port: number, token: string, body: unknown) =>
        fetch(`http://127.0.0.1:${port}/review`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });
    const read = (port: number, token: string, key: string) =>
        fetch(`http://127.0.0.1:${port}/review/${key}`, { headers: { authorization: `Bearer ${token}` } });

    async function opened(reviewer: ReviewRelay | undefined) {
        const server = createGateServer({ host: '127.0.0.1', manager });
        server.openControl('tok-r', undefined, undefined, reviewer);
        return { server, port: await server.listen() };
    }

    const relayOf = (verdict: ReviewVerdict) => ({
        request: async () => verdict,
        read: async () => verdict,
    });

    it('answers a started review with 201 and the fields an agent reads, never the board’s row id', async () => {
        const { server, port } = await opened(relayOf({ review: REVIEW, created: true }));
        const answer = await request(port, 'tok-r', { key: 'sec-1', profile: 'security' });
        expect(answer.status).toBe(CREATED_STATUS);
        await expect(answer.json()).resolves.toEqual({
            key: 'sec-1',
            profile: 'security',
            status: 'running',
            done: false,
            verdict: 'none',
            findings: null,
            revision: 'abc:def',
            failureKind: null,
            approved: false,
        });
        await server.close();
    });

    it('answers a read with 200, done once the review settled, approved only when the thread’s evidence says so', async () => {
        const settled: ReviewReport = {
            ...REVIEW,
            status: 'succeeded',
            verdict: 'clean',
            findings: 'fine\nVERDICT: CLEAN',
            evidence: { state: 'approved', revision: 'abc:def' },
        };
        const { server, port } = await opened(relayOf({ review: settled, created: false }));
        const answer = await read(port, 'tok-r', 'sec-1');
        expect(answer.status).toBe(OK_STATUS);
        await expect(answer.json()).resolves.toMatchObject({ done: true, verdict: 'clean', approved: true });
        await server.close();
    });

    it.each(['failed', 'dead', 'stopped'] as const)(
        'reads a %s review as done with no verdict and no approval',
        async (status) => {
            const { server, port } = await opened(relayOf({ review: { ...REVIEW, status }, created: false }));
            await expect((await read(port, 'tok-r', 'sec-1')).json()).resolves.toMatchObject({
                done: true,
                verdict: 'none',
                approved: false,
            });
            await server.close();
        }
    );

    it.each<[ReviewVerdict, number]>([
        ['forbidden', FORBIDDEN_STATUS],
        ['unsupported', NOT_IMPLEMENTED_STATUS],
        ['gone', UNAUTHORIZED_STATUS],
        [{ refused: 'No reviewer named "x" is declared' }, CONFLICT_STATUS],
    ])('maps %j to %i', async (verdict, status) => {
        const { server, port } = await opened(relayOf(verdict));
        expect((await request(port, 'tok-r', { key: 'k', profile: 'security' })).status).toBe(status);
        expect((await read(port, 'tok-r', 'k')).status).toBe(status);
        await server.close();
    });

    it('says the board’s own reason when it refused', async () => {
        const { server, port } = await opened(relayOf({ refused: 'No reviewer named "x" is declared' }));
        await expect((await request(port, 'tok-r', { key: 'k', profile: 'security' })).json()).resolves.toEqual({
            error: 'No reviewer named "x" is declared',
        });
        await server.close();
    });

    it.each([
        ['a body that is not JSON', 'nope'],
        ['no key', { profile: 'security' }],
        ['a key with a bad character', { key: 'a b', profile: 'security' }],
        ['a key over 64 characters', { key: 'k'.repeat(65), profile: 'security' }],
        ['no profile', { key: 'k' }],
        ['an upper-case profile', { key: 'k', profile: 'Security' }],
    ])('refuses %s with 400 before the relay is asked', async (_label, body) => {
        let asked = 0;
        const { server, port } = await opened({
            request: async () => {
                asked += 1;
                return 'gone';
            },
            read: async () => 'gone',
        });
        expect((await request(port, 'tok-r', body)).status).toBe(BAD_REQUEST_STATUS);
        expect(asked).toBe(0);
        await server.close();
    });

    it('refuses a bad key on a read, and a body past the limit', async () => {
        const { server, port } = await opened(relayOf({ review: REVIEW, created: false }));
        expect((await read(port, 'tok-r', 'a%20b')).status).toBe(BAD_REQUEST_STATUS);
        expect((await request(port, 'tok-r', 'x'.repeat(2048))).status).toBe(PAYLOAD_TOO_LARGE_STATUS);
        await server.close();
    });

    it('is forbidden when the attempt has no reviewer relay — a reviewer’s own channel', async () => {
        const { server, port } = await opened(undefined);
        expect((await request(port, 'tok-r', { key: 'k', profile: 'security' })).status).toBe(FORBIDDEN_STATUS);
        expect((await read(port, 'tok-r', 'k')).status).toBe(FORBIDDEN_STATUS);
        await server.close();
    });

    it('refuses an unknown token, a closed one, and a method that is not the route', async () => {
        const { server, port } = await opened(relayOf({ review: REVIEW, created: true }));
        expect((await request(port, 'nope', { key: 'k', profile: 'security' })).status).toBe(UNAUTHORIZED_STATUS);
        const put = await fetch(`http://127.0.0.1:${port}/review`, {
            method: 'PUT',
            headers: { authorization: 'Bearer tok-r' },
        });
        expect(put.status).toBe(NOT_FOUND_STATUS);
        server.closeControl('tok-r');
        expect((await read(port, 'tok-r', 'k')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('runs one request at a time per token: a second is told, never queued', async () => {
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { server, port } = await opened({
            request: async () => {
                await held;
                return { review: REVIEW, created: true };
            },
            read: async () => ({ review: REVIEW, created: false }),
        });
        const first = request(port, 'tok-r', { key: 'a', profile: 'security' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect((await request(port, 'tok-r', { key: 'b', profile: 'security' })).status).toBe(CONFLICT_STATUS);
        // A read is not a request: it is never blocked behind one.
        expect((await read(port, 'tok-r', 'a')).status).toBe(OK_STATUS);
        release();
        expect((await first).status).toBe(CREATED_STATUS);
        await server.close();
    });
});

describe('the review relay: what an attempt may ask for', () => {
    interface Calls {
        measured: number;
        snapshots: string[];
        requests: ReviewRequest[];
        reads: string[];
    }
    const SNAPSHOT_REF = `refs/factory/review/${JOB.rootJobId}/sec-1`;

    const relayFor = (
        over: {
            job?: Partial<BoardJob>;
            tree?: string | null;
            snapshot?: SnapshotResult;
            answer?: ReviewAnswer;
            noSnapshot?: boolean;
            noProbe?: boolean;
            boardThrows?: boolean;
        } = {}
    ) => {
        const calls: Calls = { measured: 0, snapshots: [], requests: [], reads: [] };
        const state = newJobState();
        const answer: ReviewAnswer = over.answer ?? { result: 'ok', review: REVIEW, created: true };
        const runner = {
            // A lost lease or a removal stands the attempt down, which kills its runner.
            kill: async () => {},
            ...(over.noProbe
                ? {}
                : {
                      probeTree: async () => {
                          calls.measured += 1;
                          return 'tree' in over ? over.tree : 'abc:def';
                      },
                  }),
            ...(over.noSnapshot
                ? {}
                : {
                      snapshotTree: async (_job: BoardJob, key: string) => {
                          calls.snapshots.push(key);
                          return over.snapshot ?? { ok: true as const, ref: SNAPSHOT_REF };
                      },
                  }),
        };
        const board = {
            requestReview: async (_job: BoardJob, request: ReviewRequest) => {
                if (over.boardThrows) throw new Error('board down');
                calls.requests.push(request);
                return answer;
            },
            readReview: async (_job: BoardJob, key: string) => {
                calls.reads.push(key);
                return answer;
            },
        };
        const rt = { runner, board, log: () => {}, sleep: async () => {} } as unknown as LoopRuntime;
        const job = { ...JOB, ...over.job } as BoardJob;
        return { relay: createReviewRelay(rt, job, state), state, calls, job };
    };

    it('measures the tree, freezes it, and only then asks the board — with the revision the driver measured', async () => {
        const { relay, calls } = relayFor();
        await expect(relay.request('sec-1', 'security')).resolves.toEqual({ review: REVIEW, created: true });
        expect(calls.measured).toBe(1);
        expect(calls.snapshots).toEqual(['sec-1']);
        expect(calls.requests).toEqual([{ key: 'sec-1', profile: 'security', revision: 'abc:def', ref: SNAPSHOT_REF }]);
    });

    it('adopts the thread’s review evidence from the board’s answer, on a request and on a read', async () => {
        const approved: ReviewReport = {
            ...REVIEW,
            status: 'succeeded',
            verdict: 'clean',
            evidence: { state: 'approved', revision: 'abc:def' },
        };
        const { relay, job } = relayFor({ answer: { result: 'ok', review: approved, created: false } });
        expect(job.review).toBeUndefined();
        await relay.read('sec-1');
        expect(job.review).toEqual({ state: 'approved', revision: 'abc:def' });

        const requested = relayFor({
            answer: { result: 'ok', review: { ...approved, evidence: { state: 'incomplete' } }, created: false },
        });
        await requested.relay.request('sec-1', 'security');
        expect(requested.job.review).toEqual({ state: 'incomplete' });
    });

    it('asks the board nothing when the tree cannot be measured or the snapshot fails', async () => {
        const unmeasured = relayFor({ tree: null });
        await expect(unmeasured.relay.request('sec-1', 'security')).resolves.toMatchObject({
            refused: expect.stringContaining('could not be measured'),
        });
        expect(unmeasured.calls.snapshots).toEqual([]);
        expect(unmeasured.calls.requests).toEqual([]);

        const failed = relayFor({ snapshot: { ok: false, reason: 'the review snapshot failed: no space' } });
        await expect(failed.relay.request('sec-1', 'security')).resolves.toEqual({
            refused: 'the review snapshot failed: no space',
        });
        expect(failed.calls.requests).toEqual([]);
    });

    it('is unsupported on a runner that cannot measure or snapshot', async () => {
        await expect(relayFor({ noSnapshot: true }).relay.request('k', 'p')).resolves.toBe('unsupported');
        await expect(relayFor({ noProbe: true }).relay.request('k', 'p')).resolves.toBe('unsupported');
    });

    it.each(['stopped', 'lost', 'removed', 'draining', 'finished'] as const)(
        'asks for nothing once the attempt is %s',
        async (flag) => {
            const { relay, state, calls } = relayFor();
            state[flag] = true;
            await expect(relay.request('sec-1', 'security')).resolves.toBe('gone');
            await expect(relay.read('sec-1')).resolves.toBe('gone');
            expect(calls.measured).toBe(0);
            expect(calls.snapshots).toEqual([]);
            expect(calls.requests).toEqual([]);
            expect(calls.reads).toEqual([]);
        }
    );

    it('asks the board nothing when the lease is lost while the tree is frozen', async () => {
        const requests: ReviewRequest[] = [];
        const state = newJobState();
        const rt = {
            runner: {
                probeTree: async () => 'abc:def',
                snapshotTree: async () => {
                    state.lost = true;
                    return { ok: true as const, ref: SNAPSHOT_REF };
                },
            },
            board: {
                requestReview: async (_job: BoardJob, request: ReviewRequest) => {
                    requests.push(request);
                    return { result: 'ok' as const, review: REVIEW, created: true };
                },
            },
            log: () => {},
        } as unknown as LoopRuntime;
        const relay = createReviewRelay(rt, JOB, state);
        await expect(relay.request('sec-1', 'security')).resolves.toBe('gone');
        expect(requests).toEqual([]);
    });

    it('passes the board’s refusal through, and stands the attempt down on a lost lease or a removal', async () => {
        const refused = relayFor({ answer: { result: 'refused', reason: 'No reviewer named "x" is declared' } });
        await expect(refused.relay.request('sec-1', 'x')).resolves.toEqual({
            refused: 'No reviewer named "x" is declared',
        });
        expect(refused.job.review).toBeUndefined();

        const lost = relayFor({ answer: { result: 'lost' } });
        await expect(lost.relay.request('sec-1', 'security')).resolves.toBe('gone');
        expect(lost.state.lost).toBe(true);

        const removed = relayFor({ answer: { result: 'removed' } });
        await expect(removed.relay.read('sec-1')).resolves.toBe('gone');
        expect(removed.state.removed).toBe(true);
    });

    it('answers a board that cannot be reached as a refusal to ask again, not a crash', async () => {
        const { relay } = relayFor({ boardThrows: true });
        await expect(relay.request('sec-1', 'security')).resolves.toEqual({
            refused: 'the board could not be reached; ask again',
        });
    });
});

describe('a reviewer’s own control channel', () => {
    it('refuses every question: a reviewer reports to its caller, not to a member', async () => {
        await expect(reviewerQuestionRelay.ask('q1', [])).resolves.toBe('refused');
    });
});
