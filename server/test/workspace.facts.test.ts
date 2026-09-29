import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFactsCache } from '../src/workspace/facts.js';

/** Lets the cache's single-flight refresh promise settle: the reads are real subprocesses, so the loop must reach the timer phase, not just the microtask queue. */
const settle = async () => {
    while (cache.get(dir).sizeBytes === null) await new Promise((r) => setTimeout(r, 5));
};

/**
 * The facts cache against a real git checkout — the branch and commit reads are one `git log`, and
 * faking git here would test the fake. The suite builds one bare-fixture checkout of its own, the
 * same way workspace.reconcile.test.ts does, with every identity pinned on the command line so the
 * runner's global git config cannot leak in.
 */

let dir = '';
let cache: ReturnType<typeof createFactsCache>;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-facts-'));
    const run = (args: string[], cwd?: string) =>
        execFileSync('git', ['-c', 'user.email=t@f.io', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
            cwd,
        });
    run(['init', '-b', 'main', dir]);
    writeFileSync(join(dir, 'file.txt'), 'one\n');
    run(['add', '.'], dir);
    run(['commit', '-m', 'first'], dir);
    cache = createFactsCache();
});

afterAll(() => {
    execFileSync('rm', ['-rf', '--', dir]);
});

describe('the facts cache', () => {
    it('measures a real checkout once the refresh settles', async () => {
        const facts = cache.get(dir);
        // Cold: nothing has been measured yet, and none of it is awaited.
        expect(facts.sizeBytes).toBeNull();
        await settle();
        const measured = cache.get(dir);
        expect(measured.sizeBytes).toBeGreaterThan(0);
        expect(measured.branch).toBe('main');
        expect(measured.lastCommit?.headline).toBe('first');
    });

    it('forgets a directory it is told to invalidate', async () => {
        cache.get(dir);
        await settle();
        expect(cache.get(dir).sizeBytes).toBeGreaterThan(0);

        cache.invalidate(dir);
        const cold = cache.get(dir);
        // A deleted tree's facts must not survive it: the next get is a cold entry, so a
        // re-cloned checkout can never briefly show its predecessor's size or commit.
        expect(cold).toEqual({ branch: null, lastCommit: null, sizeBytes: null });
    });
});
