import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * What a checkout looks like on disk: its branch, its newest commit, and its size.
 *
 * All three are filesystem reads on a route the SPA polls. Done naively that is a `git log` plus a
 * recursive directory walk per repo, per member, per tick — so nothing here is read on demand. The
 * route serves whatever is cached and schedules a refresh, and a cold entry reports null rather
 * than making the request wait for a walk.
 *
 * Null therefore means "not measured yet", never zero. A repository that is still cloning has no
 * size, and rendering `0 B` for it would be a claim rather than an absence.
 */

export interface CheckoutFacts {
    readonly branch: string | null;
    readonly lastCommit: { sha: string; at: string; headline: string } | null;
    readonly sizeBytes: number | null;
}

const UNKNOWN: CheckoutFacts = { branch: null, lastCommit: null, sizeBytes: null };

/**
 * Branch and last commit are one cheap `git log`, so they refresh often enough to look live after a
 * commit. The size is a full walk of the tree, which is the expensive one, so it refreshes rarely
 * and is allowed to be minutes out of date — nobody makes a decision on it.
 */
const HEAD_TTL_MS = 30_000;
const SIZE_TTL_MS = 5 * 60 * 1000;

/**
 * How long the size measurement is allowed to take before it is abandoned.
 *
 * A checkout with its dependencies installed is hundreds of thousands of files. `du` is fast, but a
 * cold page cache on a network volume is not, and an unbounded child process per checkout per five
 * minutes is a way to accumulate them.
 */
const SIZE_TIMEOUT_MS = 20_000;

interface Entry {
    facts: CheckoutFacts;
    headAt: number;
    sizeAt: number;
    /** Single-flight per key, so a burst of polls does not start a walk each. */
    pending: Promise<void> | null;
}

export interface FactsCache {
    /**
     * Never blocks and never throws. Schedules a refresh when what it has is stale.
     *
     * There is no `invalidate`: the route only asks about a checkout once it is `ready`, and a
     * repository reaches `ready` exactly once, so a newly-cloned tree has no entry to be stale.
     */
    get(dir: string): CheckoutFacts;
}

async function readHead(dir: string): Promise<Pick<CheckoutFacts, 'branch' | 'lastCommit'>> {
    // Concurrent: two independent reads of the same checkout, and each is a process spawn.
    const [branch, log] = await Promise.all([
        run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
            .then((r) => r.stdout.trim() || null)
            .catch(() => null),
        run('git', ['-C', dir, 'log', '-1', '--format=%H%x00%cI%x00%s'])
            .then((r) => r.stdout.trim())
            .catch(() => ''),
    ]);
    const [sha, at, headline] = log.split('\0');
    return {
        branch,
        lastCommit: sha && at ? { sha, at, headline: headline ?? '' } : null,
    };
}

/**
 * `du`, not a walk in this process.
 *
 * This was a `readdirSync`/`statSync` recursion, and it was a genuine mistake: an async function
 * runs synchronously up to its first `await`, so on the common path — the size is due, the head is
 * not — the whole traversal executed inline inside the request handler. A checkout with its
 * dependencies installed is hundreds of thousands of files, so that stalled the event loop for
 * every other request in the process, for seconds, per checkout, every five minutes.
 *
 * `du` does the same work in another process, where blocking is free. `-s` for a total, `-k` for
 * kibibytes (POSIX; `-b` is GNU-only and this runs on alpine). Symlinks are not followed by
 * default, which is what stops a link out of the checkout double-counting or walking the disk.
 */
async function readSize(dir: string): Promise<number | null> {
    try {
        const { stdout } = await run('du', ['-sk', dir], { timeout: SIZE_TIMEOUT_MS });
        const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
        return Number.isFinite(kib) ? kib * 1024 : null;
    } catch {
        // Timed out, or `du` is absent. Null renders as an em dash, which is the honest answer:
        // nobody measured it. Never 0, which would claim an empty checkout.
        return null;
    }
}

export function createFactsCache(now: () => number = Date.now): FactsCache {
    const entries = new Map<string, Entry>();

    const refresh = (dir: string, entry: Entry): void => {
        if (entry.pending) return;
        const wantHead = now() - entry.headAt >= HEAD_TTL_MS;
        const wantSize = now() - entry.sizeAt >= SIZE_TTL_MS;
        if (!wantHead && !wantSize) return;

        entry.pending = (async () => {
            // Both off the request path — nothing awaits this promise — and both concurrent with
            // each other, because they are separate processes reading the same directory.
            const [head, size] = await Promise.all([wantHead ? readHead(dir) : null, wantSize ? readSize(dir) : null]);
            if (head) {
                entry.facts = { ...entry.facts, ...head };
                entry.headAt = now();
            }
            if (wantSize) {
                entry.facts = { ...entry.facts, sizeBytes: size };
                entry.sizeAt = now();
            }
        })()
            .catch(() => {
                // A checkout that vanished, or a git that is not installed. The stale facts stay,
                // and the route keeps answering — none of this is load-bearing.
            })
            .finally(() => {
                entry.pending = null;
            });
    };

    return {
        get(dir) {
            let entry = entries.get(dir);
            if (!entry) {
                entry = { facts: UNKNOWN, headAt: 0, sizeAt: 0, pending: null };
                entries.set(dir, entry);
            }
            refresh(dir, entry);
            return entry.facts;
        },
    };
}
