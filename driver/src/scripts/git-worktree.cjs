// The startup sync: make a per-task worktree reflect the remote default, so every run starts
// from the code — and the declared gates — that main actually has. One execFileSync per git
// call: no value can become a command. One JSON verdict on stdout: {ok:true,reason:null} or
// {ok:false,reason}.
//
// Environment (set by the driver; paths, a branch name, and — when the claim carries a token —
// the credential-helper CODE; never a credential value):
//   REPO        — the clone, where `origin` lives and the worktree is created FROM;
//   WORKTREE    — the task's own tree;
//   BRANCH      — the branch the worktree runs on (`factory/<thread root id>`);
//   RESTORE     — set to `1` for a claim that CONTINUES a session (a follow-up, or a parked
//                 job resumed): the task is mid-flight, and git operations that touch the
//                 remote belong to the task's beginning and end, never its middle. No fetch,
//                 no rebase: the existing tree is left byte-for-byte as the run before it
//                 left it, and a reclaimed tree is recreated from the surviving branch —
//                 its own tip, never a fresh start off origin/<default> (a missing branch is
//                 a named failure: there is nothing to continue). No credential helper is
//                 needed, because nothing here talks to the remote.
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
// session, and destroying it is the one outcome worse than a burned attempt. The clone's own
// working tree is never touched — the worktree model is what makes that literally true.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const repo = process.env.REPO;
const wt = process.env.WORKTREE;
const branch = process.env.BRANCH;
const restore = process.env.RESTORE === '1';

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const inw = (...a) => execFileSync('git', a, { cwd: wt, encoding: 'utf8' }).trim();
const fail = (r) => {
    if (!restore) {
        try {
            inw('rebase', '--abort');
        } catch {}
    }
    console.log(JSON.stringify({ ok: false, reason: r }));
};

try {
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
            console.log(JSON.stringify({ ok: true, reason: null }));
            process.exit(0);
        }
        if (fs.existsSync(wt + '/.git')) {
            fail('the worktree path exists and holds a git tree this sync did not create; remove it by hand if it is truly stale: ' + wt);
            process.exit(0);
        }
        fs.rmSync(wt, { recursive: true, force: true });
        git('worktree', 'prune');
        try {
            git('worktree', 'add', wt, branch);
        } catch (e) {
            fail(
                'the task branch ' + branch + ' could not be restored — if it is gone from the clone there is ' +
                    'nothing to continue, and a follow-up is never restarted fresh off the remote default ' +
                    '(re-queue the task to start it over): ' +
                    String((e && e.stderr) || (e && e.message) || e).slice(0, 200),
            );
            process.exit(0);
        }
        console.log(JSON.stringify({ ok: true, reason: null }));
        process.exit(0);
    }
    if (process.env.CRED_HELPER) {
        const origin = git('remote', 'get-url', 'origin');
        if (!origin.startsWith('https://')) {
            fail(
                'the credentialed fetch refuses origin ' + origin + ': the credential helper answers the token to ' +
                    'whatever asks, so only an https origin may fetch with it — re-point origin at the https URL ' +
                    'the clone was made from and re-run',
            );
            process.exit(0);
        }
        git('-c', 'credential.helper=' + process.env.CRED_HELPER, '-c', 'http.followRedirects=initial', 'fetch', 'origin', '--prune');
    } else git('fetch', 'origin', '--prune');
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
