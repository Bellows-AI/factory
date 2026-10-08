import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasGit, pathOf } from './fixtures/scripts-support.js';

/**
 * The review snapshot script, against real git — the artifact the snapshot container runs when an
 * agent asks for a reviewer (issue #549). What it must never do is move anything the agent has:
 * HEAD, the branch, the real index and the working files stay exactly as they were; only a ref is
 * written, once.
 */
describe.skipIf(!hasGit())('the review snapshot script', () => {
    const GIT_FIXTURE_CONFIG = ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'init.defaultBranch=main'];
    const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', [...GIT_FIXTURE_CONFIG, ...args], { cwd, encoding: 'utf8' }).trim();
    const REF = 'refs/factory/review/22222222-2222-4222-8222-222222222222/security-1';

    let wt: string;

    const snapshot = (ref = REF): { ok: boolean; ref?: string; existed?: boolean; reason?: string } => {
        const stdout = execFileSync('node', [pathOf('git-review-snapshot.cjs')], {
            env: { ...process.env, REPO: wt, REVIEW_REF: ref },
            encoding: 'utf8',
        });
        return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!);
    };

    beforeEach(() => {
        wt = realpathSync(mkdtempSync(join(tmpdir(), 'factory-review-snapshot-')));
        git(wt, 'init');
        writeFileSync(join(wt, 'a.txt'), 'committed\n');
        git(wt, 'add', 'a.txt');
        git(wt, 'commit', '-m', 'init');
    });

    it('freezes the committed, modified and untracked state as one commit under the ref', () => {
        writeFileSync(join(wt, 'a.txt'), 'edited after the commit\n');
        writeFileSync(join(wt, 'new.txt'), 'never added\n');
        const verdict = snapshot();
        expect(verdict).toEqual({ ok: true, ref: REF, existed: false });
        expect(git(wt, 'show', `${REF}:a.txt`)).toBe('edited after the commit');
        expect(git(wt, 'show', `${REF}:new.txt`)).toBe('never added');
        expect(git(wt, 'rev-parse', `${REF}^`)).toBe(git(wt, 'rev-parse', 'HEAD'));
    });

    it('moves nothing the agent has: HEAD, branch, index and working files are untouched', () => {
        writeFileSync(join(wt, 'a.txt'), 'edited\n');
        writeFileSync(join(wt, 'new.txt'), 'untracked\n');
        const before = {
            head: git(wt, 'rev-parse', 'HEAD'),
            branch: git(wt, 'branch', '--show-current'),
            status: git(wt, 'status', '--porcelain'),
            cached: git(wt, 'diff', '--cached', '--name-only'),
        };
        snapshot();
        expect({
            head: git(wt, 'rev-parse', 'HEAD'),
            branch: git(wt, 'branch', '--show-current'),
            status: git(wt, 'status', '--porcelain'),
            cached: git(wt, 'diff', '--cached', '--name-only'),
        }).toEqual(before);
        expect(before.cached).toBe('');
    });

    it('leaves the .factory state namespace out', () => {
        mkdirSync(join(wt, '.factory'));
        writeFileSync(join(wt, '.factory', 'state.json'), '{}');
        snapshot();
        expect(git(wt, 'ls-tree', '-r', '--name-only', REF).split('\n')).toEqual(['a.txt']);
    });

    it('finds its own snapshot again over the same tree — a retried or reclaimed request', () => {
        writeFileSync(join(wt, 'a.txt'), 'first\n');
        snapshot();
        const first = git(wt, 'rev-parse', REF);
        expect(snapshot()).toEqual({ ok: true, ref: REF, existed: true });
        expect(git(wt, 'rev-parse', REF)).toBe(first);
    });

    it('refuses to bind a key to a different tree, and never overwrites the snapshot it has', () => {
        writeFileSync(join(wt, 'a.txt'), 'first\n');
        snapshot();
        const first = git(wt, 'rev-parse', REF);
        writeFileSync(join(wt, 'a.txt'), 'second\n');
        const verdict = snapshot();
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toMatch(/already names a different tree/);
        expect(git(wt, 'rev-parse', REF)).toBe(first);
        expect(git(wt, 'show', `${REF}:a.txt`)).toBe('first');
    });

    it('does not adopt a ref the agent planted over a tree it never reviewed', () => {
        // The ref store is shared with the agent: a commit made from a benign tree, planted
        // under the key, must not stand in for the work actually in the worktree.
        const benign = git(wt, 'rev-parse', 'HEAD');
        git(wt, 'update-ref', REF, benign);
        writeFileSync(join(wt, 'a.txt'), 'the real, unreviewed work\n');
        const verdict = snapshot();
        expect(verdict.ok).toBe(false);
        expect(git(wt, 'rev-parse', REF)).toBe(benign);
    });

    it('snapshots a repository with no commits yet', () => {
        const empty = realpathSync(mkdtempSync(join(tmpdir(), 'factory-review-empty-')));
        git(empty, 'init');
        writeFileSync(join(empty, 'only.txt'), 'x\n');
        const stdout = execFileSync('node', [pathOf('git-review-snapshot.cjs')], {
            env: { ...process.env, REPO: empty, REVIEW_REF: REF },
            encoding: 'utf8',
        });
        expect(JSON.parse(stdout.trim()).ok).toBe(true);
        expect(git(empty, 'show', `${REF}:only.txt`)).toBe('x');
    });

    it('answers a named failure, never a crash, for a path that is not a repository', () => {
        const stdout = execFileSync('node', [pathOf('git-review-snapshot.cjs')], {
            env: { ...process.env, REPO: tmpdir(), REVIEW_REF: REF },
            encoding: 'utf8',
        });
        const verdict = JSON.parse(stdout.trim());
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toMatch(/^the review snapshot failed/);
    });
});
