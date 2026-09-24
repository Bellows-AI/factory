/**
 * The worker's claim: picking the next candidate under the lease rules, resolving what the claim
 * carries (executor config and env, gates, the publish flag), and the terminal reclaim's own
 * claim/ack pair. See docs/jobs.md for the lease protocol and docs/workflows.md for the publish flag.
 */

import { CLAUDE_CODE, EXECUTOR_TYPES, type ExecutorType, OPENCODE } from '@factory-ai/core';
import type { Fragment, TransactionSql } from 'postgres';
import type { BellowsConfig } from '../workspace/bellows.js';
import { withMintedToken } from './job-store-org-resolvers.js';
import { workspacePathFor } from './job-store-rows.js';
import type {
    JobStoreContext,
    JobStore,
    CreateJobStoreDeps,
    Claim,
    ClaimHelperPlan,
    JobStorePrs,
} from './job-store-types.js';
import { type WorkflowDefinition, isPublishNode, nodeOf } from './workflow-schema.js';

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
    root_command: string;
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
    const { sql, orgId, env, githubToken, gatesReader, executorConfig, hasWorkspaces, prs } = ctx;
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
         * path and stays). Every member of
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
                    root_command: string;
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
                -- stopped, and is never claimed again.
                returning id, command, attempts, lease_token, lease_expires_at, created_by,
                          session_id, repo, parent_job_id, executor, workflow_node,
                          (parent_job_id is not null and command_delivered_at is null) as follow_up,
                          (select r.command from job r
                           where r.org_id = job.org_id and r.id = job.root_job_id) as root_command
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
            // Control claim never sees claimEnv at all (driver/src/claim.ts) — like every
            // other claim env value, a claude-code row's config does not reach a Remote
            // Control runner, which gets only the baked settings.json and the mounted auth
            // volume.
            const { claimEnv, executorType } = await resolveClaimExecutor(
                tx,
                { env, githubToken, executorConfig },
                row
            );
            const gates = await resolveClaimGates(gatesReader, { orgId, hasWorkspaces, rootJobId }, row);
            const snapshot = row.workflow_node === null ? null : await readWorkflowSnapshot(tx, orgId, rootJobId);
            const published = resolveClaimPublish(snapshot, row.workflow_node, gates);
            const helperPlans = await resolveClaimHelperPlans(tx, {
                rootJobId,
                workflowNode: row.workflow_node,
                snapshot,
                prs,
            });
            return buildClaimResult(row, rootJobId, { claimEnv, executorType, ...gates, ...published, helperPlans });
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
    if (configured?.type === OPENCODE) {
        // `permission` is the runner's fence, baked into the image and patched by its entrypoint
        // — the one key the member does not get to set: a pasted `external_directory: allow`
        // would open every member's tree to this run. Everything else travels verbatim.
        const { permission: _fence, ...rest } = member;
        return { ...(claimEnv ?? {}), OPENCODE_CONFIG_CONTENT: JSON.stringify(rest) };
    }
    if (configured?.type === CLAUDE_CODE) {
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
 * claim()'s ONE read of the root row's frozen workflow snapshot — the graph every per-node
 * decision below is computed off. Shared by `resolveClaimPublish` and `resolveClaimHelperPlans`
 * so a claim of a workflow node pays this query once, not once per resolver: both run inside the
 * same claim transaction, which already holds the thread's advisory lock for its duration.
 */
async function readWorkflowSnapshot(
    tx: TransactionSql,
    orgId: string,
    rootJobId: string
): Promise<WorkflowDefinition | null> {
    const [root] = await tx<{ workflow_snapshot: WorkflowDefinition | null }[]>`
        select workflow_snapshot from job
        where org_id = ${orgId} and id = ${rootJobId}
    `;
    return root?.workflow_snapshot ?? null;
}

/**
 * claim()'s workflow read: the graph's per-node decisions, computed off the ROOT row's snapshot.
 * `publish` is the board's answer to "may this run push" — true only out of a publish node, false
 * on every other workflow node, and ABSENT (undefined) on a workflow-less row, which the driver
 * reads as "publish": the exact behavior before 027. A node may also opt its run out of the gates
 * — a fresh-eyes review need not pay suite minutes, and must not fail the thread on a gate it did
 * not touch — in which case neither gates nor a gate error ride the claim.
 */
export function resolveClaimPublish(
    snapshot: WorkflowDefinition | null,
    workflowNode: string | null,
    gates: { claimGates: BellowsConfig | null; gateError: string | null }
): ResolvedClaimPublish {
    if (workflowNode === null) return { publish: undefined, ...gates };
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

/**
 * claim()'s block-helper read: the snapshot node's own declared `helperPlans` (issue #207's
 * transport, #122's first producer), each resolved into a runtime plan by injecting ONE generic
 * value every helperId alike may use — the thread's recorded PR publication, when it has one.
 * This resolver knows no helperId's own meaning, exactly as `resolveClaimPublish` knows no
 * block's: a block's `expand()` is the only place that decides what a helper does with its input.
 * Absent (undefined) on a workflow-less claim and on any workflow node that declares no
 * `helperPlans` — the ordinary case for every plain `agent` node today, unchanged from before
 * this field existed.
 */
export async function resolveClaimHelperPlans(
    tx: TransactionSql,
    ctx: {
        rootJobId: string;
        workflowNode: string | null;
        snapshot: WorkflowDefinition | null;
        prs: JobStorePrs | undefined;
    }
): Promise<ClaimHelperPlan[] | undefined> {
    const { rootJobId, workflowNode, snapshot, prs } = ctx;
    if (workflowNode === null || snapshot === null) return undefined;
    const declared = nodeOf(snapshot, workflowNode)?.helperPlans;
    if (!declared || declared.length === 0) return undefined;
    const publication = prs ? await prs.publicationOf(rootJobId, tx) : null;
    return declared.map((plan) => ({
        helperId: plan.helperId,
        phase: plan.phase,
        githubWriting: plan.githubWriting,
        input: { publication },
    }));
}

/** claim()'s answer, assembled from the claimed row plus its resolved env/gates/workflow halves. */
export function buildClaimResult(
    row: ClaimCandidateRow,
    rootJobId: string,
    resolved: ResolvedClaimExecutor &
        ResolvedClaimGates &
        ResolvedClaimPublish & { helperPlans: ClaimHelperPlan[] | undefined }
): Claim {
    const { claimEnv, executorType, claimPath, claimGates, gateError, publish, helperPlans } = resolved;
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
        rootCommand: row.root_command,
        // Survived the case above, so this claim is a resume.
        resumeSessionId: row.session_id,
        followUp: row.follow_up,
        ...(claimEnv ? { env: claimEnv } : {}),
        ...(row.repo !== null ? { repo: row.repo } : {}),
        ...(claimGates || gateError ? { gates: claimGates, gateError } : {}),
        ...(publish !== undefined ? { publish } : {}),
        ...(helperPlans !== undefined ? { helperPlans } : {}),
    };
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
