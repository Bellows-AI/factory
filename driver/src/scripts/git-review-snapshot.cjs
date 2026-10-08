// The review snapshot (issue #549): freezes the task worktree's CURRENT state — HEAD plus every
// uncommitted and untracked file, `.factory/` excluded — as one commit under a ref of the shared
// clone, so a reviewer's own worktree can start from exactly the tree it was asked about while the
// agent keeps editing. One execFileSync per git call, no shell: no value can become a command. One
// JSON verdict on stdout: {ok:true,ref,existed} or {ok:false,reason}.
//
// Nothing the agent sees moves: HEAD, the branch, the real index and the working files are never
// touched — the commit is built in a THROWAWAY index (`GIT_INDEX_FILE`) and only a ref is written.
// The ref is created and never overwritten, and a key names ONE tree: a retried or reclaimed
// request over the same tree finds its snapshot (`existed`), while a different tree under the same
// ref is a named refusal — so a review the board already bound to a revision can never be
// re-pointed at a later tree, whether by an honest key reuse or a planted ref.
//
// Environment (set by the driver; paths and a ref name, never a credential):
//   REPO       — the task worktree to snapshot;
//   REVIEW_REF — the ref to write (`refs/factory/review/<caller job id>/<key>`).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = process.env.REPO;
const ref = process.env.REVIEW_REF;
const SHA1_HEX_LENGTH = 40;
const ZERO_OID = '0'.repeat(SHA1_HEX_LENGTH);
const SNAPSHOT_PATHSPEC = ['--', ':/', ':(top,exclude).factory'];
const REASON_MAX_LENGTH = 300;
const MAX_BUFFER = 268_435_456; // 256 MiB: a large tree must not read as a failed snapshot

const reasonOf = (e) => String((e && e.stderr) || (e && e.message) || e).slice(0, REASON_MAX_LENGTH);
const git = (args, env) =>
    execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, ...env },
    }).trim();

let scratch = null;
try {
    if (!repo || !ref) throw new Error('REPO and REVIEW_REF are required');
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'review-index-'));
    const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    let head = null;
    try {
        head = git(['rev-parse', '--verify', '--quiet', 'HEAD']);
    } catch {}
    if (head) git(['read-tree', 'HEAD'], env);
    git(['add', '-A', ...SNAPSHOT_PATHSPEC], env);
    const tree = git(['write-tree'], env);
    // A ref that already exists is accepted ONLY when it holds this very tree (a retried or
    // reclaimed request). A different tree — the agent edited and reused the key, or planted the
    // ref — is refused: a key names one tree, so a verdict can never be bound to a tree the
    // reviewer did not see. Nothing is ever overwritten.
    let existingTree = null;
    try {
        existingTree = git(['rev-parse', '--verify', '--quiet', ref + '^{tree}']);
    } catch {}
    if (existingTree !== null) {
        if (existingTree === tree) {
            console.log(JSON.stringify({ ok: true, ref, existed: true }));
        } else {
            console.log(
                JSON.stringify({
                    ok: false,
                    reason: 'this review key already names a different tree — ask again under a new key',
                })
            );
        }
        process.exit(0);
    }
    const identity = ['-c', 'user.name=factory', '-c', 'user.email=factory@invalid'];
    const commit = git([...identity, 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'review snapshot']);
    git(['update-ref', ref, commit, ZERO_OID]);
    console.log(JSON.stringify({ ok: true, ref, existed: false }));
} catch (e) {
    console.log(JSON.stringify({ ok: false, reason: 'the review snapshot failed: ' + reasonOf(e) }));
} finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}
