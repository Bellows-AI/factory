/**
 * The generic workflow-block runtime dispatcher (issue #231): turns a block's declared wait
 * boundary — `WorkflowNode.runtime`, attached by `workflow-blocks/index.ts`'s compiler — into
 * durable park/wake behavior built on #202's PR-lifecycle primitives (`enterWait`/`claimReview`,
 * `pr-lifecycle-store.ts`). Dispatch is by allowlisted runtime id only, never by a user-provided
 * module or script name; this module knows no block's own review-repair or merge-conflict policy —
 * see docs/workflows.md, "Durable block waits".
 *
 * A wait consumes a row of `workflow_round` (038), never a `job` row: parking a thread here is
 * exactly what keeps a waiting thread from holding a runner/executor lease. The round is keyed by
 * `(org, root, workflow_node)` — the compiled node name is already unique within one thread's
 * expanded graph (`DUPLICATE_NODE`), so it doubles as the PR-lifecycle wait's own `reason` with no
 * extra namespacing required.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { JobStorePrs } from '../job-store-types.js';
import { insertWorkflowSuccessor } from '../job-store-rows.js';
import type { BlockConfigValue, WorkflowNode } from '../workflow-schema.js';

/** The one runtime id shipped so far. A future one is a new entry in `HANDLERS`, nothing else. */
export const BLOCK_RUNTIME_IDS = ['pr-delivery-wait'] as const;
export type BlockRuntimeId = (typeof BLOCK_RUNTIME_IDS)[number];

interface BlockRuntimeHandler {
    id: BlockRuntimeId;
    /** Validates a descriptor's raw `params` at compile time; `null` refuses `BAD_BLOCK_CONFIG`. */
    parseParams(raw: Record<string, BlockConfigValue>): Record<string, BlockConfigValue> | null;
}

/**
 * Parks the thread until GitHub review activity folds against the thread's published PR, then
 * makes exactly one continuation claimable. No params of its own today — the wait's address (repo,
 * PR number) comes from the thread's recorded publication (#202's `job_pr`), never from config.
 */
const PR_DELIVERY_WAIT: BlockRuntimeHandler = {
    id: 'pr-delivery-wait',
    parseParams(raw) {
        return Object.keys(raw).length === 0 ? {} : null;
    },
};

const HANDLERS: ReadonlyMap<BlockRuntimeId, BlockRuntimeHandler> = new Map(
    [PR_DELIVERY_WAIT].map((handler) => [handler.id, handler])
);

export function isBlockRuntimeId(id: string): id is BlockRuntimeId {
    return HANDLERS.has(id as BlockRuntimeId);
}

/**
 * Validates one runtime descriptor's params against its handler — the compiler's own attach step
 * (`workflow-blocks/index.ts`). `null` means the id is unknown or the params do not match its
 * handler's shape; either refuses `BAD_BLOCK_CONFIG` before the descriptor's node is ever stored.
 */
export function parseRuntimeParams(
    runtimeId: string,
    raw: Record<string, BlockConfigValue>
): Record<string, BlockConfigValue> | null {
    const handler = HANDLERS.get(runtimeId as BlockRuntimeId);
    return handler ? handler.parseParams(raw) : null;
}

/** Whether a resolved snapshot node's own `runtime` is well-formed against the current allowlist. */
export function runtimeIsValid(node: WorkflowNode): boolean {
    if (!node.runtime) return false;
    return parseRuntimeParams(node.runtime.runtime, node.runtime.params) !== null;
}

/** The successor a completed transition would otherwise have inserted immediately (docs/workflows.md). */
export interface PendingSuccessor {
    orgId: string;
    rootJobId: string;
    /** The row whose completion produced this transition — the continuation's eventual parent. */
    parentJobId: string;
    repo: string | null;
    executor: string | null;
    sessionId: string | null;
    workflowNode: string;
    command: string;
}

/**
 * The transition's wait-boundary half (`job-store-worker.ts`'s `runWorkflowTransition`, inside the
 * verdict's transaction and the same per-root advisory lock that transaction already holds — no
 * additional locking is needed here, the park is already fully serialized against every other
 * transition, claim and sweep of this thread).
 *
 * A node with a `runtime` this build does not recognize, or with no PR store configured, or whose
 * thread has not published yet, RESTS the thread — never falls back to an ordinary insert, which
 * would silently skip the wait ("Marker absence is a first-class outcome", docs/workflows.md, holds
 * here too). The caller (`job-store-worker.ts`) only calls this when `node.runtime` is set; every
 * other node keeps inserting its successor directly.
 */
export async function enterRuntimeBoundary(
    tx: TransactionSql,
    prs: JobStorePrs | undefined,
    node: WorkflowNode,
    successor: PendingSuccessor
): Promise<void> {
    if (!prs || !runtimeIsValid(node)) return;

    const publication = await prs.publicationOf(successor.rootJobId, tx);
    if (!publication) return;

    await prs.enterWait(
        {
            root: successor.rootJobId,
            reason: successor.workflowNode,
            repo: publication.repo,
            prNumber: publication.prNumber,
        },
        tx
    );

    const [parked] = await tx<{ round: number }[]>`
        select round from workflow_round
        where org_id = ${successor.orgId} and root_job_id = ${successor.rootJobId}
          and workflow_node = ${successor.workflowNode} and woken_at is null
    `;
    if (parked) {
        // A second transition into this same wait node before the first ever woke (an unusual but
        // legal graph shape) refreshes the parked continuation in place — the newest transition's
        // command/session/repo/executor wins, and the round number (and the wait's own pending
        // count, untouched by enterWait on an already-active wait) both carry over unchanged.
        await tx`
            update workflow_round set
                repo = ${publication.repo}, pr_number = ${publication.prNumber},
                command = ${successor.command}, session_id = ${successor.sessionId},
                job_repo = ${successor.repo}, executor = ${successor.executor},
                parent_job_id = ${successor.parentJobId}, parked_at = now()
            where org_id = ${successor.orgId} and root_job_id = ${successor.rootJobId}
              and workflow_node = ${successor.workflowNode} and round = ${parked.round}
        `;
        return;
    }
    const [previous] = await tx<{ max: number | null }[]>`
        select max(round) as max from workflow_round
        where org_id = ${successor.orgId} and root_job_id = ${successor.rootJobId}
          and workflow_node = ${successor.workflowNode}
    `;
    const round = (previous?.max ?? 0) + 1;
    await tx`
        insert into workflow_round (
            org_id, root_job_id, workflow_node, round, repo, pr_number,
            command, session_id, job_repo, executor, parent_job_id
        ) values (
            ${successor.orgId}, ${successor.rootJobId}, ${successor.workflowNode}, ${round},
            ${publication.repo}, ${publication.prNumber},
            ${successor.command}, ${successor.sessionId}, ${successor.repo}, ${successor.executor},
            ${successor.parentJobId}
        )
    `;
}

/** At most this many parked rounds are considered per sweep — a bounded batch, not a full scan. */
const WAKE_BATCH = 8;

interface RoundRow {
    workflow_node: string;
    command: string;
    session_id: string | null;
    job_repo: string | null;
    executor: string | null;
    parent_job_id: string;
}

/**
 * The claim preamble's wake sweep (`job-store-claim.ts`'s `claimJob`, before it looks for queued
 * work): claims every parked wait with pending review activity and makes exactly one continuation
 * job claimable for it. Each candidate wakes in its OWN transaction, under that thread's per-root
 * advisory lock — the same serialization point a claim and a transition already use — so a wake can
 * never race a transition re-parking the same node, and two sweepers (or a sweeper and a claim
 * re-checking after waking) can never double-wake one round: the second one's re-check under the
 * lock finds `woken_at` already set and does nothing.
 *
 * A thread with any active member (queued, running, or already marked done) is skipped — waking it
 * would either duplicate a live run's worktree or wake a thread nobody can act on again.
 */
export async function sweepRuntimeWakes(ctx: { sql: Sql; orgId: string; prs: JobStorePrs | undefined }): Promise<void> {
    const { sql, orgId, prs } = ctx;
    if (!prs) return;

    const candidates = await sql<{ root_job_id: string; workflow_node: string }[]>`
        select r.root_job_id, r.workflow_node
        from workflow_round r
        join workflow_wait w
          on w.org_id = r.org_id and w.root_job_id = r.root_job_id and w.reason = r.workflow_node
        where r.org_id = ${orgId}
          and r.woken_at is null
          and w.completed_at is null and w.cancelled_at is null
          and w.pending > 0
          and not exists (
              select 1 from job m
              where m.org_id = r.org_id and m.root_job_id = r.root_job_id
                and (m.status in ('queued', 'running') or m.done_at is not null)
          )
        order by w.last_event_at nulls last, r.parked_at
        limit ${WAKE_BATCH}
    `;

    for (const candidate of candidates) {
        await sql.begin(async (tx) => {
            await tx`select pg_advisory_xact_lock(hashtextextended(${candidate.root_job_id}::text, 0))`;

            // Re-checked under the lock: the candidate list above ran unlocked, so a follow-up
            // queued or the thread marked done between that read and this lock grant would
            // otherwise slip past it. Best-effort, not a hard guarantee — neither writer takes
            // this same advisory lock, so a write landing in the narrow window between this check
            // and the insert below is still possible; `sameThreadRunning` (job-store-claim.ts) is
            // what actually keeps two rows of one thread from running at once regardless.
            const [active] = await tx<{ any: boolean }[]>`
                select exists (
                    select 1 from job m
                    where m.org_id = ${orgId} and m.root_job_id = ${candidate.root_job_id}
                      and (m.status in ('queued', 'running') or m.done_at is not null)
                ) as any
            `;
            if (active?.any) return;

            const [round] = await tx<RoundRow[]>`
                select workflow_node, command, session_id, job_repo, executor, parent_job_id
                from workflow_round
                where org_id = ${orgId} and root_job_id = ${candidate.root_job_id}
                  and workflow_node = ${candidate.workflow_node} and woken_at is null
                for update
            `;
            if (!round) return;

            const claimed = await prs.claimReview(candidate.root_job_id, candidate.workflow_node, tx);
            if (claimed.pending === 0) return;

            const [root] = await tx<
                { workflow_id: string | null; workflow_name: string | null; created_by: string | null }[]
            >`
                select workflow_id, workflow_name, created_by from job
                where org_id = ${orgId} and id = ${candidate.root_job_id}
            `;
            if (!root) return;

            const jobId = await insertWorkflowSuccessor(tx, {
                orgId,
                command: round.command,
                createdBy: root.created_by,
                repo: round.job_repo,
                executor: round.executor,
                parentJobId: round.parent_job_id,
                sessionId: round.session_id,
                rootJobId: candidate.root_job_id,
                workflowId: root.workflow_id,
                workflowName: root.workflow_name,
                workflowNode: candidate.workflow_node,
            });

            await tx`
                update workflow_round set
                    woken_at = now(), job_id = ${jobId},
                    delivery_count = ${claimed.pending}, last_delivery_id = ${claimed.lastDeliveryId}
                where org_id = ${orgId} and root_job_id = ${candidate.root_job_id}
                  and workflow_node = ${candidate.workflow_node} and woken_at is null
            `;
        });
    }
}

/**
 * The claim's cancellation fence (`job-store-claim.ts`'s `claimNextCandidate`, run under the
 * candidate's own claim — already inside that thread's per-root advisory lock): a continuation the
 * sweep just woke, whose wait was cancelled (PR close, task stop/remove) after the wake committed
 * but before this claim reached it, is settled `stopped` instead of handed to a worker. Every other
 * claim — a workflow-less job, a plain agent node, a continuation whose wait is still open — pays
 * one indexed lookup keyed off nothing but the just-claimed row id and returns false immediately.
 */
export async function isCancelledContinuation(tx: TransactionSql, orgId: string, jobId: string): Promise<boolean> {
    const rows = await tx<{ job_id: string }[]>`
        select r.job_id from workflow_round r
        join workflow_wait w
          on w.org_id = r.org_id and w.root_job_id = r.root_job_id and w.reason = r.workflow_node
        where r.org_id = ${orgId} and r.job_id = ${jobId} and w.cancelled_at is not null
    `;
    return rows.length > 0;
}
