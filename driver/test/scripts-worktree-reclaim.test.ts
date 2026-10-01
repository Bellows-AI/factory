import { execFileSync } from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasGit, pathOf } from './fixtures/scripts-support.js';

/**
 * The terminal reclaim script, against real git — the artifact the reclaim container runs once a
 * thread is finished (issue #47). Both runners parse only the LAST stdout line, so the script's
 * stated contract of one JSON verdict is load-bearing: the refusal case here pins that a refusal
 * is terminal — exactly one line, and no trailing prune or success verdict that would shadow it
 * as a successful no-op.
 */
describe.skipIf(!hasGit())('the worktree reclaim script', () => {
    const GIT_FIXTURE_CONFIG = [
        '-c',
        'user.email=test@example.com',
        '-c',
        'user.name=Test',
        '-c',
        'init.defaultBranch=main',
    ];
    const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', [...GIT_FIXTURE_CONFIG, ...args], { cwd, encoding: 'utf8' }).trim();

    const ROOT = '55555555-5555-4555-8555-555555555555';
    const STALE = '66666666-6666-4666-8666-666666666666';
    const UNREGISTERED = '77777777-7777-4777-8777-777777777777';

    let dir: string;
    let clone: string;

    const wtPath = (name: string): string => join(dir, 'worktrees', name);

    const remove = (wt: string): { stdout: string; verdict: { ok: boolean; removed?: boolean; reason?: string } } => {
        // The script FILE itself, not a -e wrap: the artifact the reclaim container runs is what
        // is under test.
        const stdout = execFileSync('node', [pathOf('git-worktree-remove.cjs')], {
            env: { ...process.env, REPO: clone, WORKTREE: wt },
            encoding: 'utf8',
        });
        return { stdout, verdict: JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!) };
    };

    /** A registered worktree of the clone, at a path beside it — the sync's own shape. */
    const addWorktree = (name: string): string => {
        const wt = wtPath(name);
        git(clone, 'worktree', 'add', '-b', `factory/${name}`, wt);
        return wt;
    };

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-reclaim-')));
        const work = join(dir, 'origin-work');
        mkdirSync(work, { recursive: true });
        git(work, 'init');
        writeFileSync(join(work, 'README.md'), '# factory\n');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, '-C', work, 'add', 'README.md'], { stdio: 'ignore' });
        execFileSync('git', [...GIT_FIXTURE_CONFIG, '-C', work, 'commit', '-m', 'init'], { stdio: 'ignore' });
        const bare = join(dir, 'factory.git');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
        clone = join(dir, 'clone');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${bare}`, clone], { stdio: 'ignore' });
    });

    it('removes a registered worktree whose directory is there', () => {
        const wt = addWorktree(ROOT);
        expect(remove(wt).verdict).toEqual({ ok: true, removed: true });
        expect(existsSync(wt)).toBe(false);
        expect(git(clone, 'worktree', 'list', '--porcelain')).not.toContain(wt);
    });

    // The removal is a parallel walk under a semaphore (issue: an EFS reclaim of a ~143k-file
    // checkout took ~8 minutes serially and then died ENOTEMPTY). Nesting and breadth are what
    // the walk has to survive — a node_modules is both — and the fan-out must not outrun the
    // semaphore and exhaust file descriptors.
    it('removes a deep, wide tree in one pass', () => {
        const wt = addWorktree(ROOT);
        let deep = wt;
        for (let level = 0; level < 12; level++) {
            deep = join(deep, `level-${level}`);
            mkdirSync(deep, { recursive: true });
            for (let file = 0; file < 40; file++) writeFileSync(join(deep, `f-${file}.js`), 'x');
        }
        // An empty directory at the bottom: rmdir has to retire it even with nothing to unlink.
        mkdirSync(join(deep, 'empty'), { recursive: true });

        expect(remove(wt).verdict).toEqual({ ok: true, removed: true });
        expect(existsSync(wt)).toBe(false);
        expect(git(clone, 'worktree', 'list', '--porcelain')).not.toContain(wt);
    });

    // The walk removes entries, it does not follow them. A symlink to a directory reports
    // isDirectory() false and is unlinked as the one entry it is; recursing through it would
    // delete whatever it aims at, which is the whole repository when a checkout happens to carry
    // a link to its own root.
    it('unlinks symlinks without deleting what they point at', () => {
        const wt = addWorktree(ROOT);
        const outside = join(dir, 'outside');
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, 'keep.txt'), 'keep me');
        symlinkSync(outside, join(wt, 'link-to-dir'));
        symlinkSync(join(outside, 'keep.txt'), join(wt, 'link-to-file'));
        symlinkSync(join(dir, 'does-not-exist'), join(wt, 'dangling'));

        expect(remove(wt).verdict).toEqual({ ok: true, removed: true });
        expect(existsSync(wt)).toBe(false);
        // The targets survive: only the links inside the tree were entries of the tree.
        expect(existsSync(outside)).toBe(true);
        expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep me');
    });

    it('prunes a registered worktree whose directory is already gone', () => {
        const wt = addWorktree(ROOT);
        rmSync(wt, { recursive: true });
        expect(remove(wt).verdict).toEqual({ ok: true, removed: false });
        expect(git(clone, 'worktree', 'list', '--porcelain')).not.toContain(wt);
    });

    it('refuses an unregistered git tree with exactly one verdict, pruning nothing', () => {
        // A stale registered entry beside the refused tree: the trailing prune that used to run
        // after the refusal would have cleared it, so its survival proves nothing ran.
        const stale = addWorktree(STALE);
        rmSync(stale, { recursive: true });
        const refused = wtPath(UNREGISTERED);
        mkdirSync(refused, { recursive: true });
        writeFileSync(join(refused, '.git'), 'gitdir: /somewhere/else\n');
        writeFileSync(join(refused, 'PRECIOUS.md'), 'uncommitted work\n');

        const { stdout, verdict } = remove(refused);

        // One line, and it is the refusal: a second verdict would make the runner — which reads
        // only the last line — report this as a successful no-op.
        expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(1);
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toContain('not a registered worktree');

        // The refused tree is untouched...
        expect(readFileSync(join(refused, 'PRECIOUS.md'), 'utf8')).toBe('uncommitted work\n');
        // ...and so is the stale admin entry beside it.
        expect(git(clone, 'worktree', 'list', '--porcelain')).toContain(`worktree ${stale}`);
    });

    it('removes a bare leftover with no .git at the path', () => {
        const wt = wtPath(UNREGISTERED);
        mkdirSync(wt, { recursive: true });
        writeFileSync(join(wt, 'leftover.txt'), 'not a worktree');
        expect(remove(wt).verdict).toEqual({ ok: true, removed: true });
        expect(existsSync(wt)).toBe(false);
    });

    it('refuses an unregistered tree whose .git is a dangling symlink', () => {
        // existsSync reads a dangling symlink as "no .git at all", which would send the tree
        // down the bare-leftover branch and rmSync a directory holding uncommitted files.
        // A .git entry that exists on lstat is a git tree either way — refused, not deleted.
        const stale = addWorktree(STALE);
        rmSync(stale, { recursive: true });
        const refused = wtPath(UNREGISTERED);
        mkdirSync(refused, { recursive: true });
        symlinkSync('/nonexistent/factory-admin', join(refused, '.git'));
        writeFileSync(join(refused, 'PRECIOUS.md'), 'uncommitted work\n');

        const { stdout, verdict } = remove(refused);

        expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(1);
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toContain('not a registered worktree');
        expect(readFileSync(join(refused, 'PRECIOUS.md'), 'utf8')).toBe('uncommitted work\n');
        expect(lstatSync(join(refused, '.git')).isSymbolicLink()).toBe(true);
        expect(git(clone, 'worktree', 'list', '--porcelain')).toContain(`worktree ${stale}`);
    });

    it('is a no-op when there is nothing at the path', () => {
        expect(remove(wtPath(ROOT)).verdict).toEqual({ ok: true, removed: false });
    });

    // The purge (issue #92) may delete the parent clone while a finished task's worktree is
    // queued for reclaim. The reclaim must not fail forever on it — and must not grow bolder
    // than it was: only a tree it can PROVE was this clone's registered worktree goes.
    describe('when the parent clone is gone', () => {
        it('removes a worktree whose own .git proves it was this clone\u2019s', () => {
            const wt = addWorktree(ROOT);
            rmSync(clone, { recursive: true, force: true });

            const { verdict } = remove(wt);

            expect(verdict).toEqual({ ok: true, removed: true });
            expect(existsSync(wt)).toBe(false);
        });

        it('still refuses an unrelated git tree, with exactly one verdict', () => {
            const refused = wtPath(UNREGISTERED);
            mkdirSync(refused, { recursive: true });
            writeFileSync(join(refused, '.git'), 'gitdir: /somewhere/else\n');
            writeFileSync(join(refused, 'PRECIOUS.md'), 'uncommitted work\n');
            rmSync(clone, { recursive: true, force: true });

            const { stdout, verdict } = remove(refused);

            expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(1);
            expect(verdict.ok).toBe(false);
            expect(verdict.reason).toContain('not a registered worktree');
            expect(readFileSync(join(refused, 'PRECIOUS.md'), 'utf8')).toBe('uncommitted work\n');
        });

        it('refuses a standalone repo parked at the path — its .git is a directory, and the verdict is honest', () => {
            // A .git directory (not the pointer file a task worktree carries) is somebody's git
            // tree; the clone being gone must turn this into the deliberate refusal, not a
            // generic read-error verdict, and never a removal.
            const refused = wtPath(UNREGISTERED);
            mkdirSync(join(refused, '.git'), { recursive: true });
            writeFileSync(join(refused, 'PRECIOUS.md'), 'uncommitted work\n');
            rmSync(clone, { recursive: true, force: true });

            const { stdout, verdict } = remove(refused);

            expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(1);
            expect(verdict.ok).toBe(false);
            expect(verdict.reason).toContain('not a registered worktree');
            expect(existsSync(refused)).toBe(true);
        });

        it('removes a bare leftover with no .git at the path', () => {
            const wt = wtPath(UNREGISTERED);
            mkdirSync(wt, { recursive: true });
            writeFileSync(join(wt, 'leftover.txt'), 'not a worktree');
            rmSync(clone, { recursive: true, force: true });

            expect(remove(wt).verdict).toEqual({ ok: true, removed: true });
            expect(existsSync(wt)).toBe(false);
        });

        it('refuses a tree whose .git is a dangling symlink, with no clone to prove it against', () => {
            // The purge scenario of the review: with the clone gone, a dangling .git symlink
            // reads as "no .git" and the bare-leftover branch would delete the tree and every
            // uncommitted file in it. The entry exists on lstat, so the verdict is the refusal.
            const refused = wtPath(UNREGISTERED);
            mkdirSync(refused, { recursive: true });
            symlinkSync('/nonexistent/factory-admin', join(refused, '.git'));
            writeFileSync(join(refused, 'PRECIOUS.md'), 'uncommitted work\n');
            rmSync(clone, { recursive: true, force: true });

            const { stdout, verdict } = remove(refused);

            expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(1);
            expect(verdict.ok).toBe(false);
            expect(verdict.reason).toContain('not a registered worktree');
            expect(readFileSync(join(refused, 'PRECIOUS.md'), 'utf8')).toBe('uncommitted work\n');
            expect(lstatSync(join(refused, '.git')).isSymbolicLink()).toBe(true);
        });

        it('is a no-op when neither the clone nor the worktree is there', () => {
            rmSync(clone, { recursive: true, force: true });
            expect(remove(wtPath(ROOT)).verdict).toEqual({ ok: true, removed: false });
        });
    });
});
