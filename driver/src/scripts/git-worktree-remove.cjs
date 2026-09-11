// The terminal reclaim: remove the task's worktree once the whole thread is finished, so a
// finished or deleted task does not leave its tree squatting on the member volume forever
// (issue #47). One execFileSync per git call: no value can become a command. One JSON verdict
// on stdout: {ok:true,removed:bool} or {ok:false,reason}.
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
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const repo = process.env.REPO;
const wt = process.env.WORKTREE;

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const ref = (r) => console.log(JSON.stringify({ ok: false, reason: r }));

try {
    const wtExists = fs.existsSync(wt);
    const registered =
        wtExists &&
        git('worktree', 'list', '--porcelain')
            .split('\n')
            .filter((l) => l.startsWith('worktree '))
            .map((l) => l.slice('worktree '.length))
            .includes(wt);
    let removed = false;
    if (registered) {
        git('worktree', 'remove', '--force', wt);
        removed = true;
    } else if (wtExists && fs.existsSync(wt + '/.git')) {
        ref(
            'refusing to remove ' +
                wt +
                ': the path holds a git tree that is not a registered worktree of ' +
                repo +
                '; remove it by hand if it is truly stale',
        );
    } else if (wtExists) {
        fs.rmSync(wt, { recursive: true, force: true });
        removed = true;
    }
    git('worktree', 'prune');
    console.log(JSON.stringify({ ok: true, removed }));
} catch (e) {
    ref('worktree reclaim failed: ' + String((e && e.stderr) || (e && e.message) || e).slice(0, 300));
}