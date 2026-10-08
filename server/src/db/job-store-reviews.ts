/**
 * Independent reviewer invocation (issue #549), the store half. A review is a job row of its OWN
 * thread — `root_job_id` is its own id — linked to the caller by `review_of`, so it never contends
 * with the caller for the thread's one running row and runs in a worktree of its own. The caller
 * asks under a key (`(caller, key)` is unique: a retried or reclaimed caller gets the same review
 * back), reads the verdict by the same key, and the thread's review evidence — what the policy
 * validator reads at completion — counts the review's row as bound to the revision the caller
 * asked about. Cancellation is the rest of the lifecycle: a Stop, the caller's verdict and a
 * removal all reach the reviews (`job-store-actions.ts`, `job-store-worker.ts`).
 */

import { OBJECTIVE_MODE, USER_SCOPE } from '@factory-ai/core';
import type { Fragment, Sql, TransactionSql } from 'postgres';
import type { ReviewEvidence } from './evidence-policy.js';
import { readReviewEvidence } from './job-store-evidence.js';
import { exists, stopRows } from './job-store-rows.js';
import type {
    FailureKind,
    JobStatus,
    JobStoreContext,
    ReadReviewResult,
    RequestReviewResult,
    ReviewerSpec,
    ReviewRequest,
    ReviewView,
} from './job-store-types.js';
import { reviewerPrompts } from './review-prompt.js';
import { tailMatches } from './workflow-schema.js';
import { REVIEW_BLOCKERS_MARKER, REVIEW_VERDICT_MARKER } from './workflow-templates.js';

/**
 * The git ref one review's snapshot lives under in the shared clone, keyed by the CALLER ROW — the
 * same scope the board's uniqueness is, so a follow-up or retry (a new row of the same thread)
 * never meets a ref an earlier row made. The driver builds the same string
 * (`driver/src/review-snapshot.ts`) before it asks — a copy, not an import — and the board refuses
 * any other, so a request can never point a reviewer at a ref that is not this caller's.
 */
export const reviewRefOf = (callerId: string, key: string): string => `refs/factory/review/${callerId}/${key}`;

interface CallerRow {
    id: string;
    root_job_id: string;
    created_by: string | null;
    repo: string | null;
    executor: string | null;
    executor_scope: string | null;
    mode: string;
    reviewers: ReviewerSpec[] | null;
}

interface ReviewRow {
    id: string;
    review_key: string;
    review_profile: string;
    review_revision: string;
    status: JobStatus;
    output: string | null;
    failure_kind: FailureKind | null;
}

/** The verdict a review row's output ends on: only a SUCCEEDED run's marker counts. */
function verdictOf(row: Pick<ReviewRow, 'status' | 'output'>): ReviewView['verdict'] {
    if (row.status !== 'succeeded') return 'none';
    if (tailMatches(row.output, REVIEW_BLOCKERS_MARKER)) return 'blockers';
    return tailMatches(row.output, REVIEW_VERDICT_MARKER) ? 'clean' : 'none';
}

const viewOf = (row: ReviewRow, evidence: ReviewEvidence): ReviewView => ({
    id: row.id,
    key: row.review_key,
    profile: row.review_profile,
    status: row.status,
    verdict: verdictOf(row),
    revision: row.review_revision,
    findings: row.output,
    failureKind: row.failure_kind,
    evidence,
});

async function reviewByKey(
    tx: TransactionSql,
    orgId: string,
    callerId: string,
    key: string
): Promise<ReviewRow | undefined> {
    const [row] = await tx<ReviewRow[]>`
        select id, review_key, review_profile, review_revision, status, output, failure_kind
        from job
        where org_id = ${orgId} and review_of = ${callerId} and review_key = ${key}
    `;
    return row;
}

/** The caller under its live lease, locked: the guard and the serializer of one request. */
async function lockedCaller(
    tx: TransactionSql,
    orgId: string,
    id: string,
    leaseToken: string
): Promise<CallerRow | undefined> {
    const [caller] = await tx<CallerRow[]>`
        select id, root_job_id, created_by, repo, executor, executor_scope, mode, reviewers from job
        where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
        for update
    `;
    return caller;
}

/**
 * Stops every live review of the given callers — what a caller's Stop, its verdict and its dead
 * retirement all do, so no review outlives the work it assessed (issue #549). A queued review
 * settles `stopped`, a leased one is stamped and its heartbeat delivers the kill; one that already
 * ended is left alone, which is what makes a retried Stop change nothing.
 */
export async function stopReviewsOf(
    sql: Sql | TransactionSql,
    stop: { orgId: string; wallTick: Fragment; stoppedBy: string | null },
    callerIds: readonly string[]
): Promise<void> {
    if (callerIds.length === 0) return;
    await stopRows(sql, { ...stop, where: sql`review_of = any(${[...callerIds]}::uuid[])` });
}

export async function requestReviewFor(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    request: ReviewRequest
): Promise<RequestReviewResult> {
    const { sql, orgId } = ctx;
    return sql.begin(async (tx): Promise<RequestReviewResult> => {
        const caller = await lockedCaller(tx, orgId, id, leaseToken);
        if (!caller) return { result: (await exists(tx, orgId, id)) ? 'lost' : 'missing' };
        // A workflow thread's graph owns its review node; a profile review belongs to the
        // objective path, whose evidence has no graph to read it from.
        if (caller.mode !== OBJECTIVE_MODE) return { result: 'unsupported' };
        const evidence = () => readReviewEvidence(tx, { orgId, rootJobId: caller.root_job_id }, null);
        const stored = await reviewByKey(tx, orgId, id, request.key);
        if (stored) return { result: 'existing', review: viewOf(stored, await evidence()) };
        const spec = caller.reviewers?.find((profile) => profile.name === request.profile);
        if (!spec) return { result: 'unknown_profile' };
        // The reviewer's worktree starts from this ref in the SHARED clone: it must be the one
        // snapshot namespace of this caller and key, never another's ref or a branch.
        if (request.ref !== reviewRefOf(caller.id, request.key)) return { result: 'invalid_ref' };
        const [root] = await tx<{ command: string }[]>`
            select command from job where org_id = ${orgId} and id = ${caller.root_job_id}
        `;
        const { command } = reviewerPrompts(spec, root?.command ?? '');
        // id and root_job_id are the SAME uuid, as a task's root row is: the review is its own thread.
        await tx`
            insert into job (
                org_id, command, created_by, repo, executor, executor_scope, id, root_job_id, mode,
                review_of, review_key, review_profile, review_spec, review_revision, review_ref
            )
            select ${orgId}, ${command}, ${caller.created_by}, ${caller.repo}, ${caller.executor},
                   ${caller.executor_scope ?? USER_SCOPE}, x, x, ${OBJECTIVE_MODE},
                   ${id}, ${request.key}, ${spec.name}, ${tx.json(spec as never)}, ${request.revision}, ${request.ref}
            from (select gen_random_uuid() as x) s
        `;
        const created = await reviewByKey(tx, orgId, id, request.key);
        return { result: 'created', review: viewOf(created!, await evidence()) };
    });
}

export async function readReviewFor(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    key: string
): Promise<ReadReviewResult> {
    const { sql, orgId } = ctx;
    return sql.begin(async (tx): Promise<ReadReviewResult> => {
        const [caller] = await tx<{ root_job_id: string }[]>`
            select root_job_id from job
            where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
        `;
        if (!caller) return { result: (await exists(tx, orgId, id)) ? 'lost' : 'missing' };
        const row = await reviewByKey(tx, orgId, id, key);
        if (!row) return { result: 'unknown' };
        const evidence = await readReviewEvidence(tx, { orgId, rootJobId: caller.root_job_id }, null);
        return { result: 'ok', review: viewOf(row, evidence) };
    });
}
