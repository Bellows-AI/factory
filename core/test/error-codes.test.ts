import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/error-codes.js';

/**
 * The manual purge's refusals (issue #92) are wire contracts: the SPA branches on them, so the
 * codes are pinned here the same way the routes' payloads are pinned in the route suites.
 */
describe('ERROR_CODES', () => {
    it('carries the purge refusal codes', () => {
        expect(ERROR_CODES.PURGE_IN_PROGRESS).toBe('PURGE_IN_PROGRESS');
        expect(ERROR_CODES.TASKS_IN_FLIGHT).toBe('TASKS_IN_FLIGHT');
        expect(ERROR_CODES.REPO_SELECTED).toBe('REPO_SELECTED');
        expect(ERROR_CODES.REPO_CLONING).toBe('REPO_CLONING');
    });
});
