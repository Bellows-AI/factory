import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitProbeScript } from '../src/publish.js';
import { GIT_FIXTURE_CONFIG, git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * Gremlin repros for the tree fingerprint (git-probe.cjs / git-worktree.cjs fingerprintOf). The
 * engine only stops a gate-fix loop on `treeChanged === false`; null and true both keep it going.
 */
describe.skipIf(!hasGit())('gremlin/gates: the tree fingerprint', () => {
    const fx = setupWorktreeFixture();
    const probed = (): string | null => {
        const out = execFileSync('node', ['-e', gitProbeScript], {
            env: { ...process.env, REPO: fx.worktree() },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return (JSON.parse(out.trim().split('\n').filter(Boolean).pop()!) as { fingerprint: string | null })
            .fingerprint;
    };

    // ---- unknown forever: an untracked path `hash-object --stdin-paths` cannot read ----------------
    it.each([
        ['a dangling symlink', () => symlinkSync('/nonexistent/target', join(fx.worktree(), 'link'))],
        [
            'a nested repository',
            () => {
                mkdirSync(join(fx.worktree(), 'vendored'));
                git(join(fx.worktree(), 'vendored'), 'init');
            },
        ],
    ])('stays measurable with an untracked %s', (_what, make) => {
        fx.sync();
        make();
        // Observed: null — treeChanged is null on every round, so the no-progress stop never fires.
        expect(probed()).toMatch(/^[0-9a-f]{40}:[0-9a-f]{64}$/);
    });

    // The gate's own writes are kept out by ordering, not by the fingerprint: the loop probes
    // before the gates (driver/test/loop.test.ts, 'reads the tree before the gates run').

    // ---- false negative: a submodule that was dirty and is now differently dirty -------------------
    it('moves when a dirty submodule’s content changes again', () => {
        fx.sync();
        const subSrc = realpathSync(mkdtempSync(join(tmpdir(), 'gremlin-sub-')));
        git(subSrc, 'init');
        writeFileSync(join(subSrc, 'lib.txt'), 'v1\n');
        git(subSrc, 'add', 'lib.txt');
        git(subSrc, 'commit', '-m', 'sub');
        execFileSync(
            'git',
            [...GIT_FIXTURE_CONFIG, '-c', 'protocol.file.allow=always', 'submodule', 'add', subSrc, 'sub'],
            { cwd: fx.worktree(), stdio: 'ignore' }
        );
        git(fx.worktree(), 'commit', '-m', 'add sub');
        writeFileSync(join(fx.worktree(), 'sub', 'lib.txt'), 'agent edit one\n');
        const before = probed();
        writeFileSync(join(fx.worktree(), 'sub', 'lib.txt'), 'agent edit two — the real fix\n');
        // Observed: equal (" m sub" / "Subproject commit X-dirty" both unchanged) — treeChanged
        // false, and the engine drops the gate-fix edge on a round that did change the tree.
        expect(probed()).not.toBe(before);
    });

    // ---- held up (kept as regression pins) ---------------------------------------------------------
    it('held: untracked names git C-quotes (a double quote, a tab)', () => {
        fx.sync();
        writeFileSync(join(fx.worktree(), 'say "hi".txt'), 'x');
        writeFileSync(join(fx.worktree(), 'a\tb.txt'), 'x');
        expect(probed()).toMatch(/^[0-9a-f]{40}:[0-9a-f]{64}$/);
    });

    it('held: moves on a mode-only change, and survives a stale index.lock', () => {
        fx.sync();
        const before = probed();
        chmodSync(join(fx.worktree(), 'README.md'), 0o755);
        const moded = probed();
        expect(moded).not.toBe(before);
        const gitDir = git(fx.worktree(), 'rev-parse', '--git-dir');
        writeFileSync(join(gitDir, 'index.lock'), '');
        expect(probed()).toBe(moded);
    });
});
