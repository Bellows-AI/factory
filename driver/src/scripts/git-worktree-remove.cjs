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
//      -> removed, discarding uncommitted edits in a logged-off tree: the thread is terminal, its
//      branch abandoned — the verdict already lives on the board, not in these edits. The removal
//      is this file's own parallel walk rather than `git worktree remove --force`, because git
//      unlinks one entry at a time and the volume is NFS; the prune below retires the admin entry
//      that `worktree remove` would have retired itself.
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
const fsp = require('node:fs/promises');

const repo = process.env.REPO;
const wt = process.env.WORKTREE;
const ERROR_MESSAGE_MAX_LENGTH = 300;

// Every unlink on a ReadWriteMany NFS mount is a network round trip, and the tree being removed
// is a checkout WITH its node_modules: measured at ~143k files, of which ~89% were node_modules,
// against EFS at roughly 7ms per metadata op. Serially that is ~8 minutes, which is what the
// first real reclaim on EKS took before it died (2026-10-01). Latency cannot be made smaller, so
// the only lever is overlapping the round trips. 64 is chosen to be well clear of the point where
// one reclaim's I/O would starve the runners sharing the volume; it is not a tuned optimum, and
// the win is the order of magnitude, not the exact number.
const CONCURRENCY = 64;
// An NFS client can answer readdir from a cached listing that still names entries this process
// has already unlinked, so the rmdir that follows fails ENOTEMPTY on a directory that is in fact
// empty. That is not a reason to refuse — it is a reason to look again.
const RMDIR_ATTEMPTS = 3;

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const refused = (r) => ({ ok: false, reason: r });

// A plain counting semaphore. The slot is held across ONE syscall and released before any
// recursion: holding it while awaiting a subdirectory would let every slot fill with parents
// waiting on children that can never acquire one.
let inFlight = 0;
const waiters = [];
function limited(fn) {
    const run = async () => {
        try {
            return await fn();
        } finally {
            const next = waiters.shift();
            if (next) next();
            else inFlight--;
        }
    };
    if (inFlight < CONCURRENCY) {
        inFlight++;
        return run();
    }
    return new Promise((resolve) => waiters.push(resolve)).then(run);
}

/**
 * Remove a directory tree with concurrent unlinks. Replaces both `fs.rmSync(recursive)` and
 * git's own removal, which walk the tree one entry at a time.
 *
 * Entries are removed with `rm`, never followed: a symlink — including one whose target is a
 * directory, and including a dangling one — reports `isDirectory()` false and is unlinked as the
 * single entry it is. Nothing outside this tree is ever reached.
 */
async function removeTree(root) {
    let entries;
    try {
        entries = await limited(() => fsp.readdir(root, { withFileTypes: true }));
    } catch (e) {
        // Gone already, or not a directory at all: either way the path is removable as one entry.
        if (e.code === 'ENOENT') return;
        if (e.code === 'ENOTDIR') {
            await limited(() => fsp.rm(root, { force: true }));
            return;
        }
        throw e;
    }
    const dirs = [];
    const files = [];
    for (const entry of entries) {
        (entry.isDirectory() ? dirs : files).push(root + '/' + entry.name);
    }
    // The files of one directory go out together; the subdirectories then recurse in parallel.
    // Both are throttled by the semaphore at the syscall, so the fan-out is in pending promises
    // rather than in concurrent I/O.
    await Promise.all(files.map((p) => limited(() => fsp.rm(p, { force: true }))));
    await Promise.all(dirs.map((d) => removeTree(d)));
    await rmdir(root);
}

async function rmdir(p, attempt = 1) {
    try {
        await limited(() => fsp.rmdir(p));
    } catch (e) {
        if (e.code === 'ENOENT') return;
        if (e.code !== 'ENOTEMPTY' || attempt >= RMDIR_ATTEMPTS) throw e;
        // Re-walk: either the listing was stale, or something genuinely appeared. Bounded, so a
        // directory somebody is actively writing into still ends as an honest failure.
        await removeTree(p);
        await rmdir(p, attempt + 1);
    }
}

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
async function reclaimWithoutClone(wtExists) {
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
        await removeTree(wt);
        return { ok: true, removed: true };
    }
    // The bare-leftover case, without the clone that would have pruned after it.
    await removeTree(wt);
    return { ok: true, removed: true };
}

async function reclaim() {
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
    // `registered` implies `wtExists` — it is computed from it — so the two old arms (git's
    // removal for a registered tree, a hand rmSync for a bare leftover) are now one removal. The
    // distinction only ever existed because git had to be the one to retire its own admin entry.
    let removed = false;
    if (wtExists) {
        // The registered case used to be `git worktree remove --force`, which unlinks serially and
        // then rmdirs — the shape that took ~8 minutes and died ENOTEMPTY on EFS. The registration
        // check above has already decided this tree may go, so what is left is the removal itself,
        // and the prune below retires the admin entry exactly as `worktree remove` would have.
        await removeTree(wt);
        removed = true;
    }
    git('worktree', 'prune');
    return { ok: true, removed };
}

reclaim()
    .then((verdict) => console.log(JSON.stringify(verdict)))
    .catch((e) =>
        console.log(
            JSON.stringify(
                refused(
                    'worktree reclaim failed: ' +
                        String((e && e.stderr) || (e && e.message) || e).slice(0, ERROR_MESSAGE_MAX_LENGTH)
                )
            )
        )
    );
