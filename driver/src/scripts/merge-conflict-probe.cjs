// The merge-conflict-autofix block's deterministic preflight (issue #122): runs as a PRE
// block-helper (issue #207's transport) in the task worktree — the docker/kubernetes transports
// both set the container's working directory to it, so every git call below runs against
// process.cwd() with no REPO/WORKTREE env needed, unlike the sync's own git-worktree.cjs. One
// JSON verdict on stdout, matching driver/src/helpers.ts's registered descriptor
// (schema "merge-conflict-probe/v1", version 1); the SAME object is also written to
// .factory/merge-conflict-probe.json in the worktree, because the generic helper transport
// surfaces only ok/fail to the loop — never a helper's own output — to the agent turn that
// follows, and that agent is how the issue's "invoke an agent only when conflicts need judgment"
// prompt reads this verdict.
//
// Input (HELPER_INPUT, issue #207): {"publication": {repo, prNumber, prUrl, headBranch,
// baseBranch} | null} — the thread's structured PR identity (issue #202), injected generically by
// the board's resolveClaimHelperPlans. No publication recorded for this thread is a hard
// precondition failure: there is nothing here to reconcile.
//
// GITHUB_TOKEN, when present (this helper always declares githubWriting: true): the fresh
// installation token the loop mints immediately before running a github-writing helper. The
// credential-helper CODE is a literal copy of scripts/credential-helper.sh — CRED_HELPER is a
// reserved claim env name the generic transport does not forward to a helper, and a script
// content-passed into a container cannot require() a sibling file, so every consumer of this
// pattern (this file, publish.ts's own CREDENTIAL_HELPER) carries its own copy.
//
// Verdict output.verdict, three shapes only — a "stale/refused" checkout state (wrong branch, no
// publication) is instead an ok:false helper FAILURE: the row fails without ever spawning the
// agent, and the next trigger of this block re-probes fresh, which is what the issue's "abort
// safely and re-probe" asks for.
//   "up-to-date"  — the branch already contains its base branch's tip. No rebase attempted.
//   "rebased"     — the base moved; the preflight rebased onto it with no conflicts.
//   "conflicted"  — the rebase hit conflicts; the tree is left mid-rebase, output.conflictingPaths
//                   bounded and listed, for the repair agent's `git rebase --continue`/`--abort`.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'merge-conflict-probe/v1';
const VERSION = 1;
const CONFLICTING_PATHS_MAX = 50;
const STATE_PATH = '.factory/merge-conflict-probe.json';
const ERROR_MAX_LENGTH = 200;

// The exact snippet driver/src/scripts/credential-helper.sh carries, trimmed the same way
// publish.ts's CREDENTIAL_HELPER is: git appends the credential operation to this value verbatim.
const CREDENTIAL_HELPER = '! f(){ printf "username=x-access-token\\n"; printf "password=%s\\n" "$GITHUB_TOKEN"; }; f';

const emit = (line) => {
    console.log(JSON.stringify(line));
    try {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, `${JSON.stringify(line)}\n`);
    } catch {
        // The state file is how the repair agent reads this verdict; a write failure still
        // leaves the stdout verdict for the driver, so this is never fatal to the probe itself.
    }
};

const ok = (output) => emit({ schema: SCHEMA, version: VERSION, ok: true, output });
const fail = (reason, error) => emit({ schema: SCHEMA, version: VERSION, ok: false, reason, error });

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const errText = (e) => String((e && e.stderr) || (e && e.message) || e).slice(0, ERROR_MAX_LENGTH);

/** { ok: true, publication } or { ok: false } — a refusal already emitted. */
function resolvePublication() {
    let input;
    try {
        input = JSON.parse(process.env.HELPER_INPUT || 'null');
    } catch {
        input = null;
    }
    const publication = input && typeof input === 'object' ? input.publication : null;
    if (!publication || !publication.repo || !publication.headBranch || !publication.baseBranch) {
        fail('runner_error', 'no recorded PR publication for this thread — nothing to reconcile');
        return { ok: false };
    }
    return { ok: true, publication };
}

/**
 * Asserts the worktree stands on the PR's own head branch, and clears any mid-rebase state a
 * previous, unfinished attempt left — never trust it, always start this probe from a clean tree.
 * { ok: true } or { ok: false } — a refusal already emitted.
 */
function ensureCleanCheckout(publication) {
    try {
        git('rev-parse', '--is-inside-work-tree');
    } catch (e) {
        fail('runner_error', 'not a git worktree: ' + errText(e));
        return { ok: false };
    }

    let gitDir;
    try {
        gitDir = git('rev-parse', '--git-dir');
    } catch (e) {
        fail('runner_error', 'could not resolve the git dir: ' + errText(e));
        return { ok: false };
    }
    if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
        try {
            git('rebase', '--abort');
        } catch {
            // Nothing to abort, or the abort itself failed — the fetch/rebase below still
            // recomputes this deterministically; a stuck abort does not block re-probing.
        }
    }

    const branch = git('branch', '--show-current');
    if (branch !== publication.headBranch) {
        fail(
            'runner_error',
            'the worktree stands on ' +
                (branch || 'a detached HEAD') +
                ' instead of the pull request’s head branch ' +
                publication.headBranch
        );
        return { ok: false };
    }
    return { ok: true };
}

/** Fetches the PR's recorded base, authenticated when a token is available. { ok } or a refusal. */
function fetchBase(publication) {
    const token = process.env.GITHUB_TOKEN;
    try {
        if (token) {
            const origin = git('remote', 'get-url', 'origin');
            if (!origin.startsWith('https://')) {
                fail('auth_failed', 'the credentialed fetch refuses a non-https origin: ' + origin);
                return { ok: false };
            }
            git(
                '-c',
                'credential.helper=' + CREDENTIAL_HELPER,
                '-c',
                'http.followRedirects=initial',
                'fetch',
                'origin',
                publication.baseBranch
            );
        } else {
            git('fetch', 'origin', publication.baseBranch);
        }
    } catch (e) {
        fail('auth_failed', 'could not fetch the pull request’s base: ' + errText(e));
        return { ok: false };
    }
    return { ok: true };
}

const unmergedPaths = () =>
    git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean).slice(0, CONFLICTING_PATHS_MAX);

/**
 * Attempts `git rebase --autostash base`. `{ conflicted: true, paths }` only for a GENUINE
 * conflict — the rebase itself failing to apply a commit, or its autostash reapply conflicting
 * with the freshly rebased tree (git exits 0 for that one, the exact quirk
 * scripts/git-worktree.cjs's own sync guards against — the rebase "succeeding" while leaving
 * conflict markers behind). Any OTHER rebase failure (a hook rejection, a gpg-sign failure, disk
 * pressure) is never disguised as a conflict for the repair agent to "resolve": whatever state
 * remains is aborted and `{ conflicted: false, error }` is returned, so the caller can fail the
 * helper outright and let the block's own `repair -> repair` retry edge do its job.
 */
function attemptRebase(base) {
    try {
        git('rebase', '--autostash', base);
    } catch (e) {
        const paths = unmergedPaths();
        if (paths.length > 0) return { conflicted: true, paths };
        try {
            git('rebase', '--abort');
        } catch {
            // Nothing to abort — the rebase failed before ever starting one.
        }
        return { conflicted: false, error: errText(e) };
    }
    const paths = unmergedPaths();
    if (paths.length > 0) {
        // The rebase itself reported success, but the autostash reapply left conflict markers —
        // no rebase is in progress for the agent's `--continue`/`--abort` to act on, so this is
        // not the "conflicted" state its prompt is built around. The autostash is retained for
        // recovery, exactly like the sync's own handling of the identical quirk.
        return { conflicted: false, error: 'the rebase succeeded, but its autostash reapply left conflict markers' };
    }
    return { conflicted: false, paths: [] };
}

/** Reconciles HEAD against the fetched base: up to date, cleanly rebased, or left conflicted. */
function reconcile(base) {
    let baseSha;
    let headSha;
    try {
        baseSha = git('rev-parse', base);
        headSha = git('rev-parse', 'HEAD');
    } catch (e) {
        fail('runner_error', 'could not resolve the fetched base: ' + errText(e));
        return;
    }

    let mergeBase;
    try {
        mergeBase = git('merge-base', 'HEAD', base);
    } catch (e) {
        fail('runner_error', 'could not compute a merge base with ' + base + ': ' + errText(e));
        return;
    }
    if (mergeBase === baseSha) {
        ok({ verdict: 'up-to-date', baseSha, headSha, conflictingPaths: [] });
        return;
    }

    const attempt = attemptRebase(base);
    if (attempt.error !== undefined) {
        fail('runner_error', 'the rebase did not complete: ' + attempt.error);
        return;
    }
    if (attempt.conflicted) {
        ok({ verdict: 'conflicted', baseSha, headSha, conflictingPaths: attempt.paths });
        return;
    }

    const rebasedHeadSha = git('rev-parse', 'HEAD');
    ok({ verdict: 'rebased', baseSha, headSha: rebasedHeadSha, conflictingPaths: [] });
}

function main() {
    const resolved = resolvePublication();
    if (!resolved.ok) return;
    const { publication } = resolved;

    if (!ensureCleanCheckout(publication).ok) return;
    if (!fetchBase(publication).ok) return;

    reconcile('origin/' + publication.baseBranch);
}

try {
    main();
} catch (e) {
    fail('runner_error', 'the merge-conflict probe failed: ' + errText(e));
}
