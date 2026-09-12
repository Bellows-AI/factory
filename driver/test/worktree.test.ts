import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { gitProbeScript } from '../src/publish.js';

/**
 * The worktree sync script, against real git — offline throughout: every remote here is a
 * `file://` bare repository this file creates, so the suite keeps its no-network contract.
 * `workspace.reconcile.test.ts` is the pattern; the script under test is what the driver's sync
 * container (docker) or sync Job (kubernetes) runs.
 *
 * The script's git children inherit this process's environment, so the fixture pins a committer
 * identity through GIT_* env vars — a rebase creates commits, and a runner without a global git
 * config must not fail the fixture.
 */
const SCRIPT_IDENTITY = {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
};

function hasGit(): boolean {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Pinned so the fixture does not depend on the runner's global git config, or on having one. */
const GIT_FIXTURE_CONFIG = [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    '-c',
    'init.defaultBranch=main',
    '-c',
    'commit.gpgsign=false',
];

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', [...GIT_FIXTURE_CONFIG, ...args], { cwd, encoding: 'utf8' }).trim();
}

const runScript = (env: Record<string, string>): { ok: boolean; reason: string | null } => {
    // The script FILE itself, not a -e wrap: the artifact the sync container runs is what is
    // under test.
    const out = execFileSync('node', [join(import.meta.dirname, '..', 'src', 'scripts', 'git-worktree.cjs')], {
        env: { ...process.env, ...SCRIPT_IDENTITY, ...env },
        encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').filter(Boolean).pop()!);
};

const USER = '11111111-2222-3333-4444-555555555555';
const ROOT = '55555555-5555-4555-8555-555555555555';
const OTHER_ROOT = '66666666-6666-4666-8666-666666666666';

describe.skipIf(!hasGit())('the worktree sync script', () => {
    let dir: string;
    let clone: string;
    let worktree: string;
    let branch: string;
    let work: string;
    let bare: string;

    const sync = (root = ROOT): { ok: boolean; reason: string | null } =>
        runScript({
            REPO: clone,
            WORKTREE: join(dir, 'bellows', USER, '.worktrees', root),
            BRANCH: `factory/${root}`,
        });

    /** The restore mode a continuation claim gets (RESTORE=1): no fetch, no rebase. */
    const restore = (root = ROOT): { ok: boolean; reason: string | null } =>
        runScript({
            REPO: clone,
            WORKTREE: join(dir, 'bellows', USER, '.worktrees', root),
            BRANCH: `factory/${root}`,
            RESTORE: '1',
        });

    /** A commit on the remote default branch, pushed from the fixture's work copy. */
    const pushToOrigin = (file: string, content: string, message: string): void => {
        writeFileSync(join(work, file), content);
        git(work, 'add', file);
        git(work, 'commit', '-m', message);
        git(work, 'push', 'origin', 'main');
    };

    const commitIn = (cwd: string, file: string, content: string, message: string): void => {
        writeFileSync(join(cwd, file), content);
        git(cwd, 'add', file);
        git(cwd, 'commit', '-m', message);
    };

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-worktree-')));
        // The real layout: the clone sits at <mount>/<org>/<user>/<repo>, worktrees beside it.
        clone = join(dir, 'bellows', USER, 'factory');
        worktree = join(dir, 'bellows', USER, '.worktrees', ROOT);
        branch = `factory/${ROOT}`;
        mkdirSync(join(dir, 'origin-work'), { recursive: true });
        work = join(dir, 'origin-work');
        git(work, 'init');
        writeFileSync(join(work, 'README.md'), '# factory\n');
        git(work, 'add', 'README.md');
        git(work, 'commit', '-m', 'init');
        bare = join(dir, 'factory.git');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
        // The work copy pushes to the bare the way a real checkout pushes to its forge.
        git(work, 'remote', 'add', 'origin', bare);
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${bare}`, clone], { stdio: 'ignore' });
    });

    it('creates the worktree branched off the remote default, leaving the clone pristine', () => {
        expect(sync()).toEqual({ ok: true, reason: null });

        // The worktree exists, is on the task branch, and sits at the remote default's commit.
        expect(git(worktree, 'rev-parse', '--is-inside-work-tree')).toBe('true');
        expect(git(worktree, 'branch', '--show-current')).toBe(branch);
        expect(git(worktree, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'origin/main'));
        expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('# factory\n');

        // The clone is exactly what it was: same branch, same HEAD, clean tree, and the worktree
        // is registered in its `git worktree` list.
        expect(git(clone, 'branch', '--show-current')).toBe('main');
        expect(git(clone, 'status', '--porcelain')).toBe('');
        expect(git(clone, 'worktree', 'list', '--porcelain')).toContain(`worktree ${worktree}`);
    });

    it('is idempotent: a second sync of an existing worktree rebases it onto the new default', () => {
        expect(sync()).toEqual({ ok: true, reason: null });
        commitIn(worktree, 'TASK.md', 'task work\n', 'the task commit');
        pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(sync()).toEqual({ ok: true, reason: null });

        // The branch kept its own commit AND gained the remote's, with the remote's as the base.
        expect(git(worktree, 'log', '--format=%s')).toContain('the task commit');
        expect(existsSync(join(worktree, 'NEWS.md'))).toBe(true);
        expect(git(worktree, 'rev-parse', 'HEAD')).not.toBe(git(clone, 'rev-parse', 'origin/main'));
        expect(git(worktree, 'merge-base', 'HEAD', 'origin/main')).toBe(git(clone, 'rev-parse', 'origin/main'));
    });

    it('answers a conflicted rebase with a reason and never leaves the worktree mid-rebase', () => {
        expect(sync()).toEqual({ ok: true, reason: null });
        commitIn(worktree, 'README.md', 'task rewrites the readme\n', 'conflicting task commit');
        pushToOrigin('README.md', 'upstream rewrites the readme\n', 'conflicting upstream commit');

        const result = sync();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('rebased onto');

        // No rebase in progress: the next attempt (or the agent) finds a tree, not a trap.
        const gitDir = git(worktree, 'rev-parse', '--git-dir');
        expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
        expect(existsSync(join(gitDir, 'rebase-apply'))).toBe(false);
    });

    it('replaces garbage at the worktree path instead of failing forever', () => {
        // A previous add that died midway, or anything else that is not a checkout: the path is
        // the driver's own namespace (`.worktrees/<uuid>`), so what is there is never precious.
        mkdirSync(worktree, { recursive: true });
        writeFileSync(join(worktree, 'leftover.txt'), 'not a worktree');

        expect(sync()).toEqual({ ok: true, reason: null });
        expect(git(worktree, 'rev-parse', '--is-inside-work-tree')).toBe('true');
        expect(existsSync(join(worktree, 'leftover.txt'))).toBe(false);
    });

    it('gives two tasks two independent worktrees — neither sees the other’s uncommitted edits', () => {
        // The issue's acceptance test: the second task's workspace is branched off main, not
        // dropped into the tree the first task is mid-edit in.
        expect(sync()).toEqual({ ok: true, reason: null });
        writeFileSync(join(worktree, 'WIP.md'), 'first task, still working\n');

        const second = join(dir, 'bellows', USER, '.worktrees', OTHER_ROOT);
        expect(sync(OTHER_ROOT)).toEqual({ ok: true, reason: null });

        expect(existsSync(join(second, 'WIP.md'))).toBe(false);
        expect(readFileSync(join(second, 'README.md'), 'utf8')).toBe('# factory\n');
        expect(readFileSync(join(worktree, 'WIP.md'), 'utf8')).toBe('first task, still working\n');
        expect(git(second, 'branch', '--show-current')).toBe(`factory/${OTHER_ROOT}`);
    });

    it('reattaches a branch whose worktree directory was lost, keeping its commits', () => {
        expect(sync()).toEqual({ ok: true, reason: null });
        commitIn(worktree, 'FOUND.md', 'committed work\n', 'work worth keeping');
        rmSync(worktree, { recursive: true });

        expect(sync()).toEqual({ ok: true, reason: null });

        // The same branch, at its own tip — NOT reset to the remote default, which would throw
        // the thread's committed work away.
        expect(git(worktree, 'branch', '--show-current')).toBe(branch);
        expect(git(worktree, 'log', '--format=%s')).toContain('work worth keeping');
    });

    it('rebases a worktree with uncommitted edits by autostash, and keeps the edits', () => {
        // A follow-up lands in the SAME tree as the run before it (the session is only coherent
        // there), and runs routinely end with uncommitted leftovers — the rebase must carry the
        // edits across, not dead-end the thread on them.
        expect(sync()).toEqual({ ok: true, reason: null });
        pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
        writeFileSync(join(worktree, 'README.md'), 'an agent was here\n');

        expect(sync()).toEqual({ ok: true, reason: null });

        // The base moved AND the edit survived.
        expect(git(worktree, 'merge-base', 'HEAD', 'origin/main')).toBe(git(clone, 'rev-parse', 'origin/main'));
        expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('an agent was here\n');
    });

    it('keeps the uncommitted edits when the autostash rebase conflicts with upstream', () => {
        // The nastiest legitimate state: upstream rewrote the very file the agent has mid-edit.
        // The rebase itself succeeds and git exits 0 even though the reapplied STASH conflicts —
        // the script must catch the unmerged entries and refuse, leaving the tree (and the
        // stash git kept) for recovery instead of running on conflict markers.
        expect(sync()).toEqual({ ok: true, reason: null });
        commitIn(worktree, 'TASK.md', 'task work\n', 'the task commit');
        writeFileSync(join(worktree, 'README.md'), 'an agent was here\n');
        pushToOrigin('README.md', 'upstream rewrites the readme\n', 'conflicting upstream commit');

        const result = sync();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('conflict');
        // The edit survived, as conflict markers in the tree, and the autostash is retained.
        expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toContain('an agent was here');
        expect(git(worktree, 'stash', 'list')).toContain('autostash');
    });

    it('refuses to delete a git tree at the worktree path that this sync did not create', () => {
        // Registration pruned by hand, or a whole clone someone put there: whatever holds a
        // .git may hold uncommitted work, and deleting it is the one outcome worse than a
        // burned attempt.
        mkdirSync(worktree, { recursive: true });
        writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere/else\n');
        writeFileSync(join(worktree, 'PRECIOUS.md'), 'uncommitted work\n');

        const result = sync();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('git tree this sync did not create');
        expect(readFileSync(join(worktree, 'PRECIOUS.md'), 'utf8')).toBe('uncommitted work\n');
    });

    it('restores an existing worktree untouched: no fetch, no rebase', () => {
        // A follow-up continues the task where it stands (issue #58): git operations that touch
        // the remote belong to the task's beginning and end, never mid-flight. The tree must be
        // byte-for-byte what the previous run left — no rebase onto a moved main, no fetch
        // dragging upstream commits in, no autostash dance over the session's edits.
        expect(sync()).toEqual({ ok: true, reason: null });
        commitIn(worktree, 'TASK.md', 'task work\n', 'the task commit');
        writeFileSync(join(worktree, 'TASK.md'), 'task work, mid-edit\n');
        pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');
        const before = git(worktree, 'rev-parse', 'HEAD');

        expect(restore()).toEqual({ ok: true, reason: null });

        expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
        expect(existsSync(join(worktree, 'NEWS.md'))).toBe(false);
        expect(readFileSync(join(worktree, 'TASK.md'), 'utf8')).toBe('task work, mid-edit\n');
        expect(git(worktree, 'stash', 'list')).toBe('');
    });

    it('recreates a reclaimed worktree from the surviving branch, without adopting upstream moves', () => {
        // The thread went terminal and its tree was reclaimed; the follow-up then restores the
        // tree from the surviving factory/<root> branch — its own work, not a fresh start off a
        // freshly fetched main.
        expect(sync()).toEqual({ ok: true, reason: null });
        commitIn(worktree, 'KEPT.md', 'kept work\n', 'kept committed work');
        rmSync(worktree, { recursive: true });
        pushToOrigin('NEWS.md', 'upstream news\n', 'upstream moves on');

        expect(restore()).toEqual({ ok: true, reason: null });

        expect(git(worktree, 'branch', '--show-current')).toBe(branch);
        expect(git(worktree, 'log', '--format=%s')).toContain('kept committed work');
        expect(existsSync(join(worktree, 'NEWS.md'))).toBe(false);
    });

    it('fails a restore whose branch is gone, instead of restarting the thread from main', () => {
        // A follow-up with no thread branch has nothing to continue: creating the tree at
        // origin/<default> would look like a continuation while carrying none of the work over.
        // The attempt fails with the branch named, the way every sync refusal names its reason.
        expect(sync()).toEqual({ ok: true, reason: null });
        // The reclaim's own sequence: the tree removed AND its registration pruned, leaving the
        // branch in the clone — which is then deleted, as a thread whose session was lost would be.
        git(clone, 'worktree', 'remove', '--force', worktree);
        git(clone, 'branch', '-D', branch);

        const result = restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain(branch);
        expect(existsSync(worktree)).toBe(false);
    });

    it('refuses a foreign git tree at the worktree path when restoring too', () => {
        // The creation arm's one guard must hold in restore mode as well: whatever holds a .git
        // the sync did not create may hold uncommitted work, and restore deletes nothing either.
        mkdirSync(worktree, { recursive: true });
        writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere/else\n');
        writeFileSync(join(worktree, 'PRECIOUS.md'), 'uncommitted work\n');

        const result = restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('git tree this sync did not create');
        expect(readFileSync(join(worktree, 'PRECIOUS.md'), 'utf8')).toBe('uncommitted work\n');
    });

    it('replaces garbage at the worktree path when restoring, the same as a sync does', () => {
        // Restore recreates a reclaimed tree from the branch, and the path it needs may hold a
        // bare leftover — the same driver-owned namespace the sync arm clears, so the same
        // replacement applies: never a failed-forever attempt over a directory nobody owns.
        expect(sync()).toEqual({ ok: true, reason: null });
        rmSync(worktree, { recursive: true });
        mkdirSync(worktree, { recursive: true });
        writeFileSync(join(worktree, 'leftover.txt'), 'not a worktree');

        expect(restore()).toEqual({ ok: true, reason: null });
        expect(git(worktree, 'rev-parse', '--is-inside-work-tree')).toBe('true');
        expect(existsSync(join(worktree, 'leftover.txt'))).toBe(false);
    });

    it('refuses a restore whose worktree belongs to another clone', () => {
        // A whole independent checkout stands at the worktree path: rev-parse succeeds inside
        // it, but continuing the thread there would run a resumed job in another clone's tree.
        // The restore must name the ownership mismatch and leave the foreign tree alone.
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${bare}`, worktree], { stdio: 'ignore' });

        const result = restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('not a worktree of this clone');
        expect(git(worktree, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    });

    it('refuses a restore whose worktree sits on another branch', () => {
        // The tree is ours, but the checkout moved off the task branch: a follow-up must not
        // run there, and must not reset or recreate it either — the refusal names the branch
        // it found against the branch it expected, and the tree stays as it stands.
        expect(sync()).toEqual({ ok: true, reason: null });
        git(worktree, 'switch', '-c', 'rogue');

        const result = restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('rogue');
        expect(result.reason).toContain(branch);
        expect(git(worktree, 'branch', '--show-current')).toBe('rogue');
    });

    it('refuses a restore whose worktree is on a detached HEAD', () => {
        // A detached checkout is no thread to continue either: no branch survives under it,
        // so the refusal names the detached state instead of answering success.
        expect(sync()).toEqual({ ok: true, reason: null });
        git(worktree, 'checkout', '--detach');

        const result = restore();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('detached');
        expect(git(worktree, 'rev-parse', '--is-inside-work-tree')).toBe('true');
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
