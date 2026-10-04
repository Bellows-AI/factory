import { execFile } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
    OTHER_ROOT,
    SCRIPT_IDENTITY,
    git,
    hasGit,
    setupWorktreeFixture,
    USER,
} from './fixtures/git-worktree-support.js';

/**
 * The startup sync's per-checkout lock and fetch retry (issue #307): two STARTING claims on one
 * member's repo fetch the SAME clone's refs, and git's ref transaction moves a remote-tracking
 * ref only from the value it read — so overlapping fetches lose with `cannot lock ref … is at X
 * but expected Y`, and the run went terminal `failed` before the agent ever started. The script
 * now takes an exclusive `factory-sync.lock` in the clone's git dir (on the shared workspaces
 * volume, so docker sync containers AND kubernetes sync Jobs of one checkout contend on one
 * file), retries a fetch that lost a ref lock anyway, and answers lock contention with a
 * `transient worktree sync:` verdict the loop reads as infrastructure, never as a failure.
 *
 * Same discipline as `worktree.test.ts`: real git, offline throughout, the script FILE under
 * test. The two race-shaped tests drive a `git` PATH shim that instruments (never replaces)
 * the real binary: it delegates every call and only logs fetch intervals, holds each fetch open
 * for a fixed span (forcing the overlap deterministic), and — for the retry test — removes a
 * stray ref lock after the first fetch has failed on it. Test-only tooling; nothing ships.
 */
describe.skipIf(!hasGit())('the worktree sync lock', () => {
    const fx = setupWorktreeFixture();

    const scriptPath = join(import.meta.dirname, '..', 'src', 'scripts', 'git-worktree.cjs');
    const run = promisify(execFile);

    interface Verdict {
        ok: boolean;
        reason: string | null;
    }

    const parseVerdict = (stdout: string): Verdict =>
        JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!) as Verdict;

    /** The fixture's `sync`, but async and overlay-able — concurrent syncs need real parallelism. */
    const runScriptAsync = async (env: Record<string, string>): Promise<Verdict> => {
        try {
            const { stdout } = await run('node', [scriptPath], {
                env: { ...process.env, ...SCRIPT_IDENTITY, ...env },
            });
            return parseVerdict(stdout);
        } catch (e) {
            // The script answers every failure with a JSON verdict on stdout and exit 0; a
            // non-zero here would still carry the verdict it printed before dying.
            return parseVerdict((e as { stdout?: string }).stdout ?? '');
        }
    };

    interface FetchEvent {
        pid: number;
        phase: string;
        at: number;
    }

    /**
     * Writes an executable `git` shim into the fixture's directory and answers the env overlay
     * that puts it first on PATH. Delegates every invocation to the real git (the next `git` on
     * PATH outside its own directory), logging each fetch's start/end wall-clock instants under
     * the shim process's own pid; `GIT_SHIM_FETCH_SLEEP_MS` in the overlay holds each fetch open
     * before delegating, and `GIT_SHIM_UNLOCK` names a file removed after the first FAILED
     * fetch — the stray ref lock a retry must clear.
     */
    const writeGitShim = (): { dir: string; log: string } => {
        const dir = join(fx.dir(), 'git-shim');
        const log = join(fx.dir(), 'fetch-log.jsonl');
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const shim = [
            '#!/usr/bin/env node',
            "const { spawnSync } = require('node:child_process');",
            "const fs = require('node:fs');",
            'const args = process.argv.slice(2);',
            'const isFetch = args.includes("fetch");',
            'let real = null;',
            'for (const dir of process.env.PATH.split(":")) {',
            '    if (real !== null) break;',
            '    try {',
            '        fs.accessSync(dir + "/git", fs.constants.X_OK);',
            '        if (dir !== __dirname) real = dir + "/git";',
            '    } catch {}',
            '}',
            'const log = process.env.GIT_SHIM_LOG;',
            'if (isFetch && log) fs.appendFileSync(log, JSON.stringify({ pid: process.pid, phase: "start", at: Date.now() }) + "\\n");',
            'const sleepMs = Number(process.env.GIT_SHIM_FETCH_SLEEP_MS || 0);',
            'if (isFetch && sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);',
            'const done = spawnSync(real, args, { stdio: "inherit" });',
            'if (isFetch && log) fs.appendFileSync(log, JSON.stringify({ pid: process.pid, phase: "end", at: Date.now() }) + "\\n");',
            'const unlock = process.env.GIT_SHIM_UNLOCK;',
            'if (isFetch && unlock && done.status !== 0) fs.rmSync(unlock, { force: true });',
            'process.exit(done.status === null ? 1 : done.status);',
        ].join('\n');
        const file = join(dir, 'git');
        writeFileSync(file, shim);
        chmodSync(file, 0o755);
        return { dir, log };
    };

    const readFetchEvents = (log: string): FetchEvent[] =>
        readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as FetchEvent);

    const LOCK = 'factory-sync.lock';
    const lockPath = (): string => join(fx.clone(), '.git', LOCK);

    it('serializes two concurrent syncs of one shared checkout', async () => {
        // The remote advances while both claims are starting — the production shape.
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
        const shim = writeGitShim();
        const shimEnv = {
            PATH: `${shim.dir}:${process.env.PATH}`,
            GIT_SHIM_LOG: shim.log,
            GIT_SHIM_FETCH_SLEEP_MS: '750',
        };

        const [first, second] = await Promise.all([
            runScriptAsync({ ...fx.syncEnv(), ...shimEnv }),
            runScriptAsync({ ...fx.syncEnv(OTHER_ROOT), ...shimEnv }),
        ]);

        // Both claims start from the code the remote actually has — neither loses the fetch.
        expect(first).toMatchObject({ ok: true, reason: null });
        expect(second).toMatchObject({ ok: true, reason: null });
        expect(git(fx.worktree(), 'branch', '--show-current')).toBe(fx.branch());
        expect(git(join(fx.dir(), 'bellows', USER, '.worktrees', OTHER_ROOT), 'branch', '--show-current')).toBe(
            `factory/${OTHER_ROOT}`
        );

        // And the two fetches — distinct pids — never overlapped: the lock serialized them.
        const events = readFetchEvents(shim.log);
        const pids = [...new Set(events.map((e) => e.pid))];
        expect(pids).toHaveLength(2);
        const intervals = pids.map((pid) => {
            const rows = events.filter((e) => e.pid === pid).sort((x, y) => x.at - y.at);
            expect(rows.map((r) => r.phase)).toEqual(['start', 'end']);
            return { start: rows[0]!.at, end: rows[1]!.at };
        });
        expect(Math.max(intervals[0]!.start, intervals[1]!.start)).toBeGreaterThanOrEqual(
            Math.min(intervals[0]!.end, intervals[1]!.end)
        );
    });

    it('waits out a held checkout lock and answers a transient verdict', async () => {
        // A live holder: a fresh lockfile another sync wrote moments ago is NEVER stolen.
        writeFileSync(lockPath(), 'someone else holds this\n');
        const started = Date.now();

        const result = await runScriptAsync({ ...fx.syncEnv(), SYNC_LOCK_WAIT_MS: '250' });

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/transient worktree sync/);
        expect(result.reason).toContain(LOCK);
        // It waited the bound — and left the holder's lock exactly as it found it.
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(existsSync(lockPath())).toBe(true);
    });

    it('steals a stale checkout lock and syncs anyway', async () => {
        // No holder can still be alive this long (the kubernetes sync Job dies at its deadline),
        // so an old lock is an orphan a killed sync left behind — stolen, never waited out.
        writeFileSync(lockPath(), 'a dead holder\n');
        utimesSync(lockPath(), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));

        const result = await runScriptAsync({ ...fx.syncEnv(), SYNC_LOCK_STALE_MS: '60000' });

        expect(result).toMatchObject({ ok: true, reason: null });
        expect(git(fx.worktree(), 'branch', '--show-current')).toBe(fx.branch());
        // Our own hold was released on the way out — the next sync does not wait for a ghost.
        expect(existsSync(lockPath())).toBe(false);
        // And the steal leaves no litter: the renamed file is the winner's own to unlink.
        const litter = readdirSync(join(fx.clone(), '.git')).filter((f) => f.startsWith('factory-sync.lock'));
        expect(litter).toEqual([]);
    });

    it('retries a fetch that lost a ref lock, then succeeds', async () => {
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
        // The loser's exact production state: a ref lock another fetch holds — here a stray
        // `main.lock`, whose stderr is git's real `cannot lock ref` refusal.
        const strayLock = join(fx.clone(), '.git', 'refs', 'remotes', 'origin', 'main.lock');
        mkdirSync(join(strayLock, '..'), { recursive: true });
        writeFileSync(strayLock, 'held by the concurrent fetch\n');
        const shim = writeGitShim();

        const result = await runScriptAsync({
            ...fx.syncEnv(),
            PATH: `${shim.dir}:${process.env.PATH}`,
            GIT_SHIM_LOG: shim.log,
            GIT_SHIM_UNLOCK: strayLock,
        });

        // The retry is cheap and correct — after the winner, the refs are already current.
        expect(result).toMatchObject({ ok: true, reason: null });
        expect(git(fx.worktree(), 'rev-parse', 'HEAD')).toBe(git(fx.clone(), 'rev-parse', 'origin/main'));
        const fetches = readFetchEvents(shim.log).filter((e) => e.phase === 'start');
        expect(fetches).toHaveLength(2);
        expect(existsSync(strayLock)).toBe(false);
    });
});
