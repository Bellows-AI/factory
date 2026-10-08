import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { CONTROL_TOKEN_ENV, CONTROL_URL_ENV } from '../src/claim.js';
import { newJobState } from '../src/loop-attempt.js';
import { openRunControl } from '../src/loop-gates.js';
import { reviewerQuestionRelay } from '../src/loop-review.js';
import type { LoopRuntime } from '../src/loop-types.js';

/**
 * What a run's control channel carries (issue #549): an ordinary attempt gets the question, publish
 * and reviewer relays; a named reviewer's attempt gets the stop poll and a question relay that
 * refuses — no publication and no reviewer of its own, whatever the agent inside it calls.
 */

const JOB = {
    id: '00000001-1111-4111-8111-111111111111',
    command: 'job',
    leaseToken: '00000001-2222-4222-8222-222222222222',
} as BoardJob;

function opened() {
    const calls: unknown[][] = [];
    const rt = {
        gates: {
            server: {
                listen: async () => 9099,
                openControl: (...args: unknown[]) => {
                    calls.push(args);
                },
            },
            advertiseUrl: (port: number) => `http://driver:${port}`,
        },
        log: () => {},
    } as unknown as LoopRuntime;
    return { rt, calls, state: newJobState() };
}

describe('openRunControl', () => {
    it('gives an ordinary attempt the question, publish and reviewer relays, and the endpoint in its env', async () => {
        const job = { ...JOB } as BoardJob;
        const { rt, calls, state } = opened();
        await openRunControl(rt, job, state);
        const [token, questions, publisher, reviewer] = calls[0] as [
            string,
            object,
            object,
            { request: unknown; read: unknown },
        ];
        expect(questions).toBeDefined();
        expect(publisher).toBeDefined();
        expect(reviewer).toMatchObject({ request: expect.any(Function), read: expect.any(Function) });
        expect(job.gateEnv).toMatchObject({ [CONTROL_URL_ENV]: 'http://driver:9099', [CONTROL_TOKEN_ENV]: token });
        expect(state.control).toBe(token);
    });

    it('gives a named reviewer’s attempt the stop poll alone: no publisher, no reviewer, questions refused', async () => {
        const job = {
            ...JOB,
            reviewRun: { profile: 'security', ref: 'refs/factory/review/r/k', timeoutMinutes: 5 },
        } as BoardJob;
        const { rt, calls, state } = opened();
        await openRunControl(rt, job, state);
        const [token, questions, publisher, reviewer] = calls[0] as unknown[];
        expect(questions).toBe(reviewerQuestionRelay);
        expect(publisher).toBeUndefined();
        expect(reviewer).toBeUndefined();
        expect(job.gateEnv).toMatchObject({ [CONTROL_TOKEN_ENV]: token });
    });
});
