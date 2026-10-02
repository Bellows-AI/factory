/**
 * What members do to tasks: create, follow up, mark done, reopen, stop, suspend, remove, control
 * a parked PR wait (issue #328) — and the reclaim a thread queues once its last member is done.
 */

import type { Sql, TransactionSql } from 'postgres';
import { USER_SCOPE } from '@factory-ai/core';
import { exists, queueReclaimIfThreadDone, workspacePathFor, hasRunningMember } from './job-store-rows.js';
import { settleIfMergeClosed } from './job-store-merge.js';
import type { EditCommandResult, JobStore, JobStoreContext, JobStatus } from './job-store-types.js';
import { wakeOneRound } from './workflow-blocks/runtime.js';

export type CreateTarget = Parameters<JobStore['create']>[2];

/**
 * The author's checkout row, locked and checked, INSIDE the job-insert transaction (issue #92).
 *
 * A checkout stamped `purging` is coming off the disk; a task must not be queued into it. Taking
 * the row's `for update` lock here — the same lock `stampPurge` holds — is what makes both orders
 * safe: an insert that commits BEFORE the stamp is visible to the stamp's unfinished-task count
 * (so the purge refuses), and an insert that arrives AFTER the stamp reads `purging` under READ
 * COMMITTED once the lock is granted (so the insert refuses). An unlocked preflight query would
 * be a stale-snapshot read that can race the stamp either way, which is why there isn't one.
 *
 * No row is no refusal: a job may be queued when the checkout row is already gone (the rows come
 * and go with a PUT), under the existing task contract — the claim may later find no checkout.
 * Command-only tasks (no repo) and authorless tasks run in no checkout and are never guarded.
 */
async function refuseIfCheckoutPurging(
    tx: TransactionSql,
    orgId: string,
    createdBy: string | null,
    repo: string | null
): Promise<boolean> {
    if (!createdBy || !repo) return false;
    const name = repo.split('/')[1];
    if (!name) return false;
    const rows = await tx<{ status: string }[]>`
        select status from user_repo
        where org_id = ${orgId} and user_id = ${createdBy} and repo_name = ${name}
        for update
    `;
    return rows[0]?.status === 'purging';
}

export async function createJobRow(
    ctx: JobStoreContext,
    command: string,
    createdBy: string | null,
    target: CreateTarget
): Promise<{ id: string } | 'purging'> {
    const { sql, orgId } = ctx;
    // One transaction: the checkout-row lock/check and the insert are decided together, which is
    // the whole point — see refuseIfCheckoutPurging.
    return sql.begin(async (tx) => {
        if (await refuseIfCheckoutPurging(tx, orgId, createdBy, target.repo)) return 'purging';
        // id and root_job_id are the SAME uuid, computed once in the select so the column can
        // be not null from insert — the root's root is itself (022). The workflow triple rides
        // the same insert when a workflow resolved: workflow_id names what the task walks (null
        // for the code-owned default, issue #209 — it is never a row in `workflow`),
        // workflow_name freezes the resolved record's NAME on the row (033), workflow_node is
        // the entry the first run carries, the snapshot freezes the graph onto
        // the root — where every transition decision reads it — and workflow_params freezes the
        // validated launch values beside it (030). default_review_reconciliation/
        // default_merge_conflict_autofix (039) and default_gate_fix_rounds (043) freeze the
        // default workflow's launch-time options, root-only like the snapshot, and stay null on
        // every other create — a named workflow, or the pre-209 workflow-less create this insert
        // has always supported.
        const rows = await tx<{ id: string }[]>`
            insert into job (
                org_id, command, created_by, repo, executor, executor_scope, id, root_job_id,
                workflow_id, workflow_name, workflow_node, workflow_snapshot, workflow_params,
                default_review_reconciliation, default_merge_conflict_autofix, default_gate_fix_rounds
            )
            select ${orgId}, ${command}, ${createdBy}, ${target.repo}, ${target.executor}, ${target.executorScope ?? USER_SCOPE}, x, x,
                   ${target.workflow?.id ?? null},
                   ${target.workflow?.name ?? null},
                   ${target.workflow?.node ?? null},
                   ${target.workflow ? sql.json(target.workflow.snapshot as never) : null},
                   ${target.workflow ? sql.json(target.workflow.params as never) : null},
                   ${target.workflow?.defaultOptions?.reviewReconciliation ?? null},
                   ${target.workflow?.defaultOptions?.mergeConflictAutofix ?? null},
                   ${target.workflow?.defaultOptions?.gateFixRounds ?? null}
            from (select gen_random_uuid() as x) s
            returning id
        `;
        return { id: rows[0]!.id };
    });
}

/**
 * createFollowUp's body. One conditional insert: the select carries every precondition (finished, not done, has a
 * session, same org), so a follow-up can never land on a parent that fails one. The select also
 * takes the parent row's lock, which is what makes a racing markDone impossible to answer from a
 * stale snapshot: under READ COMMITTED, whichever statement gets the lock second re-checks the
 * qualifications against the row's newest committed version — a done parent yields no row and the
 * read below answers task_done, never a done task with queued follow-up work. The author
 * predicate is null-safe (`is not distinct from`): a null caller may only follow up a parent with
 * no author — the state every pre-accounts task is in — and an authored parent refuses a caller
 * with no account, which is the read below's forbidden answer. The session ids AND the executor
 * are copied at insert, which is what makes the claim resume the parent conversation, on the
 * executor that ran it, without any new claim-side rule. The parent's root_job_id comes across
 * with them — the child joins the SAME conversation (022), whether its parent is a root or a
 * mid-chain turn.
 *
 * WHICH session: a pre-workflow thread copies the PARENT's session — the newest run's, the
 * conversation chaining forward exactly as it always has. A workflow thread copies its PRIMARY
 * session — the first `resume`-policy run's, read off the root's snapshot (design.md Decision 3):
 * the newest row of a workflow thread is often a fresh-eyes review, whose session is a side
 * branch, and a follow-up must continue the thread, not the branch. The coalesce answers the
 * parent's session when no resume run has reported one yet, so the refusal shape below never
 * changes.
 */
export interface FollowUpRowInput {
    orgId: string;
    parentId: string;
    command: string;
    createdBy: string | null;
}

export async function createFollowUpRow(
    sql: Sql,
    input: FollowUpRowInput
): Promise<{ id: string } | 'missing' | 'task_done' | 'not_finished' | 'no_session' | 'forbidden' | 'purging'> {
    const { orgId, parentId, command, createdBy } = input;
    // One transaction for the checkout-row guard and the conditional insert, so a purge that
    // commits between them cannot slip a follow-up into a checkout that is being deleted — the
    // same lock both job-insert paths take (refuseIfCheckoutPurging), taken BEFORE the insert.
    return sql.begin(async (tx) => {
        // The follow-up runs in the PARENT's repo's checkout, so the guard reads the parent's
        // repo label (a finished parent's label never changes) — and the same read resolves the
        // thread root the advisory lock below is keyed by.
        const [label] = await tx<{ repo: string | null; root_job_id: string }[]>`
            select repo, root_job_id from job where org_id = ${orgId} and id = ${parentId}
        `;
        if (!label) return 'missing';
        if (await refuseIfCheckoutPurging(tx, orgId, createdBy, label.repo)) return 'purging';
        // The same per-thread advisory lock the claim, remove, reopen and done take: the
        // eligibility check and the insert must be atomic with a racing done on ANY member —
        // not only on the parent row the CTE below locks — or a done could commit between the
        // check and the insert and leave queued work in a thread the user closed.
        await tx`select pg_advisory_xact_lock(hashtextextended(${label.root_job_id}::text, 0))`;
        const rows = await tx<{ id: string }[]>`
            with parent as (
                select id, repo, executor, executor_scope, session_id, root_job_id, workflow_name
                from job
                where org_id = ${orgId} and id = ${parentId}
                  and status in ('succeeded','failed','dead','stopped')
                  and done_at is null
                  and session_id is not null
                  and created_by is not distinct from ${createdBy}
                for update
            ),
            root as (
                select root.id as root_id, root.workflow_snapshot as snapshot
                from parent, job root
                where root.org_id = ${orgId} and root.id = parent.root_job_id
            ),
            primary_session as (
                select
                    case
                        when root.snapshot is null then parent.session_id
                        else (
                            select r.session_id
                            from job r
                            where r.org_id = ${orgId} and r.root_job_id = root.root_id
                              and r.session_id is not null
                              and exists (
                                  select 1 from jsonb_array_elements(root.snapshot -> 'nodes') node
                                  where node->>'name' = r.workflow_node and node->>'session' = 'resume'
                              )
                            order by r.created_at, r.id
                            limit 1
                        )
                    end as session_id
                from parent, root
            )
            insert into job (org_id, command, created_by, repo, executor, executor_scope, parent_job_id, session_id, root_job_id, workflow_name)
            select ${orgId}, ${command}, ${createdBy}, parent.repo, parent.executor, parent.executor_scope, parent.id,
                   coalesce(primary_session.session_id, parent.session_id),
                   parent.root_job_id, parent.workflow_name
            from parent, root, primary_session
            returning id
        `;
        if (rows[0]) return { id: rows[0]!.id };
        // Nothing inserted — one of the five preconditions failed, and which one decides the answer
        // the route turns into a status code. Forbidden is last: a sessionless parent answers the
        // truer no_session whoever asks, and a parent with no author falls through the author check
        // rather than refusing. The parent cannot have moved to deleted since the pre-read above —
        // remove deletes under this same advisory lock — so missing was decided before the lock.
        return followUpRefusalOf(tx, orgId, parentId, createdBy);
    });
}

/**
 * Names the precondition the conditional insert failed on, for the row AS IT IS NOW — a parent
 * that moved on between the CTE and this read can make the refusal name the newer state, and the
 * retry then succeeds (the same honesty the original inline shape had, extracted so the function
 * above stays readable).
 */
async function followUpRefusalOf(
    tx: TransactionSql,
    orgId: string,
    parentId: string,
    createdBy: string | null
): Promise<'task_done' | 'not_finished' | 'no_session' | 'forbidden'> {
    const [parent] = await tx<
        { status: JobStatus; done_at: Date | null; session_id: string | null; created_by: string | null }[]
    >`
        select status, done_at, session_id, created_by from job where org_id = ${orgId} and id = ${parentId}
    `;
    if (parent!.done_at !== null) return 'task_done';
    if (
        parent!.status !== 'succeeded' &&
        parent!.status !== 'failed' &&
        parent!.status !== 'dead' &&
        parent!.status !== 'stopped'
    ) {
        return 'not_finished';
    }
    if (parent!.session_id === null) return 'no_session';
    if (parent!.created_by !== createdBy) return 'forbidden';
    return 'no_session';
}

/**
 * createRetry's body (issue #326): queue a fresh attempt of the thread head's command in the SAME
 * thread, without resuming a session. One transaction and one conditional insert, shaped exactly
 * like the follow-up's: the checkout purge guard first, then the insert. Eligibility is the
 * THREAD's, not the named row's: the `named` CTE carries only the caller's own-row predicate
 * under its `for update` lock, and the INSERT..SELECT admits the retry only when the thread HEAD
 * (the newest member by created_at then id — the same chainHead rule the reads follow) is
 * terminal and NO member of the thread carries a done_at. A terminal root therefore cannot queue
 * a second attempt under a head that is still queued or running, and a terminal head whose
 * thread the user closed anywhere refuses task_done. The refusal below names the thread as it is
 * now, never a stale snapshot.
 *
 * What is copied comes from the thread HEAD: its command, repo, executor, workflow_name and
 * root_job_id. What is deliberately ABSENT is the follow-up's other two columns: no
 * `parent_job_id` and no `session_id`. The claim computes `followUp` from `parent_job_id` and
 * keeps `session_id` only on a follow-up, so this row is delivered as an ordinary first run —
 * `resumeSessionId: null, followUp: false` — with no claim-side rule added, and it lands in the
 * thread's own worktree because the worktree is keyed by `root_job_id`.
 */
export async function createRetryRow(
    sql: Sql,
    input: { orgId: string; id: string; createdBy: string | null }
): Promise<{ id: string } | 'missing' | 'not_finished' | 'task_done' | 'forbidden' | 'purging'> {
    const { orgId, id, createdBy } = input;
    // One transaction for the checkout-row guard and the conditional insert, the same lock both
    // job-insert paths take (refuseIfCheckoutPurging), taken BEFORE the insert.
    return sql.begin(async (tx) => {
        // The retry runs in the thread's repo's checkout, so the guard reads the named row's
        // repo label (a finished row's label never changes) — and the same read resolves the
        // thread root the advisory lock below is keyed by.
        const [label] = await tx<{ repo: string | null; root_job_id: string }[]>`
            select repo, root_job_id from job where org_id = ${orgId} and id = ${id}
        `;
        if (!label) return 'missing';
        if (await refuseIfCheckoutPurging(tx, orgId, createdBy, label.repo)) return 'purging';
        // The same per-thread advisory lock the claim, remove, reopen and done take: the
        // eligibility check and the insert must be atomic with a racing done on ANY member and
        // with a claim of the head, or a done could commit between the check and the insert and
        // leave a fresh attempt queued into a closed thread.
        await tx`select pg_advisory_xact_lock(hashtextextended(${label.root_job_id}::text, 0))`;
        const rows = await tx<{ id: string }[]>`
            with named as (
                select id, root_job_id
                from job
                where org_id = ${orgId} and id = ${id}
                  and created_by is not distinct from ${createdBy}
                for update
            ),
            head as (
                select command, repo, executor, executor_scope, root_job_id, workflow_name, status
                from job
                where org_id = ${orgId} and root_job_id = (select root_job_id from named)
                order by created_at desc, id desc
                limit 1
            )
            insert into job (org_id, command, created_by, repo, executor, executor_scope, root_job_id, workflow_name)
            select ${orgId}, head.command, ${createdBy}, head.repo, head.executor, head.executor_scope,
                   head.root_job_id, head.workflow_name
            from named, head
            where head.status in ('succeeded','failed','dead','stopped')
              and not exists (
                  select 1
                  from job d
                  where d.org_id = ${orgId}
                    and d.root_job_id = head.root_job_id
                    and d.done_at is not null
              )
            returning id
        `;
        if (rows[0]) return { id: rows[0]!.id };
        // Nothing inserted — one of the preconditions failed, and which one decides the answer
        // the route turns into a status code.
        return retryRefusalOf(tx, orgId, id, createdBy);
    });
}

/**
 * Names the precondition the conditional insert failed on, for the thread AS IT IS NOW — the
 * same honesty followUpRefusalOf states. The eligibility the insert decided is the thread's, so
 * the refusal reads all three facts in one go and answers in the priority they mean: a HEAD
 * that is still moving owns the turn (`not_finished`) even when an older member carries
 * done_at — retry later, or reopen the done first; a done on ANY member is the thread closed
 * (`task_done`); the author predicate is decided last, so a thread that is over answers its
 * over-ness to whoever asks before it answers `forbidden` — and forbidden is the catch-all for
 * a row that moved between the CTE and this read. A row that moved all the way to deleted
 * answers `missing` rather than dying on the read.
 */
async function retryRefusalOf(
    tx: TransactionSql,
    orgId: string,
    id: string,
    createdBy: string | null
): Promise<'missing' | 'task_done' | 'not_finished' | 'forbidden'> {
    const [row] = await tx<{ head_status: JobStatus | null; thread_done: boolean; created_by: string | null }[]>`
        select (
            select status from job head
            where head.org_id = ${orgId} and head.root_job_id = named.root_job_id
            order by head.created_at desc, head.id desc
            limit 1
        ) as head_status,
        exists (
            select 1 from job d
            where d.org_id = ${orgId} and d.root_job_id = named.root_job_id
              and d.done_at is not null
        ) as thread_done,
        named.created_by
        from job named
        where named.org_id = ${orgId} and named.id = ${id}
    `;
    if (!row) return 'missing';
    if (
        row.head_status !== 'succeeded' &&
        row.head_status !== 'failed' &&
        row.head_status !== 'dead' &&
        row.head_status !== 'stopped'
    ) {
        return 'not_finished';
    }
    if (row.thread_done) return 'task_done';
    if (row.created_by !== createdBy) return 'forbidden';
    return 'forbidden';
}

/**
 * editCommand's body (issue #329). One conditional UPDATE carries every precondition — queued,
 * off-graph, the caller's own task — so an edit can never land on a row a worker already holds:
 * the UPDATE takes the row's lock, and under READ COMMITTED whichever statement gets the lock
 * second re-checks its predicates against the row's newest committed version. A claim that
 * commits first turns the edit's 0-rows answer into `not_queued`; an edit that commits first is
 * what the claim's `RETURNING command` delivers. No advisory lock — this touches ONE row, and
 * the row lock is the serialization, exactly as stop's single statement already relies on it;
 * the advisory lock is the pattern for thread-wide operations (claim, remove, reopen).
 *
 * The author predicate is null-safe (`is not distinct from`): a null caller may only edit an
 * authorless row, and an authored row refuses a caller with no account. `workflow_node is null`
 * is the prompt-built discriminator: a workflow root's and a queued continuation's command are
 * interpolated prompt text, never the member's own words — there is no raw line to edit from.
 * On 0 rows, one classification read answers which precondition failed — state before author,
 * the follow-up refusal's ordering.
 */
export async function editJobCommand(
    ctx: JobStoreContext,
    id: string,
    command: string,
    caller: string | null
): Promise<EditCommandResult> {
    const { sql, orgId } = ctx;
    return sql.begin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
            update job set command = ${command}
            where org_id = ${orgId} and id = ${id}
              and status = 'queued'
              and workflow_node is null
              and created_by is not distinct from ${caller}
            returning id
        `;
        if (rows[0]) return { result: 'ok', command };
        const [row] = await tx<{ status: JobStatus; workflow_node: string | null; created_by: string | null }[]>`
            select status, workflow_node, created_by from job where org_id = ${orgId} and id = ${id}
        `;
        if (!row) return 'missing';
        if (row.status !== 'queued') return { result: 'not_queued', status: row.status };
        if (row.workflow_node !== null) return 'workflow';
        return 'forbidden';
    });
}

export async function markJobDone(
    ctx: JobStoreContext,
    id: string,
    doneBy: string | null
): Promise<{ status: JobStatus; doneAt: string } | 'missing' | 'conflict'> {
    const { sql, orgId, hasWorkspaces } = ctx;
    // One transaction, because done is what frees the tree now (issue #47's second half):
    // stamping done_at and queueing the worktree reclaim must be decided together, on the
    // thread AS THE DONE LANDS — the terminality read below runs on the same connection,
    // where the just-stamped row is visible and a follow-up inserted after the commit is
    // not. A thread that is still moving keeps its tree: its last completing attempt will
    // find every member terminal AND this done_at in place, and reclaim at the verdict.
    return sql.begin(async (tx) => {
        // The thread root, straight off the named row (022) — the same pre-lock read remove and
        // reopen make. Nothing when the input never existed.
        const [named] = await tx<{ root_job_id: string }[]>`
            select root_job_id from job where org_id = ${orgId} and id = ${id}
        `;
        if (!named) return 'missing';
        // The same per-thread advisory lock the claim, remove, reopen and both insert paths take:
        // stamping done_at must be atomic with the follow-up and retry inserts — whose
        // thread-done eligibility checks read it — and with remove and reopen, or one of them
        // could decide against a thread whose done it could not see. It also serializes done
        // against remove and reopen, which row-locking alone never did.
        await tx`select pg_advisory_xact_lock(hashtextextended(${named.root_job_id}::text, 0))`;
        // coalesce, not assignment: the second "done" answers the first one's instant,
        // which is what makes the route idempotent rather than silently rewriting history.
        // done_by rides the same rule: the first writer's actor survives a retried click.
        const rows = await tx<{ status: JobStatus; done_at: Date; root_job_id: string }[]>`
            update job set done_at = coalesce(done_at, now()), done_by = coalesce(done_by, ${doneBy})
            where org_id = ${orgId} and id = ${id}
              and status in ('succeeded','failed','dead','stopped')
            returning status, done_at, root_job_id
        `;
        const row = rows[0];
        if (!row) {
            return (await exists(sql, orgId, id)) ? 'conflict' : 'missing';
        }
        await queueReclaimIfThreadDone(tx, orgId, hasWorkspaces, row.root_job_id);
        return { status: row.status, doneAt: row.done_at.toISOString() };
    });
}

export type StopJobResult = Awaited<ReturnType<JobStore['stop']>>;

export async function stopJob(ctx: JobStoreContext, id: string, stoppedBy: string | null): Promise<StopJobResult> {
    const { sql, orgId, wallTick, prs } = ctx;
    // One statement decides the outcome by the status it sees. A QUEUED row never started,
    // so it is settled `stopped` here: the turn is over, and the session it keeps is what
    // the follow-up continues. A RUNNING
    // row whose lease is still live is stamped `cancel_requested_at` and left running:
    // the request travels on the heartbeat the worker already sends, and the settle that
    // honours it (suspend under the stamp) clears it. A RUNNING row whose lease has
    // ALREADY expired is settled `stopped` here instead (issue #152): nobody holds the
    // lease, so a stamp would wait for a heartbeat nobody will send — and a previous
    // holder that is still beating loses the row on its next beat (`lost`, the kill
    // order) exactly as a reclaim delivers it. The settle lands like the suspend park
    // does: finished_at stamped, the last segment banked, the attempt handed back — a
    // stop is a park, not a failed try — and the session kept for the follow-up.
    // coalesce keeps the FIRST request, which is what makes /stop idempotent rather than
    // a rewrite of when it was asked. stopped_by coalesces beside it unconditionally —
    // every status this UPDATE touches is a stoppable one, so this caller acted, and the
    // first asker is the actor that survives.
    const rows = await sql<{ status: JobStatus; cancel_requested_at: Date | null; root_job_id: string }[]>`
        update job set
            status = case
                when status = 'queued' then 'stopped'
                when status = 'running' and lease_expires_at <= now() then 'stopped'
                else status
            end,
            finished_at = case
                when status = 'queued' then now()
                when status = 'running' and lease_expires_at <= now() then now()
                else finished_at
            end,
            wall_clock_ms = case
                when status = 'running' and lease_expires_at <= now() then ${wallTick}
                else wall_clock_ms
            end,
            attempts = case
                when status = 'running' and lease_expires_at <= now() then greatest(attempts - 1, 0)
                else attempts
            end,
            lease_token = case
                when status = 'running' and lease_expires_at <= now() then null
                else lease_token
            end,
            lease_expires_at = case
                when status = 'running' and lease_expires_at <= now() then now()
                else lease_expires_at
            end,
            cancel_requested_at = case
                when status = 'running' and lease_expires_at > now() then coalesce(cancel_requested_at, now())
                else null
            end,
            stopped_by = coalesce(stopped_by, ${stoppedBy})
        where org_id = ${orgId} and id = ${id}
          and status in ('queued','running')
        returning status, cancel_requested_at, root_job_id
    `;
    const row = rows[0];
    if (!row) {
        // Nothing settled or moving — a task that already ended has no turn to stop, and
        // the status rides the refusal so the route can say which.
        const [other] = await sql<{ status: JobStatus }[]>`
            select status from job where org_id = ${orgId} and id = ${id}
        `;
        return other ? { result: 'conflict', status: other.status } : 'missing';
    }
    if (row.cancel_requested_at === null) {
        // A settled stop ends the thread's turn: its PR waits have nothing left to
        // fold for — the session a follow-up continues from starts its own wait cycle.
        if (prs) {
            await prs.cancelWaitsForRoot(row.root_job_id, 'task stopped');
        }
        // A merge-marked thread whose last moving member just stopped is closed by that stop
        // (issue #390): done stamp, reclaim — the shared conditional settle, a no-op on any
        // thread the closure never marked.
        await settleIfMergeClosed(ctx, row.root_job_id);
    }
    return row.cancel_requested_at !== null
        ? { result: 'requested', cancelRequestedAt: row.cancel_requested_at.toISOString() }
        : { result: 'stopped' };
}

export async function suspendJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string
): ReturnType<JobStore['suspend']> {
    const { sql, orgId, wallTick } = ctx;
    // One update: the parking IS the user's stop landing (the stamp the heartbeat
    // delivered). The row settles `stopped` — terminal, `finished_at` stamped, the session
    // kept for the follow-up that continues the turn. The lease expires, exactly as insert
    // does it: the row is not claimable, so this changes nothing while it sits — and then
    // it is the difference between the next poll acting on the row and it waiting out the
    // lease the dying worker held. The command is in the transcript now
    // (command_delivered_at), the stamp clears — the stop has happened — and the attempt is
    // handed back: a park is not a failed try, so it must never exhaust max_attempts.
    const rows = await sql<{ id: string; status: JobStatus; root_job_id: string }[]>`
        update job set
            status           = 'stopped',
            finished_at      = now(),
            -- The park ends the segment the attempt was running: the container was doing
            -- real work up to now, and the time after this statement banks nothing.
            wall_clock_ms    = ${wallTick},
            lease_token      = null,
            -- Expired on the way in, exactly as insert does it.
            lease_expires_at = now(),
            -- The command is in the transcript now, and this is the moment that becomes
            -- true: the claim reads this column to keep a resumed follow-up from
            -- re-delivering it (see claim). coalesce, so parking twice stamps once.
            command_delivered_at = coalesce(command_delivered_at, now()),
            -- Parking IS the deferred stop landing (the flag was set by the user's /stop
            -- and delivered by the heartbeat): cleared now, or the settled row would keep
            -- answering a request that already happened.
            cancel_requested_at = null,
            -- Hands back the attempt the claim took.
            attempts         = greatest(attempts - 1, 0)
        where org_id = ${orgId} and id = ${id}
          and status = 'running' and lease_token = ${leaseToken}
        returning id, status, root_job_id
    `;
    if (rows[0]) {
        // The park settles a moving row; a merge-marked thread whose last moving member just
        // parked is closed by it (issue #390) — the shared conditional settle.
        await settleIfMergeClosed(ctx, rows[0].root_job_id);
        return { result: 'ok', status: rows[0]!.status };
    }
    return (await exists(sql, orgId, id)) ? ({ result: 'lost' } as const) : ({ result: 'missing' } as const);
}

export async function removeJobThread(
    ctx: JobStoreContext,
    id: string,
    removedBy: string | null
): ReturnType<JobStore['removeThread']> {
    const { sql, orgId, hasWorkspaces, prs } = ctx;
    // Same per-thread advisory lock the claim takes, for the same serialization reason: the
    // refusal check and the delete must see every earlier claim of this thread commit, or a
    // claim could walk out with a row after the check passed and before the delete ran — a
    // removed task with a member running again afterwards. The lock queues removals against
    // claims of the same thread and nothing else.
    return sql.begin(async (tx) => {
        // The thread root, straight off the named row (022). Nothing when the input never
        // existed — the row read below then answers nothing and the route says missing.
        const [named] = await tx<{ id: string; root_job_id: string }[]>`
            select id, root_job_id from job
            where org_id = ${orgId} and id = ${id}
        `;
        if (!named) return 'missing';
        const rootJobId = named.root_job_id;
        await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;

        // The thread's ROOT row carries the labels the reclaim is addressed by — the repo
        // the worktree was checked out from and the author whose checkout root it lives
        // under.
        const [root] = await tx<{ id: string; repo: string | null; created_by: string | null }[]>`
            select id, repo, created_by from job
            where org_id = ${orgId} and id = ${rootJobId}
        `;
        if (!root) return 'missing';

        // Every member of the thread carries the same root_job_id (022), so the thread is
        // one indexed read. Branching included, should two adjustments ever land on one
        // parent.
        const members = await tx<{ id: string; status: JobStatus }[]>`
            select id, status from job
            where org_id = ${orgId} and root_job_id = ${rootJobId}
        `;
        // The one refusal: a member is running. The user stops it first — the per-task
        // worktree is a live runner's checkout, and tearing it out under the container would
        // corrupt a run that was happily going.
        if (hasRunningMember(members)) return 'conflict';

        // The rows are gone for good — nothing joins through job.id at claim time (the
        // claim copies its session labels onto its own row), so deleting the audit trail is
        // the removal, not a cleanup that orphans something.
        await tx`
            delete from job
            where org_id = ${orgId} and id = any(${members.map((m) => m.id)})
        `;

        // The thread is gone, and with it every PR wait folded for it — the webhook's
        // next redelivery folds into nothing, which is the point: no ghost thread wakes.
        if (prs) {
            await prs.cancelWaitsForRoot(rootJobId, 'task removed', tx);
        }
        // Any parked or already-woken block-wait round (issue #231) is this thread's audit data
        // too — cancelWaitsForRoot above already makes it permanently unwakeable, this is just not
        // leaving it behind forever.
        await tx`delete from workflow_round where org_id = ${orgId} and root_job_id = ${rootJobId}`;
        // The merge-closure marker (issue #390) is the thread's audit data the same way: the rows
        // it discriminates are gone.
        await tx`delete from job_merge_close where org_id = ${orgId} and root_job_id = ${rootJobId}`;

        // Queue the worktree reclaim. The driver polls this queue — nothing is holding a
        // lease on a removed thread, so no live driver would ever notice the deletion
        // otherwise — and takes the tree down, acking the row when it has. Same relative
        // path the claim derives, empty labels included: a tree keyed only on the root id
        // still gets reclaimed, pointing at nothing additional is fine.
        const workspacePath = workspacePathFor(orgId, hasWorkspaces, root.created_by);
        await tx`
            insert into task_reclaim (org_id, root_job_id, repo, workspace_path, removed_by)
            values (${orgId}, ${rootJobId}, ${root.repo}, ${workspacePath}, ${removedBy})
        `;

        return { result: 'ok', rootJobId, repo: root.repo, workspacePath };
    });
}

/**
 * The shared preamble of both wait-control verbs (issue #328): resolve the named id to its
 * thread root and check the caller may act on the thread. `id` may be any member — the wait
 * belongs to the root, exactly as `removeThread` resolves. Author-scoped like the follow-up (the
 * woken continuation runs in the author's worktree): only the account that queued the thread —
 * or an anonymous caller on a thread with no author — gets past here.
 */
type ControlledRoot = { ok: true; root: string } | { ok: false; refusal: 'missing' | 'forbidden' };

async function resolveControlledRoot(
    sql: Sql,
    orgId: string,
    id: string,
    caller: string | null
): Promise<ControlledRoot> {
    const [named] = await sql<{ root_job_id: string; created_by: string | null }[]>`
        select root_job_id, created_by from job
        where org_id = ${orgId} and id = ${id}
    `;
    if (!named) return { ok: false, refusal: 'missing' };
    if (named.created_by !== caller) return { ok: false, refusal: 'forbidden' };
    return { ok: true, root: named.root_job_id };
}

/**
 * The user's wait-cancel (issue #328): `cancelWaitsForRoot` with the user reason and the acting
 * caller, decided atomically enough — the update's `cancelled_at is null` predicate IS the
 * no-open-wait answer, so a cancel racing itself answers `ok` exactly once and `no_wait` after.
 * No advisory lock, exactly like `cancelForRepoPr`/`cancelWaitsForRoot` today: a cancel can land
 * at any time, including between a wake committing and the continuation being claimed, and the
 * claim-time cancellation fence is what makes cancellation win that race.
 */
export async function cancelThreadWait(
    ctx: JobStoreContext,
    id: string,
    cancelledBy: string | null
): ReturnType<JobStore['cancelWait']> {
    const { sql, orgId, prs } = ctx;
    const resolved = await resolveControlledRoot(sql, orgId, id, cancelledBy);
    if (!resolved.ok) return resolved.refusal;
    if (!prs) return 'no_wait';
    const cancelled = await prs.cancelWaitsForRoot(resolved.root, 'cancelled by user', undefined, cancelledBy);
    return cancelled > 0 ? { result: 'ok' } : 'no_wait';
}

/**
 * The user's poke (issue #328): re-evaluate the parked PR now. The board's only GitHub input is
 * webhook deliveries, so "re-evaluate" cannot mean fetching GitHub here — it means running the
 * wake transaction (`wakeOneRound`) for the thread's parked rounds without the sweep's
 * `pending > 0` gate: whatever IS folded is claimed honestly (a poke that folds nothing stamps
 * `delivery_count = 0` — the audit signature of a user wake), and the continuation's own
 * claim-time pre-helper is what actually re-fetches the PR state. Pre-reads run unlocked, exactly
 * like the sweep's candidate list; `wakeOneRound` re-checks everything that matters under the
 * thread's advisory lock, so two concurrent pokes wake a round exactly once.
 */
export async function pokeThreadWait(
    ctx: JobStoreContext,
    id: string,
    pokedBy: string | null
): ReturnType<JobStore['pokeWait']> {
    const { sql, orgId, prs } = ctx;
    const resolved = await resolveControlledRoot(sql, orgId, id, pokedBy);
    if (!resolved.ok) return resolved.refusal;
    if (!prs) return 'no_wait';
    const root = resolved.root;

    // The no-open-wait refusal first — the issue's one mandated 409: a thread that never parked,
    // or whose wait already ended, has nothing to evaluate. Distinct from the `woken: false`
    // answer an OPEN wait with nothing parked gets below (already woken, active member, done).
    const [open] = await sql<{ one: number }[]>`
        select 1 as one from workflow_wait
        where org_id = ${orgId} and root_job_id = ${root}
          and completed_at is null and cancelled_at is null
    `;
    if (!open) return 'no_wait';

    // The same shape the sweep's candidate query takes, scoped to this thread: an open wait
    // joined to its parked round. `woken: false` for none — nothing parked, or already woken.
    const parked = await sql<{ workflow_node: string }[]>`
        select r.workflow_node
        from workflow_round r
        join workflow_wait w
          on w.org_id = r.org_id and w.root_job_id = r.root_job_id and w.reason = r.workflow_node
        where r.org_id = ${orgId}
          and r.root_job_id = ${root}
          and r.woken_at is null
          and w.completed_at is null and w.cancelled_at is null
        order by r.parked_at
    `;
    if (parked.length === 0) return { result: 'ok', woken: false };

    let woken = false;
    for (const round of parked) {
        const jobId = await wakeOneRound({ sql, orgId, prs }, root, round.workflow_node, false);
        woken = woken || jobId !== null;
    }
    return { result: 'ok', woken };
}

/**
 * Done's inverse (issue #327): clear the done stamp on every member of the thread and withdraw a
 * task_reclaim row that has not run yet, so a task closed by mistake can be followed up again —
 * createFollowUpRow's `done_at is null` predicate is exactly what this reverses. The whole decision
 * is one transaction under the SAME per-thread advisory lock the claim and remove take: the refusal
 * checks, the withdraw and the clear must see every earlier claim of this thread commit, or a
 * reclaim claim could take the row between the check and the withdraw — a tree removed for a task
 * that believes itself reopened. A row a worker holds a LIVE claim on is refused outright
 * (`reclaiming`): the tree is coming down right now, and a 200 over it would be the board vouching
 * for a worktree that is about to stop existing. The lease expiry is what relinquishes a crashed
 * worker's claim — the same rule #152 applies to a lost job lease — so an expired claim withdraws
 * like an unclaimed row. The lock does NOT cover done or complete (deliberately — docs/jobs.md
 * forbids stalling them behind claim preparation), so a redundant done click or a verdict whose
 * aggregate straddles this commit can still queue or order a removal after the withdraw; the
 * follow-up recovers by recreating the tree from the surviving branch.
 */
export async function reopenJob(ctx: JobStoreContext, id: string): ReturnType<JobStore['reopen']> {
    const { sql, orgId } = ctx;
    return sql.begin(async (tx) => {
        // The thread root, straight off the named row (022) — the same pre-lock read
        // removeJobThread makes. Nothing when the input never existed.
        const [named] = await tx<{ id: string; root_job_id: string }[]>`
            select id, root_job_id from job
            where org_id = ${orgId} and id = ${id}
        `;
        if (!named) return 'missing';
        const rootJobId = named.root_job_id;
        await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;

        // A removed tree is unrecoverable: a follow-up resumes a session in the tree it ran in,
        // and there is no tree. The marker (045) is stamped at the ack and at a threadDone
        // verdict — the queue row alone could not carry this, because ack deletes it and the
        // verdict path never queues one. The root read doubles as the remove-lost-the-race
        // check: remove deletes the rows under this same lock, so no root row means the thread
        // is gone, whatever the pre-lock read saw.
        const [root] = await tx<{ worktree_reclaimed_at: Date | null }[]>`
            select worktree_reclaimed_at from job
            where org_id = ${orgId} and id = ${rootJobId}
        `;
        if (!root) return 'missing';
        if (root.worktree_reclaimed_at !== null) return 'reclaimed';

        // A worker holding a LIVE claim is mid-removal — refuse rather than reopen over a tree
        // that is about to come down. claimed_at-or-expired is exactly claimReclaimRow's own
        // claimable predicate, read the other way; the post-withdraw re-check below is what
        // catches a claim that commits between here and the delete (claimReclaimRow takes no
        // advisory lock).
        const claimed = (table: typeof tx) => table`
            select id from task_reclaim
            where org_id = ${orgId} and root_job_id = ${rootJobId}
              and claimed_by is not null and lease_expires_at > now()
        `;
        if ((await claimed(tx))[0]) return 'reclaiming';

        // A thread nobody closed has nothing to reopen — and reopen is deliberately NOT
        // idempotent: the second call answers this, the state the first one left behind.
        const [members] = await tx<{ done: number }[]>`
            select count(*)::int as done from job
            where org_id = ${orgId} and root_job_id = ${rootJobId} and done_at is not null
        `;
        if (!members || members.done === 0) return 'not_done';

        // Withdraw the queued reclaim BEFORE clearing the stamp, in the same transaction — and
        // only rows no worker holds a live claim on. The DELETE's row lock is what serializes
        // against claimReclaimRow's `for update skip locked` candidate: a row being withdrawn is
        // skipped, never handed out; a row claimed mid-transaction fails this delete's re-checked
        // predicate and survives it, which the re-read below then refuses.
        await tx`
            delete from task_reclaim
            where org_id = ${orgId} and root_job_id = ${rootJobId}
              and (claimed_by is null or lease_expires_at <= now())
        `;
        if ((await claimed(tx))[0]) return 'reclaiming';

        // The stamp is the thread's done (the UI marks the head, so it can sit on any member):
        // cleared wherever it sits, which is what makes the follow-up possible again.
        await tx`
            update job set done_at = null, done_by = null
            where org_id = ${orgId} and root_job_id = ${rootJobId} and done_at is not null
        `;
        // A merge closure's marker (issue #390) is the discriminator complete's transition reads:
        // gone with the stamps, so a thread the user reopens after an automatic Done walks its
        // graph again — and the surviving `pr_merge` ledger row is what keeps a redelivered merge
        // from re-closing it.
        await tx`
            delete from job_merge_close
            where org_id = ${orgId} and root_job_id = ${rootJobId}
        `;
        return { result: 'ok' };
    });
}
