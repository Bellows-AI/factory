import { describe, expect, it } from 'vitest';
import { type BoardJob, createBoard } from '../src/board.js';

/** The board client's review calls (issue #549) and how a claim's `reviewRun` arrives. */

const job = {
    id: 'job-1',
    command: 'echo hi',
    attempts: 1,
    claimSeq: 1,
    leaseToken: 'token-1',
    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
    resumeSessionId: null,
    userId: null,
} as unknown as BoardJob;

const REVIEW = {
    id: 'review-1',
    key: 'sec-1',
    profile: 'security',
    status: 'queued',
    verdict: 'none',
    revision: 'abc:def',
    findings: null,
    failureKind: null,
    evidence: { state: 'incomplete' },
};
const REQUEST = { key: 'sec-1', profile: 'security', revision: 'abc:def', ref: 'refs/factory/review/root/sec-1' };

function boardAnswering(status: number, body: unknown) {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return Response.json(body, { status });
    }) as unknown as typeof globalThis.fetch;
    return { calls, board: createBoard({ url: 'http://board', leaseSeconds: 300, fetch }) };
}

describe('requestReview', () => {
    it('posts the key, profile, revision and ref under the lease token, and reads 201 as a new review', async () => {
        const { calls, board } = boardAnswering(201, REVIEW);
        await expect(board.requestReview(job, REQUEST)).resolves.toEqual({
            result: 'ok',
            review: REVIEW,
            created: true,
        });
        expect(calls).toEqual([
            { url: 'http://board/api/jobs/job-1/review', body: { leaseToken: 'token-1', ...REQUEST } },
        ]);
    });

    it('reads 200 as the stored review', async () => {
        const { board } = boardAnswering(200, REVIEW);
        await expect(board.requestReview(job, REQUEST)).resolves.toMatchObject({ result: 'ok', created: false });
    });

    it('tells the lease verdict from a refusal on the SAME 409 by the code the board sends', async () => {
        const lost = boardAnswering(409, { error: 'Lease lost', code: 'LEASE_LOST' });
        await expect(lost.board.requestReview(job, REQUEST)).resolves.toEqual({ result: 'lost' });

        const unknown = boardAnswering(409, { error: 'No reviewer named "x" is declared', code: 'UNKNOWN_REVIEWER' });
        await expect(unknown.board.requestReview(job, REQUEST)).resolves.toEqual({
            result: 'refused',
            reason: 'No reviewer named "x" is declared',
        });

        const workflow = boardAnswering(409, {
            error: 'A workflow task reviews through its own graph',
            code: 'REVIEW_UNSUPPORTED',
        });
        await expect(workflow.board.requestReview(job, REQUEST)).resolves.toMatchObject({ result: 'refused' });
    });

    it('reads a missing job as removed, and a 400 as the board’s refusal rather than a throw', async () => {
        const removed = boardAnswering(404, { error: 'No such job', code: 'NOT_FOUND' });
        await expect(removed.board.requestReview(job, REQUEST)).resolves.toEqual({ result: 'removed' });

        const invalid = boardAnswering(400, { error: 'ref is not the snapshot ref', code: 'INVALID_REVIEW' });
        await expect(invalid.board.requestReview(job, REQUEST)).resolves.toEqual({
            result: 'refused',
            reason: 'ref is not the snapshot ref',
        });
    });

    it('throws on a 5xx so the caller retries', async () => {
        await expect(boardAnswering(503, {}).board.requestReview(job, REQUEST)).rejects.toThrow(/503/);
    });
});

describe('readReview', () => {
    it('posts the key under the lease token and answers the review with the thread’s evidence', async () => {
        const review = { ...REVIEW, evidence: { state: 'approved', revision: 'abc:def' } };
        const { calls, board } = boardAnswering(200, review);
        await expect(board.readReview(job, 'sec-1')).resolves.toEqual({ result: 'ok', review, created: false });
        expect(calls).toEqual([
            { url: 'http://board/api/jobs/job-1/review-read', body: { leaseToken: 'token-1', key: 'sec-1' } },
        ]);
    });

    it('reads an unknown key as a refusal and a missing job as removed — the two 404s', async () => {
        const unknown = boardAnswering(404, {
            error: 'No review was requested under that key',
            code: 'REVIEW_NOT_FOUND',
        });
        await expect(unknown.board.readReview(job, 'nope')).resolves.toEqual({
            result: 'refused',
            reason: 'No review was requested under that key',
        });
        const removed = boardAnswering(404, { error: 'No such job', code: 'NOT_FOUND' });
        await expect(removed.board.readReview(job, 'sec-1')).resolves.toEqual({ result: 'removed' });
        const lost = boardAnswering(409, { code: 'LEASE_LOST', error: 'gone' });
        await expect(lost.board.readReview(job, 'sec-1')).resolves.toEqual({ result: 'lost' });
    });
});
