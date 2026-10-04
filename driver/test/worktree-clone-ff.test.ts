import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/*
 * Issue #444: the base clone's checked-out files were frozen at whatever commit it was first
 * cloned at — the startup sync fetched, which moves only origin/*. A STARTING sync now
 * fast-forwards the clone's default branch when that is safe: checked out, clean, and an ancestor
 * of origin/<default>. Anything else is left exactly as it was, never forced; RESTORE never
 * touches the remote, so never moves it either.
 */
describe.skipIf(!hasGit())('the worktree sync fast-forwards the base clone', () => {
    const fx = setupWorktreeFixture();

    it('fast-forwards a clean clone standing on the default branch', () => {
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.clone(), 'rev-parse', 'HEAD')).toBe(git(fx.clone(), 'rev-parse', 'origin/main'));
        expect(git(fx.clone(), 'status', '--porcelain')).toBe('');
    });

    it('leaves a dirty clone alone', () => {
        const before = git(fx.clone(), 'rev-parse', 'HEAD');
        writeFileSync(join(fx.clone(), 'README.md'), 'a member edit\n');
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.clone(), 'rev-parse', 'HEAD')).toBe(before);
        expect(git(fx.clone(), 'status', '--porcelain')).toBe('M README.md');
    });

    it('leaves a clone on another branch alone', () => {
        git(fx.clone(), 'checkout', '-q', '-b', 'side');
        const before = git(fx.clone(), 'rev-parse', 'HEAD');
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.clone(), 'branch', '--show-current')).toBe('side');
        expect(git(fx.clone(), 'rev-parse', 'HEAD')).toBe(before);
        expect(git(fx.clone(), 'rev-parse', 'main')).toBe(before);
    });

    it('leaves a clone whose default branch diverged alone', () => {
        fx.commitIn(fx.clone(), 'LOCAL.md', 'local only\n', 'a local commit');
        const before = git(fx.clone(), 'rev-parse', 'HEAD');
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.clone(), 'rev-parse', 'HEAD')).toBe(before);
    });

    it('never moves the clone on a RESTORE sync', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
        git(fx.clone(), 'fetch', '-q', 'origin');
        const before = git(fx.clone(), 'rev-parse', 'HEAD');

        expect(fx.restore()).toMatchObject({ ok: true, reason: null });

        expect(git(fx.clone(), 'rev-parse', 'HEAD')).toBe(before);
        expect(before).not.toBe(git(fx.clone(), 'rev-parse', 'origin/main'));
    });
});
