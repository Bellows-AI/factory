/**
 * The worker's claim: picking the next candidate under the lease rules, resolving what the claim
 * carries (executor config and env, gates, the publish flag), and the terminal reclaim's own
 * claim/ack pair. See docs/jobs.md for the lease protocol and docs/workflows.md for the publish flag.
 */

import { OBJECTIVE_MODE, type JobMode, skillSelectionProblems } from '@factory-ai/core';
import type { Fragment, TransactionSql } from 'postgres';
import type { BellowsConfig } from '../workspace/bellows.js';
import type { ServiceSpec } from '../workspace/bellows-services.js';
import type { EvidencePolicy, ReviewEvidence } from './evidence-policy.js';
import { INTERRUPTION_BUDGET, LEASE_EXPIRED_REASON } from './job-store-actions.js';
import { type ResolvedClaimExecutor, resolveClaimExecutor } from './job-store-claim-executor.js';
import { readReviewEvidence } from './job-store-evidence.js';
import { stopReviewsOf } from './job-store-reviews.js';
import { workspacePathFor } from './job-store-rows.js';
import { settleIfMergeClosed } from './job-store-merge.js';
import type {
    JobStoreContext,
    JobStore,
    CreateJobStoreDeps,
    Claim,
    ClaimHelperPlan,
    JobStorePrs,
    ReviewerSpec,
} from './job-store-types.js';
import { claimCommand } from './follow-up-recap.js';
import { reviewerPrompts } from './review-prompt.js';
import { resolveMasterPrompt, resolveTurnContext } from './master-prompt.js';
import { skillCatalog } from '../skills.js';
import { isCancelledContinuation, sweepRuntimeWakes } from './workflow-blocks/runtime.js';
import { type WorkflowDefinition, isAgentlessNode, isPublishNode, nodeOf, nodeSkipsGates } from './workflow-schema.js';

export interface ClaimCandidateRow {
    id: string;
    command: string;
    attempts: number;
    max_attempts: number;
    claim_seq: string;
    lease_token: string;
    lease_expires_at: Date;
    created_by: string | null;
    session_id: string | null;
    repo: string | null;
    parent_job_id: string | null;
    executor: string | null;
    follow_up: boolean;
    workflow_node: string | null;
    workflow_name: string | null;
    mode: JobMode;
    root_command: string;
    /** Set only on a named-profile review's row (issue #549): the profile it runs as and the ref it starts from. */
    review_of: string | null;
    review_spec: ReviewerSpec | null;
    review_ref: string | null;
    /** The thread ROOT's selected skills (055), read in the claim's RETURNING. */
    skills: string[];
    /** Whether the thread ROOT selected a managed Jira connection (054), read in the same RETURNING. */
    has_jira_connection: boolean;
    /** The frozen target branch of the batch task the thread works (059), read in the same RETURNING; null outside a batch. */
    base_branch: string | null;
    /** Whether this attempt's loss retires the job: attempts and interruption budget spent (issue #822). */
    last_attempt: boolean;
}

/**
 * Retire what has burned its attempts, before looking for work. Without this a command that kills
 * its worker is reclaimed every time its lease expires, forever. An expired lease is first an
 * interruption the claim records (issue #822), so only a row whose interruption budget is spent
 * too retires; its session stays, for the follow-up that continues it. The dead attempt's segment banks
 * here: the row ran for real before its worker went quiet, and the retirement must not erase it. A
 * stamped row never reaches this sweep — the settle in `claimJob` has already landed it `stopped`,
 * which is the verdict a stop is (issue #152): dead is for attempts that failed on their own.
 */
async function retireExhaustedAttempts(ctx: JobStoreContext, tx: TransactionSql): Promise<void> {
    const { orgId, wallTick } = ctx;
    const retired = await tx<{ id: string; root_job_id: string }[]>`
        update job set status = 'dead', finished_at = now(), lease_token = null,
                       wall_clock_ms = ${wallTick}
        where org_id = ${orgId} and status = 'running'
          and lease_expires_at <= now() and attempts >= max_attempts
          and jsonb_array_length(interruptions) >= ${INTERRUPTION_BUDGET}
        returning id, root_job_id
    `;
    // A retired caller's separate reviews (issue #549) have no one left to read them.
    await stopReviewsOf(
        tx,
        { orgId, wallTick, stoppedBy: null },
        retired.map((r) => r.id)
    );
    // A merge-marked thread whose last moving member just retired is closed by it (issue #390) —
    // the shared conditional settle, distinct roots in deterministic order so two transactions
    // settling the same roots cannot cycle on the locks.
    for (const root of [...new Set(retired.map((r) => r.root_job_id))].sort()) {
        await settleIfMergeClosed(ctx, root, tx);
    }
}

/**
 * The cancellation fence (issue #231): a block-wait continuation the wake sweep just made
 * claimable, whose wait was cancelled (PR close, task stop/remove) after the wake committed but
 * before this claim reached it, is settled here rather than handed out — PR-close/thread-stop
 * cancellation must win the race against a wake. Every other candidate (a workflow-less job, a
 * plain agent node, a still-open continuation) pays one indexed lookup keyed off nothing but this
 * row's own id. True when the row was settled and the claim must move to the next candidate.
 */
async function settleCancelledContinuation(
    ctx: JobStoreContext,
    tx: TransactionSql,
    row: { id: string; workflow_node: string | null },
    rootJobId: string
): Promise<boolean> {
    const { orgId } = ctx;
    if (row.workflow_node === null || !(await isCancelledContinuation(tx, orgId, row.id))) return false;
    await tx`
        update job set status = 'stopped', finished_at = now(),
                       lease_token = null, lease_expires_at = now(),
                       -- The claim update above already burned an attempt and banked a
                       -- segment for a run that never actually launched — handed back,
                       -- the same "a settle here is not a failed try" rule stop/suspend
                       -- already follow for a park.
                       attempts = greatest(attempts - 1, 0)
        where org_id = ${orgId} and id = ${row.id}
    `;
    // The settled continuation may have been a merge-closed thread's last moving member (issue
    // #390) — the shared conditional settle, on the already-held lock.
    await settleIfMergeClosed(ctx, rootJobId, tx);
    return true;
}

/**
 * How long a claim reserves its candidate while it prepares it (issue #822): above the plan read's
 * worst case — two GitHub requests of up to 20 s each, each behind an installation-token mint of up
 * to 5 s (`server/src/github/app-client.ts`, `app-token.ts`). Only an optimization: the acquisition
 * re-checks everything, so a preparation that outlives it is dropped, never trusted.
 */
export const CLAIM_PREPARE_SECONDS = 60;

/** The candidate a claim reserved, as the preparation outside every lock needs it. */
interface ReservedCandidate {
    id: string;
    root_job_id: string;
    claim_seq: string;
    created_by: string | null;
    repo: string | null;
    workflow_node: string | null;
    review: boolean;
    base_branch: string | null;
}

/** The answer an acquisition that lost its candidate gives: move to the next one. */
const NEXT_CANDIDATE = Symbol('next candidate');

/**
 * The claimability rules, rendered for the reservation and the acquisition alike.
 *
 * `sameThreadRunning` is the thread exclusion: `id` and `root` are the candidate row's id and
 * root_job_id, correlated expressions in the reservation, bound parameters in the acquisition. A row
 * whose thread already has another row running waits. The per-task worktree (issue #35) is keyed by
 * the thread root, so two claimed rows of one thread would run two runners and two sync jobs into the
 * same tree. The blocker is status = 'running' and nothing else: an expired lease is still a run the
 * board believes in until the claim reclaims it (the same-row reclaim, o.id <> <candidate>, is the
 * heartbeat-409 path and stays). Every member of the thread carries the same root_job_id (022), so
 * the exclusion is one indexed lookup, not a walk — and it is symmetric and terminal rows block nothing.
 *
 * `recovering` is a `running` row whose lease expired: an attempt the infrastructure lost — its
 * driver went silent (issue #822). While the interruption budget lasts, the claim that takes it over
 * records that loss as the superseded attempt's interruption and spends no attempt, so an expiry at
 * the last allowed attempt stays recoverable. Unqualified on purpose: the reservation's only table
 * is the candidate, and the acquisition's SET reads the pre-update row.
 *
 * `baseBranch` is the frozen target branch of the batch task the thread works, joined through the
 * root, so every retry, follow-up and repair of a batch task bases on the target's branch with no
 * column to copy.
 */
function claimRules(ctx: JobStoreContext) {
    const { sql, orgId } = ctx;
    return {
        sameThreadRunning: (id: string | Fragment, root: string | Fragment) => sql`
            not exists (
                select 1 from job o
                where o.org_id = ${orgId}
                  and o.root_job_id = ${root}
                  and o.id <> ${id}
                  and o.status = 'running'
            )
        `,
        recovering: sql`(status = 'running' and jsonb_array_length(interruptions) < ${INTERRUPTION_BUDGET})`,
        baseBranch: sql`(select tg.branch from batch_task t
                         join batch_target tg on tg.org_id = t.org_id and tg.batch_id = t.batch_id
                                             and tg.key = t.target_key
                         where t.org_id = job.org_id and t.root_job_id = job.root_job_id)`,
    };
}

/**
 * Reserves the next candidate, in one autocommit statement so no lock outlives it: the oldest
 * claimable row nobody reserved, with a row whose earlier preparation failed or was abandoned —
 * its `claim_deferred_until` still set — ordered behind every row that never failed, oldest failure
 * first. That ordering, not only the window, is what lets healthy work past a poison candidate
 * however long the driver sleeps between polls (`DRIVER_POLL_MS`).
 */
async function reserveCandidate(ctx: JobStoreContext): Promise<ReservedCandidate | null> {
    const { sql, orgId } = ctx;
    const { sameThreadRunning, recovering, baseBranch } = claimRules(ctx);
    const [reserved] = await sql<ReservedCandidate[]>`
        update job set claim_deferred_until = now() + make_interval(secs => ${CLAIM_PREPARE_SECONDS}::int)
        where org_id = ${orgId} and id = (
            select j.id from job j
            where j.org_id = ${orgId}
              and j.status in ('queued','running')
              and j.lease_expires_at <= now()
              and (j.attempts < j.max_attempts or ${recovering})
              and (j.claim_deferred_until is null or j.claim_deferred_until <= now())
              and ${sameThreadRunning(sql`j.id`, sql`j.root_job_id`)}
            order by j.claim_deferred_until asc nulls first, j.created_at, j.id
            limit 1
            -- Below the limit in the plan, so a row another claimer is reserving is skipped
            -- rather than counted and then discarded.
            for update skip locked
        )
        returning id, root_job_id, claim_seq, created_by, repo, workflow_node,
                  (review_spec is not null and review_ref is not null) as review,
                  ${baseBranch} as base_branch
    `;
    return reserved ?? null;
}

/**
 * The claim's slow half, outside every transaction: the plan read through the GitHub API. A
 * named-profile review never reads the plan (`claimReview`), and neither does a cancelled
 * continuation, which the acquisition settles — so an outage of the plan source never holds up the
 * cancellation fence. A read that throws propagates, and the reservation stays as the candidate's
 * backoff.
 */
async function prepareCandidate(ctx: JobStoreContext, reserved: ReservedCandidate): Promise<ResolvedClaimGates> {
    const { sql, orgId, planReader, hasWorkspaces } = ctx;
    const skip =
        reserved.review ||
        (reserved.workflow_node !== null && (await isCancelledContinuation(sql, orgId, reserved.id)));
    return resolveClaimGates(
        skip ? undefined : planReader,
        { orgId, hasWorkspaces, rootJobId: reserved.root_job_id },
        reserved
    );
}

/**
 * The claim's short half: one transaction that takes the candidate's row lock, then its thread
 * root's advisory lock — the order a verdict takes them, so the two never deadlock — and claims it
 * only if nothing moved since the reservation: the whole claimability predicate re-asserted under
 * the locks, and `claim_seq` unchanged, so a claim that committed while this one prepared (its
 * reservation lapsed, say) is never overwritten with a stale plan read. The lease starts at this
 * acquisition (`clock_timestamp()`), after any lock wait, never at a transaction's start.
 *
 * The root lock is the serialization point. Deliberately not `for update` on the root ROW: that row
 * is the one a running thread heartbeats and completes against, and a claim parked on it would stall
 * those writes for as long as its env resolution takes. An advisory xact lock queues claims against
 * each other and nothing else, is keyed per root so different threads never block each other, and
 * claims of one thread therefore fully serialize: the re-check sees every earlier claim committed.
 *
 * The rest of the claim — env and executor resolution, the workflow snapshot, the evidence stamp —
 * resolves on this transaction, so a throw rolls the half-claim back: the row is never `running`
 * with a lease nobody holds. The reservation outlives the rollback as the candidate's backoff.
 */
async function acquireCandidate(
    ctx: JobStoreContext,
    lease: { worker: string; leaseSeconds: number },
    reserved: ReservedCandidate,
    gates: ResolvedClaimGates
): Promise<Claim | typeof NEXT_CANDIDATE> {
    const { sql, orgId } = ctx;
    const { sameThreadRunning, recovering, baseBranch } = claimRules(ctx);
    const expiry = sql.json({ reason: LEASE_EXPIRED_REASON, at: new Date().toISOString() });
    const rootJobId = reserved.root_job_id;
    return sql.begin(async (tx) => {
        // Gone (the thread was removed while this claim prepared): nothing to acquire.
        const [locked] = await tx`select id from job where org_id = ${orgId} and id = ${reserved.id} for update`;
        if (!locked) return NEXT_CANDIDATE;
        await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;

        const rows = await tx<
            (ClaimCandidateRow & {
                executor_scope: string | null;
            })[]
        >`
            update job set
                status           = 'running',
                claimed_by       = ${lease.worker},
                lease_token      = gen_random_uuid(),
                -- A lost attempt is recorded, not spent: the interruption names the claim it
                -- supersedes, so an adoption of that claim's runner is the same disruption.
                attempts         = attempts + case when ${recovering} then 0 else 1 end,
                interruptions    = case when ${recovering}
                    then interruptions || jsonb_build_array(
                        ${expiry}::jsonb || jsonb_build_object('claimSeq', claim_seq)
                    )
                    else interruptions
                end,
                -- Never refunded (057): what orders this claim after every earlier one.
                claim_seq        = claim_seq + 1,
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
                -- session_id is not written: the session a lost attempt reported is the one
                -- its takeover resumes (issue #822). A fresh run is a retry — a new row.
                -- The previous attempt's vitals are not this attempt's, and a new container
                -- starts unsampled: the started_at reset, one row down.
                runtime          = null,
                -- Likewise the gate report: an attempt that never reports gates must not leave
                -- the previous attempt's red report for the workflow engine to read.
                gates            = null,
                claim_deferred_until = null,
                lease_expires_at = clock_timestamp() + make_interval(secs => ${lease.leaseSeconds}::int)
            where org_id = ${orgId} and id = ${reserved.id}
              and claim_seq = ${reserved.claim_seq}
              and status in ('queued','running')
              and lease_expires_at <= now()
              and (attempts < max_attempts or ${recovering})
              and ${sameThreadRunning(reserved.id, rootJobId)}
            -- parent_job_id and command_delivered_at are not written above, so RETURNING reads
            -- their pre-update values: delivered-so-far is exactly "this row was suspended at
            -- least once with its command in the transcript". A fresh or crashed follow-up has
            -- never been parked, so its command still has to go out; a suspended one settles
            -- stopped, and is never claimed again.
            returning id, command, attempts, max_attempts, claim_seq, lease_token, lease_expires_at, created_by,
                      session_id, repo, parent_job_id, executor, executor_scope, workflow_node, workflow_name, mode,
                      review_of, review_spec, review_ref,
                      -- The post-update row: whether this attempt's loss would retire the job.
                      (attempts >= max_attempts
                       and jsonb_array_length(interruptions) >= ${INTERRUPTION_BUDGET}) as last_attempt,
                      (parent_job_id is not null and command_delivered_at is null) as follow_up,
                      (select r.command from job r
                       where r.org_id = job.org_id and r.id = job.root_job_id) as root_command,
                      (select r.skills from job r
                       where r.org_id = job.org_id and r.id = job.root_job_id) as skills,
                      (select r.jira_connection_id is not null from job r
                       where r.org_id = job.org_id and r.id = job.root_job_id) as has_jira_connection,
                      ${baseBranch} as base_branch
        `;
        const row = rows[0];
        // Moved while this claim prepared — claimed, stopped, its lease renewed, its thread busy:
        // the next candidate, with nothing written here.
        if (!row) return NEXT_CANDIDATE;
        if (await settleCancelledContinuation(ctx, tx, row, rootJobId)) return NEXT_CANDIDATE;
        return assembleClaim(ctx, tx, row, { rootJobId, gates });
    });
}

/**
 * `claim()`'s reserve-prepare-acquire loop, one candidate at a time. Returns the assembled claim,
 * or null when nothing is claimable. A candidate that moved between its reservation and its
 * acquisition falls through to the next round, exactly as a single statement skipped a row that was
 * not claimable; a preparation that throws ends the poll with the candidate deferred.
 */
async function claimNextCandidate(
    ctx: JobStoreContext,
    worker: string,
    leaseSeconds: number
): ReturnType<JobStore['claim']> {
    for (;;) {
        const reserved = await reserveCandidate(ctx);
        if (!reserved) return null;
        const gates = await prepareCandidate(ctx, reserved);
        const claim = await acquireCandidate(ctx, { worker, leaseSeconds }, reserved, gates);
        if (claim !== NEXT_CANDIDATE) return claim;
    }
}

/**
 * Resolves what the claimed row carries and builds the claim. Resolved here rather than in the
 * route, because the org is bound here and the author and repo label are in hand — and ON THE
 * TRANSACTION, so a claim holds one connection. A resolver failure propagates: the claim route's
 * guard answers 503, the driver retries the claim, and a job is never handed out with half an
 * environment. A Remote Control claim never sees claimEnv at all
 * (driver/src/claim.ts) — like every other claim env value, a claude-code row's config does not
 * reach a Remote Control runner, which gets only the baked settings.json and the mounted auth volume.
 * The plan was read before the locks (`prepareCandidate`); the workspace path is the acquired row's.
 *
 * A named-profile review (issue #549) is claimed on its own, narrower terms: the profile's env
 * grant, no gates, no publish — see `claimReview`.
 */
async function assembleClaim(
    ctx: JobStoreContext,
    tx: TransactionSql,
    row: Parameters<typeof reviewRowOf>[0] & {
        created_by: string | null;
        repo: string | null;
        base_branch: string | null;
        executor: string | null;
        executor_scope: string | null;
        workflow_node: string | null;
        workflow_name: string | null;
        mode: JobMode;
    },
    prepared: { rootJobId: string; gates: ResolvedClaimGates }
): Promise<Claim> {
    const { orgId, env, githubApp, executorConfig, hasWorkspaces, prs } = ctx;
    const { rootJobId } = prepared;
    const reviewRow = reviewRowOf(row);
    if (reviewRow) return claimReview(tx, { env, executorConfig, orgId, hasWorkspaces, rootJobId }, reviewRow);
    const executor = await resolveClaimExecutor(tx, { env, executorConfig }, row);
    const gates = { ...prepared.gates, claimPath: workspacePathFor(orgId, hasWorkspaces, row.created_by) };
    const workflow = await resolveClaimWorkflow(tx, { orgId, rootJobId, prs }, row, gates);
    const evidence = await resolveClaimEvidence(tx, { orgId, rootJobId }, row, gates);
    const command = await claimCommand(tx, orgId, rootJobId, row);
    // The thread root's selection checked against what this claim's env authorizes: names
    // only, so selecting a skill never adds to the env and the sentence never carries a value.
    const managed = [...(row.has_jira_connection ? ['jira'] : []), ...(githubApp ? ['github'] : [])];
    const skillRefusal = resolveClaimSkills(row.skills, executor.claimEnv, managed);
    return buildClaimResult({ ...row, command }, rootJobId, {
        ...executor,
        ...gates,
        ...workflow,
        ...evidence,
        skillRefusal,
    });
}

export async function claimJob(
    ctx: JobStoreContext,
    worker: string,
    leaseSeconds: number
): ReturnType<JobStore['claim']> {
    const { sql, orgId, wallTick, prs } = ctx;

    // The wake sweep (issue #231), before looking for queued work: a parked block-wait round with
    // folded deliveries becomes exactly one queued continuation here, so claimNextCandidate below
    // can find it like any other row. Each candidate wakes in its own transaction, under that
    // thread's per-root advisory lock — never inside a claim transaction, whose failure must not
    // roll back a wake that already committed for an unrelated thread.
    await sweepRuntimeWakes({ sql, orgId, prs });
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
     * Committed as its own statement, deliberately OUTSIDE the claim (review of PR #153):
     * the claim's preparation — the plan read, the env resolution — awaits calls that
     * throw, and a settle that rode with them would be lost to every failed poll: the
     * stamped zombie would stay `running` and the follow-up the member queued would keep
     * answering not_finished — the exact stuck state this settle exists to end.
     */
    const stampedStops = await sql<{ root_job_id: string }[]>`
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
        returning root_job_id
    `;
    for (const root of [...new Set(stampedStops.map((r) => r.root_job_id))].sort()) {
        // A merge-marked thread whose last moving member was this undelivered stop closes here
        // (issue #390) — the shared conditional settle the other settle points run. This
        // statement is autocommit by design (above), so the settle opens its own transaction.
        await settleIfMergeClosed(ctx, root);
    }
    // The dead retirement commits on its own for the same reason (issue #822): a preparation that
    // keeps failing must not keep an exhausted row `running` across every poll.
    await sql.begin((tx) => retireExhaustedAttempts(ctx, tx));

    /*
     * Reserve, prepare, acquire (issue #822). The plan read — the claim's one remote call, tens of
     * seconds at worst — runs between two short steps and holds no lock: a stop, a heartbeat, a
     * remove or a verdict on the candidate's thread never waits on GitHub. The reservation keeps
     * other claimers off the candidate meanwhile and, left in place by a failed preparation, is
     * the candidate's backoff; the acquisition decides under the row and root locks, against the
     * `claim_seq` the reservation read, so two racing claims of one thread cannot both walk out —
     * the exclusion reads OTHER rows without locking them, and only the root lock makes it see a
     * same-thread claim that committed while this one waited.
     */
    return claimNextCandidate(ctx, worker, leaseSeconds);
}

/**
 * The sentence that stops a claim whose selected skills cannot run, or null (issue #545): a
 * selection the catalog lacks, a skill whose connection has no env names in the claim's resolved
 * env, or a managed connection the task never selected (`managed`; whether it is still authorized
 * is the proxy's per-call check, docs/connections.md). Config-kind and recoverable — the member fixes the settings and retries.
 */
export function resolveClaimSkills(
    skills: readonly string[],
    claimEnv: Readonly<Record<string, string>> | undefined,
    managed: readonly string[] = []
): string | null {
    const problems = skillSelectionProblems(skillCatalog(), skills, claimEnv ?? {}, managed);
    return problems.length === 0 ? null : `[skills unavailable] ${problems.join('; ')}. Fix this, then retry the task.`;
}

export interface ResolvedClaimGates {
    claimGates: BellowsConfig | null;
    claimServices: readonly ServiceSpec[];
    /** The commit the plan was read at; null when nothing was read. */
    planRevision: string | null;
    /** Why the plan cannot launch (`Claim.planRefusal`); null for a schedulable plan. */
    planRefusal: string | null;
    claimPath: string | null;
    /** The repository's evidence policy (base clone only); null when none is declared. */
    claimPolicy: EvidencePolicy | null;
    /** The repository's reviewer profiles (base clone only); empty when none is declared. */
    claimReviewers: readonly ReviewerSpec[];
}

/** What a claim carries of the evidence policy: the requirement and the thread's review evidence. */
export interface ResolvedClaimEvidence {
    policy?: EvidencePolicy;
    review?: ReviewEvidence;
}

/**
 * claim()'s plan resolution, off the transaction's tables: the repository's `.bellows.yaml` at the
 * tip of the thread's base branch (its default branch outside a batch), read through the GitHub
 * API and validated as one execution plan. A refusal — a typo, a port collision, an unreadable
 * branch — travels to the driver as `planRefusal`, so the task fails `config` before anything
 * launches, rather than as a 503 that would retry the claim forever; a GitHub outage rejects and
 * is retried. The plan rides only when the job has a repo label to read it from.
 */
export async function resolveClaimGates(
    planReader: CreateJobStoreDeps['plan'],
    ctx: { orgId: string; hasWorkspaces: boolean; rootJobId: string },
    row: { created_by: string | null; repo: string | null; base_branch: string | null }
): Promise<ResolvedClaimGates> {
    const claimPath = workspacePathFor(ctx.orgId, ctx.hasWorkspaces, row.created_by);
    if (!planReader || !row.repo) {
        return {
            claimGates: null,
            claimServices: [],
            planRevision: null,
            planRefusal: null,
            claimPath,
            claimPolicy: null,
            claimReviewers: [],
        };
    }
    const read = await planReader.readFor(row.repo, row.base_branch);
    return {
        claimGates: read.error ? null : read.config,
        claimServices: read.error ? [] : read.services,
        planRevision: read.revision,
        planRefusal: read.error,
        claimPath,
        claimPolicy: read.policy ?? null,
        claimReviewers: read.reviewers ?? [],
    };
}

/**
 * claim()'s evidence half. The policy is stamped on THIS row — re-stamped on every claim, so a
 * retry or a reclaim is judged against the requirement as it stands now — and the thread's review
 * evidence is derived from its rows only when a review is required (one read, otherwise none).
 * The completion check (`completeJob`) reads the stamped policy, never the repository again.
 */
async function resolveClaimEvidence(
    tx: TransactionSql,
    ctx: { orgId: string; rootJobId: string },
    row: { id: string; mode: JobMode },
    declared: Pick<ResolvedClaimGates, 'claimPolicy' | 'claimReviewers'>
): Promise<ResolvedClaimEvidence> {
    const { orgId, rootJobId } = ctx;
    const { claimPolicy: policy, claimReviewers: reviewers } = declared;
    const stamp = policy === null ? null : tx.json(policy as never);
    // The reviewer profiles are stamped the same way: a review request is validated against the
    // profiles as of THIS claim (issue #549), never against the repository at request time.
    const profiles = reviewers.length === 0 ? null : tx.json(reviewers as never);
    await tx`update job set policy = ${stamp}, reviewers = ${profiles} where org_id = ${orgId} and id = ${row.id}`;
    if (policy === null) return {};
    if (!policy.review) return { policy };
    // An objective thread has no graph; its reviewers are the named profiles its callers invoke.
    const snapshot = row.mode === OBJECTIVE_MODE ? null : await readWorkflowSnapshot(tx, orgId, rootJobId);
    return { policy, review: await readReviewEvidence(tx, { orgId, rootJobId }, snapshot) };
}

/** The row as a named-profile review's, when it is one: the spec and the ref come together (`job_review_ck`). */
function reviewRowOf<T extends ClaimCandidateRow>(
    row: T
): (T & { review_spec: ReviewerSpec; review_ref: string }) | null {
    if (row.review_spec === null || row.review_ref === null) return null;
    return { ...row, review_spec: row.review_spec, review_ref: row.review_ref };
}

/**
 * A named-profile review's claim (issue #549): the row is its own thread, claimed under the
 * profile's frozen spec. What it does NOT carry is the point — no minted GitHub token and no member
 * env beyond the profile's `connections`, no gates (so no gate error either), no publish, no
 * helpers, no policy to enforce on itself — and what it does carry that others do not is the
 * profile's own system prompt and `reviewRun`, the snapshot ref its worktree starts from and the
 * wall-clock budget the profile grants. The board decides all of it; the caller names none of it.
 */
async function claimReview(
    tx: TransactionSql,
    deps: {
        env: CreateJobStoreDeps['env'];
        executorConfig: CreateJobStoreDeps['executorConfig'];
        orgId: string;
        hasWorkspaces: boolean;
        rootJobId: string;
    },
    row: ClaimCandidateRow & { executor_scope: string | null; review_spec: ReviewerSpec; review_ref: string }
): Promise<Claim> {
    const { env, executorConfig, orgId, hasWorkspaces, rootJobId } = deps;
    const spec = row.review_spec;
    const executor = await resolveClaimExecutor(tx, { env, executorConfig, grant: spec.connections }, row);
    const claim = buildClaimResult(row, rootJobId, {
        ...executor,
        claimPath: workspacePathFor(orgId, hasWorkspaces, row.created_by),
        claimGates: null,
        claimServices: [],
        planRevision: null,
        planRefusal: null,
        claimPolicy: null,
        claimReviewers: [],
        publish: false,
        helperPlans: undefined,
        masterPrompt: reviewerPrompts(spec, '').masterPrompt,
        turnContext: null,
        // A reviewer selects no skills and no managed connection: nothing to refuse.
        skillRefusal: null,
    });
    return { ...claim, reviewRun: { profile: spec.name, ref: row.review_ref, timeoutMinutes: spec.timeoutMinutes } };
}

export interface ResolvedClaimPublish {
    publish: boolean | undefined;
    /** `false` only for an agent-less workflow node; absent otherwise. */
    agent?: false;
    claimGates: BellowsConfig | null;
    claimServices: readonly ServiceSpec[];
    planRevision: string | null;
    planRefusal: string | null;
}

type ClaimGatesRead = Pick<ResolvedClaimGates, 'claimGates' | 'claimServices' | 'planRevision' | 'planRefusal'>;

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
    gates: ClaimGatesRead
): ResolvedClaimPublish {
    if (workflowNode === null) return { publish: undefined, ...gates };
    if (snapshot === null) {
        // A node without a snapshot cannot happen on a live thread (the transition insert always
        // copies the id and the root carries the snapshot); answering "do not publish" is the
        // safe arm of the branch.
        return { publish: false, ...gates };
    }
    const publish = isPublishNode(snapshot, workflowNode);
    const agent = isAgentlessNode(snapshot, workflowNode) ? { agent: false as const } : {};
    if (nodeSkipsGates(snapshot, workflowNode)) {
        return { publish, ...agent, claimGates: null, claimServices: [], planRevision: null, planRefusal: null };
    }
    return { publish, ...agent, ...gates };
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

/**
 * claim()'s one bundle of every workflow-shaped decision: the snapshot read, the publish flag, the
 * declared helper plans, and the master prompt they all feed (issue #244) — pulled out of
 * `claimNextCandidate` purely to keep that function's own complexity readable, no behavior change.
 * Reads the snapshot for a workflow-mode member follow-up too (workflow_node null, workflow_name not): the
 * master prompt's graph-wide capabilities (publish path, review/merge-conflict blocks) still apply
 * to that turn, even though it carries no node of its own — `resolveClaimPublish` and
 * `resolveClaimHelperPlans` both branch on workflowNode first, so this widening changes neither of
 * their answers.
 */
async function resolveClaimWorkflow(
    tx: TransactionSql,
    ctx: { orgId: string; rootJobId: string; prs: JobStorePrs | undefined },
    row: { workflow_node: string | null; workflow_name: string | null; mode: JobMode; skills: string[] },
    gates: ClaimGatesRead
): Promise<
    ResolvedClaimPublish & {
        helperPlans: ClaimHelperPlan[] | undefined;
        masterPrompt: string | null;
        turnContext: string | null;
    }
> {
    const { orgId, rootJobId, prs } = ctx;
    // The stored mode decides (051): an objective row never reads a snapshot, so it resolves no
    // publish, no helper plans and an objective master prompt.
    const snapshot = row.mode === OBJECTIVE_MODE ? null : await readWorkflowSnapshot(tx, orgId, rootJobId);
    const published = resolveClaimPublish(snapshot, row.workflow_node, gates);
    const helperPlans = await resolveClaimHelperPlans(tx, {
        rootJobId,
        workflowNode: row.workflow_node,
        snapshot,
        prs,
    });
    const promptInput = {
        mode: row.mode,
        workflowNode: row.workflow_node,
        workflowName: row.workflow_name,
        snapshot,
        helperPlans,
        skills: row.skills,
    };
    return {
        ...published,
        helperPlans,
        masterPrompt: resolveMasterPrompt(promptInput),
        turnContext: resolveTurnContext(promptInput),
    };
}

/** claim()'s answer, assembled from the claimed row plus its resolved env/gates/workflow halves. */
export function buildClaimResult(
    row: ClaimCandidateRow,
    rootJobId: string,
    resolved: ResolvedClaimExecutor &
        ResolvedClaimGates &
        ResolvedClaimPublish &
        ResolvedClaimEvidence & {
            helperPlans: ClaimHelperPlan[] | undefined;
            masterPrompt: string | null;
            turnContext: string | null;
            skillRefusal: string | null;
        }
): Claim {
    const {
        claimEnv,
        executorType,
        executorRefusal,
        skillRefusal,
        claimPath,
        claimGates,
        claimServices,
        planRevision,
        planRefusal,
        publish,
        agent,
        helperPlans,
        masterPrompt,
        turnContext,
        policy,
        review,
    } = resolved;
    return {
        id: row.id,
        command: row.command,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        lastAttempt: row.last_attempt,
        claimSeq: Number(row.claim_seq),
        leaseToken: row.lease_token,
        leaseExpiresAt: row.lease_expires_at.toISOString(),
        executorType,
        executorRefusal,
        skillRefusal,
        planRefusal,
        userId: row.created_by,
        masterPrompt,
        turnContext,
        // Built here rather than in the route, because this is where the org is bound. Null for
        // an unattributed job — no member, so no workspace — and null when this deployment has no
        // workspace root, where no directory exists to point at.
        workspacePath: claimPath,
        rootJobId,
        rootCommand: row.root_command,
        // A follow-up's copied session, or the one a lost attempt of this row reported: a resume.
        resumeSessionId: row.session_id,
        followUp: row.follow_up,
        ...(claimEnv ? { env: claimEnv } : {}),
        ...(row.repo !== null ? { repo: row.repo } : {}),
        ...(row.base_branch ? { baseBranch: row.base_branch } : {}),
        ...(claimGates ? { gates: claimGates } : {}),
        ...(claimServices.length > 0 ? { services: claimServices } : {}),
        ...(planRevision ? { planRevision } : {}),
        ...(policy ? { policy } : {}),
        ...(review ? { review } : {}),
        ...(publish !== undefined ? { publish } : {}),
        ...(agent === false ? { agent } : {}),
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
    //
    // One transaction now, because the ack also stamps the durable `worktree_reclaimed_at`
    // marker on the thread root (045, issue #327): the delete alone left "reclaim already ran"
    // indistinguishable from "reclaim never queued" — the ambiguity reopen has to resolve. The
    // update answers 0 rows for a thread remove deleted whole (its artifact is the reclaim row
    // being deleted here); coalesce keeps the first writer's instant.
    return sql.begin(async (tx) => {
        const rows = await tx<{ id: string; root_job_id: string }[]>`
            delete from task_reclaim
            where org_id = ${orgId} and id = ${id} and claimed_by = ${worker}
            returning id, root_job_id
        `;
        if (rows[0]) {
            await tx`
                update job set worktree_reclaimed_at = coalesce(worktree_reclaimed_at, now())
                where org_id = ${orgId} and id = ${rows[0].root_job_id}
            `;
            return 'ok';
        }
        const present = await tx<{ id: string }[]>`select id from task_reclaim where org_id = ${orgId} and id = ${id}`;
        return present[0] ? 'lost' : 'missing';
    });
}
