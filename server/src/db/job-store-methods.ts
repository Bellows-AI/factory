import type { Fragment, Sql } from 'postgres';
import type { Job, JobOutcome, JobStatus, RuntimeVitals } from './job-store-contract.js';
import { runtimePatch } from './job-store-contract.js';
import type { JobStore, TaskListFilters } from './job-store-read-model.js';
import {
    type CreateJobStoreDeps,
    type JobRow,
    type JobStorePrs,
    type TaskRow,
    hasRunningMember,
    nextTaskCursor,
    queueReclaimIfThreadDone,
    resolveTaskCursor,
    taskAuthorWhere,
    taskCursorWhere,
    taskQWhere,
    taskRepoWhere,
    taskStateWhere,
    toJob,
    toTask,
    workspacePathFor,
} from './job-store-rows.js';
import {
    type WorkflowTransitionRoot,
    buildClaimResult,
    createFollowUpRow,
    exists,
    maybeRecordPublication,
    resolveClaimExecutor,
    resolveClaimGates,
    resolveClaimPublish,
    runWorkflowTransition,
} from './job-store-claim.js';

/**
 * Every `JobStore` method's own body, one function apiece — pulled out of `createJobStore` purely
 * to keep it under the repo's line-count ceiling, no behavior change. `JobStoreContext` bundles
 * what the factory closes over (the connection, the bound org, the precompiled SQL fragments, and
 * the optional collaborators); `createJobStore` builds one and every method here is a thin
 * delegation to its function. Read docs/jobs.md before touching this file: the decisions here
 * look simplifiable and mostly are not.
 */
export interface JobStoreContext {
    sql: Sql;
    orgId: string;
    hasWorkspaces: boolean;
    env: CreateJobStoreDeps['env'];
    githubToken: CreateJobStoreDeps['githubToken'];
    gatesReader: CreateJobStoreDeps['gates'];
    executorConfig: CreateJobStoreDeps['executorConfig'];
    prs: JobStorePrs | undefined;
    wallTick: Fragment;
    authorJoin: Fragment;
    authorColumns: Fragment;
    taskPreviewColumns: Fragment;
}

const toJobRow = (ctx: JobStoreContext, row: JobRow): Job => toJob(ctx.orgId, ctx.hasWorkspaces, row);

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

export type StopJobResult = Awaited<ReturnType<JobStore['stop']>>;

export async function stopJob(ctx: JobStoreContext, id: string, stoppedBy: string | null): Promise<StopJobResult> {
    const { sql, orgId, wallTick, prs } = ctx;
    // One statement decides the outcome by the status it sees. A QUEUED row never started
    // and a STANDBY row's run is long gone — both are settled `stopped` here: the turn is
    // over, and the session these rows keep is what the follow-up continues. A RUNNING
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
                when status in ('queued','standby') then 'stopped'
                when status = 'running' and lease_expires_at <= now() then 'stopped'
                else status
            end,
            finished_at = case
                when status in ('queued','standby') then now()
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
          and status in ('queued','running','standby')
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

/**
 * `claim()`'s select-lock-claim loop, one candidate at a time: pulled out of `claimJob` purely so
 * that function itself stays under the complexity ceiling — no behavior change. Returns the
 * assembled claim, or null when nothing is claimable.
 */
async function claimNextCandidate(
    ctx: JobStoreContext,
    worker: string,
    leaseSeconds: number
): ReturnType<JobStore['claim']> {
    const { sql, orgId, env, githubToken, gatesReader, executorConfig, hasWorkspaces } = ctx;
    return sql.begin(async (tx) => {
        // Retire what has burned its attempts, before looking for work. Without this a
        // command that kills its worker is reclaimed every time its lease expires, forever.
        // The dead attempt's segment banks here: the row ran for real before its worker
        // went quiet, and the retirement must not erase it. A stamped row never reaches
        // this sweep — the settle above has already landed it `stopped`, which is the
        // verdict a stop is (issue #152): dead is for attempts that failed on their own.
        await tx`
            update job set status = 'dead', finished_at = now(), lease_token = null,
                           wall_clock_ms = ${ctx.wallTick}
            where org_id = ${orgId} and status = 'running'
              and lease_expires_at <= now() and attempts >= max_attempts
        `;

        /*
         * The thread-exclusion, rendered once and used twice below. `id` and `root` are the
         * candidate row's id and root_job_id: correlated expressions in the select, bound
         * parameters in the update.
         *
         * A row whose thread already has another row running waits. The per-task worktree
         * (issue #35) is keyed by the thread root, so two claimed rows of one thread would run
         * two runners and two sync jobs into the same tree. The blocker is status = 'running'
         * and nothing else: an expired lease is still a run the board believes in until the
         * claim reclaims it (the same-row reclaim, o.id <> <candidate>, is the heartbeat-409
         * path and stays), and a standby row neither blocks nor is claimable. Every member of
         * the thread carries the same root_job_id (022), so the exclusion is one indexed
         * lookup, not a walk — and it is symmetric and terminal rows block nothing.
         */
        const sameThreadRunning = (id: string | Fragment, root: string | Fragment) => sql`
            not exists (
                select 1 from job o
                where o.org_id = ${orgId}
                  and o.root_job_id = ${root}
                  and o.id <> ${id}
                  and o.status = 'running'
            )
        `;

        for (;;) {
            const [candidate] = await tx<{ id: string; root_job_id: string }[]>`
                select j.id, j.root_job_id from job j
                where j.org_id = ${orgId}
                  and j.status in ('queued','running')
                  and j.lease_expires_at <= now()
                  and j.attempts < j.max_attempts
                  and ${sameThreadRunning(sql`j.id`, sql`j.root_job_id`)}
                order by j.created_at, j.id
                limit 1
                -- Below the limit in the plan, so a row another claimer holds is skipped
                -- rather than counted and then discarded. Holding the candidate's row
                -- lock from here through the claim update below is what lets that update
                -- target this id directly.
                for update skip locked
            `;
            if (!candidate) return null;

            // The thread's ROOT id, straight off the candidate's own row (022).
            // The serialization point: one transaction-scoped advisory lock per claim,
            // keyed on that root. Deliberately not `for update` on the root ROW:
            // that row is the one a running thread heartbeats and completes against, and
            // a claim parked on it would stall those writes for as long as its env
            // resolution and token mint take. An advisory xact lock queues claims
            // against each other and nothing else, is keyed per root so different
            // threads never block each other, and one lock per transaction means no
            // lock-ordering deadlock. Claims of one thread therefore fully serialize,
            // and the re-check below sees every earlier claim committed.
            const rootJobId = candidate.root_job_id;
            await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;

            const rows = await tx<
                {
                    id: string;
                    command: string;
                    attempts: number;
                    lease_token: string;
                    lease_expires_at: Date;
                    created_by: string | null;
                    session_id: string | null;
                    repo: string | null;
                    parent_job_id: string | null;
                    executor: string | null;
                    follow_up: boolean;
                    workflow_node: string | null;
                }[]
            >`
                update job set
                    status           = 'running',
                    claimed_by       = ${worker},
                    lease_token      = gen_random_uuid(),
                    attempts         = attempts + 1,
                    -- Unconditional, not coalesce(started_at, now()): this must describe the
                    -- attempt that is about to run, or every duration is measured from attempt 1.
                    started_at       = now(),
                    -- The attempt this claim supersedes banked its segment in the same
                    -- statement (the SET reads the pre-update row): a run that crashed after
                    -- forty minutes and was retried keeps its forty minutes. A row that never
                    -- started (the first claim of a queued one) banks nothing — its clock
                    -- stays null, because null means "never ran" and zero would claim a
                    -- measurement that was never made.
                    wall_clock_ms    = case when started_at is null then wall_clock_ms else ${ctx.wallTick} end,
                    -- Kept on a follow-up only, whose session IS the parent conversation it
                    -- continues. The status read here is the row's value BEFORE this update, so
                    -- 'running' means a lease that expired: for an ordinary job that attempt's
                    -- session is not this one, and leaving it would show a link to a run whose
                    -- output was thrown away. A follow-up keeps its copied session through a
                    -- crash, because the session carries the whole conversation, not just the
                    -- dead attempt's work.
                    session_id       = case
                        when parent_job_id is not null then session_id
                        else null
                    end,
                    remote_session_id = case
                        when parent_job_id is not null then remote_session_id
                        else null
                    end,
                    -- The previous attempt's vitals are not this attempt's, and a new container
                    -- starts unsampled: the started_at reset, one row down.
                    runtime          = null,
                    lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int)
                where org_id = ${orgId} and id = ${candidate.id}
                  and status in ('queued','running')
                  and lease_expires_at <= now()
                  and attempts < max_attempts
                  -- Re-asserted under the root lock: whatever the select saw, this is the
                  -- decision the lock serializes. A same-thread claim that committed while
                  -- this transaction waited is visible here, and the candidate's own row
                  -- has been locked since the select.
                   and ${sameThreadRunning(candidate.id, candidate.root_job_id)}
                -- parent_job_id and command_delivered_at are not written above, so RETURNING reads
                -- their pre-update values: delivered-so-far is exactly "this row was suspended at
                -- least once with its command in the transcript". A fresh or crashed follow-up has
                -- never been parked, so its command still has to go out; a suspended one settles
                -- stopped or standby, and is never claimed again.
                returning id, command, attempts, lease_token, lease_expires_at, created_by,
                          session_id, repo, parent_job_id, executor, workflow_node,
                          (parent_job_id is not null and command_delivered_at is null) as follow_up
            `;

            const row = rows[0];
            // The candidate moved between the select and the lock: the previous lock
            // holder claimed this thread first. Fall through to the next candidate.
            if (!row) continue;

            // Resolved here rather than in the route, because the org is bound here and
            // the author and repo label are in hand — and ON THE TRANSACTION, so a claim
            // holds one connection. A resolver failure propagates: the claim route's
            // guard answers 503, the driver retries the claim, and a job is never handed
            // out with half an environment. The minted installation token goes under it
            // as the base layer, and its failure rolls back exactly the same way. A Remote
            // Control claim never sees claimEnv at all (driver/src/docker.ts) — like every
            // other claim env value, a claude-code row's config does not reach a Remote
            // Control runner, which gets only the baked settings.json and the mounted auth
            // volume.
            const { claimEnv, executorType } = await resolveClaimExecutor(
                tx,
                { env, githubToken, executorConfig },
                row
            );
            const gates = await resolveClaimGates(gatesReader, { orgId, hasWorkspaces, rootJobId }, row);
            const published = await resolveClaimPublish(
                tx,
                { orgId, rootJobId, workflowNode: row.workflow_node },
                gates
            );
            return buildClaimResult(row, rootJobId, { claimEnv, executorType, ...gates, ...published });
        }
    });
}

export async function claimJob(
    ctx: JobStoreContext,
    worker: string,
    leaseSeconds: number
): ReturnType<JobStore['claim']> {
    const { sql, orgId, wallTick } = ctx;
    /*
     * Settle the stops nobody could deliver, before looking for work (issue #152).
     * A `running` row stamped `cancel_requested_at` whose lease has expired is a stop
     * whose worker died before its heartbeat could carry the kill order: re-claiming
     * it would burn an attempt and spawn a container for a command the member just
     * cancelled — and wipe the session the follow-up continues. The claim is the poll
     * that runs forever, so it is the settle point: the row lands `stopped` here,
     * finished_at stamped, the stamp and the lease cleared, the session kept for the
     * follow-up composer the member sees next. The attempt is handed back exactly as
     * the delivered stop's suspend hands one back — a stop is a park, not a failed
     * try — and the last segment banks with the same overcount the dead retirement
     * accepts, because the board cannot know when the run actually stopped.
     *
     * Committed as its own statement, deliberately OUTSIDE the claim transaction below
     * (review of PR #153): that transaction also carries the claim's preparation — the
     * env resolution and the token mint, awaited calls that throw — and a throw there
     * rolls the whole transaction back, settlement included. Inside it, a board whose
     * preparation keeps failing would keep the stamped zombie `running` across every
     * retried poll, and the follow-up the member queued would keep answering
     * not_finished — the exact stuck state this settle exists to end. Committed first,
     * the settle survives every failed preparation; the transaction below still rolls
     * back exactly the half-claim it always did.
     */
    await sql`
        update job set
            status             = 'stopped',
            finished_at        = now(),
            wall_clock_ms      = ${wallTick},
            attempts           = greatest(attempts - 1, 0),
            lease_token        = null,
            lease_expires_at   = now(),
            cancel_requested_at = null
        where org_id = ${orgId} and status = 'running'
          and cancel_requested_at is not null
          and lease_expires_at <= now()
    `;

    /*
     * One transaction, not two autocommit statements. The UPDATE makes the job running
     * with a fresh lease before the env resolver and the token mint answer; if either
     * then throws, a half-claim must not survive — a row that is `running` with a lease
     * nobody holds is stranded until that lease expires on every retry, walking the job
     * to dead on an infrastructure blip. The rollback puts it back: queued, attempt
     * unburned, claimable by the very next poll. (The resolver reads env_var, not job,
     * and the mint reads GitHub, so neither needs a share of this transaction — only
     * their failures do.)
     *
     * The selection is a select-lock-claim loop, because the exclusion reads OTHER rows
     * without locking them and so cannot by itself see a same-thread claim that is
     * still uncommitted: under READ COMMITTED two racing claims could both pass it and
     * both walk out with rows of one thread. Each round selects one candidate (skip
     * locked, holding its row), takes the thread ROOT's advisory lock, and only then
     * claims — the claim update re-asserts the whole claimability predicate where the
     * lock can vouch for it. A candidate that moved under us falls through to the next
     * round, exactly as a single statement skipped a row that was not claimable.
     */
    return claimNextCandidate(ctx, worker, leaseSeconds);
}

export type HeartbeatResult = Awaited<ReturnType<JobStore['heartbeat']>>;

export async function heartbeatJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    leaseSeconds: number
): Promise<HeartbeatResult> {
    const { sql, orgId } = ctx;
    // The heartbeat already travels every few seconds, which makes it the stop channel: a
    // `cancel_requested_at` stamped by the user's /stop is read here and handed to the
    // worker as `cancelRequested` — no new route, no separate poll. The stamp is cleared
    // only by the parking or completion that IS the stop happening, so a beat answers
    // false the moment the request was honoured.
    const rows = await sql<{ lease_expires_at: Date; cancel_requested_at: Date | null }[]>`
        update job
        set lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int)
        where org_id = ${orgId} and id = ${id}
          and status = 'running' and lease_token = ${leaseToken}
        returning lease_expires_at, cancel_requested_at
    `;
    const row = rows[0];
    if (row) {
        return {
            result: 'ok',
            leaseExpiresAt: row.lease_expires_at.toISOString(),
            cancelRequested: row.cancel_requested_at !== null,
        };
    }
    return {
        result: (await exists(sql, orgId, id)) ? 'lost' : 'missing',
        leaseExpiresAt: null,
        cancelRequested: false,
    };
}

export async function sessionReport(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    report: { sessionId: string; remoteSessionId: string | null }
): ReturnType<JobStore['session']> {
    const { sql, orgId } = ctx;
    const { sessionId, remoteSessionId } = report;
    const rows = await sql<{ id: string }[]>`
        update job set
            session_id = ${sessionId},
            -- coalesce, not assignment: the first report of an attempt carries no remote id
            -- yet, and it must not wipe one a later report already stored.
            remote_session_id = coalesce(${remoteSessionId}, remote_session_id)
        where org_id = ${orgId} and id = ${id}
          and status = 'running' and lease_token = ${leaseToken}
        returning id
    `;
    if (rows[0]) return 'ok';
    return (await exists(sql, orgId, id)) ? 'lost' : 'missing';
}

export async function progressReport(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    report: { output: string; runtime: RuntimeVitals | null }
): ReturnType<JobStore['progress']> {
    const { sql, orgId } = ctx;
    const { output, runtime } = report;
    // The tail the driver sent IS the output while the run is going — stored verbatim,
    // replaced on every report. No append, no merge: this side cannot know where the
    // previous tail ended, and the driver already keeps the window bounded. The vitals
    // ride the same statement, merged KEY-WISE: a report without services keeps the fleet
    // a previous one carried, a report whose numbers could not be read keeps the last
    // good numbers, and a null sample still leaves the whole column alone.
    const patch = runtime === null ? null : runtimePatch(runtime);
    const rows = await sql<{ id: string }[]>`
        update job set output = ${output},
                       runtime = ${patch === null ? sql`runtime` : sql`coalesce(runtime, '{}'::jsonb) || ${sql.json(patch as never)}`}
        where org_id = ${orgId} and id = ${id}
          and status = 'running' and lease_token = ${leaseToken}
        returning id
    `;
    if (rows[0]) return 'ok';
    return (await exists(sql, orgId, id)) ? 'lost' : 'missing';
}

export async function gatesReport(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    results: Parameters<JobStore['gates']>[2]
): ReturnType<JobStore['gates']> {
    const { sql, orgId } = ctx;
    // The worker's list IS the gate state while the run is going — replaced whole on every
    // report, the `progress` precedent. Lease-guarded like every other worker write: a
    // superseded worker must not relabel the run that replaced it.
    const rows = await sql<{ id: string }[]>`
        update job set gates = ${sql.json(results as never)}
        where org_id = ${orgId} and id = ${id}
          and status = 'running' and lease_token = ${leaseToken}
    returning id
    `;
    if (rows[0]) return 'ok';
    return (await exists(sql, orgId, id)) ? 'lost' : 'missing';
}

export async function rereadGatesJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string
): ReturnType<JobStore['rereadGates']> {
    const { sql, orgId, hasWorkspaces, gatesReader } = ctx;
    // Lease-guarded like every worker route: the freshness answer goes only to the worker
    // that holds the run, and only while it still does.
    const rows = await sql<{ created_by: string | null; repo: string | null; root_job_id: string }[]>`
        select created_by, repo, root_job_id
        from job
        where org_id = ${orgId} and id = ${id}
          and status = 'running' and lease_token = ${leaseToken}
    `;
    const row = rows[0];
    if (!row) return { result: (await exists(sql, orgId, id)) ? 'lost' : 'missing' };
    // The claim's own derivation: `<orgId>/<author>`, gated on having somewhere to read.
    const workspacePath = workspacePathFor(orgId, hasWorkspaces, row.created_by);
    if (!gatesReader || !row.repo || !workspacePath) {
        return { result: 'ok', gates: null, gateError: null };
    }
    // The worktree the run edits is keyed by the thread's root, not by this row — the
    // column read (022) answers for it directly.
    const read = await gatesReader.readFor(workspacePath, row.repo, row.root_job_id);
    return { result: 'ok', gates: read.config, gateError: read.error };
}

export async function publishTokenJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string
): ReturnType<JobStore['publishToken']> {
    const { sql, orgId, env, githubToken } = ctx;
    // Lease-guarded like every worker route: a fresh credential goes only to the worker
    // that holds the run, and only while it still does (the gates-reread precedent).
    const rows = await sql<{ created_by: string | null; repo: string | null }[]>`
        select created_by, repo
        from job
        where org_id = ${orgId} and id = ${id}
          and status = 'running' and lease_token = ${leaseToken}
    `;
    const row = rows[0];
    if (!row) return { result: (await exists(sql, orgId, id)) ? 'lost' : 'missing' };
    // The claim's own assembly, answered NOW: a configured value wins over the mint —
    // the claim-time rule, unchanged — and the mint is FRESH, because the point of this
    // route is that the claim's token does not have to survive the whole run.
    const resolved = env ? await env.resolveFor({ userId: row.created_by, repo: row.repo }, sql) : undefined;
    if (resolved?.GITHUB_TOKEN !== undefined) return { result: 'ok', token: resolved.GITHUB_TOKEN };
    if (!githubToken) return { result: 'ok', token: null };
    return { result: 'ok', token: await githubToken.fresh() };
}

export async function suspendJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string
): ReturnType<JobStore['suspend']> {
    const { sql, orgId, wallTick } = ctx;
    // One update, two landings decided by the stop stamp the heartbeat delivered. Under a
    // stamp the parking IS the user's stop landing: the row settles `stopped` — terminal,
    // `finished_at` stamped, the session kept for the follow-up that continues the turn.
    // Without one this is the Remote Control idle park: `standby`, not finished, the
    // session kept so the conversation can be driven on from the Claude UI. Both expire
    // the lease, exactly as insert does it: neither landing is claimable, so this changes
    // nothing while the row sits — and then it is the difference between the next poll
    // acting on the row and it waiting out the lease the dying worker held. The command
    // is in the transcript now either way (command_delivered_at), the stamp clears — the
    // stop has happened, whatever landing it produced — and the attempt is handed back:
    // a park is not a failed try, so parking a hundred times must never exhaust
    // max_attempts.
    const rows = await sql<{ id: string; status: JobStatus }[]>`
        update job set
            status           = case
                                   when cancel_requested_at is not null then 'stopped'
                                   else 'standby'
                               end,
            finished_at      = case
                                   when cancel_requested_at is not null then now()
                                   else finished_at
                               end,
            -- The park ends the segment the attempt was running, whichever landing it
            -- takes: stopped or standby, the container was doing real work up to now, and
            -- the parked time after this statement banks nothing.
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

export async function claimReclaimRow(
    ctx: JobStoreContext,
    worker: string,
    leaseSeconds: number
): ReturnType<JobStore['claimReclaim']> {
    const { sql, orgId } = ctx;
    // The job claim's select-lock-claim shape, one statement: the candidate list reads the
    // lease predicate under row locks, and the update re-asserts nothing because there is
    // nothing else to assert — a row that passed the predicate is the whole claim. `for
    // update skip locked` keeps two drivers from claiming the same tree: the loser's
    // candidate list finds nothing and answers null, exactly as an idle job poll does.
    // The expiry read here is the one GRANTED to the current holder — stamped on the row
    // by the claim that took it — and never re-measured from the polling worker's own
    // leaseSeconds, or a worker granted 300s would lose its row to the first 10s poll ten
    // seconds in. The CTE exposes only claim_id, so the RETURNING columns read the target
    // table unambiguously.
    const rows = await sql<
        {
            id: string;
            root_job_id: string;
            repo: string | null;
            workspace_path: string | null;
            lease_expires_at: Date;
        }[]
    >`
        with candidate as (
            select id as claim_id from task_reclaim
            where org_id = ${orgId}
              and (claimed_by is null or lease_expires_at <= now())
            order by created_at, id
            limit 1
            for update skip locked
        )
        update task_reclaim
        set claimed_by = ${worker},
            lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int)
        from candidate
        where task_reclaim.id = candidate.claim_id
        returning id, root_job_id, repo, workspace_path, lease_expires_at
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        id: row.id,
        rootJobId: row.root_job_id,
        repo: row.repo,
        workspacePath: row.workspace_path,
        leaseExpiresAt: row.lease_expires_at.toISOString(),
    };
}

export async function ackReclaimRow(
    ctx: JobStoreContext,
    id: string,
    worker: string
): ReturnType<JobStore['ackReclaim']> {
    const { sql, orgId } = ctx;
    // The claim's worker only, and the row id the claim handed back is the whole proof — a
    // reclaim's lease token IS its id. A foreign ack is refused rather than deleting a
    // row somebody else's driver is mid-reclaim on.
    const rows = await sql<{ id: string }[]>`
        delete from task_reclaim
        where org_id = ${orgId} and id = ${id} and claimed_by = ${worker}
        returning id
    `;
    if (rows[0]) return 'ok';
    const present = await sql<{ id: string }[]>`select id from task_reclaim where org_id = ${orgId} and id = ${id}`;
    return present[0] ? 'lost' : 'missing';
}

export type CompleteResult = Parameters<JobStore['complete']>[2];

export async function completeJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    result: CompleteResult
): ReturnType<JobStore['complete']> {
    const { sql, orgId, wallTick, prs } = ctx;
    const { status, exitCode, output, contextTokens, contextCostUsd, agentTurns, summary, publication } = result;
    // The context stats ride the verdict and merge into the runtime vitals — the row keeps
    // its last CPU sample AND gains the context the run reached. The stats are stored
    // under the keys the task view reads (`contextTokens`, `costUsd`; the wire field is
    // the driver's `contextCostUsd`, the stored key is the cost's own name). A run with no
    // sample at all gets a vitals object holding the stats alone, so "died at a full
    // window" is visible even where no container sample ever landed. Neither stat present
    // → the column is left exactly as the samples left it.
    const context =
        typeof contextTokens === 'number' || typeof contextCostUsd === 'number'
            ? sql.json({
                  ...(typeof contextTokens === 'number' ? { contextTokens } : {}),
                  ...(typeof contextCostUsd === 'number' ? { costUsd: contextCostUsd } : {}),
              } as never)
            : null;
    // The close-time turn count: a number lands, and an absent one overwrites to null —
    // the report is the attempt's whole verdict, and a retried report that lost its read
    // must not inherit the killed attempt's count.
    const agentTurnsPatch = typeof agentTurns === 'number' ? agentTurns : null;
    // The close-time summary, same overwrite rule: the verdict replaces whatever the
    // attempt left, it never merges with one.
    const summaryPatch = typeof summary === 'string' ? summary : null;
    const runtimeUpdate = context === null ? sql`runtime` : sql`coalesce(runtime, '{}'::jsonb) || ${context}`;
    // One transaction, because the terminality answer must describe the thread AS THE
    // VERDICT lands: the walk below runs on the same connection, where the just-updated
    // row's new status is visible and no follow-up inserted after the commit can be.
    return sql.begin(async (tx) => {
        const rows = await tx<{ id: string; root_job_id: string; repo: string | null }[]>`
            update job set
                status      = ${status},
                exit_code   = ${exitCode},
                output      = ${output},
                finished_at = now(),
                -- The lease token is RETAINED, deliberately — the only settle point that
                -- keeps it (dead and suspend clear theirs). The reporter's final --once
                -- tail sample lands after this verdict, and it authenticates with the
                -- attempt's job-id + lease-token pair; clearing the token here would
                -- 401 that sample into silence and lose the run's last branch state. The
                -- pair stays attempt-scoped anyway: a reclaim rotates the token on the
                -- row, so a superseded attempt's pair stops resolving the moment the
                -- job is handed out again.
                -- The verdict is the last settle point of the attempt: bank its segment,
                -- so the task's clock covers the run that just ended.
                wall_clock_ms = ${wallTick},
                -- A stop request that never landed is settled by the run ending: the task
                -- finished, there is nothing left to park.
                cancel_requested_at = null,
                agent_turns = ${agentTurnsPatch},
                summary = ${summaryPatch},
                runtime     = ${runtimeUpdate}
            where org_id = ${orgId} and id = ${id}
              and status = 'running' and lease_token = ${leaseToken}
            returning id, root_job_id, repo
        `;
        if (!rows[0]) {
            // A report from a worker whose lease was reclaimed is refused, not merged: the
            // job is someone else's now, and the two runs did different work.
            return { result: (await exists(sql, orgId, id)) ? 'lost' : 'missing' };
        }
        const completedId = rows[0]!.id;
        const rootJobId = rows[0]!.root_job_id;
        const jobRepo = rows[0]!.repo;

        await maybeRecordPublication(tx, prs, { rootJobId, jobRepo, publication: publication ?? null });

        // The workflow transition, when this thread walks a graph — decided HERE, in the
        // verdict's transaction (docs/workflows.md). A workflow-less thread has no
        // snapshot on its root and skips it: its completes behave byte-identically to
        // before 027.
        const [root] = await tx<WorkflowTransitionRoot[]>`
            select workflow_id, workflow_name, workflow_snapshot, workflow_params, command, created_by, repo from job
            where org_id = ${orgId} and id = ${rootJobId}
        `;
        if (root) {
            await runWorkflowTransition(tx, {
                orgId,
                rootJobId,
                root,
                completedId,
                status: status as JobOutcome,
                output,
            });
        }

        // The thread's state, read off the root column the row already carries (022) —
        // every member answers to the same root_job_id. The just-updated row's verdict
        // status is visible here, and the aggregate answers in one row: terminal means
        // every member reached `succeeded`/`failed`/`dead`/`stopped`; done means ONE member carries
        // the user's `done_at` (the UI marks the thread's head, so the column can sit on
        // any member). Both must hold before the tree may go. A transition-inserted row
        // above is queued, not terminal — the aggregate then says the thread moves on,
        // which is exactly why this read runs after the insert decision.
        const [thread] = await tx<{ total: number; terminal: number; done: number }[]>`
            select count(*)::int as total,
                   count(*) filter (where status in ('succeeded','failed','dead','stopped'))::int as terminal,
                   count(*) filter (where done_at is not null)::int as done
            from job
            where org_id = ${orgId} and root_job_id = ${rootJobId}
        `;
        return {
            result: 'ok',
            threadDone: (thread?.total ?? 0) > 0 && thread!.total === thread!.terminal && thread!.done > 0,
        };
    });
}

export async function threadOf(ctx: JobStoreContext, id: string): Promise<Job[] | null> {
    const { sql, orgId, authorJoin, authorColumns } = ctx;
    // The named row's root_job_id is the whole resolution (022): every member of the
    // conversation carries the same value, so the chain is one indexed read, oldest
    // first. If two adjustments ever landed on one parent, both come back in creation
    // order — the conversation still reads top to bottom. An absent id resolves nothing
    // and the read answers null.
    const rows = await sql<JobRow[]>`
        select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
               session_id, remote_session_id, exit_code, output, gates, runtime, repo, executor,
               parent_job_id, root_job_id, workflow_node, workflow_name, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
               -- The task's overall wall clock, summed over the thread the WHERE already
               -- scoped: every member carries the total, so the view reads it off any of
               -- them. A sum over all-null banks is null — nothing measurable, never zero.
               sum(wall_clock_ms) over () as task_wall_clock_ms,
               wall_clock_ms, summary,
               wl.wait_reason, wl.waiting_since, wl.wait_terminal_reason
               ${authorColumns}
        from job ${authorJoin}
        -- The thread's wait (036), carried on every member alike — the open wait first, else
        -- the most recently active terminal one, the same rule listTasksOf() applies.
        left join lateral (
            select w.reason as wait_reason, w.active_at as waiting_since,
                   w.terminal_reason as wait_terminal_reason
            from workflow_wait w
            where w.org_id = ${orgId} and w.root_job_id = job.root_job_id
            order by (w.completed_at is null and w.cancelled_at is null) desc, w.active_at desc
            limit 1
        ) wl on true
        where org_id = ${orgId}
          and root_job_id = (select root_job_id from job where org_id = ${orgId} and id = ${id})
        order by job.created_at, job.id
    `;
    const [first] = rows;
    return first ? rows.map((row) => toJobRow(ctx, row)) : null;
}

export async function getJob(ctx: JobStoreContext, id: string): Promise<Job | null> {
    const { sql, orgId, authorJoin, authorColumns } = ctx;
    const rows = await sql<JobRow[]>`
        select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
               session_id, remote_session_id, exit_code, output, gates, runtime, repo, executor,
               parent_job_id, root_job_id, workflow_node, workflow_name, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
               summary, wall_clock_ms
               ${authorColumns}
        from job ${authorJoin}
        where org_id = ${orgId} and job.id = ${id}
    `;
    const row = rows[0];
    return row ? toJobRow(ctx, row) : null;
}

export type ListFilter = Parameters<JobStore['list']>[0];

export async function listJobs(ctx: JobStoreContext, filter: ListFilter): Promise<Job[]> {
    const { sql, orgId, authorColumns, authorJoin } = ctx;
    const { status, repo, limit } = filter;
    // The recently-completed view asks for TASKS, not runs (#124): the terminal set folds
    // into one row per thread. Identity (id, command, author, created) comes from the
    // root; the present tense (status, summary, runtime, session, started) from the HEAD
    // — the newest member, the same resolution `chainHead` renders in the sidenav; the
    // clock and the completion stamp are the thread's sum and max; the done comes from
    // whichever member carries it (one done is the thread's). A thread with a member
    // still queued, running or parked is not completed and is excluded whole — which
    // also makes the sum exact, because nothing in it is still banking.
    if (status === 'terminal') {
        const rows = await sql<JobRow[]>`
            with finished_thread as (
                -- The rollup rides the terminality scan: one read of the org's history
                -- answers both the settled-verdict filter and the per-thread clock and
                -- completion stamps. The order+limit below therefore binds to AGGREGATE
                -- rows, and the per-thread head and actor resolution afterwards runs for
                -- the selected tasks alone — not once per thread the retention keeps.
                select root_job_id,
                       sum(wall_clock_ms) as task_wall_clock_ms,
                       max(done_at) as done_at,
                       max(finished_at) as finished_at
                from job
                where org_id = ${orgId}
                group by root_job_id
                having count(*) filter (
                    where status not in ('succeeded', 'failed', 'dead', 'stopped')
                ) = 0
            ),
            picked as (
                select finished_thread.root_job_id as root_job_id,
                       finished_thread.task_wall_clock_ms as task_wall_clock_ms,
                       finished_thread.done_at as done_at,
                       finished_thread.finished_at as finished_at
                from finished_thread
                join job on job.org_id = ${orgId} and job.id = finished_thread.root_job_id
                ${repo ? sql`where job.repo = ${repo}` : sql``}
                order by finished_thread.finished_at desc, job.created_at desc, job.id
                limit ${limit}
            )
            select job.id as id, job.command as command, head.status as status,
                   head.attempts as attempts, head.max_attempts as max_attempts,
                   head.claimed_by as claimed_by, job.created_by as created_by,
                   head.session_id as session_id, head.remote_session_id as remote_session_id,
                   head.exit_code as exit_code, head.summary as summary, head.runtime as runtime,
                   head.wall_clock_ms as wall_clock_ms,
                   job.repo as repo, job.executor as executor,
                   job.parent_job_id as parent_job_id, job.root_job_id as root_job_id,
                   job.workflow_node as workflow_node, job.workflow_name as workflow_name,
                   picked.done_at as done_at, head.cancel_requested_at as cancel_requested_at,
                   job.created_at as created_at, head.started_at as started_at,
                   picked.finished_at as finished_at,
                   picked.task_wall_clock_ms as task_wall_clock_ms
                   ${authorColumns}
            from picked
            join job on job.org_id = ${orgId} and job.id = picked.root_job_id
            join lateral (
                select h.*
                from job h
                where h.org_id = ${orgId} and h.root_job_id = job.root_job_id
                order by h.created_at desc, h.id desc
                limit 1
            ) head on true
            -- The authorship joins, aimed per member: the author is the thread's (the
            -- root's — a follow-up's creator is forced to the parent's), the stopper the
            -- head's (the status is the head's verdict), the doner the member carrying
            -- the thread's done. The shared authorJoin cannot be reused here: it binds
            -- su/du to the row's own stopped_by/done_by, which in this query is the
            -- root's.
            left join app_user cu on cu.id = job.created_by
            left join app_user su on su.id = head.stopped_by
            left join app_user du on du.id = (
                select d.done_by from job d
                where d.org_id = ${orgId} and d.root_job_id = job.root_job_id
                  and d.done_by is not null
                order by d.done_at desc, d.id desc
                limit 1
            )
            order by picked.finished_at desc, job.created_at desc, job.id
        `;
        return rows.map((row) => toJobRow(ctx, row));
    }
    const rows = await sql<JobRow[]>`
        select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
               session_id, remote_session_id, exit_code, runtime, repo, executor,
               parent_job_id, root_job_id, workflow_name, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
               -- The close-time summary and the run's own banked clock ride beside the
               -- vitals, both bounded where output is not (#109).
               summary, wall_clock_ms
               ${authorColumns}
        from job ${authorJoin}
        where org_id = ${orgId} ${
            // The terminal set is the branch above; this query is the per-run lists.
            status ? sql`and status = ${status}` : sql``
        }
          ${repo ? sql`and repo = ${repo}` : sql``}
        order by job.created_at desc, job.id
        limit ${limit}
    `;
    return rows.map((row) => toJobRow(ctx, row));
}

export async function listTasksOf(ctx: JobStoreContext, filters: TaskListFilters): ReturnType<JobStore['listTasks']> {
    const { sql, taskPreviewColumns, orgId } = ctx;
    const cursor = resolveTaskCursor(filters);
    const newest = filters.sort === 'newest';

    // One statement, one derived set. `head` resolves each thread's newest run exactly as
    // the sidenav's chainHead does (created desc, id desc); `task` keeps one row per ROOT
    // — the root row for identity and authorship, the head for the present tense — and
    // computes the bucket and the activity stamp once, so the state filter, the counts
    // and the previews cannot disagree. Navigation reads the set UNFILTERED (org-wide,
    // rule of the read model); the page reads it under every filter, paginated by keyset
    // on (activity_at, id) — direction flips with the sort, never an OFFSET.
    const stateWhere = taskStateWhere(sql, filters.state);
    const pageOrder = newest ? sql`activity_at desc, id desc` : sql`activity_at asc, id asc`;
    const cursorWhere = taskCursorWhere(sql, cursor, newest);

    const [row] = await sql<
        {
            counts: { running: number; review: number; past: number };
            running_preview: TaskRow[] | null;
            review_preview: TaskRow[] | null;
            page: TaskRow[] | null;
        }[]
    >`
        with head as (
            select distinct on (root_job_id)
                   root_job_id, id, status, done_at, cancel_requested_at,
                   created_at, started_at, finished_at, summary, runtime
            from job
            where org_id = ${orgId}
            order by root_job_id, created_at desc, id desc
        ),
        task as (
            -- The root row joins back by PK from the head's root id (one index lookup per
            -- thread) rather than scanning the org's runs and filtering id = root_job_id —
            -- the EXPLAIN-measured difference between touching every run and touching one
            -- row per thread.
            select h.root_job_id as id, r.command, r.repo, r.executor, r.created_at,
                   h.status, h.done_at, h.cancel_requested_at, h.summary, h.runtime,
                   -- The sort key is truncated to milliseconds, the precision an ISO
                   -- stamp and a JS Date carry: the cursor's value round-trips EXACTLY,
                   -- so the exclusive keyset predicate cannot re-admit a row that only
                   -- differs from the boundary below the millisecond.
                   date_trunc('milliseconds',
                              greatest(h.created_at, h.started_at, h.finished_at, h.done_at)) as activity_at,
                   -- An open wait (a wait row with no terminal reason yet) is terminal for
                   -- bucketing the same way a settled status is: a thread parked on a human's
                   -- review is never "running", whatever status the row itself carries while
                   -- parked on it (206). A wait that has gone terminal carries no extra weight
                   -- here — the status/done rule alone decides, same as a thread that never waited.
                   (h.status in ('succeeded', 'failed', 'dead', 'stopped')
                       or (wl.wait_reason is not null and wl.wait_terminal_reason is null)) as terminal,
                   cu.id as creator_id, cu.github_login as creator_login,
                   cu.display_name as creator_name, cu.avatar_url as creator_avatar_url,
                   wl.wait_reason, wl.waiting_since, wl.wait_terminal_reason
            from head h
            join job r on r.org_id = ${orgId} and r.id = h.root_job_id
            left join app_user cu on cu.id = r.created_by
            -- The thread's wait, when it has one (036): the OPEN wait first, else the most
            -- recently active terminal one — one row, so a waiting thread reads waiting and
            -- a finished wait reads what exhausted it.
            left join lateral (
                select w.reason as wait_reason, w.active_at as waiting_since,
                       w.terminal_reason as wait_terminal_reason
                from workflow_wait w
                where w.org_id = ${orgId} and w.root_job_id = h.root_job_id
                order by (w.completed_at is null and w.cancelled_at is null) desc, w.active_at desc
                limit 1
            ) wl on true
        )
        select
            (
                select json_build_object(
                           'running', count(*) filter (where not terminal),
                           'review', count(*) filter (where terminal and done_at is null),
                           'past', count(*) filter (where terminal and done_at is not null)
                       )
                from task
            ) as counts,
            (
                select coalesce(json_agg(p), '[]'::json)
                from (select ${taskPreviewColumns} from task
                      where not terminal
                      order by activity_at desc, id desc limit 3) p
            ) as running_preview,
            (
                select coalesce(json_agg(p), '[]'::json)
                from (select ${taskPreviewColumns} from task
                      where terminal and done_at is null
                      order by activity_at desc, id desc limit 5) p
            ) as review_preview,
            (
                select coalesce(json_agg(p), '[]'::json)
                from (select ${taskPreviewColumns} from task
                      where ${stateWhere}
                        ${taskQWhere(sql, filters.q)}
                        ${taskRepoWhere(sql, filters.repo)}
                        ${taskAuthorWhere(sql, filters.author)}
                        ${cursorWhere}
                      order by ${pageOrder}
                      limit ${filters.limit + 1}) p
            ) as page
    `;

    // Fetch limit + 1: the extra row is the only honest nextCursor signal — a page filled
    // exactly is not — and the cursor is minted from the last row RETURNED.
    const pageRows = (row?.page ?? []).map(toTask);
    const items = pageRows.slice(0, filters.limit);
    return {
        navigation: {
            counts: row?.counts ?? { running: 0, review: 0, past: 0 },
            running: (row?.running_preview ?? []).map(toTask),
            review: (row?.review_preview ?? []).map(toTask),
        },
        page: {
            items,
            nextCursor: nextTaskCursor(filters, pageRows.length, items),
        },
    };
}
