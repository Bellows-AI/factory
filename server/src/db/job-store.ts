/**
 * The job board: task and thread creation, the claim/lease protocol a driver walks a run through,
 * and the read models the dashboard polls. `createJobStore` binds a connection and an org into a
 * `JobStore` whose every method delegates to a free function over a `JobStoreContext`:
 *
 * - `job-store-types.ts` — every shape: `Job`, `Claim`, the `JobStore` contract, results, deps.
 * - `job-store-rows.ts` — row shapes, mappers and the shared SQL fragments.
 * - `job-store-claim.ts` — the worker's claim and the reclaim claim/ack.
 * - `job-store-worker.ts` — heartbeat, reports, publish token, `complete` and the workflow walk.
 * - `job-store-actions.ts` — member actions: create, follow up, done, stop, suspend, remove.
 * - `job-store-reads.ts` — get, thread, list, and the task list.
 * - `job-store-org-resolvers.ts` — org-of-lease/job/reclaim, and the minted-token base layer.
 *
 * Import from the file that owns a name; there is no barrel. Read docs/jobs.md before touching any
 * of them: the decisions here look simplifiable and mostly are not.
 */

import {
    createJobRow,
    createFollowUpRow,
    markJobDone,
    stopJob,
    suspendJob,
    removeJobThread,
} from './job-store-actions.js';
import { claimJob, claimReclaimRow, ackReclaimRow } from './job-store-claim.js';
import { threadOf, getJob, listJobs, listTasksOf } from './job-store-reads.js';
import {
    wallTickFragment,
    authorJoinFragment,
    authorColumnsFragment,
    taskPreviewColumnsFragment,
} from './job-store-rows.js';
import type { CreateJobStoreDeps, JobStore, JobStoreContext, RuntimeVitals } from './job-store-types.js';
import {
    heartbeatJob,
    sessionReport,
    progressReport,
    gatesReport,
    rereadGatesJob,
    publishTokenJob,
    completeJob,
} from './job-store-worker.js';

/**
 * The organization is bound at construction: it is a constant for the life of the process, and a
 * per-call parameter is one more thing a write path can forget.
 *
 * `hasWorkspaces` is bound the same way, and it decides whether a claim reports a `workspacePath`
 * at all. Without a configured workspace root no directory was ever created, so naming one would
 * hand the driver a path that does not exist — and `docker run -w` silently CREATES a missing
 * workdir, so the runner would start in an empty directory rather than failing the job. That is
 * exactly the case the driver's null check exists to catch, and it only reaches it if the board is
 * honest here.
 */
export function createJobStore(deps: CreateJobStoreDeps): JobStore {
    const { sql, orgId, hasWorkspaces = true, ready, env, githubToken, gates: gatesReader, executorConfig, prs } = deps;
    const gate = async () => {
        if (ready) await ready;
    };

    // Every method's own body is a function in the sibling job-store-*.ts files (the header's map);
    // this context is what each of them closes over.
    const ctx: JobStoreContext = {
        sql,
        orgId,
        hasWorkspaces,
        env,
        githubToken,
        gatesReader,
        executorConfig,
        prs,
        wallTick: wallTickFragment(sql),
        authorJoin: authorJoinFragment(sql),
        authorColumns: authorColumnsFragment(sql),
        taskPreviewColumns: taskPreviewColumnsFragment(sql),
    };

    return {
        async create(command, createdBy, target) {
            await gate();
            return createJobRow(ctx, command, createdBy, target);
        },

        async createFollowUp(parentId, command, createdBy) {
            await gate();
            return createFollowUpRow(sql, { orgId, parentId, command, createdBy });
        },

        async markDone(id, doneBy) {
            await gate();
            return markJobDone(ctx, id, doneBy);
        },

        async stop(id, stoppedBy) {
            await gate();
            return stopJob(ctx, id, stoppedBy);
        },

        async claim(worker, leaseSeconds) {
            await gate();
            return claimJob(ctx, worker, leaseSeconds);
        },

        async heartbeat(id, leaseToken, leaseSeconds) {
            await gate();
            return heartbeatJob(ctx, id, leaseToken, leaseSeconds);
        },

        async session(id, leaseToken, sessionId, remoteSessionId) {
            await gate();
            return sessionReport(ctx, id, leaseToken, { sessionId, remoteSessionId });
        },

        async progress(id, leaseToken, output, runtime: RuntimeVitals | null = null) {
            await gate();
            return progressReport(ctx, id, leaseToken, { output, runtime });
        },

        async gates(id, leaseToken, results) {
            await gate();
            return gatesReport(ctx, id, leaseToken, results);
        },

        async rereadGates(id, leaseToken) {
            await gate();
            return rereadGatesJob(ctx, id, leaseToken);
        },

        async publishToken(id, leaseToken) {
            await gate();
            return publishTokenJob(ctx, id, leaseToken);
        },

        async suspend(id, leaseToken) {
            await gate();
            return suspendJob(ctx, id, leaseToken);
        },

        async removeThread(id, removedBy) {
            await gate();
            return removeJobThread(ctx, id, removedBy);
        },

        async claimReclaim(worker, leaseSeconds) {
            await gate();
            return claimReclaimRow(ctx, worker, leaseSeconds);
        },

        async ackReclaim(id, worker) {
            await gate();
            return ackReclaimRow(ctx, id, worker);
        },

        async complete(id, leaseToken, result) {
            await gate();
            return completeJob(ctx, id, leaseToken, result);
        },

        async thread(id) {
            await gate();
            return threadOf(ctx, id);
        },

        async get(id) {
            await gate();
            return getJob(ctx, id);
        },

        async list(filter) {
            await gate();
            return listJobs(ctx, filter);
        },

        async listTasks(filters) {
            await gate();
            return listTasksOf(ctx, filters);
        },
    };
}
