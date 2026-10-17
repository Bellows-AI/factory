import type { BoardJob } from '../../src/board.js';

/** The lease-holding job the board-client tests write against; `over` changes only what a test is about. */
export const boardJob = (over: { attempts?: number; claimSeq?: number } = {}): BoardJob => ({
    id: 'job-1',
    command: 'echo hi',
    rootCommand: 'echo hi',
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: 'token-1',
    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt: null,
    resumeSessionId: null,
    followUp: false,
    userId: null,
    workspacePath: null,
    ...over,
});
