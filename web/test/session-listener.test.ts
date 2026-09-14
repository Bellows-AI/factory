import { describe, expect, it, vi } from 'vitest';
import { reportUnauthenticated, subscribeUnauthenticated } from '../src/api/useSession.js';

/**
 * The 401 broadcast, pinned at the module level because the suite has no DOM: more than one
 * `useSession` instance is mounted at once (the shell, plus the settings and environment pages),
 * and every one of them must hear an expiry — a single stolen slot used to silence the gate for
 * all of them when a second hook mounted.
 */
describe('the 401 listener', () => {
    it('notifies every subscriber, and an unsubscribe leaves the others live', () => {
        const shell = vi.fn();
        const page = vi.fn();
        const offShell = subscribeUnauthenticated(shell);
        const offPage = subscribeUnauthenticated(page);

        reportUnauthenticated();
        expect(shell).toHaveBeenCalledTimes(1);
        expect(page).toHaveBeenCalledTimes(1);

        offShell();
        reportUnauthenticated();
        expect(shell).toHaveBeenCalledTimes(1);
        expect(page).toHaveBeenCalledTimes(2);
    });
});
