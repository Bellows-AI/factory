// The startup sync: make a per-task worktree reflect the remote default, so every run starts
// from the code — and the declared gates — that main actually has. One execFileSync per git
// call: no value can become a command. One JSON verdict on stdout: {ok:true,reason:null,fingerprint}
// or {ok:false,reason}.
//
// Environment (set by the driver; paths, a branch name, and — when the claim carries a token —
// the credential-helper CODE; never a credential value):
//   REPO        — the clone, where `origin` lives and the worktree is created FROM;
//   WORKTREE    — the task's own tree;
//   BRANCH      — the branch the worktree runs on (`factory/<thread root id>`);
//   RESTORE     — set to `1` for a claim that CONTINUES a session (a follow-up): the task is mid-flight, and git operations that touch the
//                 remote belong to the task's beginning and end, never its middle. No fetch,
//                 no rebase: the existing tree is left byte-for-byte as the run before it
//                 left it, and a reclaimed tree is recreated from the surviving branch —
//                 its own tip, never a fresh start off origin/<default> (a missing branch is
//                 a named failure: there is nothing to continue). An existing tree is kept
//                 only when it is this clone's own worktree standing on the task branch — a
//                 foreign checkout, or the worktree on another branch or a detached HEAD,
//                 is a named refusal, never a recreation: a resumed job must never run in
//                 the wrong checkout. No credential helper is
//                 needed, because nothing here talks to the remote.
//   REVIEW_REF  — optional, RESTORE only, set for a named reviewer's claim (issue #549): the ref of
//                 the snapshot its worktree starts from. A review has no session and no earlier
//                 tree, so where a follow-up would find its branch, a review's worktree is created
//                 on its own branch AT this ref — still with no fetch and no rebase, because
//                 nothing a reviewer needs is on the remote.
//   CRED_HELPER — optional, STARTING claims only: the git credential-helper program the fetch
//                 runs (`-c credential.helper=`), set only when the claim env carries a
//                 NON-EMPTY GITHUB_TOKEN. The token itself still arrives only via the
//                 environment, which git hands the helper it spawns; git reads no token from
//                 the environment itself, so a private-repo fetch without a helper cannot
//                 authenticate. Absent: the fetch runs plain, which is what a public repo
//                 wants. When set, the fetch runs under two credential-safety rules, because
//                 this helper is CONTEXT-FREE — it answers the token to whatever host or
//                 transport asks: origin must be an https URL (read via `git remote get-url
//                 origin`; the remote is the member tree's state, and a prior session can
//                 re-point it — anything else refuses the sync rather than send the token
//                 toward a cleartext or local transport), and the fetch carries `-c
//                 http.followRedirects=initial`, which permits same-host redirects only,
//                 never a hop to another host or scheme.
//   SYNC_LOCK_WAIT_MS / SYNC_LOCK_STALE_MS — test seams for the checkout lock's bounds (below);
//                 the driver never sets them, and both names are reserved from member
//                 configuration on the board and in the driver's own claim-env filter.
//
// STARTING claims (no RESTORE), WORKTREE present: rebased onto the new default with
// --autostash, so a follow-up — which lands in this same tree by design — works whether or
// not the previous run left uncommitted edits; the edits are stashed for the rebase and
// reapplied on the new base. Git exits 0 even when the reapplied STASH conflicts (the rebase
// itself succeeded), so the script re-checks for unmerged entries and refuses — a tree with
// conflict markers is not one to run on, and the stash is retained for recovery. A
// conflicting rebase likewise aborts itself and names the failure.
//
// STARTING claims, WORKTREE absent: fetched, pruned, and `git worktree add` — from the
// existing branch when the thread already has one (a lost directory must not cost its
// commits), else -b at origin/<default>. A path that holds a git tree this sync did not
// create is REFUSED, never deleted: whatever uncommitted work sits there belongs to an agent
// session, and destroying it is the one outcome worse than a burned attempt. A remote with NO
// commits (a scaffolding task) has no origin/<default>: the worktree starts empty on an unborn
// task branch, nothing is fast-forwarded, and an existing tree is not rebased.
//
// The clone's own working tree is touched in exactly one way: after a STARTING sync's fetch, its
// default branch is fast-forwarded to origin/<default> when it is checked out, clean and behind —
// agents read sibling checkouts' files, which would otherwise stay at whatever commit was first
// cloned. Another branch, a dirty tree or a diverged history is left as it is and logged to
// stderr (stdout is the verdict channel), never forced. RESTORE syncs never reach it.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = process.env.REPO;
const wt = process.env.WORKTREE;
const branch = process.env.BRANCH;
const restore = process.env.RESTORE === '1';
const reviewRef = process.env.REVIEW_REF;
const GIT_ERROR_MAX_LENGTH = 200;
const SYNC_ERROR_MAX_LENGTH = 300;
const FACTORY_STATE_EXCLUDE = '/.factory/';

const positiveIntEnv = (name, fallback) => {
    const parsed = Number.parseInt(process.env[name], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// One Int32 word — the smallest buffer Atomics.wait can sleep on.
const SLEEP_WORD_BYTES = 4;

const sleep = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(SLEEP_WORD_BYTES)), 0, 0, ms);
};

// The sync runs under an exclusive per-checkout lockfile (issue #307): two STARTING claims on
// one repo fetch the SAME clone's refs, and git's ref transaction moves a remote-tracking ref
// only from the value it read, so overlapping fetches lose with `cannot lock ref … is at X but
// expected Y`. The file lives in the clone's git dir — on the shared workspaces volume, so the
// sync containers (docker) and sync Jobs (kubernetes) of one checkout contend on ONE file.
const SYNC_LOCK_NAME = 'factory-sync.lock';
// The defaults for the two bounds above: 120s is inside the kubernetes sync Job's 600s deadline
// and covered by the still-beating setup heartbeat; 600s IS that deadline — a lock older than it
// can have no living holder.
const DEFAULT_SYNC_LOCK_WAIT_MS = 120000;
const DEFAULT_SYNC_LOCK_STALE_MS = 600000;
// How long a second sync waits for the holder before giving up with a transient verdict: well
// inside the kubernetes sync Job's 600s deadline, and covered by the still-beating setup
// heartbeat. Test seam only — the driver never sets it, and the name is reserved from member
// configuration on both the board and the driver.
const SYNC_LOCK_WAIT_MS = positiveIntEnv('SYNC_LOCK_WAIT_MS', DEFAULT_SYNC_LOCK_WAIT_MS);
// A lock older than this is an orphan: on kubernetes the sync Job's own deadline is exactly
// this bound, so no holder can still be alive past it and an older file is one a killed holder
// left behind — also the recovery for a holder killed outright mid-sync. Docker bounds nothing,
// so a live-but-wedged holder CAN be stolen from there; the release below is ownership-checked,
// which is what keeps such a theft from cascading into deleting a successor's live lock.
const SYNC_LOCK_STALE_MS = positiveIntEnv('SYNC_LOCK_STALE_MS', DEFAULT_SYNC_LOCK_STALE_MS);
const SYNC_LOCK_POLL_MS = 250;
// The fetch itself retries when it lost a ref lock anyway — a lock that slipped past the sync
// lock, or a concurrent git outside this script. After the winner's fetch the refs are already
// current, so a retry is cheap and correct.
const SYNC_FETCH_ATTEMPTS = 3;
const SYNC_FETCH_BACKOFF_MS = 500;
// The stderr spellings of a ref-lock loss: issue #307's observed fetch race, plus the lockfile
// shapes of an interrupted git.
const TRANSIENT_REF_LOCK = /cannot lock ref|unable to update local ref|index\.lock|shallow\.lock/;

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const inw = (...a) => execFileSync('git', a, { cwd: wt, encoding: 'utf8' }).trim();
// The tree fingerprint (spelled identically in git-probe.cjs, which the driver re-runs after a
// failed gate): HEAD plus a hash of the uncommitted state — the porcelain status, the tracked
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
const synced = () => console.log(JSON.stringify({ ok: true, reason: null, fingerprint: fingerprintOf(wt) }));
const fail = (r) => {
    if (!restore) {
        try {
            inw('rebase', '--abort');
        } catch {}
    }
    console.log(JSON.stringify({ ok: false, reason: r }));
};

/**
 * Steals the lock when it is an orphan past the stale bound — no legal holder lives this long.
 * The steal is a RENAME: atomic, so of several waiters polling one stale file exactly one wins
 * (the losers' renames fail on a path that no longer holds it) and the renamed file is the
 * winner's own to unlink. A failed rename is a live holder's exit or another waiter having
 * moved the file first; either way the create is retried. Residual, stated: a waiter stalled
 * between its staleness stat and its rename can displace a freshly recreated lock — two
 * adjacent syscalls wide — and the ownership-checked release below is what keeps that from
 * cascading.
 */
const stealIfStale = (lock) => {
    try {
        if (Date.now() - fs.statSync(lock).mtimeMs <= SYNC_LOCK_STALE_MS) return false;
    } catch {
        return false;
    }
    const stolen = lock + '.' + process.pid + '.stolen';
    try {
        fs.renameSync(lock, stolen);
    } catch {
        return false;
    }
    fs.rmSync(stolen, { force: true });
    return true;
    // A SIGKILL between the rename and that unlink leaks the `.stolen` litter — inert to git,
    // and swept by nothing; the price of the atomic steal, and cheaper than a non-atomic one.
};

const lockHeldRefusal = (lock) =>
    'transient worktree sync: the checkout lock ' +
    lock +
    ' is still held after ' +
    SYNC_LOCK_WAIT_MS +
    'ms — a concurrent sync of this clone is running; the claim should be retried';

/**
 * Takes the checkout's sync lock, waiting out a live holder and stealing an orphaned one.
 * Released by an `exit` handler — the failure paths below answer with `fail(...)` and
 * `process.exit(0)`, and `exit` handlers run synchronously on that path — and the handler
 * removes the file only while it is still OURS (the inode we opened): a holder stolen from
 * while alive, or outlived by a successor's recreate, must never delete the winner's lock.
 * A holder killed outright leaks the file; the stale bound recovers it.
 */
const acquireSyncLock = () => {
    let common = git('rev-parse', '--git-common-dir');
    if (!path.isAbsolute(common)) common = path.resolve(repo, common);
    const lock = path.join(common, SYNC_LOCK_NAME);
    const deadline = Date.now() + SYNC_LOCK_WAIT_MS;
    while (true) {
        let fd;
        try {
            fd = fs.openSync(lock, 'wx');
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            if (Date.now() >= deadline) {
                fail(lockHeldRefusal(lock));
                process.exit(0);
            }
            // A steal retries the create immediately; a live holder costs one poll interval.
            if (!stealIfStale(lock)) sleep(SYNC_LOCK_POLL_MS);
            continue;
        }
        const ino = fs.fstatSync(fd).ino;
        process.on('exit', () => {
            try {
                if (fs.statSync(lock).ino === ino) fs.rmSync(lock, { force: true });
            } catch {}
        });
        fs.writeSync(fd, `${process.pid}\n`);
        fs.closeSync(fd);
        return lock;
    }
};

/** The one fetch of the remote, under the claim's credential helper when it carries a token. */
const fetchOrigin = () => {
    if (process.env.CRED_HELPER) {
        git(
            '-c',
            'credential.helper=' + process.env.CRED_HELPER,
            '-c',
            'http.followRedirects=initial',
            'fetch',
            'origin',
            '--prune'
        );
    } else git('fetch', 'origin', '--prune');
};

/** The fetch, retried while it loses ref locks to a concurrent git; exhausted, a transient verdict. */
const fetchOriginWithRetries = () => {
    for (let attempt = 1; attempt <= SYNC_FETCH_ATTEMPTS; attempt += 1) {
        try {
            fetchOrigin();
            return;
        } catch (e) {
            const detail = String((e && e.stderr) || (e && e.message) || e);
            if (!TRANSIENT_REF_LOCK.test(detail)) throw e;
            if (attempt === SYNC_FETCH_ATTEMPTS) {
                fail(
                    "transient worktree sync: the fetch kept losing the refs' locks to a concurrent git on " +
                        SYNC_FETCH_ATTEMPTS +
                        ' attempts: ' +
                        detail.slice(0, GIT_ERROR_MAX_LENGTH)
                );
                process.exit(0);
            }
            sleep(SYNC_FETCH_BACKOFF_MS);
        }
    }
};

/** Fast-forwards the clone's checked-out default branch when that is safe; see the header. */
const fastForwardClone = (def) => {
    const on = git('branch', '--show-current');
    if (on !== def)
        return console.error('base clone is on ' + (on || 'a detached HEAD') + ', not ' + def + '; left as is');
    if (git('status', '--porcelain')) return console.error('base clone has uncommitted changes; left as is');
    try {
        git('merge', '--ff-only', '--no-overwrite-ignore', '--quiet', 'origin/' + def);
    } catch (e) {
        console.error(
            'base clone could not be fast-forwarded to origin/' +
                def +
                '; left as is: ' +
                String((e && e.stderr) || (e && e.message) || e).slice(0, GIT_ERROR_MAX_LENGTH)
        );
    }
};

/**
 * Git-ignores the `.factory/` state namespace (helper verdicts, review digests) for every worktree
 * of this clone: `info/exclude` lives in the COMMON dir, which a worktree's `.git` FILE only
 * points at, so the path comes from `git rev-parse --git-path`, never a `.git/info` join. Without
 * it the publisher's `git add -A` committed the probe's state file into task PRs.
 */
const excludeFactoryState = () => {
    let excludePath = git('rev-parse', '--git-path', 'info/exclude');
    if (!path.isAbsolute(excludePath)) excludePath = path.resolve(repo, excludePath);
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (existing.split('\n').includes(FACTORY_STATE_EXCLUDE)) return;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(
        excludePath,
        (existing === '' || existing.endsWith('\n') ? '' : '\n') + FACTORY_STATE_EXCLUDE + '\n'
    );
};

/** Whether the fetched remote has a default branch to build on; false for a repository with no commits. */
const hasRemoteBase = (def) => {
    try {
        git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + def);
        return true;
    } catch {
        return false;
    }
};

/**
 * The worktree of a repository with no commits: `worktree add --orphan` needs git 2.42 and the
 * runner images ship 2.39, so it is built by hand — a throwaway commit over the empty tree
 * anchors a detached worktree, and `checkout --orphan` then leaves it standing on the unborn task
 * branch with nothing in it. The anchor commit is never referenced again.
 */
const addUnbornWorktree = () => {
    const tree = execFileSync('git', ['mktree'], { cwd: repo, input: '', encoding: 'utf8' }).trim();
    const base = git('-c', 'user.name=factory', '-c', 'user.email=factory@invalid', 'commit-tree', tree, '-m', 'base');
    git('worktree', 'add', '--detach', wt, base);
    inw('checkout', '--orphan', branch);
};

try {
    acquireSyncLock();
    excludeFactoryState();
    if (restore) {
        // Mid-task: the tree is what the conversation continues from, kept exactly as the run
        // before it left it — or recreated from the branch that outlived the tree's reclaim.
        // The remote is nobody's business here.
        let existing = false;
        try {
            inw('rev-parse', '--is-inside-work-tree');
            existing = true;
        } catch {}
        if (existing) {
            // An existing tree is accepted only when it is this clone's worktree standing on
            // the task branch — anything else (another clone's checkout, or this worktree on
            // another branch or a detached HEAD) is a named refusal, never a recreation: a
            // resumed job must never run in the wrong checkout.
            let common = inw('rev-parse', '--git-common-dir');
            if (!path.isAbsolute(common)) common = path.resolve(wt, common);
            const found = fs.realpathSync(common);
            const ours = fs.realpathSync(repo + '/.git');
            if (found !== ours) {
                fail(
                    'the worktree path holds a git tree that is not a worktree of this clone: its git dir is ' +
                        found +
                        ', but the task tree must belong to ' +
                        ours +
                        ' — remove it by hand if it is truly stale'
                );
                process.exit(0);
            }
            const on = inw('branch', '--show-current');
            if (on !== branch) {
                fail(
                    'the task worktree stands on ' +
                        (on ? 'branch ' + on : 'a detached HEAD') +
                        ' instead of the task branch ' +
                        branch +
                        ' — a resumed job must never run in the wrong checkout'
                );
                process.exit(0);
            }
            synced();
            process.exit(0);
        }
        if (fs.existsSync(wt + '/.git')) {
            fail(
                'the worktree path exists and holds a git tree this sync did not create; remove it by hand if it is truly stale: ' +
                    wt
            );
            process.exit(0);
        }
        fs.rmSync(wt, { recursive: true, force: true });
        git('worktree', 'prune');
        try {
            try {
                git('worktree', 'add', wt, branch);
            } catch (e) {
                // A named reviewer's first attempt has no branch yet: it starts at its snapshot.
                if (!reviewRef) throw e;
                try {
                    git('worktree', 'add', '-b', branch, wt, reviewRef);
                } catch (snapshotError) {
                    fail(
                        'the review snapshot ' +
                            reviewRef +
                            ' could not be checked out: ' +
                            String((snapshotError && snapshotError.stderr) || snapshotError).slice(
                                0,
                                GIT_ERROR_MAX_LENGTH
                            )
                    );
                    process.exit(0);
                }
            }
        } catch (e) {
            fail(
                'the task branch ' +
                    branch +
                    ' could not be restored — if it is gone from the clone there is ' +
                    'nothing to continue, and a follow-up is never restarted fresh off the remote default ' +
                    '(re-queue the task to start it over): ' +
                    String((e && e.stderr) || (e && e.message) || e).slice(0, GIT_ERROR_MAX_LENGTH)
            );
            process.exit(0);
        }
        synced();
        process.exit(0);
    }
    if (process.env.CRED_HELPER) {
        const origin = git('remote', 'get-url', 'origin');
        if (!origin.startsWith('https://')) {
            fail(
                'the credentialed fetch refuses origin ' +
                    origin +
                    ': the credential helper answers the token to ' +
                    'whatever asks, so only an https origin may fetch with it — re-point origin at the https URL ' +
                    'the clone was made from and re-run'
            );
            process.exit(0);
        }
    }
    fetchOriginWithRetries();
    let def = 'main';
    try {
        def = git('symbolic-ref', 'refs/remotes/origin/HEAD').replace('refs/remotes/origin/', '');
    } catch {
        // A clone of an empty remote never got origin/HEAD; once the remote has a first branch,
        // learn its name rather than keep assuming main.
        try {
            git('remote', 'set-head', 'origin', '--auto');
            def = git('symbolic-ref', 'refs/remotes/origin/HEAD').replace('refs/remotes/origin/', '');
        } catch {}
    }
    // An empty remote (a scaffolding task's repository has no commits yet) has no origin/<def>:
    // nothing to fast-forward, branch from or rebase onto.
    const hasBase = hasRemoteBase(def);
    if (hasBase) fastForwardClone(def);
    let existing = false;
    try {
        inw('rev-parse', '--is-inside-work-tree');
        existing = true;
    } catch {}
    // An existing tree over an empty remote has no new base to rebase onto: it is left as it is.
    if (existing && hasBase) {
        try {
            inw('rebase', '--autostash', 'origin/' + def);
        } catch (e) {
            fail(
                'the task worktree could not be rebased onto origin/' +
                    def +
                    ': ' +
                    String((e && e.stderr) || (e && e.message) || e).slice(0, GIT_ERROR_MAX_LENGTH)
            );
            process.exit(0);
        }
        if (inw('diff', '--name-only', '--diff-filter=U').length) {
            fail(
                'the task worktree was rebased onto origin/' +
                    def +
                    ', but its uncommitted edits conflict ' +
                    'with the new base and are left as conflict markers in the tree (the autostash is kept ' +
                    'for recovery); resolve them before re-running'
            );
            process.exit(0);
        }
    } else if (!existing) {
        if (fs.existsSync(wt + '/.git')) {
            fail(
                'the worktree path exists and holds a git tree this sync did not create; remove it by hand if it is truly stale: ' +
                    wt
            );
            process.exit(0);
        }
        fs.rmSync(wt, { recursive: true, force: true });
        git('worktree', 'prune');
        try {
            git('worktree', 'add', wt, branch);
        } catch {
            if (hasBase) git('worktree', 'add', '-b', branch, wt, 'origin/' + def);
            else addUnbornWorktree();
        }
    }
    synced();
} catch (e) {
    fail('worktree sync failed: ' + String((e && e.stderr) || (e && e.message) || e).slice(0, SYNC_ERROR_MAX_LENGTH));
}
