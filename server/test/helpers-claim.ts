import type { Claim } from '../src/db/job-store-types.js';

/** A complete root-job claim with nothing optional set; `overrides` adds or replaces fields. */
export const makeClaim = (overrides: Partial<Claim> & Pick<Claim, 'id' | 'command' | 'leaseToken'>): Claim => ({
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
    executorType: null,
    executorRefusal: null,
    skillRefusal: null,
    planRefusal: null,
    userId: null,
    masterPrompt: null,
    turnContext: null,
    workspacePath: null,
    rootJobId: overrides.id,
    rootCommand: overrides.command,
    resumeSessionId: null,
    followUp: false,
    ...overrides,
});
