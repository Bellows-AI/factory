import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    git,
    hasGit,
    OTHER_ROOT,
    runScript,
    setupWorktreeFixture,
    SCRIPT_IDENTITY,
} from './fixtures/git-worktree-support.js';
import { pathOf } from './fixtures/scripts-support.js';

/**
 * The reviewer's start of the worktree sync script (issue #549): a named reviewer is its own
 * thread, so its tree is created on its own branch AT the snapshot ref the caller's run froze —
 * restore mode, no fetch, no rebase — never at the remote default.
 */
describe.skipIf(!hasGit())('the worktree sync script (a reviewer’s start)', () => {
    const fx = setupWorktreeFixture();
    const REF = 'refs/factory/review/55555555-5555-4555-8555-555555555555/security-1';

    const snapshotCallersTree = (): void => {
        execFileSync('node', [pathOf('git-review-snapshot.cjs')], {
            env: { ...process.env, ...SCRIPT_IDENTITY, REPO: fx.worktree(), REVIEW_REF: REF },
            encoding: 'utf8',
        });
    };

    const reviewerStart = (ref: string) => runScript({ ...fx.syncEnv(OTHER_ROOT), RESTORE: '1', REVIEW_REF: ref });

    it('creates the reviewer’s own worktree at the snapshot, work in progress and all, without touching the remote', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'TASK.md', 'committed\n', 'the task commit');
        writeFileSync(join(fx.worktree(), 'TASK.md'), 'edited, not committed\n');
        writeFileSync(join(fx.worktree(), 'NEW.md'), 'untracked\n');
        snapshotCallersTree();
        // The remote moves on after the snapshot: the reviewer must not see it.
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(reviewerStart(REF)).toMatchObject({ ok: true, reason: null });

        const reviewerTree = join(fx.worktree(), '..', OTHER_ROOT);
        expect(git(reviewerTree, 'branch', '--show-current')).toBe(`factory/${OTHER_ROOT}`);
        expect(readFileSync(join(reviewerTree, 'TASK.md'), 'utf8')).toBe('edited, not committed\n');
        expect(readFileSync(join(reviewerTree, 'NEW.md'), 'utf8')).toBe('untracked\n');
        expect(existsSync(join(reviewerTree, 'NEWS.md'))).toBe(false);
        // The caller's tree is exactly as it was.
        expect(readFileSync(join(fx.worktree(), 'TASK.md'), 'utf8')).toBe('edited, not committed\n');
    });

    it('keeps the reviewer’s tree on a repeated start', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        snapshotCallersTree();
        expect(reviewerStart(REF)).toMatchObject({ ok: true, reason: null });
        const reviewerTree = join(fx.worktree(), '..', OTHER_ROOT);
        writeFileSync(join(reviewerTree, 'NOTES.md'), 'the reviewer’s notes\n');
        expect(reviewerStart(REF)).toMatchObject({ ok: true, reason: null });
        expect(readFileSync(join(reviewerTree, 'NOTES.md'), 'utf8')).toBe('the reviewer’s notes\n');
    });

    it('fails, naming the snapshot, when the ref is not in the clone', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        const result = reviewerStart('refs/factory/review/nothing/here');
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('review snapshot');
    });
});
