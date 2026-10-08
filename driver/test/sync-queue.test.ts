import { describe, expect, it } from 'vitest';
import { type SyncTurn, syncQueue } from '../src/sync-queue.js';

/** A promise and the hand that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

/** What a pending acquire has answered so far: undefined while it still waits. */
function watch(acquiring: Promise<SyncTurn | null>): { answer: () => SyncTurn | null | undefined } {
    let answer: SyncTurn | null | undefined;
    void acquiring.then((turn) => (answer = turn));
    return { answer: () => answer };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const HOLDER = { jobId: 'job-1', leaseToken: 'lease-1' };
const LONG = { signal: new AbortController().signal, waitMs: 60_000, holder: HOLDER };

describe('the per-clone startup sync queue (issue #559)', () => {
    it('turns the syncs of one clone one at a time, in arrival order', async () => {
        const queue = syncQueue();
        const first = watch(queue.acquire('/w/a', LONG));
        const second = watch(queue.acquire('/w/a', LONG));
        const third = watch(queue.acquire('/w/a', LONG));
        await tick();
        expect(first.answer()).toBeTruthy();
        expect(second.answer()).toBeUndefined();

        const sync = deferred();
        first.answer()!.release(sync.promise);
        await tick();
        expect(second.answer()).toBeUndefined();
        sync.resolve();
        await tick();
        expect(second.answer()).toBeTruthy();
        expect(third.answer()).toBeUndefined();

        second.answer()!.release(Promise.reject(new Error('the sync threw')));
        await tick();
        expect(third.answer()).toBeTruthy();
    });

    it('lets syncs of different clones run side by side', async () => {
        const queue = syncQueue();
        await queue.acquire('/w/a', LONG);

        expect(await queue.acquire('/w/b', LONG)).toBeTruthy();
    });

    it('answers null to a waiter whose signal aborts, freeing its place for the one behind it', async () => {
        const queue = syncQueue();
        const holder = await queue.acquire('/w/a', LONG);
        const stop = new AbortController();
        const quitter = watch(queue.acquire('/w/a', { signal: stop.signal, waitMs: 60_000, holder: HOLDER }));
        const next = watch(queue.acquire('/w/a', LONG));

        stop.abort();
        await tick();
        expect(quitter.answer()).toBeNull();
        expect(next.answer()).toBeUndefined();
        holder!.release();
        await tick();
        expect(next.answer()).toBeTruthy();
    });

    it('answers null at once to a waiter already stood down, holding nothing', async () => {
        const queue = syncQueue();
        const stop = new AbortController();
        stop.abort();

        expect(await queue.acquire('/w/a', { signal: stop.signal, waitMs: 60_000, holder: HOLDER })).toBeNull();
        expect(await queue.acquire('/w/a', LONG)).toBeTruthy();
    });

    it('answers null once the wait bound runs out behind a holder that never lands, and frees the place', async () => {
        const queue = syncQueue();
        const holder = await queue.acquire('/w/a', LONG);
        holder!.release(new Promise(() => {}));
        const impatient = watch(queue.acquire('/w/a', { ...LONG, waitMs: 5 }));
        const next = watch(queue.acquire('/w/a', LONG));

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(impatient.answer()).toBeNull();
        // Still behind the wedged holder, but no longer behind the waiter that gave up.
        expect(next.answer()).toBeUndefined();
    });

    it('keeps an abandoned holder’s place until its sync actually lands', async () => {
        const queue = syncQueue();
        const holder = await queue.acquire('/w/a', LONG);
        const sync = deferred();
        holder!.release(sync.promise);
        const next = watch(queue.acquire('/w/a', LONG));

        await tick();
        expect(next.answer()).toBeUndefined();
        sync.resolve();
        await tick();
        expect(next.answer()).toBeTruthy();
    });
});
