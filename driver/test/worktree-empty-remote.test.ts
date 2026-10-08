import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GIT_FIXTURE_CONFIG, ROOT, USER, git, hasGit, runScript } from './fixtures/git-worktree-support.js';

/*
 * Issue 543: an objective-mode task may scaffold a project from nothing, so the startup sync must
 * work against a remote with NO commits — no origin/<default> to branch from or rebase onto. The
 * worktree starts on an unborn task branch over an empty tree; the same script serves the docker
 * sync container and the kubernetes sync Job, and none of `.bellows.yaml`, `AGENTS.md` or a skill
 * file is required to exist.
 */
describe.skipIf(!hasGit())('the worktree sync against a remote with no commits', () => {
    let dir: string;
    let clone: string;
    let worktree: string;
    let bare: string;
    const branch = `factory/${ROOT}`;

    const sync = () => runScript({ REPO: clone, WORKTREE: worktree, BRANCH: branch });
    const hasHead = (cwd: string): boolean => {
        try {
            git(cwd, 'rev-parse', '--verify', '--quiet', 'HEAD');
            return true;
        } catch {
            return false;
        }
    };

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-worktree-empty-')));
        clone = join(dir, 'bellows', USER, 'scaffold');
        worktree = join(dir, 'bellows', USER, '.worktrees', ROOT);
        bare = join(dir, 'scaffold.git');
        mkdirSync(join(dir, 'bellows', USER), { recursive: true });
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'init', '--bare', bare], { stdio: 'ignore' });
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${bare}`, clone], { stdio: 'ignore' });
    });

    it('creates the worktree on the task branch with no commit and no required files', () => {
        expect(sync()).toMatchObject({ ok: true, reason: null });

        expect(git(worktree, 'branch', '--show-current')).toBe(branch);
        expect(hasHead(worktree)).toBe(false);
        expect(git(worktree, 'status', '--porcelain')).toBe('');
        for (const required of ['.bellows.yaml', 'AGENTS.md', 'SKILL.md']) {
            expect(existsSync(join(worktree, required)), required).toBe(false);
        }
    });

    it('syncs again onto the existing worktree without touching it', () => {
        expect(sync()).toMatchObject({ ok: true, reason: null });
        writeFileSync(join(worktree, 'scaffold.txt'), 'in progress\n');

        expect(sync()).toMatchObject({ ok: true, reason: null });

        expect(git(worktree, 'branch', '--show-current')).toBe(branch);
        expect(git(worktree, 'status', '--porcelain')).toBe('?? scaffold.txt');
    });

    it('keeps the task branch and its commit across a later sync', () => {
        expect(sync()).toMatchObject({ ok: true, reason: null });
        writeFileSync(join(worktree, 'scaffold.txt'), 'first file\n');
        git(worktree, 'add', 'scaffold.txt');
        git(worktree, 'commit', '-m', 'scaffold');
        const tip = git(worktree, 'rev-parse', 'HEAD');

        expect(sync()).toMatchObject({ ok: true, reason: null });

        expect(git(worktree, 'branch', '--show-current')).toBe(branch);
        expect(git(worktree, 'rev-parse', 'HEAD')).toBe(tip);
    });

    it('recreates a lost worktree from the surviving task branch', () => {
        expect(sync()).toMatchObject({ ok: true, reason: null });
        writeFileSync(join(worktree, 'scaffold.txt'), 'first file\n');
        git(worktree, 'add', 'scaffold.txt');
        git(worktree, 'commit', '-m', 'scaffold');
        const tip = git(worktree, 'rev-parse', 'HEAD');
        git(clone, 'worktree', 'remove', '--force', worktree);

        expect(sync()).toMatchObject({ ok: true, reason: null });

        expect(git(worktree, 'rev-parse', 'HEAD')).toBe(tip);
    });
});
