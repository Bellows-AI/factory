import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { readFileSync } from 'node:fs';

/**
 * Publishing the work a run produced. The policy lives in the loop — a successful run, gates
 * passed, nothing asks — and the mechanics here: what the branch and commit message should be,
 * and the exact `docker run` argv of every step. Pure and exported for the same pinning as
 * dockerArgs: everything security-relevant about publishing (which values interpolate where, and
 * how the push credential travels) is decided in these arrays.
 *
 * The publisher is a BACKSTOP, not the primary author: the executor's AGENTS.md tells the agent
 * to work on a task branch and commit as it goes, and the board's gates run the declared checks
 * again after the agent finishes. This path exists because instructions are not enforcement — a
 * run that "succeeded" while leaving its work uncommitted in a local checkout did not land
 * anywhere, and nobody was asked.
 */

/**
 * The container scripts this module ships: real files under `driver/src/scripts/`, read at load
 * time and passed to the container by content (`node -e`, `sh -c`, a git credential helper) —
 * never inline template strings in TS, and never by mounting a path (the driver talks to a
 * remote daemon and has no host path into the volumes it names). Under tsx and vitest this
 * resolves into `src/scripts/`; in the built driver into `dist/scripts/`, where the build copies
 * the directory — forgetting THAT copy fails only in the container, the server/migrations trap.
 */
const script = (name: string): string => readFileSync(new URL(`./scripts/${name}`, import.meta.url), 'utf8');

/** The probe's node script: see scripts/git-probe.cjs. */
export const gitProbeScript = script('git-probe.cjs');

/** The startup sync's node script: see scripts/git-worktree.cjs. */
export const gitWorktreeScript = script('git-worktree.cjs');

/** The terminal reclaim's node script: see scripts/git-worktree-remove.cjs. */
export const gitWorktreeRemoveScript = script('git-worktree-remove.cjs');

/** What the board intends to publish for one job. */
export interface PublishPlan {
    /** The task branch: `fix/<issue>` when the command names an issue, `task/<date>` otherwise. */
    branch: string;
    /** The commit / PR title: the command's first line, with the issue reference appended. */
    title: string;
    /** The issue the command names, when it names one — the PR body closes it. */
    issueNumber: number | null;
}

/**
 * The plan for one job. The command is the author's own prompt — an audit record, not
 * attacker-controlled content, but it still only ever becomes a `-m`/`--title` VALUE in direct
 * argv (execFile, no shell), never a fragment of one.
 */
export function publishPlan(job: BoardJob, now: Date = new Date()): PublishPlan {
    const issue = /issues\/(\d+)/.exec(job.command)?.[1] ?? /#(\d+)/.exec(job.command)?.[1] ?? null;
    const firstLine = (job.command.trim().split('\n')[0] ?? '').trim().slice(0, 72);
    const title = issue ? `${firstLine} (#${issue})` : firstLine;
    const branch = issue ? `fix/${issue}` : `task/${now.toISOString().slice(0, 10).replace(/-/g, '')}`;
    return { branch, title, issueNumber: issue ? Number(issue) : null };
}

/** What a probe of the checkout found, and what every later step branches on. */
export interface GitState {
    /** False when the directory is not a git checkout at all — a just-connected repository. */
    cloned: boolean;
    /** The current branch, or '' when HEAD is detached. */
    branch: string;
    /** The origin default branch — the one a task branch must not commit to. */
    defaultBranch: string;
    /** Uncommitted changes exist. */
    dirty: boolean;
    /** Commits on this branch that origin does not have. */
    unpushed: number;
    /** The checkout has a committer identity configured; the fallback is only applied when not. */
    hasIdentity: boolean;
}

/** What the publish attempt answers to the loop. */
export interface PublishResult {
    /** False means the verdict must not be success: the work did not land and the reason says why. */
    ok: boolean;
    /** True when a branch was pushed (a PR url is then expected beside it). */
    published: boolean;
    branch: string | null;
    prUrl: string | null;
    reason: string | null;
}

/** What the startup sync answers: ok, or the reason the run should not start from a stale tree. */
export interface SyncResult {
    ok: boolean;
    reason: string | null;
}

/** What the terminal reclaim answers: ok, whether anything was removed, or the reason it did not. */
export interface ReclaimResult {
    ok: boolean;
    /**
     * True when the task tree no longer exists after the call: it was removed, or it was already
     * gone. False when the reclaim refused (the tree stays) or there was nothing to reclaim because
     * the thread never touched the volume.
     */
    removed: boolean;
    reason: string | null;
}

/** Nothing to publish: no checkout, or a clean tree with nothing unpushed. Not an error. */
export const publishNothing = (reason: string): PublishResult => ({
    ok: true,
    published: false,
    branch: null,
    prUrl: null,
    reason,
});

export const publishFailed = (reason: string): PublishResult => ({
    ok: false,
    published: false,
    branch: null,
    prUrl: null,
    reason,
});

/**
 * The repo directory of the job's clone: `<mount>/<workspacePath>/<repo segment>`. Both halves
 * are asserted before they join a path — the same rule every board-supplied value obeys before it
 * becomes part of an argv or a filesystem location, because the board's own shape validation is
 * not this process's to trust.
 */
export function repoPath(config: DriverConfig, job: BoardJob): string | null {
    if (!job.workspacePath || !/^[a-zA-Z0-9-]+\/[0-9a-fA-F-]{36}$/.test(job.workspacePath)) return null;
    const segment = job.repo?.split('/')[1];
    // '.' and '..' are valid by character but are the traversal themselves.
    if (!segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment)) return null;
    return `${config.workspaceMount}/${job.workspacePath}/${segment}`;
}

/** A uuid, asserted before it names a worktree directory or a branch segment. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The workspace half, COPIED from docker.ts's WORKSPACE_PATH (which copied it from the server's
 * ORG_ID_PATTERN): the value becomes the agent's working directory, and a validator narrower
 * than the input domain would fail every job on a legally-named workspace — the trap every
 * copied pattern here exists to avoid.
 */
const WORKSPACE_PATH = /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The task worktree of the job's clone, RELATIVE to the mount:
 * `<workspacePath>/.worktrees/<thread root id>` — or null when the job names no repository (a
 * command-only job runs at the member root, where it always did) or any half fails its assertion.
 *
 * The key is the thread's ROOT job id — this job's own, unless it is a follow-up, and then the
 * chain's first job. One task thread = one workspace (issue #35): every attempt of the job, and
 * every follow-up resuming its session, lands in the same tree, branched off the remote default.
 * Per-JOB keying was rejected because a follow-up would then start a fresh tree off main,
 * orphaning the conversation and the parent's unmerged work.
 *
 * The `.worktrees/` segment is the driver's own namespace beside the checkouts, which the
 * workspace reconcile never creates, reads, or prunes (its naming rules refuse a leading dot, the
 * same protection `.opencode` relies on).
 */
export function worktreeRelDir(job: BoardJob): string | null {
    if (!job.workspacePath || !WORKSPACE_PATH.test(job.workspacePath)) return null;
    const segment = job.repo?.split('/')[1];
    if (!segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment)) return null;
    const root = job.rootJobId ?? job.id;
    if (!UUID.test(root)) return null;
    return `${job.workspacePath}/.worktrees/${root}`;
}

/** The absolute worktree path inside the mounted volume, or null when the job has none. */
export function worktreeDir(config: DriverConfig, job: BoardJob): string | null {
    const rel = worktreeRelDir(job);
    return rel ? `${config.workspaceMount}/${rel}` : null;
}

/**
 * The branch the task worktree runs on: `factory/<thread root id>`. Created at
 * `origin/<default>` on the first sync; rebased onto it on every later one. A branch per thread,
 * never per attempt — a re-claimed attempt continues the same branch its predecessor edited.
 */
export function worktreeBranch(job: BoardJob): string {
    return `factory/${job.rootJobId ?? job.id}`;
}

/** Pulls the probe's answer out of its stdout, tolerating anything else. */
export function parseGitState(stdout: string): GitState {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
        const p = JSON.parse(line) as Partial<GitState>;
        return {
            cloned: p.cloned === true,
            branch: typeof p.branch === 'string' ? p.branch : '',
            defaultBranch: typeof p.defaultBranch === 'string' && p.defaultBranch ? p.defaultBranch : 'main',
            dirty: p.dirty === true,
            unpushed: typeof p.unpushed === 'number' && Number.isFinite(p.unpushed) && p.unpushed >= 0 ? p.unpushed : 0,
            hasIdentity: p.hasIdentity === true,
        };
    } catch {
        return { cloned: false, branch: '', defaultBranch: 'main', dirty: false, unpushed: 0, hasIdentity: false };
    }
}

/**
 * A branch name is about to become a `-w` path-adjacent argv value and a `gh --head` value. The
 * probe's names come from the checkout itself; the plan's are built here. Either way, assert the
 * shape a git branch can have before anything interpolates it.
 */
export const isBranchName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..');

/**
 * The push credential travels as an env-file value and is read by a git credential helper that
 * git itself spawns through a shell — the same `-e NAME`, never `-e NAME=value` rule the runner
 * obeys, so the token is in no argv anywhere. Pinned because it is the one place this feature
 * touches a secret.
 *
 * The helper is a FILE (scripts/credential-helper.sh) read verbatim, because its content IS the
 * value of `-c credential.helper=`: a comment line would ship inside the helper, so that one
 * file deliberately carries no comments — its documentation lives here.
 */
export const CREDENTIAL_HELPER = script('credential-helper.sh');
