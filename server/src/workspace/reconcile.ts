import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { UUID, type Repo } from '../config.js';

/**
 * One clone, into one member's workspace at `<root>/<orgId>/<userId>/<name>`.
 *
 * This was `ensureWorkspace()`, which looped over the organization's configured repos at boot and
 * cloned them all into one shared tree. Checkouts are per member now — chosen from the dashboard,
 * cloned in the background — so the loop moved to `workspace/queue.ts` and what is left here is the
 * single-repo operation and the rules about touching a working tree.
 *
 * Those rules are unchanged, and every one of them is about the same thing: the tree may hold
 * uncommitted work belonging to a Claude Code session, and this process cannot tell.
 */

const run = promisify(execFile);

/** The variable the credential helper below reads. Never appears on a command line. */
const TOKEN_VAR = 'GIT_WORKSPACE_TOKEN';

/** `present` means a checkout was already there and was left completely alone. */
export type CloneOutcome = 'cloned' | 'present';

export type GitRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

export interface CloneOptions {
    readonly root: string;
    readonly orgId: string;
    readonly userId: string;
    readonly repo: Repo;
    /** Optional: without one, only public repos clone. A missing token is a supported state. */
    readonly token?: string | undefined;
    readonly log?: (message: string) => void;
    /** Test seam: lets the suite clone from a local bare repo over file://, with no network. */
    readonly cloneUrl?: ((repo: Repo) => string) | undefined;
    /** Test seam: lets the suite assert on argv and the child environment without running git. */
    readonly run?: GitRunner | undefined;
}

/**
 * Where one member's checkouts live.
 *
 * The segment and the repo name sit at different depths, so neither can shadow the other — the same
 * arrangement `<orgId>/<name>` had.
 */
export function workspaceDir(root: string, orgId: string, userId: string): string {
    /*
     * The uuid is asserted before it is joined into a path.
     *
     * 010_auth.sql chose a uuid for `app_user.id` partly for this: it "becomes a docker volume name
     * component and a workspace path segment sitting next to repo names, and a uuid can collide
     * with neither". Checking rather than trusting the caller is the posture `driver/src/docker.ts`
     * takes with a session id before interpolating one into a command — that package keeps its own
     * copy of the pattern because it depends on nothing, but inside the server there is one.
     */
    if (!UUID.test(userId)) {
        throw new Error(`refusing to build a workspace path from a user id that is not a uuid: ${userId}`);
    }
    return join(root, orgId, userId);
}

function httpsUrl(repo: Repo): string {
    return `https://github.com/${repo.owner}/${repo.name}.git`;
}

async function defaultRunner(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
    await run('git', [...args], { env });
}

/**
 * The token reaches git through the environment, and only the helper *snippet* — which references
 * the variable — reaches argv. A token in the clone URL would be world-readable in
 * `/proc/<pid>/cmdline` and, worse, git writes the URL permanently into `.git/config`: every later
 * `git remote get-url origin` would print it, including the one `backfill/transcripts.ts` runs to
 * attribute sessions to a repo.
 *
 * The empty `credential.helper` first clears any helper inherited from the user's global config
 * (osxkeychain, store), which would otherwise answer first with a stale credential.
 */
function gitArgs(url: string, dest: string, authenticated: boolean): string[] {
    const args = ['-c', 'credential.helper='];
    if (authenticated) {
        args.push(
            '-c',
            `credential.helper=!f(){ test "$1" = get && echo username=x-access-token && echo "password=\${${TOKEN_VAR}}"; }; f`
        );
    }
    // Not --depth 1: a reused branch has to be built on in place, which needs the history
    // (docs/workspace.md).
    // `--` so a repo name that somehow reached here as "-x" is still a path.
    return [...args, 'clone', '--origin', 'origin', '--', url, dest];
}

export async function cloneRepo(options: CloneOptions): Promise<CloneOutcome> {
    const { root, orgId, userId, repo, token, log = () => {}, cloneUrl = httpsUrl } = options;
    const exec = options.run ?? defaultRunner;

    const userDir = workspaceDir(root, orgId, userId);
    const dest = join(userDir, repo.name);

    if (existsSync(join(dest, '.git'))) {
        log(`present ${repo.name}`);
        return 'present';
    }
    // Thrown, not counted: a non-repo directory here means the root points at the wrong tree, and
    // carrying on would scatter clones through somebody's home directory.
    if (existsSync(dest)) {
        throw new Error(`${dest} exists and is not a git checkout — refusing to clone over it`);
    }

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Without this a private repo with no usable credential blocks on stdin forever, and the
        // clone never returns — a hang rather than a reported failure.
        GIT_TERMINAL_PROMPT: '0',
        ...(token ? { [TOKEN_VAR]: token } : {}),
    };

    // Cloned aside and renamed into place, so a process killed mid-clone leaves no partial tree at
    // `dest`. One that did would be classified as "exists, not a checkout" on the next attempt and
    // would then fail forever. `queue.ts` sweeps the leftover staging directories at boot.
    const staging = `${dest}.tmp-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(userDir, { recursive: true });

    log(`cloning ${repo.owner}/${repo.name}`);
    const started = Date.now();
    try {
        await exec(gitArgs(cloneUrl(repo), staging, Boolean(token)), env);
        renameSync(staging, dest);
        log(`cloned ${repo.name} in ${Date.now() - started}ms`);
        return 'cloned';
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        // Thrown, where the old boot-time reconcile counted a failure and carried on. It swallowed
        // this because boot had nowhere to put a message; now there is a column called `error` and
        // a page that shows it, so the caller decides.
        throw error;
    }
}
