import type { Sql, TransactionSql } from 'postgres';
import { EXECUTOR_TYPES, type ExecutorType } from '@factory-ai/core';
import type { BellowsConfig } from '../workspace/bellows.js';
import { type CompletedRun, nextTransition, primarySessionId } from './workflow-engine.js';
import { type ParamValues, type WorkflowDefinition, isPublishNode, nodeOf } from './workflow-schema.js';
import type { Claim, GateReport, JobOutcome, JobStatus } from './job-store-contract.js';
import type { CreateJobStoreDeps, JobStorePrs } from './job-store-rows.js';
import { workspacePathFor } from './job-store-rows.js';
import { withMintedToken } from './job-store-org-resolvers.js';

/**
 * `complete()`'s publication and workflow-transition halves, `claim()`'s env/gates/publish
 * resolution, and `createFollowUp`'s whole body — split out of job-store-types.ts purely to keep
 * every file under the repo's line-count ceiling, no behavior change. Every export here is a free
 * function that takes its dependencies explicitly; `createJobStore` in job-store.ts wires them.
 */

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
}

export async function runWorkflowTransition(tx: TransactionSql, input: WorkflowTransitionInput): Promise<void> {
    const { orgId, rootJobId, root, completedId, status, output } = input;
    if (!root.workflow_snapshot) return;
    // The same per-root advisory lock the claim takes: a transition insert must not interleave
    // with a claim's select-lock-claim of this thread, or two rows of one thread could end up
    // claimed against the one-worktree guarantee.
    await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;

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
        }[]
    >`
        select id, workflow_node, status, output, gates, session_id, repo, executor
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
    // The completed row's stored state: the UPDATE above just landed the verdict columns, so
    // `gates` and `output` here are THIS run's — what the edge rules evaluate against
    // (gate-failed reads the stored reports; markers read the tail).
    const completed = threadRows.find((row) => row.id === completedId);
    const completedRun: CompletedRun = {
        id: completedId,
        node: completed?.workflow_node ?? null,
        status,
        output,
        gates: completed?.gates ?? null,
    };

    const transition = nextTransition({
        snapshot: root.workflow_snapshot,
        // The launch values frozen on the root (030): `{{param.*}}` resolves from them on every
        // row of the thread, and `{{command}}` from the root's own command — for a workflow
        // thread, the interpolated entry prompt.
        params: root.workflow_params ?? {},
        command: root.command,
        rows: engineRows,
        completed: completedRun,
    });
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
    await tx`
        insert into job (org_id, command, created_by, repo, executor, parent_job_id, session_id, root_job_id, workflow_id, workflow_name, workflow_node)
        values (${orgId}, ${transition.command}, ${root.created_by}, ${completed?.repo ?? root.repo},
                ${completed?.executor ?? null}, ${completedId}, ${session}, ${rootJobId},
                ${root.workflow_id}, ${root.workflow_name}, ${transition.node.name})
    `;
}

export interface ResolvedClaimExecutor {
    claimEnv: Record<string, string> | undefined;
    executorType: ExecutorType | null;
}

/**
 * claim()'s env + executor resolution, unchanged: the stacked env, the minted installation token
 * under it as the base layer, and the author's executor row merged over the runner's config env
 * name. Resolved ON THE TRANSACTION, so a claim holds one connection rather than two, and a
 * resolver or mint failure rolls the whole claim back (docs/env.md).
 */
/**
 * The pasted executor config rides the claim env under the name that CLI's entrypoint merges
 * over the baked configuration, applied LAST so the synthesized value wins a collision with a
 * member env var — both names are reserved at PUT besides.
 */
export function mergeExecutorConfigEnv(
    claimEnv: Record<string, string> | undefined,
    configured: { type: string; config: Record<string, unknown> } | null
): Record<string, string> | undefined {
    const member = configured?.config;
    if (member === null || member === undefined || typeof member !== 'object' || Array.isArray(member)) {
        return claimEnv;
    }
    if (configured?.type === 'opencode') {
        // `permission` is the runner's fence, baked into the image and patched by its entrypoint
        // — the one key the member does not get to set: a pasted `external_directory: allow`
        // would open every member's tree to this run. Everything else travels verbatim.
        const { permission: _fence, ...rest } = member;
        return { ...(claimEnv ?? {}), OPENCODE_CONFIG_CONTENT: JSON.stringify(rest) };
    }
    if (configured?.type === 'claude-code') {
        // `hooks`, `enabledPlugins` and `extraKnownMarketplaces` are the runner's fence: the git
        // guard hook and the baked context-mode plugin install. A pasted `hooks` would silently
        // drop the guard; a pasted plugin/marketplace pair would run code the image never
        // installed. Everything else — model, env, permissions.allow — travels verbatim.
        const { hooks: _hooks, enabledPlugins: _plugins, extraKnownMarketplaces: _markets, ...rest } = member;
        return { ...(claimEnv ?? {}), CLAUDE_CODE_CONFIG_CONTENT: JSON.stringify(rest) };
    }
    return claimEnv;
}

export async function resolveClaimExecutor(
    tx: TransactionSql,
    deps: {
        env: CreateJobStoreDeps['env'];
        githubToken: CreateJobStoreDeps['githubToken'];
        executorConfig: CreateJobStoreDeps['executorConfig'];
    },
    row: { created_by: string | null; repo: string | null; executor: string | null }
): Promise<ResolvedClaimExecutor> {
    const { env, githubToken, executorConfig } = deps;
    const resolvedEnv = env ? await env.resolveFor({ userId: row.created_by, repo: row.repo }, tx) : undefined;
    // The mint fills only the gap: when the stacked env already carries a GITHUB_TOKEN, the mint
    // would be discarded — so it is not made at all, rather than spend a GitHub call and leave a
    // live token nothing holds.
    let claimEnv =
        githubToken && resolvedEnv?.GITHUB_TOKEN === undefined
            ? withMintedToken(await githubToken.fresh(), resolvedEnv)
            : resolvedEnv;
    // The executor label a task was queued with names a row in the AUTHOR's own executor list
    // (docs/workspace.md). Its TYPE is the execution input: it tells the driver which CLI/image
    // family to run. A label matching nothing remains null on the claim and is failed explicitly
    // by the driver; there is no global CLI fallback.
    let executorType: ExecutorType | null = null;
    if (executorConfig && row.executor !== null && row.created_by !== null) {
        const configured = await executorConfig.configFor(row.created_by, row.executor, tx);
        if (configured && EXECUTOR_TYPES.includes(configured.type as ExecutorType)) {
            executorType = configured.type as ExecutorType;
        }
        claimEnv = mergeExecutorConfigEnv(claimEnv, configured);
    }
    return { claimEnv, executorType };
}

export interface ResolvedClaimGates {
    claimGates: BellowsConfig | null;
    gateError: string | null;
    claimPath: string | null;
}

/**
 * claim()'s gates read, off the filesystem inside the claim but OFF the transaction's tables: a
 * broken `.bellows.yaml` travels to the driver as `gateError` — the job fails at the worker with
 * the reason, where the run's author can see it — rather than as a 503 that would retry the claim
 * forever. Gates ride only when the job has both a repo label (the checkout the file lives in)
 * and a workspace to read it from.
 */
export async function resolveClaimGates(
    gatesReader: CreateJobStoreDeps['gates'],
    ctx: { orgId: string; hasWorkspaces: boolean; rootJobId: string },
    row: { created_by: string | null; repo: string | null }
): Promise<ResolvedClaimGates> {
    const claimPath = workspacePathFor(ctx.orgId, ctx.hasWorkspaces, row.created_by);
    if (!gatesReader || !row.repo || !claimPath) return { claimGates: null, gateError: null, claimPath };
    const read = await gatesReader.readFor(claimPath, row.repo, ctx.rootJobId);
    return { claimGates: read.error ? null : read.config, gateError: read.error, claimPath };
}

export interface ResolvedClaimPublish {
    publish: boolean | undefined;
    claimGates: BellowsConfig | null;
    gateError: string | null;
}

/**
 * claim()'s workflow read: the graph's per-node decisions, computed off the ROOT row's snapshot.
 * `publish` is the board's answer to "may this run push" — true only out of a publish node, false
 * on every other workflow node, and ABSENT (undefined) on a workflow-less row, which the driver
 * reads as "publish": the exact behavior before 027. A node may also opt its run out of the gates
 * — a fresh-eyes review need not pay suite minutes, and must not fail the thread on a gate it did
 * not touch — in which case neither gates nor a gate error ride the claim.
 */
export async function resolveClaimPublish(
    tx: TransactionSql,
    ctx: { orgId: string; rootJobId: string; workflowNode: string | null },
    gates: { claimGates: BellowsConfig | null; gateError: string | null }
): Promise<ResolvedClaimPublish> {
    const { orgId, rootJobId, workflowNode } = ctx;
    if (workflowNode === null) return { publish: undefined, ...gates };
    const [root] = await tx<{ workflow_snapshot: WorkflowDefinition | null }[]>`
        select workflow_snapshot from job
        where org_id = ${orgId} and id = ${rootJobId}
    `;
    const snapshot = root?.workflow_snapshot ?? null;
    if (snapshot === null) {
        // A node without a snapshot cannot happen on a live thread (the transition insert always
        // copies the id and the root carries the snapshot); answering "do not publish" is the
        // safe arm of the branch.
        return { publish: false, ...gates };
    }
    const publish = isPublishNode(snapshot, workflowNode);
    if (nodeOf(snapshot, workflowNode)?.gates === false) {
        return { publish, claimGates: null, gateError: null };
    }
    return { publish, ...gates };
}

export interface ClaimCandidateRow {
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
}

/** claim()'s answer, assembled from the claimed row plus its resolved env/gates/workflow halves. */
export function buildClaimResult(
    row: ClaimCandidateRow,
    rootJobId: string,
    resolved: ResolvedClaimExecutor & ResolvedClaimGates & ResolvedClaimPublish
): Claim {
    const { claimEnv, executorType, claimPath, claimGates, gateError, publish } = resolved;
    return {
        id: row.id,
        command: row.command,
        attempts: row.attempts,
        leaseToken: row.lease_token,
        leaseExpiresAt: row.lease_expires_at.toISOString(),
        executorType,
        userId: row.created_by,
        // Built here rather than in the route, because this is where the org is bound. Null for
        // an unattributed job — no member, so no workspace — and null when this deployment has no
        // workspace root, where no directory exists to point at.
        workspacePath: claimPath,
        rootJobId,
        // Survived the case above, so this claim is a resume.
        resumeSessionId: row.session_id,
        followUp: row.follow_up,
        ...(claimEnv ? { env: claimEnv } : {}),
        ...(row.repo !== null ? { repo: row.repo } : {}),
        ...(claimGates || gateError ? { gates: claimGates, gateError } : {}),
        ...(publish !== undefined ? { publish } : {}),
    };
}

/**
 * createFollowUp's whole body, top-level purely to keep createJobStore itself under the repo's
 * line-count ceiling — no behavior change.
 *
 * One conditional insert: the select carries every precondition (finished, not done, has a
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
            select id, repo, executor, session_id, remote_session_id, root_job_id, workflow_name
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
                end as session_id,
                case
                    when root.snapshot is null then parent.remote_session_id
                    else (
                        select r.remote_session_id
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
                end as remote_session_id
            from parent, root
        )
        insert into job (org_id, command, created_by, repo, executor, parent_job_id, session_id, remote_session_id, root_job_id, workflow_name)
        select ${orgId}, ${command}, ${createdBy}, parent.repo, parent.executor, parent.id,
               coalesce(primary_session.session_id, parent.session_id),
               coalesce(primary_session.remote_session_id, parent.remote_session_id),
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

/** Separates "no such job" from "the lease is not yours" once a guarded update matched nothing. */
export async function exists(sql: Sql, orgId: string, id: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`select id from job where org_id = ${orgId} and id = ${id}`;
    return rows.length > 0;
}
