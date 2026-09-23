import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCloneQueue, sweepStaging } from '../src/workspace/queue.js';
import { memoryUserRepoStore, type MemoryUserRepoStore } from './helpers.js';

/**
 * Offline: git never runs. The `run` seam that lets workspace.reconcile.test.ts assert on argv is
 * the same one that lets this suite drive the whole queue without a network or a filesystem clone.
 */

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

let root: string;
let store: MemoryUserRepoStore;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-queue-'));
    store = memoryUserRepoStore();
});

/** A queue whose `run` records what it was asked to clone and creates the staging directory. */
function queueWith(options: { fail?: (name: string) => boolean; hold?: (name: string) => Promise<void> | null } = {}) {
    const cloned: string[] = [];
    const idle: (() => void)[] = [];
    const queue = createCloneQueue({
        store,
        root,
        orgId: 'acme',
        cloneUrl: (repo) => `file:///origins/${repo.name}.git`,
        run: async (args) => {
            const dest = args[args.length - 1] as string;
            const name = dest
                .replace(/\.tmp-\d+$/, '')
                .split('/')
                .pop() as string;
            cloned.push(name);
            // Stands in for a clone that takes minutes, without taking minutes.
            const wait = options.hold?.(name);
            if (wait) await wait;
            if (options.fail?.(name)) throw new Error(`fatal: repository not found\nsecond line`);
            mkdirSync(dest, { recursive: true });
            mkdirSync(join(dest, '.git'), { recursive: true });
        },
        onIdle: () => idle.splice(0).forEach((resolve) => resolve()),
    });
    /** Resolves after the next pass finishes, so nothing here waits on a real timer. */
    const settled = () => new Promise<void>((resolve) => idle.push(resolve));
    return { queue, cloned, settled };
}

describe('the clone queue', () => {
    it('clones what a member selected, and marks each ready', async () => {
        await store.select(USER, [
            { owner: 'acme', name: 'web' },
            { owner: 'acme', name: 'api' },
        ]);
        const { queue, cloned, settled } = queueWith();

        const done = settled();
        queue.kick();
        await done;
        queue.stop();

        expect(cloned.sort()).toEqual(['api', 'web']);
        expect(store.rows().every((row) => row.status === 'ready')).toBe(true);
        expect(readdirSync(join(root, 'acme', USER)).sort()).toEqual(['api', 'web']);
    });

    it('keeps two members apart', async () => {
        await store.select(USER, [{ owner: 'acme', name: 'web' }]);
        await store.select(OTHER, [{ owner: 'acme', name: 'web' }]);
        const { queue, settled } = queueWith();

        const done = settled();
        queue.kick();
        await done;
        queue.stop();

        expect(existsSync(join(root, 'acme', USER, 'web', '.git'))).toBe(true);
        expect(existsSync(join(root, 'acme', OTHER, 'web', '.git'))).toBe(true);
    });

    it('records a failure against the row rather than stopping everyone else', async () => {
        // One member's broken repository must not stall the queue, and the page shows this sentence
        // — which is why cloneRepo throws now where the boot-time reconcile counted a failure.
        await store.select(USER, [
            { owner: 'acme', name: 'web' },
            { owner: 'acme', name: 'broken' },
        ]);
        const { queue, settled } = queueWith({ fail: (name) => name === 'broken' });

        const done = settled();
        queue.kick();
        await done;
        queue.stop();

        const rows = Object.fromEntries(store.rows().map((row) => [row.name, row.status]));
        expect(rows).toEqual({ web: 'ready', broken: 'failed' });
    });

    it('refills a freed slot without waiting for the slowest clone', async () => {
        /*
         * The pass STARTS its clones and returns; it does not await them as a batch. Awaiting the
         * batch made concurrency effectively one — a pass could not finish until its slowest clone
         * did, and passes are serialised, so a single fifteen-minute monorepo clone idled the other
         * slot and held every other member's repository behind it.
         */
        await store.select(USER, [
            { owner: 'acme', name: 'aslow' },
            { owner: 'acme', name: 'b' },
            { owner: 'acme', name: 'c' },
            { owner: 'acme', name: 'd' },
        ]);

        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { queue, cloned, settled } = queueWith({ hold: (name) => (name === 'aslow' ? held : null) });

        queue.kick();
        // Long enough for several passes to come and go while `aslow` is still running.
        const QUEUE_DRAIN_DELAY_MS = 100;
        await new Promise((r) => setTimeout(r, QUEUE_DRAIN_DELAY_MS));
        expect(cloned.filter((name) => name !== 'aslow').sort()).toEqual(['b', 'c', 'd']);

        const done = settled();
        release();
        await done;
        queue.stop();
        expect(store.rows().every((row) => row.status === 'ready')).toBe(true);
    });

    it('takes at most `concurrency` rows per pass', async () => {
        // A clone is minutes of network and unbounded disk, and a burst against one origin is the
        // shape of a request nobody thanks you for.
        await store.select(USER, [
            { owner: 'acme', name: 'a' },
            { owner: 'acme', name: 'b' },
            { owner: 'acme', name: 'c' },
        ]);
        expect(await store.claimPending(2)).toHaveLength(2);
        expect(await store.claimPending(2)).toHaveLength(1);
    });

    it('returns rows a restart stranded mid-clone, so nothing is lost forever', async () => {
        /*
         * A `cloning` row is owned by a process that no longer exists, and the claim only ever
         * takes `queued` — so without this the row stays `cloning` for good while nothing is
         * cloning it, and the page shows a spinner that never resolves.
         */
        await store.select(USER, [{ owner: 'acme', name: 'web' }]);
        store.strand(USER, { owner: 'acme', name: 'web' });

        const { queue, cloned, settled } = queueWith();
        const done = settled();
        await queue.start();
        await done;
        queue.stop();

        expect(cloned).toEqual(['web']);
        expect(store.rows()[0]?.status).toBe('ready');
    });

    it('does not re-clone a repo that is already ready', async () => {
        // Re-selecting something already on disk must not throw away a checkout that may hold an
        // agent's uncommitted work.
        await store.select(USER, [{ owner: 'acme', name: 'web' }]);
        await store.markReady(USER, { owner: 'acme', name: 'web' });
        await store.select(USER, [{ owner: 'acme', name: 'web' }]);

        const { queue, cloned, settled } = queueWith();
        const done = settled();
        queue.kick();
        await done;
        queue.stop();

        expect(cloned).toEqual([]);
    });
});

describe('the staging sweep', () => {
    it('removes partial trees a killed clone left behind', async () => {
        // The rename into place is atomic, so a `.tmp-` directory is never a finished clone and is
        // never anything anybody wants. Without the sweep each one leaks a checkout's worth of disk.
        mkdirSync(join(root, 'acme', USER, 'web.tmp-1234'), { recursive: true });
        mkdirSync(join(root, 'acme', USER, 'api', '.git'), { recursive: true });

        expect(sweepStaging(root, 'acme', () => {})).toBe(1);
        expect(readdirSync(join(root, 'acme', USER))).toEqual(['api']);
    });

    it('is a no-op when nothing has been provisioned yet', () => {
        expect(sweepStaging(join(root, 'nope'), 'acme', () => {})).toBe(0);
    });
});
