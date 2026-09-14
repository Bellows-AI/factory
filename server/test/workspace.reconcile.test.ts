import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Repo } from '../src/config.js';
import { cloneRepo, workspaceDir } from '../src/workspace/reconcile.js';

/**
 * Offline throughout: every clone here is `file://` from a bare repository this file creates, so
 * the suite keeps its "no network, no token, no database" contract.
 */

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

function git(cwd: string, ...args: string[]): void {
    execFileSync('git', [...GIT_FIXTURE_CONFIG, ...args], { cwd, stdio: 'ignore' });
}

/** A bare repo with one commit, cloneable over file://. */
function origin(dir: string, name: string): string {
    const work = join(dir, `${name}-work`);
    const bare = join(dir, `${name}.git`);
    mkdirSync(work, { recursive: true });
    git(work, 'init');
    writeFileSync(join(work, 'README.md'), `# ${name}\n`);
    git(work, 'add', 'README.md');
    git(work, 'commit', '-m', 'init');
    execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
    return bare;
}

const repos: Repo[] = [
    { owner: 'acme', name: 'widgets' },
    { owner: 'acme', name: 'gadgets' },
];

const USER = '11111111-2222-3333-4444-555555555555';

describe('workspaceDir', () => {
    it("puts a member's checkouts under their user id", () => {
        expect(workspaceDir('/srv/f', 'acme', USER)).toBe(`/srv/f/acme/${USER}`);
    });

    it('refuses a user id that is not a uuid, before it becomes a path', () => {
        /*
         * 010_auth.sql chose a uuid for app_user.id partly so that this segment could never collide
         * with a repo name. Asserting it rather than trusting the caller is the posture
         * driver/src/docker.ts already takes with a session id before interpolating one — and here
         * the value would become a directory next to somebody else's checkouts.
         */
        for (const bad of ['..', 'alice', '../../etc', '']) {
            expect(() => workspaceDir('/srv/f', 'acme', bad), bad).toThrow(/not a uuid/);
        }
    });
});

describe.skipIf(!hasGit())('cloning into a member workspace', () => {
    let dir: string;
    let root: string;
    let cloneUrl: (repo: Repo) => string;

    const clone = (repo: Repo, extra: Record<string, unknown> = {}) =>
        cloneRepo({ root, orgId: 'acme', userId: USER, repo, cloneUrl, ...extra });

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'factory-reconcile-'));
        root = join(dir, 'workspaces');
        const origins = new Map(repos.map((repo) => [repo.name, origin(dir, repo.name)]));
        cloneUrl = (repo) => `file://${origins.get(repo.name)}`;
    });

    it('clones to <root>/<orgId>/<userId>/<name>', async () => {
        for (const repo of repos) expect(await clone(repo)).toBe('cloned');

        expect(readdirSync(join(root, 'acme', USER)).sort()).toEqual(['gadgets', 'widgets']);
        expect(existsSync(join(root, 'acme', USER, 'widgets', '.git'))).toBe(true);
    });

    it("keeps two members' checkouts of the same repo apart", async () => {
        const other = '99999999-8888-7777-6666-555555555555';
        await clone(repos[0] as Repo);
        await cloneRepo({ root, orgId: 'acme', userId: other, repo: repos[0] as Repo, cloneUrl });

        expect(existsSync(join(root, 'acme', USER, 'widgets', '.git'))).toBe(true);
        expect(existsSync(join(root, 'acme', other, 'widgets', '.git'))).toBe(true);
    });

    it('leaves an existing checkout untouched, including uncommitted work', async () => {
        await clone(repos[0] as Repo);
        const scratch = join(root, 'acme', USER, 'widgets', 'NOTES.md');
        writeFileSync(scratch, 'in progress');

        // No fetch, no reset, no branch change. The tree may hold work belonging to an agent
        // session, and this process cannot tell.
        expect(await clone(repos[0] as Repo)).toBe('present');
        expect(readFileSync(scratch, 'utf8')).toBe('in progress');
    });

    it('refuses to clone over a directory that is not a checkout', async () => {
        // The root points at the wrong tree. Carrying on would scatter clones through it.
        mkdirSync(join(root, 'acme', USER, 'widgets'), { recursive: true });

        await expect(clone(repos[0] as Repo)).rejects.toThrow(/exists and is not a git checkout/);
    });

    it('throws on a failed clone and leaves nothing behind for it', async () => {
        // Thrown, where the boot-time reconcile used to count a failure and carry on: it swallowed
        // the message because boot had nowhere to put one, and now there is a column called `error`.
        await expect(
            cloneRepo({
                root,
                orgId: 'acme',
                userId: USER,
                repo: { owner: 'acme', name: 'missing' },
                cloneUrl: () => `file://${join(dir, 'nonexistent.git')}`,
            })
        ).rejects.toThrow();

        // Neither the destination nor the staging directory outlives the failure — a partial tree
        // would be classified as "exists, not a checkout" on the next attempt and fail forever.
        expect(readdirSync(join(root, 'acme', USER))).toEqual([]);
    });

    it('passes the token through the environment, never on the command line', async () => {
        const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];

        await clone(repos[0] as Repo, {
            token: 'ghs_secret',
            run: async (args: readonly string[], env: NodeJS.ProcessEnv) => {
                calls.push({ args, env });
                // The caller renames the staging directory into place, so it has to exist.
                mkdirSync(args[args.length - 1] as string, { recursive: true });
            },
        });

        const [call] = calls;
        // argv is world-readable in /proc/<pid>/cmdline, and a token in the clone URL would also be
        // written permanently into .git/config, where `git remote get-url` leaks it.
        expect(call?.args.join(' ')).not.toContain('ghs_secret');
        expect(call?.args.join(' ')).toContain('credential.helper');
        expect(call?.env.GIT_WORKSPACE_TOKEN).toBe('ghs_secret');
        // Otherwise an unauthenticated private clone blocks on stdin and hangs forever.
        expect(call?.env.GIT_TERMINAL_PROMPT).toBe('0');
    });

    it('does not offer a credential when there is no token, since running without one is supported', async () => {
        const seen: string[][] = [];

        await clone(repos[0] as Repo, {
            run: async (args: readonly string[]) => {
                seen.push([...args]);
                mkdirSync(args[args.length - 1] as string, { recursive: true });
            },
        });

        expect(seen[0]?.join(' ')).not.toContain('x-access-token');
        expect(seen[0]).not.toContain('GIT_WORKSPACE_TOKEN');
    });

    it('clones full history, because revert detection reads it', async () => {
        const seen: string[][] = [];
        await clone(repos[0] as Repo, {
            run: async (args: readonly string[]) => {
                seen.push([...args]);
                mkdirSync(args[args.length - 1] as string, { recursive: true });
            },
        });
        expect(seen[0]).not.toContain('--depth');
    });
});
