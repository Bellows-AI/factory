import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIT_FIXTURE_CONFIG, git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The RESTORE-mode half of the worktree sync script (issue #58): a follow-up continues the task
 * where it stands — no fetch, no rebase, the tree kept byte-for-byte as the run before it left
 * it, or recreated from the surviving thread branch when the tree itself was reclaimed. Split
 * from `worktree.test.ts`'s sync-mode suite for the line-count cap; both share their fixture via
 * `./fixtures/git-worktree-support.js`.
 */
describe.skipIf(!hasGit())('the worktree sync script (restore)', () => {
    const fx = setupWorktreeFixture();

    it('restores an existing worktree untouched: no fetch, no rebase', () => {
        // A follow-up continues the task where it stands (issue #58): git operations that touch
        // the remote belong to the task's beginning and end, never mid-flight. The tree must be
        // byte-for-byte what the previous run left — no rebase onto a moved main, no fetch
        // dragging upstream commits in, no autostash dance over the session's edits.
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'TASK.md', 'task work\n', 'the task commit');
        writeFileSync(join(fx.worktree(), 'TASK.md'), 'task work, mid-edit\n');
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
        const before = git(fx.worktree(), 'rev-parse', 'HEAD');

        expect(fx.restore()).toEqual({ ok: true, reason: null });

        expect(git(fx.worktree(), 'rev-parse', 'HEAD')).toBe(before);
        expect(existsSync(join(fx.worktree(), 'NEWS.md'))).toBe(false);
        expect(readFileSync(join(fx.worktree(), 'TASK.md'), 'utf8')).toBe('task work, mid-edit\n');
        expect(git(fx.worktree(), 'stash', 'list')).toBe('');
    });

    it('recreates a reclaimed worktree from the surviving branch, without adopting upstream moves', () => {
        // The thread went terminal and its tree was reclaimed; the follow-up then restores the
        // tree from the surviving factory/<root> branch — its own work, not a fresh start off a
        // freshly fetched main.
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'KEPT.md', 'kept work\n', 'kept committed work');
        rmSync(fx.worktree(), { recursive: true });
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(fx.restore()).toEqual({ ok: true, reason: null });

        expect(git(fx.worktree(), 'branch', '--show-current')).toBe(fx.branch());
        expect(git(fx.worktree(), 'log', '--format=%s')).toContain('kept committed work');
        expect(existsSync(join(fx.worktree(), 'NEWS.md'))).toBe(false);
    });

    it('fails a restore whose branch is gone, instead of restarting the thread from main', () => {
        // A follow-up with no thread branch has nothing to continue: creating the tree at
        // origin/<default> would look like a continuation while carrying none of the work over.
        // The attempt fails with the branch named, the way every sync refusal names its reason.
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        // The reclaim's own sequence: the tree removed AND its registration pruned, leaving the
        // branch in the clone — which is then deleted, as a thread whose session was lost would be.
        git(fx.clone(), 'worktree', 'remove', '--force', fx.worktree());
        git(fx.clone(), 'branch', '-D', fx.branch());

        const result = fx.restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain(fx.branch());
        expect(existsSync(fx.worktree())).toBe(false);
    });

    it('refuses a foreign git tree at the worktree path when restoring too', () => {
        // The creation arm's one guard must hold in restore mode as well: whatever holds a .git
        // the sync did not create may hold uncommitted work, and restore deletes nothing either.
        mkdirSync(fx.worktree(), { recursive: true });
        writeFileSync(join(fx.worktree(), '.git'), 'gitdir: /somewhere/else\n');
        writeFileSync(join(fx.worktree(), 'PRECIOUS.md'), 'uncommitted work\n');

        const result = fx.restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('git tree this sync did not create');
        expect(readFileSync(join(fx.worktree(), 'PRECIOUS.md'), 'utf8')).toBe('uncommitted work\n');
    });

    it('replaces garbage at the worktree path when restoring, the same as a sync does', () => {
        // Restore recreates a reclaimed tree from the branch, and the path it needs may hold a
        // bare leftover — the same driver-owned namespace the sync arm clears, so the same
        // replacement applies: never a failed-forever attempt over a directory nobody owns.
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        rmSync(fx.worktree(), { recursive: true });
        mkdirSync(fx.worktree(), { recursive: true });
        writeFileSync(join(fx.worktree(), 'leftover.txt'), 'not a worktree');

        expect(fx.restore()).toEqual({ ok: true, reason: null });
        expect(git(fx.worktree(), 'rev-parse', '--is-inside-work-tree')).toBe('true');
        expect(existsSync(join(fx.worktree(), 'leftover.txt'))).toBe(false);
    });

    it('refuses a restore whose worktree belongs to another clone', () => {
        // A whole independent checkout stands at the worktree path: rev-parse succeeds inside
        // it, but continuing the thread there would run a resumed job in another clone's tree.
        // The restore must name the ownership mismatch and leave the foreign tree alone.
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${fx.bare()}`, fx.worktree()], {
            stdio: 'ignore',
        });

        const result = fx.restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('not a worktree of this clone');
        expect(git(fx.worktree(), 'rev-parse', '--is-inside-work-tree')).toBe('true');
    });

    it('refuses a restore whose worktree sits on another branch', () => {
        // The tree is ours, but the checkout moved off the task branch: a follow-up must not
        // run there, and must not reset or recreate it either — the refusal names the branch
        // it found against the branch it expected, and the tree stays as it stands.
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        git(fx.worktree(), 'switch', '-c', 'rogue');

        const result = fx.restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('rogue');
        expect(result.reason).toContain(fx.branch());
        expect(git(fx.worktree(), 'branch', '--show-current')).toBe('rogue');
    });

    it('refuses a restore whose worktree is on a detached HEAD', () => {
        // A detached checkout is no thread to continue either: no branch survives under it,
        // so the refusal names the detached state instead of answering success.
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        git(fx.worktree(), 'checkout', '--detach');

        const result = fx.restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('detached');
        expect(git(fx.worktree(), 'rev-parse', '--is-inside-work-tree')).toBe('true');
    });
});
