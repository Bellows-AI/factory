import { execFileSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFactsCache } from '../src/workspace/facts.js';
import { PURGE_TIMEOUT_MS, removeTree, createPurger } from '../src/workspace/purge.js';
import { memoryUserRepoStore } from './helpers-user-repo-store.js';

/**
 * The purger against real directories, with the removal child itself real on the happy path and
 * faked everywhere a fault must be injected (a hung child, a failing one). The facts cache is the
 * real one — invalidation is part of what a purge owes the next clone.
 */

const ALICE = '00000000-0000-4000-8000-00000000a11c';
const ORG = 'org';
const web = { owner: 'acme', name: 'web' };

let root: string;
let userDir: string;
let checkout: string;

const tick = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-purge-'));
    userDir = join(root, ORG, ALICE);
    checkout = join(userDir, 'web');
});

afterAll(() => {
    execFileSync('rm', ['-rf', '--', root]);
});

async function seedDeselected(store: ReturnType<typeof memoryUserRepoStore>) {
    await store.select(ALICE, [web]);
    await store.select(ALICE, []);
}

function makeCheckout() {
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'file.txt'), 'work\n');
}

describe('removeTree', () => {
    it('removes a real directory', async () => {
        makeCheckout();
        await removeTree(checkout);
        expect(existsSync(checkout)).toBe(false);
    });

    it('kills and reaps a child that outlives the timeout, then refuses', async () => {
        makeCheckout();
        const signals: string[] = [];
        // A child that ignores every kill until SIGKILL — the shape the issue calls out: the
        // timeout must terminate AND reap before the failure is reported.
        const fake = ((_command: string, _args: string | readonly string[], _options?: SpawnOptions) => {
            const child = new EventEmitter() as EventEmitter & Pick<ChildProcess, 'kill' | 'pid'>;
            child.pid = process.pid;
            child.kill = (signal?: NodeJS.Signals) => {
                signals.push(String(signal));
                if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
                return true;
            };
            return child as unknown as ChildProcess;
        }) as unknown as typeof spawn;

        await expect(removeTree(checkout, 10, fake)).rejects.toThrow(/timed out/);
        expect(signals).toEqual(['SIGKILL']);
        // The directory survives — the failure must be honest about what is still on disk.
        expect(existsSync(checkout)).toBe(true);
    });

    it('reports a non-zero exit with the child\u2019s own words', async () => {
        const fake = ((_command: string, _args: string | readonly string[], _options?: SpawnOptions) => {
            const child = new EventEmitter() as EventEmitter &
                Pick<ChildProcess, 'kill' | 'pid'> & {
                    stderr: EventEmitter | null;
                };
            child.pid = process.pid;
            child.stderr = new EventEmitter();
            child.kill = () => false;
            queueMicrotask(() => {
                child.stderr?.emit('data', Buffer.from('rm: permission denied'));
                child.emit('exit', 1, null);
            });
            return child as unknown as ChildProcess;
        }) as unknown as typeof spawn;

        await expect(removeTree(join(root, 'nowhere'), 1000, fake)).rejects.toThrow(/permission denied/);
    });

    it('bounds the removal by default', () => {
        // Not a behavior test — a pin, so nobody lowers the bound silently.
        expect(PURGE_TIMEOUT_MS).toBeGreaterThan(30_000);
    });
});

describe('the purger', () => {
    it('stamps, removes a real checkout, then deletes the row and invalidates the facts', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const facts = createFactsCache();
        facts.get(checkout); // warm the cache with the doomed tree
        const purger = createPurger({ store, root, orgId: ORG, facts });

        const outcome = await purger.purge(ALICE, web);
        expect(outcome).toEqual({ result: 'started' });

        await purger.settle();
        expect(existsSync(checkout)).toBe(false);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
        // The predecessor's facts must not survive its tree.
        expect(facts.get(checkout)).toEqual({ branch: null, lastCommit: null, sizeBytes: null });
    });

    it('cleans a stale row whose directory is already gone, spawning no child', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        let removals = 0;
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: async () => {
                removals += 1;
            },
        });

        const outcome = await purger.purge(ALICE, web);
        expect(outcome).toEqual({ result: 'cleaned' });
        expect(removals).toBe(0);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('propagates every store refusal untouched', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        const purger = createPurger({ store, root, orgId: ORG, facts: createFactsCache() });

        // A selected row is refused regardless of its clone status.
        await store.select(ALICE, [web]);
        expect(await purger.purge(ALICE, web)).toEqual({ refused: 'selected' });

        // A row still owned by a clone — deselected mid-clone, which is how it became an orphan.
        await store.claimPending(1);
        await store.select(ALICE, []);
        expect(await purger.purge(ALICE, web)).toEqual({ refused: 'cloning' });

        // A duplicate request while a stamp is held.
        const stuck = memoryUserRepoStore();
        await seedDeselected(stuck);
        let release!: () => void;
        const gated = new Promise<void>((resolve) => {
            release = resolve;
        });
        const stuckPurger = createPurger({
            store: stuck,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: () => gated,
        });
        makeCheckout();
        expect(await stuckPurger.purge(ALICE, web)).toEqual({ result: 'started' });
        expect(await stuckPurger.purge(ALICE, web)).toEqual({ refused: 'purging' });
        release();
        await stuckPurger.settle();

        // Unfinished tasks, with the count.
        const blocked = memoryUserRepoStore({ blockingTasks: () => 3 });
        await seedDeselected(blocked);
        const blockedPurger = createPurger({ store: blocked, root, orgId: ORG, facts: createFactsCache() });
        expect(await blockedPurger.purge(ALICE, web)).toEqual({ refused: 'tasks', count: 3 });

        // A row that is not there.
        expect(await purger.purge(ALICE, { owner: 'acme', name: 'nope' })).toBe('missing');
    });

    it('marks the row failed with the reason and keeps the directory when the removal fails', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: async () => {
                throw new Error('rm: permission denied');
            },
        });

        const outcome = await purger.purge(ALICE, web);
        expect(outcome).toEqual({ result: 'started' });
        await purger.settle();

        const [row] = await store.orphaned(ALICE);
        expect(row.status).toBe('failed');
        expect(row.error).toBe('rm: permission denied');
        // The row outlives the partial directory — visible and retryable.
        expect(existsSync(checkout)).toBe(true);
    });

    it('survives failing to RECORD the failure — the detached chain never rejects', async () => {
        // The finisher runs detached after the 202. A database that is down fails the removal
        // recording AND the failure recording; letting either rejection escape the chain would
        // be an unhandled rejection, and Node's default for one of those is to kill the process.
        // The row stays `purging`, which boot recovery finishes.
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        const failing: typeof store = {
            ...store,
            deletePurged: async () => {
                throw new Error('database is down');
            },
            markPurgeFailed: async () => {
                throw new Error('database is down');
            },
        };
        const purger = createPurger({
            store: failing,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: async () => {},
        });

        expect(await purger.purge(ALICE, web)).toEqual({ result: 'started' });
        // settle() must resolve, and this whole suite must not die of an unhandled rejection.
        await purger.settle();

        expect((await store.orphaned(ALICE))[0]?.status).toBe('purging');
    });

    it('holds the stamp until the removal child is observed to exit', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        let release!: () => void;
        const gated = new Promise<void>((resolve) => {
            release = resolve;
        });
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: () => gated,
        });

        const outcome = await purger.purge(ALICE, web);
        expect(outcome).toEqual({ result: 'started' });
        await tick();

        // Deletion still running: the row is stamped, not deleted, and the tree is still there.
        expect((await store.orphaned(ALICE))[0]?.status).toBe('purging');
        expect(existsSync(checkout)).toBe(true);

        release();
        await purger.settle();
        // The row is deleted only once the (seamed) removal resolved — the real-directory case
        // is the test above; this one pins the ORDER, not the unlink.
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('finishes an interrupted purge at recovery: residue removed, row deleted', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        await store.stampPurge(ALICE, web); // a crash left the stamp held

        const purger = createPurger({ store, root, orgId: ORG, facts: createFactsCache() });
        await purger.recoverInterrupted();

        expect(existsSync(checkout)).toBe(false);
        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('finishes an interrupted purge whose directory is already gone', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        await store.stampPurge(ALICE, web);

        const purger = createPurger({ store, root, orgId: ORG, facts: createFactsCache() });
        await purger.recoverInterrupted();

        expect(await store.orphaned(ALICE)).toHaveLength(0);
    });

    it('marks recovery failures failed with the reason', async () => {
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        await store.stampPurge(ALICE, web);
        const purger = createPurger({
            store,
            root,
            orgId: ORG,
            facts: createFactsCache(),
            remove: async () => {
                throw new Error('rm: device busy');
            },
        });

        await purger.recoverInterrupted();

        const [row] = await store.orphaned(ALICE);
        expect(row.status).toBe('failed');
        expect(row.error).toBe('rm: device busy');
    });

    it('never plans to touch the sibling .worktrees directory', async () => {
        // The driver's worktrees live beside the checkouts; a purge removes one checkout only.
        const store = memoryUserRepoStore();
        await seedDeselected(store);
        makeCheckout();
        mkdirSync(join(userDir, '.worktrees', 'some-job'), { recursive: true });
        writeFileSync(join(userDir, '.worktrees', 'some-job', 't.txt'), 'driver\n');

        const purger = createPurger({ store, root, orgId: ORG, facts: createFactsCache() });
        await purger.purge(ALICE, web);
        await purger.settle();

        expect(existsSync(join(userDir, '.worktrees', 'some-job', 't.txt'))).toBe(true);
    });
});
