import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

    it('is a no-op when there is nothing at the path', () => {
        expect(remove(wtPath(ROOT)).verdict).toEqual({ ok: true, removed: false });
    });
});
