// The startup sync: make a per-task worktree reflect the remote default, so every run starts
// from the code — and the declared gates — that main actually has. One execFileSync per git
// call: no value can become a command. One JSON verdict on stdout: {ok:true,reason:null} or
// {ok:false,reason}.
//
// Environment (set by the driver; paths and a branch name, never credentials):
//   REPO     — the clone, where `origin` lives and the worktree is created FROM;
//   WORKTREE — the task's own tree;
//   BRANCH   — the branch the worktree runs on (`factory/<thread root id>`).
//
// WORKTREE present: rebased onto the new default with --autostash, so a follow-up — which
// lands in this same tree by design — works whether or not the previous run left uncommitted
// edits; the edits are stashed for the rebase and reapplied on the new base. Git exits 0 even
// when the reapplied STASH conflicts (the rebase itself succeeded), so the script re-checks
// for unmerged entries and refuses — a tree with conflict markers is not one to run on, and
// the stash is retained for recovery. A conflicting rebase likewise aborts itself and names
// the failure.
//
// WORKTREE absent: fetched, pruned, and `git worktree add` — from the existing branch when the
// thread already has one (a lost directory must not cost its commits), else -b at
// origin/<default>. A path that holds a git tree this sync did not create is REFUSED, never
// deleted: whatever uncommitted work sits there belongs to an agent session, and destroying
// it is the one outcome worse than a burned attempt. The clone's own working tree is never
// touched — the worktree model is what makes that literally true.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const repo = process.env.REPO;
const wt = process.env.WORKTREE;
const branch = process.env.BRANCH;

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const inw = (...a) => execFileSync('git', a, { cwd: wt, encoding: 'utf8' }).trim();
const fail = (r) => {
    try {
        inw('rebase', '--abort');
    } catch {}
    console.log(JSON.stringify({ ok: false, reason: r }));
};

try {
    git('fetch', 'origin', '--prune');
    let def = 'main';
    try {
        def = git('symbolic-ref', 'refs/remotes/origin/HEAD').replace('refs/remotes/origin/', '');
    } catch {}
    let existing = false;
    try {
        inw('rev-parse', '--is-inside-work-tree');
        existing = true;
    } catch {}
    if (existing) {
        try {
            inw('rebase', '--autostash', 'origin/' + def);
        } catch (e) {
            fail(
                'the task worktree could not be rebased onto origin/' + def + ': ' +
                    String((e && e.stderr) || (e && e.message) || e).slice(0, 200),
            );
            process.exit(0);
        }
        if (inw('diff', '--name-only', '--diff-filter=U').length) {
            fail(
                'the task worktree was rebased onto origin/' + def + ', but its uncommitted edits conflict ' +
                    'with the new base and are left as conflict markers in the tree (the autostash is kept ' +
                    'for recovery); resolve them before re-running',
            );
            process.exit(0);
        }
    } else {
        if (fs.existsSync(wt + '/.git')) {
            fail('the worktree path exists and holds a git tree this sync did not create; remove it by hand if it is truly stale: ' + wt);
            process.exit(0);
        }
        fs.rmSync(wt, { recursive: true, force: true });
        git('worktree', 'prune');
        try {
            git('worktree', 'add', wt, branch);
        } catch (e) {
            git('worktree', 'add', '-b', branch, wt, 'origin/' + def);
        }
    }
    console.log(JSON.stringify({ ok: true, reason: null }));
} catch (e) {
    fail('worktree sync failed: ' + String((e && e.stderr) || (e && e.message) || e).slice(0, 300));
}
