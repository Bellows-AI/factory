import type { BoardJob } from './board.js';
import { deleteJob, publishStepJobName, publishStepJobSpec } from './k8s-auxspec.js';
import { jobsPath } from './k8s-podspec.js';
import { auxVerdict } from './k8s-poll.js';
import { expectOk } from './k8s-transport.js';
import type { K8sDeps } from './k8s-transport.js';
import { probeTreeFingerprint, worktreeDir } from './publish.js';
import { type SnapshotResult, snapshotTree } from './review-snapshot.js';

/**
 * The kubernetes runner's one-step aux Jobs over a task worktree: the publish's own steps, the
 * post-gate tree probe, and the review snapshot (issue #549). Each is one publish-shaped step the
 * workflow in `publish.ts` hands a transport; this is that transport's half.
 */

/** One publish-shaped step as an aux Job: create, poll to its verdict, reap on every path. */
export async function runPublishStepJob(
    deps: K8sDeps,
    job: BoardJob,
    input: Parameters<typeof publishStepJobSpec>[2],
    signal?: AbortSignal
): Promise<{ stdout: string }> {
    const jobName = publishStepJobName(job, input.step);
    try {
        const created = await deps.request(
            'POST',
            jobsPath(deps.config.k8sNamespace),
            publishStepJobSpec(deps.config, job, input)
        );
        expectOk(created, 'creating the publish job');
        const verdict = await auxVerdict(deps, jobName, signal);
        if (verdict.exitCode !== 0) {
            throw new Error(
                verdict.output.trim() || `the step exited ${verdict.exitCode ?? 'without a readable code'}`
            );
        }
        return { stdout: verdict.output };
    } finally {
        void deleteJob(deps, jobName);
    }
}

/** The post-gate tree probe's step number — below every publish step's. */
const TREE_PROBE_STEP = 0;

/** The review snapshot's step number — beside the probe's, far above any publish step's. */
const REVIEW_SNAPSHOT_STEP = 90;

/**
 * The post-gate tree probe: the publish's probe step as one aux Job, no Secret — the probe reads
 * no claim env. Step 0 is its name: publish steps count from 1, so the two never share a Job name.
 * An aborted `signal` ends the poll and deletes the Job (`runPublishStepJob`'s finally).
 */
export async function probeTree(deps: K8sDeps, job: BoardJob, signal?: AbortSignal): Promise<string | null> {
    const repo = worktreeDir(deps.config, job);
    if (!repo) return null;
    return probeTreeFingerprint(deps.config, job, (publish) =>
        runPublishStepJob(deps, job, { step: TREE_PROBE_STEP, publish, envSecret: null, repo }, signal)
    );
}

/**
 * The review snapshot: the same one-step aux Job the tree probe runs, no Secret — it reads one
 * worktree and writes one ref, and needs no claim env. An aborted `signal` ends the poll and
 * deletes the Job.
 */
export async function snapshotReviewTree(
    deps: K8sDeps,
    job: BoardJob,
    key: string,
    signal?: AbortSignal
): Promise<SnapshotResult> {
    const repo = worktreeDir(deps.config, job);
    if (!repo) return { ok: false, reason: 'this task has no worktree to snapshot' };
    return snapshotTree(deps.config, job, key, (publish) =>
        runPublishStepJob(deps, job, { step: REVIEW_SNAPSHOT_STEP, publish, envSecret: null, repo }, signal)
    );
}
