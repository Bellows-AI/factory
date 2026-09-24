/**
 * What a claim resolves to inside any runner, whichever executor starts it: the workspace and
 * working-directory paths, the transcript and opencode-database locations, the gate identity, and
 * the claim env (with the driver's reserved names) the runner receives. The docker runner renders
 * these into `docker run` flags, the kubernetes runner into a Job spec — the values must match.
 */

import type { DriverConfig } from './config.js';
import type { BoardJob } from './board.js';
import { OPENCODE } from './executors.js';
import { opencodeConfigContent } from './master-prompt.js';
import { UUID, WORKSPACE_PATH, worktreeDir } from './publish.js';

export { UUID };

/**
 * What an agent session id may look like before it is interpolated into runner argv — claude's
 * uuids and opencode's `ses_…` both qualify, and nothing shell-shaped does. The id on a resume
 * claim comes from the board, and a board is not something this process trusts with a fragment of
 * a command. Copied from server/src/routes/jobs.ts, which states the same rule for the report:
 * this package depends on nothing, deliberately. Exported because the kubernetes runner asserts
 * the same id before the same interpolation.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/**
 * The uid:gid the gate environment runs as, and the HOME it gets: the executor images' `USER
 * node` (uid 1000 in both Dockerfiles), which the runner, the sync and the reclaim containers all
 * run as. Gates write the shared task worktree, and every other writer on that tree is uid 1000 —
 * a gate writing as the declared image's own default (root, usually) would leave files the
 * uid-1000 reclaim can never remove. Exported because the kubernetes gate Job states the same
 * numbers as a securityContext (executor parity).
 */
export const GATE_UID = 1000;
export const GATE_GID = 1000;
/** HOME for the gate env's non-root uid — /tmp is world-writable where the image's own is not. */
export const GATE_HOME = '/tmp';

/**
 * The session database opencode writes under XDG_DATA_HOME, as the runner sets it: one directory
 * per member, next to their checkouts, on the workspaces volume.
 */
export function opencodeDbPath(config: DriverConfig, job: BoardJob): string {
    return `${config.workspaceMount}/${workspacePath(job)}/.opencode/opencode/opencode.db`;
}

/**
 * The working directory the runner gives a run: the task worktree when the job names a repository,
 * the member root where a command-only job always started. This is the exact string opencode
 * records as the session's `directory` column, which makes it the close-time readout's scope key
 * too — one expression here because the run's WORKDIR and the readout's OPENCODE_DIR must never
 * drift apart: a scope key that misses is a scrape that answers nothing.
 */
export function runWorkingDir(config: DriverConfig, job: BoardJob): string {
    return worktreeDir(config, job) ?? `${config.workspaceMount}/${workspacePath(job)}`;
}

/**
 * The transcript store a headless claude-code run is pointed at: one directory per THREAD ROOT on
 * the workspaces volume, passed to the runner as `FACTORY_TRANSCRIPT_DIR`. The entrypoint makes it
 * `CLAUDE_CONFIG_DIR` (guarded, headless only), so the CLI writes its transcripts onto the volume
 * the moment it writes them — no post-run copy, nothing dies with the container — and a follow-up's
 * `--resume` finds the thread's earlier sessions in the same directory it runs in. The root is the
 * claim's worktree key (`rootJobId ?? id`), which is what makes every attempt and follow-up of one
 * thread land in one directory.
 *
 * Both board-supplied halves are asserted before they join the path, exactly like `runWorkingDir`:
 * the value becomes a filesystem path inside a container that runs the agent, and neither the
 * workspace path nor the root id (which a board predating the field omits, making the job its own
 * root) is something this process trusts unasserted.
 */
export function transcriptDir(config: DriverConfig, job: BoardJob): string {
    const path = workspacePath(job);
    const root = job.rootJobId ?? job.id;
    if (!UUID.test(root)) {
        throw new Error(`refusing to run job ${job.id}: a thread root id that is not a uuid: ${root}`);
    }
    return `${config.workspaceMount}/${path}/.factory/transcripts/${root}`;
}

/**
 * The full `docker run` argument list. Pure, and exported, because it is the part worth pinning in
 * a test: everything security-relevant about a runner is decided here.
 *
 * The session id is minted by the caller, not read back out of the container. An interactive Remote
 * Control session reports its state into a TUI rather than onto stdout, so there is nothing
 * parseable to scrape — and a runner that dies early would leave the job with no session at all.
 */
/**
 * The job's workspace, or a refusal. Exported so `loop.ts` can fail a job cleanly rather than
 * letting `dockerArgs` throw halfway through building a command.
 */
export function workspacePathOf(job: BoardJob): string | null {
    return job.workspacePath && WORKSPACE_PATH.test(job.workspacePath) ? job.workspacePath : null;
}

export function workspacePath(job: BoardJob): string {
    const path = workspacePathOf(job);
    if (!path) {
        throw new Error(
            `refusing to run job ${job.id}: the board reported no usable workspace path (${job.workspacePath ?? 'null'})`
        );
    }
    return path;
}

/**
 * The names the runner's own contract claims — WORKDIR is the working directory dockerArgs itself
 * sets, the two BELLOWS_GATE_ names are the
 * ad-hoc gate credentials the loop mints per attempt, CRED_HELPER is the credential-helper CODE
 * the sync fetch runs, RESTORE is the sync's restore-mode switch (a member value there would
 * flip starting claims into restore mode, silently skipping the fetch and rebase issue #58
 * reserves for continuations), FACTORY_TRANSCRIPT_DIR is where the headless transcript store
 * lives — the driver composes it (transcriptDir), and a member value would steer transcripts,
 * and through the entrypoint's redirect the CLI's whole config dir, somewhere else — and the
 * three reporter names steer the branch reporter — where it posts, which attempt it speaks for,
 * and which session it claims. A member value in any of them is a cross-tenant write into the
 * telemetry store; CRED_HELPER above all: a member value there is member-controlled code the
 * sync container's git executes as helper code. Mirrored at the board (RESERVED_ENV_NAMES in
 * server/src/routes/env.ts, where a PUT is refused); copied rather than imported, per this
 * package's zero-dependency rule. The board's list is a superset by two names:
 * OPENCODE_CONFIG_CONTENT and CLAUDE_CODE_CONFIG_CONTENT are reserved THERE — the claim
 * synthesizes each from the author's executor row, and a member env var would be silently
 * shadowed — but deliberately absent here, because `claimEnv` must let that synthesized value
 * flow to reach the runner.
 */
export const RESERVED_ENV_NAMES = [
    'WORKDIR',
    'BELLOWS_GATE_URL',
    'BELLOWS_GATE_TOKEN',
    'CRED_HELPER',
    'RESTORE',
    'FACTORY_TRANSCRIPT_DIR',
    'FACTORY_STATS_URL',
    'RUNNER_JOB_ID',
    'RUNNER_LEASE_TOKEN',
    'BELLOWS_SESSION_ID',
] as const;

/**
 * The environment the board resolved for this job, minus the reserved names. Pure and exported for
 * the pinned-argv test — this is the boundary where a claim's secrets become this process's data.
 *
 * The accumulator is prototype-less and the passEnv filter below checks own properties: names like
 * `__proto__` or `toString` pass the board's name validation, and both would otherwise be silently
 * dropped or wrongly shadow an operator's `RUNNER_ENV` name.
 */
export function claimEnv(job: BoardJob): Record<string, string> {
    const env: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(job.env ?? {})) {
        if ((RESERVED_ENV_NAMES as readonly string[]).includes(name)) continue;
        env[name] = value;
    }
    return env;
}

/**
 * `claimEnv`, plus the reserved OpenCode `factory` agent merged into `OPENCODE_CONFIG_CONTENT`
 * (issue #244) — the one place this overlay happens, so the real runner Secret/env-file and the
 * pod spec's key names (kubernetes) can never drift onto two different merges. Never applied to
 * an aux container (sync, gates, publish, helpers): none of them runs the agent CLI, so none of
 * them needs the reserved agent at all. Claude-code claims pass through untouched — the master
 * prompt reaches that CLI as an argv flag, never through env.
 */
export function runnerClaimEnv(job: BoardJob): Record<string, string> {
    const env = claimEnv(job);
    if (job.executorType !== OPENCODE) return env;
    return { ...env, OPENCODE_CONFIG_CONTENT: opencodeConfigContent(job, env.OPENCODE_CONFIG_CONTENT) };
}

/**
 * Whether the claim env carries a NON-EMPTY GITHUB_TOKEN — the condition under which the startup
 * sync's fetch is handed the credential-helper CODE. Git reads no token from the environment, and
 * the executor images ship no helper, so a private-repo fetch needs one; a public repo with no
 * token must keep its plain unauthenticated fetch, which a helper answering an empty password
 * would break. A present-but-empty token therefore counts as no token: the helper would break the
 * public-repo fetch it exists to preserve, and a private repo with an empty token fails auth
 * either way, honestly. Shared with the kubernetes syncJobSpec, which embeds the same code as a
 * literal.
 */
export const claimCarriesGithubToken = (job: BoardJob): boolean => Boolean(claimEnv(job).GITHUB_TOKEN);

/**
 * Whether the claim CONTINUES a session rather than starting a task: a follow-up. The task is
 * mid-flight, and the startup git work is a RESTORE, not a
 * sync — no fetch, no rebase onto the remote default (issue #58): the conversation's tree is
 * what the run continues from, and moving its base underneath it is the mid-task "sync with
 * main" the follow-up flow must not do. Lease-expired RE-claims of ordinary jobs are not
 * continuation: the claim clears a dead attempt's session, so the run starts — and syncs —
 * fresh. Shared with the kubernetes runner, which must restore identically.
 */
export const claimContinuesSession = (job: BoardJob): boolean => job.followUp || job.resumeSessionId !== null;

/**
 * One `NAME=value` line, refusing a newline in either half: the file is line-structured and docker
 * has no quoting for it, so a multiline value would arrive truncated with no error anywhere. The
 * board refuses one at PUT time; this is the driver's own line of defence against rows that
 * predate that check. The refusal names WHICH half carries the newline — blaming the name for the
 * value's offence sends a reader hunting through the env scopes for a variable that is fine.
 */
const envLine = (job: BoardJob, name: string, value: string): string => {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        const part = /[\r\n]/.test(name) ? 'name' : 'value';
        throw new Error(
            `refusing to write env file for job ${job.id}: the ${part} of "${name}" contains a newline, which an env file cannot carry`
        );
    }
    return `${name}=${value}`;
};

/**
 * The `--env-file` body for the runner: the claim env's lines, then the loop's minted gate
 * credentials, then the runner's own branch-ingest credential. Pure and exported for the same
 * pinning as dockerArgs. The config argument is optional and only ever adds the attempt pair —
 * aux containers (sync, publish, gates) are called without it and get no credential, because
 * none of them reports telemetry.
 */
export function envFileBody(job: BoardJob, config?: DriverConfig): string {
    // The reserved-agent overlay only ever applies to the real runner — every aux container
    // (sync, gates, publish, block-helpers) calls this with no config and gets the plain claim env.
    const lines = Object.entries(config ? runnerClaimEnv(job) : claimEnv(job)).map(([name, value]) =>
        envLine(job, name, value)
    );
    // The driver's own gate credentials go LAST. Docker's --env-file is last-duplicate-wins, so
    // the order is the precedence rule: a `BELLOWS_GATE_TOKEN` a member configured in any env
    // scope was already dropped from the claim lines (reserved names), and the lines here are the
    // driver's minted values — but keeping them visually and structurally after the claim's is
    // what makes "the driver wins a collision" readable in one place.
    for (const [name, value] of Object.entries(job.gateEnv ?? {})) {
        lines.push(envLine(job, name, value));
    }
    // The attempt pair is the one driver-side credential in the file, and it goes after
    // everything: same precedence rule, and the lines a reader audits for "what can authenticate
    // as this runner" are always the last ones. The reporter presents them as headers, and the
    // board resolves the org from the live attempt itself — never from the report's repo.
    if (config) {
        lines.push(envLine(job, 'RUNNER_JOB_ID', job.id));
        lines.push(envLine(job, 'RUNNER_LEASE_TOKEN', job.leaseToken));
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
}
