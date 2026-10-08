import { describe, expect, it, vitest } from 'vitest';
import type { Board, BoardJob } from '../src/board.js';
import { uploadRunArtifacts } from '../src/artifacts.js';
import type { RunOutcome } from '../src/runner.js';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix it',
    attempts: 3,
    claimSeq: 3,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-09-30T12:05:00.000Z',
    executorType: 'claude-code',
    masterPrompt: null,
    resumeSessionId: null,
    followUp: false,
    userId: null,
    workspacePath: null,
};

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    exitCode: 0,
    output: 'done',
    timedOut: false,
    started: true,
    ...over,
});

/** A board that records artifact uploads and can be made to fail or lose the lease. */
function artifactBoard(options: { fail?: boolean; lost?: boolean } = {}): {
    board: Board;
    uploads: { kind: string; attempt: number; content: string; truncated: boolean }[];
} {
    const uploads: { kind: string; attempt: number; content: string; truncated: boolean }[] = [];
    const board = {
        async artifact(_j, upload) {
            if (options.fail) throw new Error('board unreachable');
            if (options.lost) return 'lost';
            uploads.push(upload);
            return 'held';
        },
    } as unknown as Board;
    return { board, uploads };
}

/**
 * The artifacts' close-time upload (issue #325): log first, then transcript, keyed to the
 * attempt the claim carries, each call best-effort on its own — a failed or lost upload is a
 * log line, never a throw into the loop's finish path and never a kill order.
 */
describe('uploading the run artifacts', () => {
    it('uploads the log and then the transcript, keyed to the attempt', async () => {
        const { board, uploads } = artifactBoard();
        const logs: string[] = [];

        await uploadRunArtifacts(
            { board, log: (m) => logs.push(m) },
            job,
            outcome({
                fullLog: 'the whole log\n',
                logTruncated: true,
                transcript: '[{"role":"user"}]',
                transcriptTruncated: false,
            })
        );

        expect(uploads).toEqual([
            { kind: 'log', attempt: 3, content: 'the whole log\n', truncated: true },
            { kind: 'transcript', attempt: 3, content: '[{"role":"user"}]', truncated: false },
        ]);
        expect(logs).toEqual([]);
    });

    it('uploads nothing for absent or empty artifacts — no artifact, never an empty one', async () => {
        const { board, uploads } = artifactBoard();

        await uploadRunArtifacts({ board, log: () => {} }, job, outcome({ fullLog: '', transcript: undefined }));

        expect(uploads).toEqual([]);
    });

    it('swallows a board failure on either upload, and still attempts the transcript', async () => {
        const { board, uploads } = artifactBoard({ fail: true });
        const logs: string[] = [];

        await uploadRunArtifacts(
            { board, log: (m) => logs.push(m) },
            job,
            outcome({ fullLog: 'log', transcript: 'tr' })
        );

        expect(uploads).toEqual([]);
        expect(logs.filter((m) => m.includes('log artifact'))).toHaveLength(1);
        expect(logs.filter((m) => m.includes('transcript artifact'))).toHaveLength(1);
    });

    it('treats a lost lease as a log line, not a kill order', async () => {
        const { board } = artifactBoard({ lost: true });
        const logs: string[] = [];

        await uploadRunArtifacts({ board, log: (m) => logs.push(m) }, job, outcome({ fullLog: 'log' }));

        expect(logs.some((m) => m.includes('refused (lease lost)'))).toBe(true);
    });

    it('never throws, whatever the board does', async () => {
        const board = {
            artifact: vitest.fn(async () => {
                throw new Error('boom');
            }),
        } as unknown as Board;

        await expect(
            uploadRunArtifacts({ board, log: () => {} }, job, outcome({ fullLog: 'x' }))
        ).resolves.toBeUndefined();
    });
});
