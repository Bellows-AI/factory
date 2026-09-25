import { describe, expect, it, vi } from 'vitest';
import { reportUnauthenticated, signOut, subscribeUnauthenticated } from '../src/api/useSession.js';

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
        subscribeUnauthenticated(page);

        reportUnauthenticated();
        expect(shell).toHaveBeenCalledTimes(1);
        expect(page).toHaveBeenCalledTimes(1);

        offShell();
        reportUnauthenticated();
        expect(shell).toHaveBeenCalledTimes(1);
        expect(page).toHaveBeenCalledTimes(2);
    });
});

describe('signOut', () => {
    const subscribe = (...fns: (() => void)[]) => fns.map((fn) => subscribeUnauthenticated(fn));

    it('POSTs the logout route and re-checks every mounted useSession', async () => {
        const post = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
        vi.stubGlobal('fetch', post);
        const shell = vi.fn();
        const page = vi.fn();
        const offs = subscribe(shell, page);
        try {
            await signOut();
            // POST, never GET — a GET logout is CSRF-able and the server refuses it.
            expect(post).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
            // Both mounts hear it (the shell and the page), so neither keeps a stale session.
            expect(shell).toHaveBeenCalledTimes(1);
            expect(page).toHaveBeenCalledTimes(1);
        } finally {
            for (const off of offs) off();
            vi.unstubAllGlobals();
        }
    });

    it('re-checks even when the POST fails, so no mount is left stale', async () => {
        // The server answers 204 to a dead session, so a failed POST means the network itself is
        // down — the re-check then reports that as an error instead of silently keeping a session.
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new Error('down')))
        );
        const shell = vi.fn();
        const offs = subscribe(shell);
        try {
            await signOut();
            expect(shell).toHaveBeenCalledTimes(1);
        } finally {
            for (const off of offs) off();
            vi.unstubAllGlobals();
        }
    });
});
