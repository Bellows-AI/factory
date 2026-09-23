/**
 * What members do to tasks: create, follow up, mark done, stop, suspend, remove — and the reclaim a
 * thread queues once its last member is done.
 */

import type { Sql, TransactionSql } from 'postgres';
import { exists, workspacePathFor, hasRunningMember } from './job-store-rows.js';
import type { JobStore, JobStoreContext, JobStatus } from './job-store-types.js';

export type CreateTarget = Parameters<JobStore['create']>[2];

export async function createJobRow(
    ctx: JobStoreContext,
    command: string,
    createdBy: string | null,
    target: CreateTarget
): Promise<{ id: string }> {
    const { sql, orgId } = ctx;
    // id and root_job_id are the SAME uuid, computed once in the select so the column can
    // be not null from insert — the root's root is itself (022). The workflow triple rides
    // the same insert when a workflow resolved: workflow_id names what the task walks,
    // workflow_name freezes the resolved record's NAME on the row (033), workflow_node is
    // the entry the first run carries, the snapshot freezes the graph onto
    // the root — where every transition decision reads it — and workflow_params freezes the
    // validated launch values beside it (030). All null on a workflow-less create,
    // byte-identical to the pre-027 insert.
    const rows = await sql<{ id: string }[]>`
        insert into job (org_id, command, created_by, repo, executor, id, root_job_id, workflow_id, workflow_name, workflow_node, workflow_snapshot, workflow_params)
        select ${orgId}, ${command}, ${createdBy}, ${target.repo}, ${target.executor}, x, x,
               ${target.workflow?.id ?? null},
               ${target.workflow?.name ?? null},
               ${target.workflow?.node ?? null},
               ${target.workflow ? sql.json(target.workflow.snapshot as never) : null},
               ${target.workflow ? sql.json(target.workflow.params as never) : null}
        from (select gen_random_uuid() as x) s
        returning id
    `;
    return { id: rows[0]!.id };
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
): Promise<{ id: string } | 'missing' | 'task_done' | 'not_finished' | 'no_session' | 'forbidden'> {
    const { orgId, parentId, command, createdBy } = input;
    const rows = await sql<{ id: string }[]>`
        with parent as (
            select id, repo, executor, session_id, root_job_id, workflow_name
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
        insert into job (org_id, command, created_by, repo, executor, parent_job_id, session_id, root_job_id, workflow_name)
        select ${orgId}, ${command}, ${createdBy}, parent.repo, parent.executor, parent.id,
               coalesce(primary_session.session_id, parent.session_id),
               parent.root_job_id, parent.workflow_name
        from parent, root, primary_session
        returning id
    `;
    if (rows[0]) return { id: rows[0]!.id };
    // Nothing inserted — one of the five preconditions failed, and which one decides the answer
    // the route turns into a status code. Forbidden is last: a sessionless parent answers the
    // truer no_session whoever asks, and a parent with no author falls through the author check
    // rather than refusing.
    if (!(await exists(sql, orgId, parentId))) return 'missing';
    const [parent] = await sql<
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

/**
 * `markDone`'s second half: if this done just made the whole thread terminal, queue its worktree
 * reclaim. The thread is one indexed read off the root column (022), and the ROOT row carries the
 * labels the reclaim is addressed by — the same fields removeThread queues. Terminal only: a
 * member still queued or running keeps the tree (its verdict will reclaim); one member
 * done (this one, usually — the UI marks the head) is what makes the done a THREAD's done and not
 * one turn's.
 */
export async function queueReclaimIfThreadDone(
    tx: TransactionSql,
    orgId: string,
    hasWorkspaces: boolean,
    rootJobId: string
): Promise<void> {
    const [thread] = await tx<{ total: number; terminal: number }[]>`
        select count(*)::int as total,
               count(*) filter (where status in ('succeeded','failed','dead','stopped'))::int as terminal
        from job
        where org_id = ${orgId} and root_job_id = ${rootJobId}
    `;
    if (!thread || thread.total === 0 || thread.total !== thread.terminal) return;

    const [root] = await tx<{ repo: string | null; created_by: string | null }[]>`
        select repo, created_by from job
        where org_id = ${orgId} and id = ${rootJobId}
    `;
    const workspacePath = workspacePathFor(orgId, hasWorkspaces, root?.created_by ?? null);
    // Idempotent against a row already queued (an earlier done, or a concurrent one): one tree,
    // one reclaim. The claim-ack cycle removes the row; until then a duplicate insert would only
    // re-offer an already-removed tree, so the guard is tidiness, not correctness.
    await tx`
        insert into task_reclaim (org_id, root_job_id, repo, workspace_path)
        select ${orgId}, ${rootJobId}, ${root?.repo ?? null}, ${workspacePath}
        where not exists (
            select 1 from task_reclaim
            where org_id = ${orgId} and root_job_id = ${rootJobId}
        )
    `;
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
    if (prs && row.cancel_requested_at === null) {
        // A settled stop ends the thread's turn: its PR waits have nothing left to
        // fold for — the session a follow-up continues from starts its own wait cycle.
        await prs.cancelWaitsForRoot(row.root_job_id, 'task stopped');
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
    const rows = await sql<{ id: string; status: JobStatus }[]>`
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
        returning id, status
    `;
    if (rows[0]) return { result: 'ok', status: rows[0]!.status };
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
