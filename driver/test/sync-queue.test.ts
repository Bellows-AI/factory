import { describe, expect, it } from 'vitest';
import { syncQueue } from '../src/sync-queue.js';

/** A promise and the hand that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
    let done = false;
    void promise.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return done;
};

describe('the per-clone startup sync queue (issue #559)', () => {
    it('turns the syncs of one clone one at a time, in arrival order', async () => {
        const queue = syncQueue();
        const first = queue.enter('/w/a');
        const second = queue.enter('/w/a');
        const third = queue.enter('/w/a');

        expect(await settled(first.ready)).toBe(true);
        expect(await settled(second.ready)).toBe(false);

        const sync = deferred();
        first.release(sync.promise);
        expect(await settled(second.ready)).toBe(false);
        sync.resolve();
        expect(await settled(second.ready)).toBe(true);
        expect(await settled(third.ready)).toBe(false);

        second.release(Promise.reject(new Error('the sync threw')));
        expect(await settled(third.ready)).toBe(true);
    });

    it('lets syncs of different clones, and syncs with no clone, run side by side', async () => {
        const queue = syncQueue();
        queue.enter('/w/a');

        expect(await settled(queue.enter('/w/b').ready)).toBe(true);
        expect(await settled(queue.enter(null).ready)).toBe(true);
        expect(await settled(queue.enter(null).ready)).toBe(true);
    });

    it('frees a waiter that gave up without holding back the one behind it', async () => {
        const queue = syncQueue();
        const holder = queue.enter('/w/a');
        const quitter = queue.enter('/w/a');
        const next = queue.enter('/w/a');

        quitter.release();
        expect(await settled(next.ready)).toBe(false);
        holder.release(Promise.resolve());
        expect(await settled(next.ready)).toBe(true);
    });

    it('keeps an abandoned holder’s place until its sync actually lands', async () => {
        const queue = syncQueue();
        const holder = queue.enter('/w/a');
        const sync = deferred();
        holder.release(sync.promise);
        const next = queue.enter('/w/a');

        expect(await settled(next.ready)).toBe(false);
        sync.resolve();
        expect(await settled(next.ready)).toBe(true);
    });
});
