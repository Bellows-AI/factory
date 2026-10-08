import type { BoardJob } from './board.js';
import { containerScript } from './container-scripts.js';
import type { DriverConfig } from './config.js';
import {
    parseLastJsonLine,
    probeTreeFingerprint,
    type PublishStep,
    type RunPublishStep,
    worktreeDir,
} from './publish.js';
import type { Runner } from './runner.js';

/**
 * The review snapshot (issue #549): the step that freezes the task worktree's current state under
 * a ref of the shared clone, so a named reviewer's own worktree starts from exactly the tree it was
 * asked about while the agent keeps editing. One PublishStep, so it runs over either executor's
 * transport — a `docker run --rm` or a kubernetes aux Job — and the two cannot drift. The script
 * writes only a ref and never overwrites one: see scripts/git-review-snapshot.cjs.
 */

/** The snapshot's node script: see scripts/git-review-snapshot.cjs. */
export const gitReviewSnapshotScript = containerScript('git-review-snapshot.cjs');

/**
 * The ref one review's snapshot lives under in the shared clone. A copy of the board's
 * `reviewRefOf` (server/src/db/job-store-reviews.ts), which refuses any other ref on a request —
 * this package depends on nothing, so the spelling is kept in step by `review-snapshot.test.ts`.
 */
export const reviewRefOf = (job: BoardJob, key: string): string => `refs/factory/review/${job.id}/${key}`;

export type SnapshotResult = { ok: true; ref: string } | { ok: false; reason: string };

/**
 * The two steps that read the task worktree and need no claim env — the tree probe and the review
 * snapshot — built over one transport: `bare` answers the step runner for a job and its stand-down
 * signal. The docker runner spreads this into itself; both ride the same `PublishStep` seam.
 */
export function treeSteps(
    config: DriverConfig,
    bare: (job: BoardJob, signal?: AbortSignal) => RunPublishStep
): Pick<Runner, 'probeTree' | 'snapshotTree'> {
    return {
        probeTree: (job, signal) => probeTreeFingerprint(config, job, bare(job, signal)),
        snapshotTree: (job, key, signal) => snapshotTree(config, job, key, bare(job, signal)),
    };
}

/**
 * Freezes the task tree for review `key`. A job with no worktree, or a step that cannot run or
 * answers nothing readable, is a named `ok: false` — never a guess at a ref that may not exist.
 */
export async function snapshotTree(
    config: DriverConfig,
    job: BoardJob,
    key: string,
    runStep: RunPublishStep
): Promise<SnapshotResult> {
    const repo = worktreeDir(config, job);
    if (!repo) return { ok: false, reason: 'this task has no worktree to snapshot' };
    const ref = reviewRefOf(job, key);
    const step: PublishStep = {
        label: 'review snapshot',
        entrypoint: 'node',
        args: ['-e', gitReviewSnapshotScript],
        env: false,
        envLiterals: { REPO: repo, REVIEW_REF: ref },
        inRepo: false,
    };
    try {
        const { stdout } = await runStep(step);
        const verdict = parseLastJsonLine<{ ok?: unknown; reason?: unknown }>(stdout, () => ({}));
        if (verdict.ok === true) return { ok: true, ref };
        return {
            ok: false,
            reason:
                typeof verdict.reason === 'string' ? verdict.reason : 'the review snapshot answered nothing readable',
        };
    } catch (e) {
        return { ok: false, reason: `the review snapshot could not run: ${(e as Error).message}` };
    }
}
