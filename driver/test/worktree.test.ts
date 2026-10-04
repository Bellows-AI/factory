import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GIT_ADD_ARGS, gitProbeScript } from '../src/publish.js';
import {
    GIT_FIXTURE_CONFIG,
    OTHER_ROOT,
    USER,
    git,
    hasGit,
    setupWorktreeFixture,
} from './fixtures/git-worktree-support.js';

/**
 * The worktree sync script, against real git — offline throughout: every remote here is a
 * `file://` bare repository this file creates, so the suite keeps its no-network contract.
 * `workspace.reconcile.test.ts` is the pattern; the script under test is what the driver's sync
 * container (docker) or sync Job (kubernetes) runs.
 *
 * The RESTORE-mode half of this same script lives in `worktree-restore.test.ts` (split for the
 * line-count cap); both suites share their fixture via `./fixtures/git-worktree-support.js`.
 */
describe.skipIf(!hasGit())('the worktree sync script', () => {
    const fx = setupWorktreeFixture();

    it('creates the worktree branched off the remote default, leaving the clone pristine', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        // The worktree exists, is on the task branch, and sits at the remote default's commit.
        expect(git(fx.worktree(), 'rev-parse', '--is-inside-work-tree')).toBe('true');
        expect(git(fx.worktree(), 'branch', '--show-current')).toBe(fx.branch());
        expect(git(fx.worktree(), 'rev-parse', 'HEAD')).toBe(git(fx.clone(), 'rev-parse', 'origin/main'));
        expect(readFileSync(join(fx.worktree(), 'README.md'), 'utf8')).toBe('# factory\n');

        // The clone is exactly what it was: same branch, same HEAD, clean tree, and the worktree
        // is registered in its `git worktree` list.
        expect(git(fx.clone(), 'branch', '--show-current')).toBe('main');
        expect(git(fx.clone(), 'status', '--porcelain')).toBe('');
        expect(git(fx.clone(), 'worktree', 'list', '--porcelain')).toContain(`worktree ${fx.worktree()}`);
    });

    it('is idempotent: a second sync of an existing worktree rebases it onto the new default', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'TASK.md', 'task work\n', 'the task commit');
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        // The branch kept its own commit AND gained the remote's, with the remote's as the base.
        expect(git(fx.worktree(), 'log', '--format=%s')).toContain('the task commit');
        expect(existsSync(join(fx.worktree(), 'NEWS.md'))).toBe(true);
        expect(git(fx.worktree(), 'rev-parse', 'HEAD')).not.toBe(git(fx.clone(), 'rev-parse', 'origin/main'));
        expect(git(fx.worktree(), 'merge-base', 'HEAD', 'origin/main')).toBe(
            git(fx.clone(), 'rev-parse', 'origin/main')
        );
    });

    it('answers a conflicted rebase with a reason and never leaves the worktree mid-rebase', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'README.md', 'task rewrites the readme\n', 'conflicting task commit');
        fx.pushToOrigin('README.md', 'upstream rewrites the readme\n', 'conflicting upstream commit');

        const result = fx.sync();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('rebased onto');

        // No rebase in progress: the next attempt (or the agent) finds a tree, not a trap.
        const gitDir = git(fx.worktree(), 'rev-parse', '--git-dir');
        expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
        expect(existsSync(join(gitDir, 'rebase-apply'))).toBe(false);
    });

    it('replaces garbage at the worktree path instead of failing forever', () => {
        // A previous add that died midway, or anything else that is not a checkout: the path is
        // the driver's own namespace (`.worktrees/<uuid>`), so what is there is never precious.
        mkdirSync(fx.worktree(), { recursive: true });
        writeFileSync(join(fx.worktree(), 'leftover.txt'), 'not a worktree');

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        expect(git(fx.worktree(), 'rev-parse', '--is-inside-work-tree')).toBe('true');
        expect(existsSync(join(fx.worktree(), 'leftover.txt'))).toBe(false);
    });

    it('gives two tasks two independent worktrees — neither sees the other’s uncommitted edits', () => {
        // The issue's acceptance test: the second task's workspace is branched off main, not
        // dropped into the tree the first task is mid-edit in.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        writeFileSync(join(fx.worktree(), 'WIP.md'), 'first task, still working\n');

        const second = join(fx.dir(), 'bellows', USER, '.worktrees', OTHER_ROOT);
        expect(fx.sync(OTHER_ROOT)).toMatchObject({ ok: true, reason: null });

        expect(existsSync(join(second, 'WIP.md'))).toBe(false);
        expect(readFileSync(join(second, 'README.md'), 'utf8')).toBe('# factory\n');
        expect(readFileSync(join(fx.worktree(), 'WIP.md'), 'utf8')).toBe('first task, still working\n');
        expect(git(second, 'branch', '--show-current')).toBe(`factory/${OTHER_ROOT}`);
    });

    it('reattaches a branch whose worktree directory was lost, keeping its commits', () => {
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'FOUND.md', 'committed work\n', 'work worth keeping');
        rmSync(fx.worktree(), { recursive: true });

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        // The same branch, at its own tip — NOT reset to the remote default, which would throw
        // the thread's committed work away.
        expect(git(fx.worktree(), 'branch', '--show-current')).toBe(fx.branch());
        expect(git(fx.worktree(), 'log', '--format=%s')).toContain('work worth keeping');
    });

    it('rebases a worktree with uncommitted edits by autostash, and keeps the edits', () => {
        // A follow-up lands in the SAME tree as the run before it (the session is only coherent
        // there), and runs routinely end with uncommitted leftovers — the rebase must carry the
        // edits across, not dead-end the thread on them.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
        writeFileSync(join(fx.worktree(), 'README.md'), 'an agent was here\n');

        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        // The base moved AND the edit survived.
        expect(git(fx.worktree(), 'merge-base', 'HEAD', 'origin/main')).toBe(
            git(fx.clone(), 'rev-parse', 'origin/main')
        );
        expect(readFileSync(join(fx.worktree(), 'README.md'), 'utf8')).toBe('an agent was here\n');
    });

    it('keeps the uncommitted edits when the autostash rebase conflicts with upstream', () => {
        // The nastiest legitimate state: upstream rewrote the very file the agent has mid-edit.
        // The rebase itself succeeds and git exits 0 even though the reapplied STASH conflicts —
        // the script must catch the unmerged entries and refuse, leaving the tree (and the
        // stash git kept) for recovery instead of running on conflict markers.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'TASK.md', 'task work\n', 'the task commit');
        writeFileSync(join(fx.worktree(), 'README.md'), 'an agent was here\n');
        fx.pushToOrigin('README.md', 'upstream rewrites the readme\n', 'conflicting upstream commit');

        const result = fx.sync();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('conflict');
        // The edit survived, as conflict markers in the tree, and the autostash is retained.
        expect(readFileSync(join(fx.worktree(), 'README.md'), 'utf8')).toContain('an agent was here');
        expect(git(fx.worktree(), 'stash', 'list')).toContain('autostash');
    });

    it('refuses to delete a git tree at the worktree path that this sync did not create', () => {
        // Registration pruned by hand, or a whole clone someone put there: whatever holds a
        // .git may hold uncommitted work, and deleting it is the one outcome worse than a
        // burned attempt.
        mkdirSync(fx.worktree(), { recursive: true });
        writeFileSync(join(fx.worktree(), '.git'), 'gitdir: /somewhere/else\n');
        writeFileSync(join(fx.worktree(), 'PRECIOUS.md'), 'uncommitted work\n');

        const result = fx.sync();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('git tree this sync did not create');
        expect(readFileSync(join(fx.worktree(), 'PRECIOUS.md'), 'utf8')).toBe('uncommitted work\n');
    });

    it('git-ignores the .factory/ state namespace in every worktree, once', () => {
        // Helpers write their verdicts under .factory/ in the task worktree; untracked there, the
        // publisher's `git add -A` committed merge-conflict-probe.json into task PRs. A worktree's
        // `.git` is a FILE, so the exclude must land in the clone's common dir to apply at all.
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });
        expect(fx.sync()).toMatchObject({ ok: true, reason: null });

        const exclude = readFileSync(join(fx.clone(), '.git', 'info', 'exclude'), 'utf8');
        expect(exclude.split('\n').filter((line) => line === '/.factory/')).toHaveLength(1);
        mkdirSync(join(fx.worktree(), '.factory', 'review-reconcile'), { recursive: true });
        writeFileSync(join(fx.worktree(), '.factory', 'merge-conflict-probe.json'), '{}\n');
        writeFileSync(join(fx.worktree(), '.factory', 'review-reconcile', 'digest.json'), '{}\n');
        expect(git(fx.worktree(), 'status', '--porcelain')).toBe('');
    });
});

/**
 * The publish probe, executed for real against a checkout — the same artifact the publish flow's
 * probe container runs, driven by `REPO` alone. It answers the three questions the publisher
 * branches on: is this a checkout at all, does it hold uncommitted work, and does it carry
 * commits the remote default does not have.
 */
describe.skipIf(!hasGit())('the publish probe script', () => {
    let dir: string;
    let repo: string;

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-probe-')));
        const work = join(dir, 'origin-work');
        mkdirSync(work, { recursive: true });
        git(work, 'init');
        writeFileSync(join(work, 'README.md'), '# probe\n');
        git(work, 'add', 'README.md');
        git(work, 'commit', '-m', 'init');
        const bare = join(dir, 'probe.git');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
        repo = join(dir, 'clone');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${bare}`, repo], { stdio: 'ignore' });
    });

    const probe = (): {
        cloned: boolean;
        branch: string;
        defaultBranch: string;
        dirty: boolean;
        unpushed: number;
        hasIdentity: boolean;
    } => {
        const out = execFileSync('node', [join(import.meta.dirname, '..', 'src', 'scripts', 'git-probe.cjs')], {
            env: {
                ...process.env,
                REPO: repo,
                // Hermetic identity: the runner's global/system git config must not decide
                // hasIdentity — the publisher's fallback-identity branch depends on the answer.
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_SYSTEM: '/dev/null',
            },
            encoding: 'utf8',
        });
        return JSON.parse(out.trim().split('\n').filter(Boolean).pop()!);
    };

    it('reads the checkout state the publish flow branches on', () => {
        writeFileSync(join(repo, 'WIP.md'), 'uncommitted\n');
        writeFileSync(join(repo, 'TRACKED.md'), 'edit\n');
        git(repo, 'add', 'TRACKED.md');
        git(repo, 'commit', '-m', 'local commit');

        expect(probe()).toMatchObject({
            cloned: true,
            branch: 'main',
            defaultBranch: 'main',
            dirty: true,
            unpushed: 1,
        });
        // The fixture pins a committer identity per git() call only — the clone itself has
        // none, which is exactly the state the publisher's fallback identity exists for.
        expect(probe().hasIdentity).toBe(false);
    });

    it('answers the never-cloned shape for a directory that is not a checkout', () => {
        repo = join(dir, 'not-a-checkout');
        mkdirSync(repo, { recursive: true });

        expect(probe()).toEqual({
            cloned: false,
            branch: '',
            defaultBranch: 'main',
            dirty: false,
            unpushed: 0,
            hasIdentity: false,
            fingerprint: null,
        });
        // The constant is the file — asserting the executed path is the artifact (parity with
        // the loader is pinned in scripts.test.ts).
        expect(gitProbeScript.length).toBeGreaterThan(0);
    });

    it('reads a tree dirty only under .factory/ as clean, and the publisher never stages it', () => {
        // A state file an older commit already tracks (how merge-conflict-probe.json leaked into
        // main): rewriting it is not publishable work, and staging it again re-spreads the leak.
        mkdirSync(join(repo, '.factory'), { recursive: true });
        writeFileSync(join(repo, '.factory', 'merge-conflict-probe.json'), '{"verdict":"up-to-date"}\n');
        git(repo, 'add', '.factory');
        git(repo, 'commit', '-m', 'leaked state');
        writeFileSync(join(repo, '.factory', 'merge-conflict-probe.json'), '{"verdict":"rebased"}\n');
        writeFileSync(join(repo, '.factory', 'digest.json'), '{}\n');

        expect(probe().dirty).toBe(false);

        writeFileSync(join(repo, 'WORK.md'), 'real work\n');
        expect(probe().dirty).toBe(true);
        git(repo, ...GIT_ADD_ARGS);
        expect(git(repo, 'diff', '--cached', '--name-only')).toBe('WORK.md');
    });
});

/**
 * The tree fingerprint the sync prints and the probe re-reads after a failed gate: equal means the
 * round between them changed nothing. Both scripts spell it identically; this pins that they agree.
 */
describe.skipIf(!hasGit())('the tree fingerprint', () => {
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
    const synced = (): string | null => (fx.sync() as { fingerprint?: string | null }).fingerprint ?? null;

    it('agrees between the sync and the probe over an untouched tree', () => {
        const before = synced();
        expect(before).toMatch(/^[0-9a-f]{40}:[0-9a-f]{64}$/);
        expect(probed()).toBe(before);
        // The restore a follow-up gets prints the same one.
        expect((fx.restore() as { fingerprint?: string | null }).fingerprint).toBe(before);
    });

    it('moves on a commit, an edit, a further edit of an already-dirty file, and a new file', () => {
        const seen = new Set([synced()]);
        const step = (): void => {
            const now = probed();
            expect(seen.has(now)).toBe(false);
            seen.add(now);
        };
        fx.commitIn(fx.worktree(), 'TASK.md', 'one\n', 'a commit');
        step();
        writeFileSync(join(fx.worktree(), 'README.md'), 'edited\n');
        step();
        // The porcelain line is the same ` M README.md`; the content is not.
        writeFileSync(join(fx.worktree(), 'README.md'), 'edited again\n');
        step();
        writeFileSync(join(fx.worktree(), 'NEW.md'), 'new\n');
        step();
        writeFileSync(join(fx.worktree(), 'NEW.md'), 'new, changed\n');
        step();
    });

    it('ignores the .factory/ state namespace', () => {
        const before = synced();
        mkdirSync(join(fx.worktree(), '.factory'), { recursive: true });
        writeFileSync(join(fx.worktree(), '.factory', 'state.json'), '{}');
        expect(probed()).toBe(before);
    });
});
