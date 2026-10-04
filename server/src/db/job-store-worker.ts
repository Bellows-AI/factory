/**
 * What a leased worker reports after the claim: heartbeat, session/progress/gates reports, the gate
 * re-read, the publish token, and `complete` — whose verdict transaction also records the
 * publication and walks the workflow to its next node (docs/workflows.md).
 */

import type { TransactionSql } from 'postgres';
import { USER_SCOPE, type ExecutorScope } from '@factory-ai/core';
import { exists, insertWorkflowSuccessor, runtimePatch, workspacePathFor } from './job-store-rows.js';
import type {
    JobStore,
    JobStoreContext,
    RuntimeVitals,
    JobOutcome,
    JobStorePrs,
    GateReport,
    ArtifactUpload,
    FailureKind,
} from './job-store-types.js';
import { type CompletedRun, nextTransition, primarySessionId } from './workflow-engine.js';
import { enterRuntimeBoundary } from './workflow-blocks/runtime.js';
import { entersBlockHelperNode, settleBlockWaits } from './workflow-blocks/runtime-settle.js';
import { applyMergeClosureIfMerged, mergeClosureMarkerSet, prLockKey, settleIfMergeClosed } from './job-store-merge.js';
import type { WorkflowDefinition, ParamValues } from './workflow-schema.js';

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
    sessionId: string | null
): ReturnType<JobStore['session']> {
    const { sql, orgId } = ctx;
    const rows = await sql<{ id: string }[]>`
        update job set
            session_id = ${sessionId}
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

export async function artifactReport(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    upload: ArtifactUpload
): ReturnType<JobStore['artifact']> {
    const { sql, orgId } = ctx;
    const { kind, attempt, content, truncated } = upload;
    // The lease guard and the upsert are ONE statement: the insert selects from a CTE that
    // answers only under a live lease, so a superseded worker's report inserts nothing —
    // there is no window between the check and the write for a reclaim to slip through.
    // Upsert, never append: a retried upload overwrites its own (kind, attempt) row.
    const rows = await sql<{ attempt: number }[]>`
        with live as (
            select id from job
            where org_id = ${orgId} and id = ${id}
              and status = 'running' and lease_token = ${leaseToken}
        )
        insert into job_artifact (org_id, job_id, kind, attempt, content, truncated)
        select ${orgId}, ${id}, ${kind}, ${attempt}, ${content}, ${truncated} from live
        on conflict (org_id, job_id, kind, attempt) do update
            set content = excluded.content, truncated = excluded.truncated
        returning attempt
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

export type CompleteResult = Parameters<JobStore['complete']>[2];

/**
 * complete()'s publication half: recorded in the VERDICT's transaction — the identity commits
 * with the run's terminal state or not at all. The repo the payload claims is cross-checked
 * against the leased job's own label before anything is written: a report can only record the
 * repository the board gave the job, never one it was not authorized to.
 */
export interface CompleteVerdict {
    rootJobId: string;
    jobRepo: string | null;
    publication: {
        repo: string;
        prNumber: number;
        prUrl: string;
        headBranch: string;
        baseBranch: string;
    } | null;
}

export async function completeJob(
    ctx: JobStoreContext,
    id: string,
    leaseToken: string,
    result: CompleteResult
): ReturnType<JobStore['complete']> {
    const { sql, orgId, wallTick, prs } = ctx;
    const { status, exitCode, output, contextTokens, contextCostUsd, agentTurns, summary, failureKind, publication } =
        result;
    const treeChanged = result.treeChanged ?? null;
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
    // The structured terminal reason (044, issue #339), same overwrite rule: the verdict is
    // the attempt's whole write, so an absent kind overwrites to null — a success and a
    // pre-column row read the same, "not a failure".
    const failureKindPatch = failureKind ?? null;
    const runtimeUpdate = context === null ? sql`runtime` : sql`coalesce(runtime, '{}'::jsonb) || ${context}`;
    // One transaction, because the terminality answer must describe the thread AS THE
    // VERDICT lands: the walk below runs on the same connection, where the just-updated
    // row's new status is visible and no follow-up inserted after the commit can be.
    return sql.begin(async (tx) => {
        const rows = await tx<{ id: string; root_job_id: string; repo: string | null; stop_pending: boolean }[]>`
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
                failure_kind = ${failureKindPatch},
                runtime     = ${runtimeUpdate}
            where org_id = ${orgId} and id = ${id}
              and status = 'running' and lease_token = ${leaseToken}
            -- The subselect reads the row as the statement began: the stamp this UPDATE cleared.
            returning id, root_job_id, repo,
                (select cancel_requested_at is not null from job where org_id = ${orgId} and id = ${id}) as stop_pending
        `;
        if (!rows[0]) {
            // A report from a worker whose lease was reclaimed is refused, not merged: the
            // job is someone else's now, and the two runs did different work.
            return { result: (await exists(sql, orgId, id)) ? 'lost' : 'missing' };
        }
        const completedId = rows[0]!.id;
        const rootJobId = rows[0]!.root_job_id;
        const jobRepo = rows[0]!.repo;
        const stopPending = rows[0]!.stop_pending;

        await maybeRecordPublicationAndClose(tx, ctx, { rootJobId, jobRepo, publication: publication ?? null });

        // The workflow transition, when this thread walks a graph — decided HERE, in the
        // verdict's transaction (docs/workflows.md). A workflow-less thread has no
        // snapshot on its root and skips it: its completes behave byte-identically to
        // before 027.
        const [root] = await tx<WorkflowTransitionRoot[]>`
            select workflow_id, workflow_name, workflow_snapshot, workflow_params, command, created_by, repo
            from job
            where org_id = ${orgId} and id = ${rootJobId}
        `;
        // A Stop the verdict outran is honored: the thread stays where the Stop left it.
        if (root && !stopPending) {
            await runWorkflowTransition(tx, {
                orgId,
                rootJobId,
                root,
                completedId,
                status: status as JobOutcome,
                output,
                failureKind: failureKindPatch,
                treeChanged,
                prs,
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
        // Issue #390's late done-stamp: a merge-marked thread whose members all went terminal
        // WITHOUT any done landing (the closure skips running rows; the other settles close a
        // marked thread from their own arms). The shared conditional settle re-checks the marker
        // under the lock and stamps every terminal member (no actor), so the thread reads done
        // and the tree reclaims at this verdict. It no-ops on unmarked threads — one indexed
        // marker lookup is the whole cost of never deciding this on a stale pre-read.
        let threadDone = (thread?.total ?? 0) > 0 && thread!.total === thread!.terminal && thread!.done > 0;
        if (!threadDone) {
            threadDone = await settleIfMergeClosed(ctx, rootJobId, tx);
        }
        if (threadDone) {
            // A threadDone-true verdict IS the worktree-reclaim order: the driver removes the
            // tree directly on this answer, with no queue row and no ack — so this verdict is
            // where the board records the removal as issued (045, issue #327), or reopen could
            // not tell "tree gone" from "tree still there". Same transaction as the verdict,
            // coalesce keeps the first writer's instant. A queue row queued moments earlier in
            // this same transaction (the merge closure's inline settle, issue #390) is
            // withdrawn — the direct order supersedes it, one tree, one work order; a row a
            // worker holds a LIVE claim on stays (it is mid-removal right now, and the ack
            // finishes it).
            await tx`
                update job set worktree_reclaimed_at = coalesce(worktree_reclaimed_at, now())
                where org_id = ${orgId} and id = ${rootJobId}
            `;
            await tx`
                delete from task_reclaim
                where org_id = ${orgId} and root_job_id = ${rootJobId}
                  and (claimed_by is null or lease_expires_at <= now())
            `;
        }
        return { result: 'ok', threadDone };
    });
}

export async function maybeRecordPublication(
    tx: TransactionSql,
    prs: JobStorePrs | undefined,
    verdict: CompleteVerdict
): Promise<void> {
    const { rootJobId, jobRepo, publication } = verdict;
    if (publication && prs && publication.repo === jobRepo) {
        await prs.recordPublication({ root: rootJobId, ...publication }, tx);
    }
}

/**
 * The verdict's publication half plus issue #390's merge-before-publication application, under the
 * PR-scoped advisory lock both merge writers take first (`job-store-merge.ts`'s `prLockKey`): a
 * merge delivery racing this verdict serializes here, so whichever commits second sees the
 * other's rows — a delivery that committed first is applied inline (the closure this verdict's
 * association was waiting for), and a delivery that commits after this one finds the fresh
 * `job_pr` row and closes the thread itself. The lock is taken only when a publication will be
 * recorded; a verdict that publishes nothing never contends.
 */
async function maybeRecordPublicationAndClose(
    tx: TransactionSql,
    ctx: JobStoreContext,
    verdict: CompleteVerdict
): Promise<void> {
    const { rootJobId, jobRepo, publication } = verdict;
    if (!(publication && ctx.prs && publication.repo === jobRepo)) return;
    await tx`select pg_advisory_xact_lock(hashtextextended(${prLockKey(ctx.orgId, publication.repo, publication.prNumber)}::text, 0))`;
    await maybeRecordPublication(tx, ctx.prs, verdict);
    await applyMergeClosureIfMerged(tx, ctx, publication, rootJobId);
}

export interface WorkflowTransitionRoot {
    workflow_id: string | null;
    workflow_name: string | null;
    workflow_snapshot: WorkflowDefinition | null;
    workflow_params: ParamValues | null;
    command: string;
    created_by: string | null;
    repo: string | null;
}

/**
 * complete()'s workflow half, when this thread walks a graph — decided HERE, in the verdict's
 * transaction (docs/workflows.md): the driver reports one verdict and the board inserts the next
 * row, or rests the thread. A workflow-less thread has no snapshot on its root and skips all of
 * this: its completes behave byte-identically to before 027.
 */
export interface WorkflowTransitionInput {
    orgId: string;
    rootJobId: string;
    root: WorkflowTransitionRoot;
    completedId: string;
    status: JobOutcome;
    output: string | null;
    /** The verdict's failure kind — a `blocked` run rests the thread before any edge. */
    failureKind: FailureKind | null;
    /** The driver's tree-change read, unstored — a gate-fix edge over an unchanged tree rests. */
    treeChanged: boolean | null;
    prs: JobStorePrs | undefined;
}

/**
 * The completed row's stored state and the halted node the transition evaluates FROM — extracted
 * so the walk below reads as the decision it is. The completed row's `gates` and `output` here
 * are THIS run's (the verdict UPDATE landed them moments ago): what the edge rules evaluate
 * against (gate-failed reads the stored reports; markers read the tail). The halted node is the
 * completed row's own node, or (an off-graph user follow-up completing) the thread's newest
 * carried node, mirroring workflow-engine.ts's own private `haltedNode` exactly (its own module
 * comment: "the current node is the completed row's own workflow_node — or, for an off-graph row,
 * the halted node"). Recomputed here rather than exported, since only this settle call and the
 * no-publication guard need it outside the engine itself.
 */
function transitionContextOf(
    threadRows: {
        id: string;
        workflow_node: string | null;
        gates: GateReport[] | null;
        repo: string | null;
        executor: string | null;
        executor_scope: string | null;
    }[],
    verdict: Pick<WorkflowTransitionInput, 'completedId' | 'status' | 'output' | 'failureKind' | 'treeChanged'>
): { completed: (typeof threadRows)[number] | undefined; completedRun: CompletedRun; halted: string | null } {
    const { completedId, status, output, failureKind, treeChanged } = verdict;
    const completed = threadRows.find((row) => row.id === completedId);
    const completedRun: CompletedRun = {
        id: completedId,
        node: completed?.workflow_node ?? null,
        status,
        output,
        gates: completed?.gates ?? null,
        failureKind,
        treeChanged,
    };
    const halted =
        completedRun.node ??
        threadRows
            .slice()
            .reverse()
            .find((row) => row.id !== completedId && row.workflow_node !== null)?.workflow_node ??
        null;
    return { completed, completedRun, halted };
}

export async function runWorkflowTransition(tx: TransactionSql, input: WorkflowTransitionInput): Promise<void> {
    const { orgId, rootJobId, root, completedId, prs } = input;
    if (!root.workflow_snapshot) return;
    // The same per-root advisory lock the claim takes: a transition insert must not interleave
    // with a claim's select-lock-claim of this thread, or two rows of one thread could end up
    // claimed against the one-worktree guarantee.
    await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;

    // A merge-closed thread (issue #390) walks no further: no successor insert, no re-park into a
    // durable wait — the PR it would wait on can never reopen. Decided on a marker read UNDER the
    // lock, never on a pre-read: a merge delivery committing while this verdict waited on the
    // lock must rest this transition too, and a pre-lock read would have answered stale. The
    // wait cancellation the closure ran is what makes resting safe (settleBlockWaits would
    // no-op, and is skipped), and any continuation woken before the closure commits is settled
    // at claim by the existing cancellation fence. A MANUAL done keeps its documented
    // mid-flight behavior — successors still insert — because the marker, not done_at, is the
    // discriminator.
    if (await mergeClosureMarkerSet(tx, orgId, rootJobId)) return;

    // The whole thread, oldest first — the audit trail the decision derives from: loop counts
    // are row counts per node (dead rows included), the halted node is the newest carried node,
    // the primary session is the first resume run's, and the placeholder tails are prior rows'
    // stored outputs.
    const threadRows = await tx<
        {
            id: string;
            workflow_node: string | null;
            status: string;
            output: string | null;
            gates: GateReport[] | null;
            session_id: string | null;
            repo: string | null;
            executor: string | null;
            executor_scope: string | null;
        }[]
    >`
        select id, workflow_node, status, output, gates, session_id, repo, executor, executor_scope
        from job
        where org_id = ${orgId} and root_job_id = ${rootJobId}
        order by created_at, id
    `;
    const engineRows = threadRows.map((row) => ({
        id: row.id,
        node: row.workflow_node,
        status: row.status,
        output: row.output,
        gates: row.gates,
        sessionId: row.session_id,
    }));
    const { completed, completedRun, halted } = transitionContextOf(threadRows, input);

    let transition = nextTransition({
        snapshot: root.workflow_snapshot,
        // The launch values frozen on the root (030): `{{param.*}}` resolves from them on every
        // row of the thread, and `{{command}}` from the root's own command — for a workflow
        // thread, the interpolated entry prompt.
        params: root.workflow_params ?? {},
        command: root.command,
        rows: engineRows,
        completed: completedRun,
    });

    // A transition entering a block's own helper-driven node from outside that block's scope (a
    // fresh entry, never its internal round-trip) with no recorded publication rests instead of
    // inserting: every declared helper plan is handed `{publication}` generically
    // (`resolveClaimHelperPlans`), and a null publication is nothing the helper can act on — the
    // same "never falls back to a runnable insert" doctrine `enterRuntimeBoundary` already applies
    // to a durable wait boundary, extended here to every block entry (issue #209).
    if (entersBlockHelperNode(halted, transition) && (!prs || (await prs.publicationOf(rootJobId, tx)) === null)) {
        transition = { action: 'rest', reason: 'no_publication' };
    }

    if (halted !== null) {
        await settleBlockWaits(tx, prs, { rootJobId, snapshot: root.workflow_snapshot, from: halted, transition });
    }

    if (transition.action !== 'insert') {
        // `rest` lands nothing: an exhausted loop, an unmatched verdict or marker absence leaves
        // the thread where the run ended — visible and follow-up-able, never silently continued
        // (docs/workflows.md).
        return;
    }
    // A resume node carries the thread's PRIMARY session from insert (design.md Decision 3); a
    // fresh node carries none and mints its own at claim. The row is an ordinary queued job: the
    // driver claims it through the existing lease/fence machinery, `max_attempts` governing it
    // individually.
    const session = transition.session === 'resume' ? primarySessionId(root.workflow_snapshot, engineRows) : null;
    const successor = {
        orgId,
        command: transition.command,
        createdBy: root.created_by,
        repo: completed?.repo ?? root.repo,
        executor: completed?.executor ?? null,
        executorScope: (completed?.executor_scope ?? USER_SCOPE) as ExecutorScope,
        parentJobId: completedId,
        sessionId: session,
        rootJobId,
        workflowId: root.workflow_id,
        workflowName: root.workflow_name,
        workflowNode: transition.node.name,
    };
    if (transition.node.runtime !== undefined) {
        // A durable wait boundary (issue #231): this park replaces the ordinary insert below
        // entirely — the caller (enterRuntimeBoundary) rests the thread instead when the runtime
        // is unrecognized, no PR store is configured, or the thread has not published yet, never
        // falling back to an immediately runnable row.
        await enterRuntimeBoundary(tx, prs, transition.node, successor);
        return;
    }
    await insertWorkflowSuccessor(tx, successor);
}
