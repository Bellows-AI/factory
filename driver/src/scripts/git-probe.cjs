// The publish probe: one read-only answer about a checkout, JSON on stdout, no shell — every
// git call is execFileSync, so no path or branch name can become a command. Printed values
// decide the publish flow; none of them are secrets.
//
// Environment (set by the driver; a path, never a credential):
//   REPO — the checkout directory to probe (the task worktree).
//
// "Unpushed" counts commits the REMOTE default branch does not have — never the upstream
// range of the current branch, which is fatal for a branch that was never pushed at all (no
// upstream) and would read a local-only branch full of work as fully landed. That exact
// miscount once reported a two-commit task branch as "nothing to publish".
const { execFileSync } = require('node:child_process');

const repo = process.env.REPO;
// The tree fingerprint (spelled identically in git-worktree.cjs, whose startup sync prints the
// before-run one): HEAD plus a hash of the uncommitted state — the porcelain status, the tracked
// diff and the untracked files' contents, `.factory/` excluded. Equal fingerprints mean the round
// between them changed nothing. Null when any read fails: an unknown is never a guess.
const FINGERPRINT_PATHSPEC = ['--', ':/', ':(top,exclude).factory'];
const FINGERPRINT_MAX_BUFFER = 268_435_456; // 256 MiB: a large diff must not read as unknown
const fingerprintOf = (cwd) => {
    try {
        const read = (args, input) =>
            execFileSync('git', args, { cwd, input, encoding: 'buffer', maxBuffer: FINGERPRINT_MAX_BUFFER });
        const hash = require('node:crypto').createHash('sha256');
        hash.update(read(['status', '--porcelain', ...FINGERPRINT_PATHSPEC]));
        hash.update(read(['diff', 'HEAD', '--binary', ...FINGERPRINT_PATHSPEC]));
        const untracked = read([
            '-c',
            'core.quotePath=false',
            'ls-files',
            '--others',
            '--exclude-standard',
            ...FINGERPRINT_PATHSPEC,
        ]);
        if (untracked.length) hash.update(read(['hash-object', '--stdin-paths'], untracked));
        return read(['rev-parse', 'HEAD']).toString().trim() + ':' + hash.digest('hex');
    } catch {
        return null;
    }
};
const out = {
    cloned: false,
    branch: '',
    defaultBranch: 'main',
    dirty: false,
    unpushed: 0,
    hasIdentity: false,
    fingerprint: null,
};
try {
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    git('rev-parse', '--is-inside-work-tree');
    out.cloned = true;
    out.branch = git('branch', '--show-current');
    try {
        out.defaultBranch = git('symbolic-ref', 'refs/remotes/origin/HEAD').replace('refs/remotes/origin/', '');
    } catch {}
    // The `.factory/` state namespace is never publishable work — publish.ts's GIT_ADD_ARGS
    // excludes it, so a tree dirty only there must read clean or the commit would find nothing.
    out.dirty = git('status', '--porcelain', '--', ':/', ':(top,exclude).factory').length > 0;
    try {
        out.unpushed = Number(git('rev-list', '--count', 'origin/' + out.defaultBranch + '..HEAD')) || 0;
    } catch {
        out.unpushed = 0;
    }
    out.fingerprint = fingerprintOf(repo);
    out.hasIdentity = (() => {
        try {
            return git('config', 'user.email').length > 0;
        } catch {
            return false;
        }
    })();
} catch {}
console.log(JSON.stringify(out));
