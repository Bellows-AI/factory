// The terminal reclaim: remove the task's worktree once the whole thread is finished, so a
// finished or deleted task does not leave its tree squatting on the member volume forever
// (issue #47). One execFileSync per git call: no value can become a command. One JSON verdict
// on stdout: {ok:true,removed:bool} or {ok:false,reason}. A refusal IS the verdict and is
// terminal: it prints and stops — no prune, no further line — because the runners parse only
// the LAST stdout line, and a trailing success verdict would shadow the refusal.
//
// Environment (set by the driver; paths only, never credentials):
//   REPO    — the clone, whose admin dir registers the worktree;
//   WORKTREE — the task's tree.
//
// WHAT MAY BE REMOVED, and nothing else. The sync created the tree, and every commit on it
// belongs to this thread; once the thread cannot continue, the tree holds nothing worth
// keeping. But the READ is the same one the sync trusts, and so is the refusal: a path that
// holds a git tree that is not this clone's registered worktree is REFUSED, never deleted —
// whatever that tree is, deleting it would be destroying a session's work for an attempt to
// reclaim disk. Concretely, in order:
//   1. WORKTREE is a registered worktree of REPO, and the directory is there
//      -> `git worktree remove --force` (the force discards uncommitted edits in a logged-off
//      tree: the thread is terminal, its branch abandoned — the verdict already lives on the
//      board, not in these edits).
//   2. WORKTREE is registered but the directory is already gone -> nothing; the prune below
//      clears the stale admin entry.
//   3. WORKTREE exists with a .git entry but is NOT registered -> refused. The sync's own
//      guard (git-worktree.cjs) treats exactly this shape as "a git tree I did not create",
//      and this script must not be less careful than the script that made the tree.
//   4. WORKTREE exists with no .git -> removed by hand (fs.rmSync); the sync would have
//      deleted this same bare leftover itself the next time it needed the path.
//   5. nothing there -> nothing to do.
// A worktree prune always follows, so a stale admin entry can never hold the path hostage for
// a follow-up that shows up later (a follow-up recreates the tree with `git worktree add` on
// the surviving factory/<root> branch — losing the directory must not cost it its commits).
//
// THE PARENT CLONE MAY BE GONE (issue #92): the member's manual purge deletes the whole
// checkout — clone, .worktrees sibling of the task tree included — while a finished task's
// reclaim is still queued. Every git call above runs with cwd REPO, so without its own branch
// the reclaim would fail forever on a tree the clone's death made it unable to even name. So
// when REPO is absent the worktree side proves registration ITSELF: a task worktree's .git is
// a file whose gitdir line points into the clone's admin dir (<repo>/.git/worktrees/...), and
// only such a tree is removed. A .git pointing anywhere else is the same refusal as ever —
// the clone being gone makes this tree nobody's registered worktree, which is a reason to be
// MORE careful, not less. There is no prune when the clone is gone: nothing to prune into.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const repo = process.env.REPO;
const wt = process.env.WORKTREE;
const ERROR_MESSAGE_MAX_LENGTH = 300;

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const refused = (r) => ({ ok: false, reason: r });

/**
 * The .git entry at a path, or null only when the entry is genuinely absent: ENOENT (nothing
 * there) or ENOTDIR (a parent of the path is not a directory). lstat, never existsSync — a
 * dangling .git symlink IS an entry (somebody's broken git tree), and reading it as "no .git"
 * is what would send a tree holding uncommitted files down a bare-leftover rmSync.
 */
function dotGitEntry(p) {
    try {
        return fs.lstatSync(p + '/.git');
    } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
        return null;
    }
}

/**
 * Whether the .git entry is the pointer file a task worktree of this clone carries: a FILE
 * whose gitdir line names this clone's admin dir. A .git DIRECTORY is a standalone repo parked
 * at the path, and a dangling symlink is a pointer that resolves to nothing — not honest either
 * way. An absent resolve or read (ENOENT/ENOTDIR) is exactly that dishonesty; every other
 * error is a real failure and propagates to the verdict.
 */
function honestWorktreePointer(p) {
    try {
        return (
            fs.statSync(p + '/.git').isFile() &&
            fs
                .readFileSync(p + '/.git', 'utf8')
                .split('\n')
                .some((l) => {
                    const gitdir = l.startsWith('gitdir: ') ? l.slice('gitdir: '.length).trim() : null;
                    return gitdir !== null && gitdir.startsWith(repo + '/.git/worktrees/');
                })
        );
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
        throw e;
    }
}

/**
 * The clone is gone. Settle the tree from what the tree itself knows, and nothing else:
 * a registered task worktree carries a .git FILE whose gitdir names this clone's admin dir.
 */
function reclaimWithoutClone(wtExists) {
    if (!wtExists) return { ok: true, removed: false };
    if (dotGitEntry(wt)) {
        if (!honestWorktreePointer(wt)) {
            return refused(
                'refusing to remove ' +
                    wt +
                    ': the path holds a git tree that is not a registered worktree of ' +
                    repo +
                    ' (whose clone is gone); remove it by hand if it is truly stale'
            );
        }
        fs.rmSync(wt, { recursive: true, force: true });
        return { ok: true, removed: true };
    }
    // The bare-leftover case, without the clone that would have pruned after it.
    fs.rmSync(wt, { recursive: true, force: true });
    return { ok: true, removed: true };
}

function reclaim() {
    const wtExists = fs.existsSync(wt);
    if (!fs.existsSync(repo)) return reclaimWithoutClone(wtExists);
    const registered =
        wtExists &&
        git('worktree', 'list', '--porcelain')
            .split('\n')
            .filter((l) => l.startsWith('worktree '))
            .map((l) => l.slice('worktree '.length))
            .includes(wt);
    if (!registered && wtExists && dotGitEntry(wt)) {
        // The refusal is terminal: returning it here means the prune below never runs, so the
        // single verdict this script prints is the refusal itself.
        return refused(
            'refusing to remove ' +
                wt +
                ': the path holds a git tree that is not a registered worktree of ' +
                repo +
                '; remove it by hand if it is truly stale'
        );
    }
    let removed = false;
    if (registered) {
        git('worktree', 'remove', '--force', wt);
        removed = true;
    } else if (wtExists) {
        fs.rmSync(wt, { recursive: true, force: true });
        removed = true;
    }
    git('worktree', 'prune');
    return { ok: true, removed };
}

try {
    console.log(JSON.stringify(reclaim()));
} catch (e) {
    console.log(
        JSON.stringify(
            refused(
                'worktree reclaim failed: ' +
                    String((e && e.stderr) || (e && e.message) || e).slice(0, ERROR_MESSAGE_MAX_LENGTH)
            )
        )
    );
}
