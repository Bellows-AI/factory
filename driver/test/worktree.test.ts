import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { gitProbeScript } from '../src/publish.js';
import {
    GIT_FIXTURE_CONFIG,
    OTHER_ROOT,
    SCRIPT_IDENTITY,
    USER,
    git,
    hasGit,
    importEmptyCommits,
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
        expect(fx.sync()).toEqual({ ok: true, reason: null });

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
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'TASK.md', 'task work\n', 'the task commit');
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(fx.sync()).toEqual({ ok: true, reason: null });

        // The branch kept its own commit AND gained the remote's, with the remote's as the base.
        expect(git(fx.worktree(), 'log', '--format=%s')).toContain('the task commit');
        expect(existsSync(join(fx.worktree(), 'NEWS.md'))).toBe(true);
        expect(git(fx.worktree(), 'rev-parse', 'HEAD')).not.toBe(git(fx.clone(), 'rev-parse', 'origin/main'));
        expect(git(fx.worktree(), 'merge-base', 'HEAD', 'origin/main')).toBe(
            git(fx.clone(), 'rev-parse', 'origin/main')
        );
    });

    it('answers a conflicted rebase with a reason and never leaves the worktree mid-rebase', () => {
        expect(fx.sync()).toEqual({ ok: true, reason: null });
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

        expect(fx.sync()).toEqual({ ok: true, reason: null });
        expect(git(fx.worktree(), 'rev-parse', '--is-inside-work-tree')).toBe('true');
        expect(existsSync(join(fx.worktree(), 'leftover.txt'))).toBe(false);
    });

    it('gives two tasks two independent worktrees — neither sees the other’s uncommitted edits', () => {
        // The issue's acceptance test: the second task's workspace is branched off main, not
        // dropped into the tree the first task is mid-edit in.
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        writeFileSync(join(fx.worktree(), 'WIP.md'), 'first task, still working\n');

        const second = join(fx.dir(), 'bellows', USER, '.worktrees', OTHER_ROOT);
        expect(fx.sync(OTHER_ROOT)).toEqual({ ok: true, reason: null });

        expect(existsSync(join(second, 'WIP.md'))).toBe(false);
        expect(readFileSync(join(second, 'README.md'), 'utf8')).toBe('# factory\n');
        expect(readFileSync(join(fx.worktree(), 'WIP.md'), 'utf8')).toBe('first task, still working\n');
        expect(git(second, 'branch', '--show-current')).toBe(`factory/${OTHER_ROOT}`);
    });

    it('reattaches a branch whose worktree directory was lost, keeping its commits', () => {
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        fx.commitIn(fx.worktree(), 'FOUND.md', 'committed work\n', 'work worth keeping');
        rmSync(fx.worktree(), { recursive: true });

        expect(fx.sync()).toEqual({ ok: true, reason: null });

        // The same branch, at its own tip — NOT reset to the remote default, which would throw
        // the thread's committed work away.
        expect(git(fx.worktree(), 'branch', '--show-current')).toBe(fx.branch());
        expect(git(fx.worktree(), 'log', '--format=%s')).toContain('work worth keeping');
    });

    it('rebases a worktree with uncommitted edits by autostash, and keeps the edits', () => {
        // A follow-up lands in the SAME tree as the run before it (the session is only coherent
        // there), and runs routinely end with uncommitted leftovers — the rebase must carry the
        // edits across, not dead-end the thread on them.
        expect(fx.sync()).toEqual({ ok: true, reason: null });
        fx.pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
        writeFileSync(join(fx.worktree(), 'README.md'), 'an agent was here\n');

        expect(fx.sync()).toEqual({ ok: true, reason: null });

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
        expect(fx.sync()).toEqual({ ok: true, reason: null });
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
        });
        // The constant is the file — asserting the executed path is the artifact (parity with
        // the loader is pinned in scripts.test.ts).
        expect(gitProbeScript.length).toBeGreaterThan(0);
    });
});

/*
 * The PR summary script (issue #82): the publish flow opens the pull request with what the
 * BRANCH did, not what the command asked. Same offline discipline as the probe — a `file://`
 * bare remote, real commits, the script file itself executed — because the title heuristic
 * (first commit subject) and the body (commit list + shortstat) are exactly the bytes a PR
 * carries.
 */
describe.skipIf(!hasGit())('the PR summary script', () => {
    let dir: string;
    let repo: string;

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-pr-summary-')));
        const work = join(dir, 'origin-work');
        mkdirSync(work, { recursive: true });
        git(work, 'init');
        writeFileSync(join(work, 'README.md'), '# summary\n');
        git(work, 'add', 'README.md');
        git(work, 'commit', '-m', 'init');
        const bare = join(dir, 'summary.git');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
        repo = join(dir, 'clone');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${bare}`, repo], { stdio: 'ignore' });
    });

    const summarize = (base = 'origin/main'): { title: string | null; body: string | null } => {
        const out = execFileSync('node', [join(import.meta.dirname, '..', 'src', 'scripts', 'pr-summary.cjs')], {
            env: { ...process.env, ...SCRIPT_IDENTITY, ...(base ? { BASE: base } : {}) },
            cwd: repo,
            encoding: 'utf8',
        });
        return JSON.parse(out.trim().split('\n').filter(Boolean).pop()!);
    };

    /** Two commits on a task branch, as an agent leaves them. */
    const branchWork = () => {
        git(repo, 'switch', '-c', 'factory/root');
        writeFileSync(join(repo, 'a.txt'), 'a\n');
        git(repo, 'add', 'a.txt');
        git(repo, 'commit', '-m', 'Fix the sync re-claim fence');
        writeFileSync(join(repo, 'b.txt'), 'b\n');
        git(repo, 'add', 'b.txt');
        git(repo, 'commit', '-m', 'Cover the fence with a regression test');
    };

    it('titles the PR with the work and lists what was done', () => {
        branchWork();

        const summary = summarize();
        expect(summary.title).toBe('Fix the sync re-claim fence');
        expect(summary.body).toContain('## Commits');
        expect(summary.body).toContain('- Fix the sync re-claim fence');
        expect(summary.body).toContain('- Cover the fence with a regression test');
        expect(summary.body).toMatch(/2 files? changed/);
    });

    it('degrades to nulls when there is no BASE or git cannot read it', () => {
        branchWork();
        expect(summarize('')).toEqual({ title: null, body: null });
        expect(summarize('origin/nope')).toEqual({ title: null, body: null });
    });

    it('caps the commit list', () => {
        const IMPORTED_COMMITS = 35;
        importEmptyCommits(repo, 'factory/root', IMPORTED_COMMITS);
        git(repo, 'switch', 'factory/root');

        const summary = summarize();
        expect(summary.body).toContain('- ... and 5 more');
        // The capped commit lines, plus the one "- ... and N more" line — both start with "- ".
        const BODY_COMMIT_CAP = 30;
        const cappedLinesWithOverflowNote = BODY_COMMIT_CAP + 1;
        expect((summary.body!.match(/^- /gm) ?? []).length).toBe(cappedLinesWithOverflowNote);
    });

    it('truncates the title to 144 characters', () => {
        git(repo, 'switch', '-c', 'factory/root');
        writeFileSync(join(repo, 'x.txt'), 'x\n');
        git(repo, 'add', 'x.txt');
        const OVERLONG_SUBJECT_LENGTH = 200;
        git(repo, 'commit', '-m', 'x'.repeat(OVERLONG_SUBJECT_LENGTH));

        const TITLE_MAX = 144;
        expect(summarize().title).toBe('x'.repeat(TITLE_MAX));
    });

    it('keeps a 73-character subject whole (PR #191 lost the last letter at the old 72 cap)', () => {
        git(repo, 'switch', '-c', 'factory/root');
        writeFileSync(join(repo, 'y.txt'), 'y\n');
        git(repo, 'add', 'y.txt');
        git(repo, 'commit', '-m', 'Web: task-outcome derivations as pure data, moved out of the task sidebar');

        expect(summarize().title).toBe('Web: task-outcome derivations as pure data, moved out of the task sidebar');
    });
});
