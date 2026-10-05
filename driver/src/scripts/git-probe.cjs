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
// Hashes the uncommitted state of one work tree into `hash`. A submodule's own diff is included
// (`--submodule=diff`), or a dirty submodule edited again would read identical. An untracked
// entry is read here, not by `hash-object`, which throws on a dangling symlink or a nested repo:
// a symlink hashes its target, a nested repo recurses (it may have no commit yet), anything that
// is not a regular file hashes its type alone.
const hashTree = (cwd, hash, nested) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const read = (args) => execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: FINGERPRINT_MAX_BUFFER });
    const hasCommit = () => {
        try {
            read(['rev-parse', '--verify', '--quiet', 'HEAD']);
            return true;
        } catch {
            return false;
        }
    };
    hash.update(read(['status', '--porcelain', ...FINGERPRINT_PATHSPEC]));
    if (!nested || hasCommit()) {
        hash.update(read(['diff', 'HEAD', '--binary', '--submodule=diff', ...FINGERPRINT_PATHSPEC]));
    }
    const untracked = read(['ls-files', '-z', '--others', '--exclude-standard', ...FINGERPRINT_PATHSPEC]);
    for (const name of untracked.toString('utf8').split('\0').filter(Boolean)) {
        const full = path.join(cwd, name);
        const stat = fs.lstatSync(full);
        hash.update(name + '\0');
        if (stat.isSymbolicLink()) hash.update('l' + fs.readlinkSync(full));
        else if (stat.isDirectory()) hashTree(full, hash, true);
        else if (stat.isFile()) hash.update(fs.readFileSync(full));
        else hash.update('o');
    }
};
const fingerprintOf = (cwd) => {
    try {
        const hash = require('node:crypto').createHash('sha256');
        hashTree(cwd, hash, false);
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
        return head + ':' + hash.digest('hex');
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
