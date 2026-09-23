import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { containerScript as script } from './container-scripts.js';

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

/** The probe's node script: see scripts/git-probe.cjs. */
export const gitProbeScript = script('git-probe.cjs');

/** The startup sync's node script: see scripts/git-worktree.cjs. */
export const gitWorktreeScript = script('git-worktree.cjs');

/** The terminal reclaim's node script: see scripts/git-worktree-remove.cjs. */
export const gitWorktreeRemoveScript = script('git-worktree-remove.cjs');

/** The PR summary's node script: see scripts/pr-summary.cjs. */
export const prSummaryScript = script('pr-summary.cjs');

/** What the board intends to publish for one job. */
export interface PublishPlan {
    /** The task branch: `fix/<issue>` when the command names an issue, `task/<date>` otherwise. */
    branch: string;
    /**
     * The commit message — and the PR title's FALLBACK, for a branch the summarizer cannot
     * read (issue #82): the command's first line, with the issue reference appended.
     */
    title: string;
    /** The issue the command names, when it names one — the PR body closes it. */
    issueNumber: number | null;
}

/**
 * The issue a command names, in `publishPlan`'s precedence order: a full `issues/\d+` URL, then
 * a `/fix <n>` command, then a bare `#\d+` mention. A match counts only when the digits end the
 * token — a trailing word character means they were a prefix (`44oops` is prose, not #44, while
 * `#44.` ends a sentence and still counts) — and the number is one GitHub could have issued:
 * positive, within the safe-integer range (`#0` is no issue, and past 2^53-1 `Number` stops
 * being a number at all).
 */
const commandIssue = (command: string): number | null => {
    for (const pattern of [/issues\/(\d+)/, /\/fix\s+#?(\d+)/, /#(\d+)/]) {
        const match = pattern.exec(command);
        if (!match || /[\w]/.test(command[match.index + match[0].length] ?? '')) continue;
        const issue = Number(match[1]);
        if (Number.isSafeInteger(issue) && issue > 0) return issue;
    }
    return null;
};

/**
 * The plan for one job. The command is the author's own prompt — an audit record, not
 * attacker-controlled content, but it still only ever becomes a `-m`/`--title` VALUE in direct
 * argv (execFile, no shell), never a fragment of one.
 */
/** The commit title / PR-title-fallback's cap: the command's first line, held to one line's worth. */
const COMMIT_TITLE_MAX_CHARS = 144;

export function publishPlan(job: BoardJob, now: Date = new Date()): PublishPlan {
    const issue = commandIssue(job.command);
    const firstLine = (job.command.trim().split('\n')[0] ?? '').trim().slice(0, COMMIT_TITLE_MAX_CHARS);
    const title = issue ? `${firstLine} (#${issue})` : firstLine;
    const branch = issue ? `fix/${issue}` : `task/${now.toISOString().slice(0, 10).replace(/-/g, '')}`;
    return { branch, title, issueNumber: issue };
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
    /**
     * What the publish actually landed, when it did: the repository the PR lives in, the branch
     * it pushed, and its base. Null on a no-op or a failed publish — the board records the
     * identity ONLY for work that reached GitHub, and a summary session's no-op must not spew a
     * phantom publication into a thread that never shipped one.
     */
    repository: string | null;
    /** The branch the PR targets — the origin default the task branched from. */
    baseBranch: string | null;
    prNumber: number | null;
}

/** The PR number a url names, or null when it does not point at a pull request. */
export const prNumberFromUrl = (url: string): number | null => {
    const match = /\/pull\/(\d+)\/?$/.exec(url.trim());
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
};

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
    repository: null,
    baseBranch: null,
    prNumber: null,
});

export const publishFailed = (reason: string): PublishResult => ({
    ok: false,
    published: false,
    branch: null,
    prUrl: null,
    reason,
    repository: null,
    baseBranch: null,
    prNumber: null,
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

/**
 * A uuid, asserted before it names a worktree directory or a branch segment. The one home for
 * this pattern (and the workspace and gate shapes below it): every other file that needs one
 * imports from here rather than restating it.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The workspace half: `<org>/<user id>`, the org-id shape server/src/auth/github.ts documents.
 * The value becomes the agent's working directory, and a validator narrower than the input
 * domain would fail every job on a legally-named workspace.
 */
export const WORKSPACE_PATH =
    /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The checkout key a gated run's environment is filed under, and the declared image: the key is
 * the task worktree the agent edits — `<org>/<uuid>/.worktrees/<root id>` (issue #35) — and is
 * interpolated into a working directory every gate command runs in, and the image is repo
 * content naming what executes. Shared by the docker and kubernetes gate managers, which assert
 * the same shapes before the same interpolation.
 */
export const GATE_KEY =
    /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\.worktrees\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same shape the board's `.bellows.yaml` parser enforces; re-asserted here, before argv. */
export const GATE_IMAGE = /^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/;

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

/** What the PR summary script answered — either half is optional; nulls mean "fall back". */
export interface PrSummary {
    title: string | null;
    body: string | null;
}

/** Pulls the PR summary's answer out of its stdout, tolerating anything else. */
export function parsePrSummary(stdout: string): PrSummary {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
        const p = JSON.parse(line) as Partial<PrSummary>;
        return {
            title: typeof p.title === 'string' && p.title ? p.title : null,
            body: typeof p.body === 'string' && p.body ? p.body : null,
        };
    } catch {
        return { title: null, body: null };
    }
}

/**
 * A branch name is about to become a `-w` path-adjacent argv value and a `gh --head` value. The
 * probe's names come from the checkout itself; the plan's are built here. Either way, assert the
 * shape a git branch can have before anything interpolates it.
 */
export const isBranchName = (name: string): boolean =>
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..');

/**
 * The push credential travels as an env-file value and is read by a git credential helper that
 * git itself spawns through a shell — the same `-e NAME`, never `-e NAME=value` rule the runner
 * obeys, so the token is in no argv anywhere. Pinned because it is the one place this feature
 * touches a secret.
 *
 * The helper is a FILE (scripts/credential-helper.sh) whose content becomes the value of
 * `-c credential.helper=`, so that one file carries no comments — its documentation lives here.
 * The leading `!` is git's own marker (gitcredentials(7)): a bang-prefixed helper value is a
 * shell SNIPPET — git strips the bang and spawns `sh -c '<snippet> <op>'`; without it git
 * prefixes `git credential-` to the whole string and the code never runs. Git appends the
 * operation to the value VERBATIM, so the constant is the file TRIMMED: the file keeps its
 * POSIX trailing newline, but in the value that newline strands ` get` on a second line and
 * the helper exits 127 after answering — git only happens to keep a dead helper's stdout
 * (observed 2026-09-13, job 43379d3a: `get: 2: get: not found` in the publish container).
 * The scripts suite pins the exact spawn shape and its exit status.
 */
export const CREDENTIAL_HELPER = script('credential-helper.sh').trim();

/**
 * Lays a publish-fresh credential over the claim env, in one place: the claim's
 * `GITHUB_TOKEN` was minted at claim time and a long run can outlive it (observed 2026-09-13,
 * job 43379d3a — a 1h33m run's push died on its expired claim credential with the work done
 * and the gates green), so the loop asks the board for a fresh answer right before the push.
 * The docker env-file body and the kubernetes Secret are both built from `envFileBody(job)`,
 * so the override must live on the job, not in either transport. Undefined — the board held
 * nothing fresher, or the ask failed — leaves the job untouched.
 */
export const withPublishToken = (job: BoardJob, publishToken?: string): BoardJob =>
    publishToken ? { ...job, env: { ...job.env, GITHUB_TOKEN: publishToken } } : job;

/**
 * One publish step, as the platform-agnostic workflow hands it to a platform transport. The
 * decisions the two executors must never let drift — branch reuse, the fallback identity,
 * `--force-with-lease`, PR reuse — live in `publishCheckout` below; this is only WHAT to run,
 * and the transport decides where a container running it comes from (`docker run --rm` with a
 * swapped entrypoint on one platform, a batch Job whose `command` is the same argv on the other).
 */
export interface PublishStep {
    /** The step's name in failure messages — "git push", the tool's own words. */
    label: string;
    /** The executable the container runs: docker's `--entrypoint`, the k8s command head. */
    entrypoint: 'git' | 'gh' | 'node';
    /** The full argv after the entrypoint, exactly what the docker runner passes after the image. */
    args: string[];
    /** Whether the step needs the claim env — the token the push and the PR calls read. */
    env: boolean;
    /** Literal env values, always paths or code and never credentials: the `REPO` the probe reads. */
    envLiterals?: Record<string, string>;
    /** Whether the step runs inside the task worktree (a working directory). */
    inRepo: boolean;
}

/**
 * Runs one publish step and answers its stdout. Rejects on a nonzero exit with the tool's own
 * output — the same extraction the docker runner performs on execFile's stderr — because the
 * workflow wraps it with the step's name, and a failure must name its step and carry the one
 * line a human can act on ("remote: Permission to ..." lives in git's stderr).
 */
export type RunPublishStep = (step: PublishStep) => Promise<{ stdout: string }>;

/** The step wrapper's error-message cap — a stray tool trace must not blow out the failure reason. */
const STEP_ERROR_MAX_CHARS = 300;
/** The final failure reason's cap — reported to the board, not a log; kept to one glance. */
const PUBLISH_FAILURE_MAX_CHARS = 400;

/**
 * Probes the checkout. A probe that cannot run reads as no state at all — the caller's
 * no-op-with-reason path, never a crash.
 */
async function probeCheckout(runStep: RunPublishStep, repo: string): Promise<GitState> {
    const probe = await runStep({
        label: 'probe',
        entrypoint: 'node',
        args: ['-e', gitProbeScript],
        env: false,
        envLiterals: { REPO: repo },
        inRepo: false,
    }).catch(() => null);
    return parseGitState(probe?.stdout ?? '');
}

/**
 * Resolves the branch to publish on, switching (or creating) it when the checkout is still on
 * the default branch. A task never lands on the default branch, and an existing task branch is
 * reused — `switch -c` only when the branch is not there yet, so earlier attempts' commits
 * survive.
 */
async function ensureTaskBranch(
    runStep: RunPublishStep,
    step: RunPublishStep,
    state: GitState,
    plan: PublishPlan
): Promise<string> {
    const onDefault = !state.branch || state.branch === state.defaultBranch;
    const branch = onDefault ? plan.branch : state.branch;
    if (!isBranchName(branch)) {
        throw new Error(`refusing to publish a branch named "${branch}"`);
    }
    if (onDefault) {
        const switched = await runStep({
            label: 'git switch',
            entrypoint: 'git',
            args: ['switch', branch],
            env: false,
            inRepo: true,
        }).catch(() => null);
        if (!switched) {
            await step({
                label: 'git switch',
                entrypoint: 'git',
                args: ['switch', '-c', branch],
                env: false,
                inRepo: true,
            });
        }
    }
    return branch;
}

/**
 * Stages and commits the checkout's dirty tree. The checkout usually has no committer identity
 * (the agent does not need one to edit); a fallback is applied only when the probe found none,
 * so a member-configured identity is never overridden.
 */
async function commitDirtyTree(step: RunPublishStep, state: GitState, title: string): Promise<void> {
    await step({ label: 'git add', entrypoint: 'git', args: ['add', '-A'], env: false, inRepo: true });
    const identity = state.hasIdentity
        ? []
        : ['-c', 'user.name=factory-ai', '-c', 'user.email=factory-ai@users.noreply.github.com'];
    await step({
        label: 'git commit',
        entrypoint: 'git',
        args: [...identity, 'commit', '-m', title],
        env: false,
        inRepo: true,
    });
}

/**
 * Reuses the branch's PR when one exists — a task that already shipped its PR gets idempotent
 * publishes, not duplicates — or opens one summarized from the branch's own commits and diff.
 */
async function resolveOrCreatePr(
    runStep: RunPublishStep,
    step: RunPublishStep,
    context: { branch: string; plan: PublishPlan; state: GitState }
): Promise<string | null> {
    const { branch, plan, state } = context;
    // A `pr view` that fails is the ordinary "no PR yet", not a step failure: the next call
    // creates one.
    const existing = await runStep({
        label: 'gh pr view',
        entrypoint: 'gh',
        args: ['pr', 'view', branch, '--json', 'url', '-q', '.url'],
        env: true,
        inRepo: true,
    }).catch(() => null);
    const reused = existing ? (existing.stdout.trim().split('\n').filter(Boolean).pop() ?? null) : null;
    if (reused) return reused;

    // The PR speaks for the work, not for the command that started it (issue #82): a
    // summarizer script reads the branch — its commits and the diff against the default
    // — in the same throwaway-container shape as every other step. It needs no
    // credential (local git reads only) and its failure is decoration: the
    // command-derived plan title and the plain body stay the fallback.
    const summarized = await runStep({
        label: 'pr summary',
        entrypoint: 'node',
        args: ['-e', prSummaryScript],
        env: false,
        envLiterals: { BASE: `origin/${state.defaultBranch}` },
        inRepo: true,
    })
        .then((r) => parsePrSummary(r.stdout))
        .catch(() => null);
    let title = summarized?.title ?? plan.title;
    // The ref is appended only when the branch's own title does not already END with it
    // — the driver's own backstop commit and the repo's commit convention both close
    // with `(#N)`, and a subject that merely MENTIONS the issue must not suppress it.
    if (summarized?.title && plan.issueNumber && !summarized.title.endsWith(`(#${plan.issueNumber})`)) {
        title = `${summarized.title} (#${plan.issueNumber})`;
    }
    const body = [
        summarized?.body,
        plan.issueNumber ? `Closes #${plan.issueNumber}.` : null,
        'Published by the factory board after the declared gates passed.',
    ]
        .filter(Boolean)
        .join('\n\n');
    const created = await step({
        label: 'gh pr create',
        entrypoint: 'gh',
        args: ['pr', 'create', '--head', branch, '--title', title, '--body', body],
        env: true,
        inRepo: true,
    });
    return created.stdout.trim().split('\n').filter(Boolean).pop() ?? null;
}

/**
 * The publish workflow both executors run: probe the checkout, branch, commit, push, open (or
 * reuse) the PR — every decision that must not drift between platforms, over an injected
 * transport. The docker runner's transport is one `docker run` per step; the kubernetes
 * runner's is one aux Job per step. Same steps, same order, same failure messages, so a
 * publish that fails reads identically wherever it ran.
 */
export async function publishCheckout(
    config: DriverConfig,
    job: BoardJob,
    runStep: RunPublishStep
): Promise<PublishResult> {
    const repo = worktreeDir(config, job);
    // Null here means a COMMAND-ONLY job — the loop refuses a repo job whose worktree cannot
    // resolve before anything runs — and a command-only job has nothing to publish by
    // construction. That is the ordinary no-op, not a failure: reporting it as publishFailed
    // failed every exit-0 command-only run, the main phase of the e2e suite included.
    if (!repo) return publishNothing('the job names no checkout — nothing to publish');

    /** Wraps the transport's rejection with the step's name — docker's own runStep shape. */
    const step = async (publish: PublishStep): Promise<{ stdout: string }> => {
        try {
            return await runStep(publish);
        } catch (e) {
            throw new Error(`${publish.label}: ${(e as Error).message.slice(0, STEP_ERROR_MAX_CHARS)}`);
        }
    };

    try {
        const plan = publishPlan(job);

        // What is there to publish? A checkout that was never cloned and a clean, fully-pushed
        // tree are the two ordinary no-ops; everything else flows.
        const state = await probeCheckout(runStep, repo);
        if (!state.cloned) return publishNothing('the checkout has not been cloned yet');
        if (!state.dirty && state.unpushed === 0) {
            return publishNothing('no uncommitted changes and nothing unpushed');
        }

        const branch = await ensureTaskBranch(runStep, step, state, plan);

        if (state.dirty) {
            await commitDirtyTree(step, state, plan.title);
        }

        await step({
            label: 'git push',
            entrypoint: 'git',
            args: [
                '-c',
                `credential.helper=${CREDENTIAL_HELPER}`,
                'push',
                '-u',
                '--force-with-lease',
                'origin',
                'HEAD',
            ],
            env: true,
            inRepo: true,
        });

        // Reuse the branch's PR when one exists, or open one — see resolveOrCreatePr.
        const prUrl = await resolveOrCreatePr(runStep, step, { branch, plan, state });

        return {
            ok: true,
            published: true,
            branch,
            prUrl,
            reason: null,
            repository: job.repo ?? null,
            baseBranch: state.defaultBranch ?? null,
            prNumber: prNumberFromUrl(prUrl ?? ''),
        };
    } catch (e) {
        return publishFailed(`${(e as Error).message}`.slice(0, PUBLISH_FAILURE_MAX_CHARS));
    }
}
