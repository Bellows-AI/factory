import { describe, expect, it } from 'vitest';
import { PurgeConflictError } from '../src/db/user-repo-store.js';
import { memoryUserRepoStore } from './helpers-user-repo-store.js';

/**
 * The purge rules as the memory double implements them — the offline suite's copy of what
 * server/test-db/user-repo-store.test.ts pins against the real SQL, minus the transaction shapes
 * a memory map cannot have. Kept here so the refusal semantics fail offline too, where most of
 * the route suite runs.
 */
describe('the manual purge (memory store)', () => {
    const ALICE = '00000000-0000-4000-8000-00000000a11c';
    const web = { owner: 'acme', name: 'web' };

    it('stamps a deselected row purging and refuses a selected, cloning or duplicate one', async () => {
        const store = memoryUserRepoStore();
        await store.select(ALICE, [web]);
        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'selected' });

        await store.select(ALICE, []);
        expect(await store.stampPurge(ALICE, web)).toEqual({ stamped: true });
        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'purging' });
    });

    it('refuses a row still owned by a clone', async () => {
        const store = memoryUserRepoStore();
        await store.select(ALICE, [web]);
        await store.claimPending(1);
        await store.select(ALICE, []);

        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'cloning' });
    });

    it('carries the blocking-task count from its seam', async () => {
        const store = memoryUserRepoStore({
            blockingTasks: (userId, name) => (userId === ALICE && name === 'web' ? 2 : 0),
        });
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);

        expect(await store.stampPurge(ALICE, web)).toEqual({ refused: 'tasks', count: 2 });
    });

    it('refuses a selection that would change a purging row, naming it', async () => {
        const store = memoryUserRepoStore();
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);

        await expect(store.select(ALICE, [web])).rejects.toBeInstanceOf(PurgeConflictError);
        expect(await store.list(ALICE)).toHaveLength(0);
        expect(await store.orphaned(ALICE)).toHaveLength(1);
    });

    it('deletes only a row that is still deselected and purging, once', async () => {
        const store = memoryUserRepoStore();
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);

        expect(await store.deletePurged(ALICE, web)).toBe(true);
        expect(await store.deletePurged(ALICE, web)).toBe(false);
        expect(store.rows()).toHaveLength(0);
    });

    it('lands a failed purge back on failed with the reason', async () => {
        const store = memoryUserRepoStore();
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);

        await store.markPurgeFailed(ALICE, web, 'rm: permission denied');

        const [row] = await store.orphaned(ALICE);
        expect(row.status).toBe('failed');
        expect(row.error).toBe('rm: permission denied');
    });

    it('lists purging rows with their member for boot recovery', async () => {
        const store = memoryUserRepoStore();
        await store.select(ALICE, [web]);
        await store.select(ALICE, []);
        await store.stampPurge(ALICE, web);

        expect(await store.listPurging()).toEqual([
            expect.objectContaining({ userId: ALICE, name: 'web', status: 'purging' }),
        ]);
    });
});
