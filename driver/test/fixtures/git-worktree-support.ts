import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach } from 'vitest';

/**
 * Shared support for the worktree sync script suites (`worktree.test.ts`, split for its
 * line-count cap into a sync half and a restore half, `worktree-restore.test.ts`) — real git,
 * offline throughout: every remote here is a `file://` bare repository the fixture creates. The
 * script under test is what the driver's sync container (docker) or sync Job (kubernetes) runs.
 *
 * The script's git children inherit this process's environment, so the fixture pins a committer
 * identity through GIT_* env vars — a rebase creates commits, and a runner without a global git
 * config must not fail the fixture.
 */
export const SCRIPT_IDENTITY = {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
};

export function hasGit(): boolean {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Pinned so the fixture does not depend on the runner's global git config, or on having one. */
export const GIT_FIXTURE_CONFIG = [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    '-c',
    'init.defaultBranch=main',
    '-c',
    'commit.gpgsign=false',
];

export function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', [...GIT_FIXTURE_CONFIG, ...args], { cwd, encoding: 'utf8' }).trim();
}

/** An arbitrary fixed instant the imported commits count up from; the exact value is irrelevant. */
const FIRST_COMMIT_EPOCH_SECONDS = 1_700_000_000;

/** Builds a long, empty history in one process; one `git commit` spawn per row made the cap test the suite's slowest. */
export function importEmptyCommits(cwd: string, branch: string, count: number): void {
    let stream = '';
    for (let i = 0; i < count; i += 1) {
        const message = `commit ${i}`;
        const timestamp = FIRST_COMMIT_EPOCH_SECONDS + i;
        stream +=
            `commit refs/heads/${branch}\n` +
            `mark :${i + 1}\n` +
            `author Test <test@example.com> ${timestamp} +0000\n` +
            `committer Test <test@example.com> ${timestamp} +0000\n` +
            `data ${Buffer.byteLength(message)}\n${message}\n` +
            `from ${i === 0 ? 'refs/heads/main' : `:${i}`}\n\n`;
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd, input: `${stream}done\n` });
}

export const runScript = (env: Record<string, string>): { ok: boolean; reason: string | null } => {
    // The script FILE itself, not a -e wrap: the artifact the sync container runs is what is
    // under test.
    const out = execFileSync('node', [join(import.meta.dirname, '..', '..', 'src', 'scripts', 'git-worktree.cjs')], {
        env: { ...process.env, ...SCRIPT_IDENTITY, ...env },
        encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').filter(Boolean).pop()!);
};

export const USER = '11111111-2222-3333-4444-555555555555';
export const ROOT = '55555555-5555-4555-8555-555555555555';
export const OTHER_ROOT = '66666666-6666-4666-8666-666666666666';

export interface WorktreeFixture {
    dir: () => string;
    clone: () => string;
    worktree: () => string;
    branch: () => string;
    work: () => string;
    bare: () => string;
    sync: (root?: string) => { ok: boolean; reason: string | null };
    /** The restore mode a continuation claim gets (RESTORE=1): no fetch, no rebase. */
    restore: (root?: string) => { ok: boolean; reason: string | null };
    /** A commit on the remote default branch, pushed from the fixture's work copy. */
    pushToOrigin: (file: string, content: string, message: string) => void;
    commitIn: (cwd: string, file: string, content: string, message: string) => void;
}

/**
 * Registers the `beforeEach` that builds one bare-remote + clone + worktree layout, and answers
 * the state and the script-driving helpers both the sync and the restore suites run against. Must
 * be called from inside a `describe` — `beforeEach` binds to whichever suite is current.
 */
export function setupWorktreeFixture(): WorktreeFixture {
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

    const restore = (root = ROOT): { ok: boolean; reason: string | null } =>
        runScript({
            REPO: clone,
            WORKTREE: join(dir, 'bellows', USER, '.worktrees', root),
            BRANCH: `factory/${root}`,
            RESTORE: '1',
        });

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

    return {
        dir: () => dir,
        clone: () => clone,
        worktree: () => worktree,
        branch: () => branch,
        work: () => work,
        bare: () => bare,
        sync,
        restore,
        pushToOrigin,
        commitIn,
    };
}
