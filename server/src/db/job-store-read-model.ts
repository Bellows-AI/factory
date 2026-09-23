import type { UserRef } from '@factory-ai/core';
import type { BellowsConfig } from '../workspace/bellows.js';
import type { ParamValues, WorkflowDefinition } from './workflow-schema.js';
import type { Claim, GateReport, Job, JobOutcome, JobStatus, RuntimeVitals } from './job-store-contract.js';

/**
 * The `JobStore` contract itself and the task read model it also serves — split out of
 * job-store-types.ts purely to keep every file under the repo's line-count ceiling, re-exported
 * from job-store.ts for every existing import site.
 */

/**
 * Why a write was refused.
 *
 * - `lost`    the job is no longer running under this token — the lease expired and someone else
 *             has it, or the board gave up on it. The caller must stop working.
 * - `missing` no such job in this organization.
 */
export type LeaseResult = 'ok' | 'lost' | 'missing';

/**
 * What a suspend (park) did.
 *
 * - `ok`      the run left `running`, and `status` says where it landed: `stopped` when the
 *             parking was the user's stop landing (the stamp the heartbeat delivered),
 *             `standby` for the Remote Control idle park.
 * - `lost`    the job is no longer running under this token — the lease expired and someone else
 *             has it, or the board gave up on it. The caller must stop working.
 * - `missing` no such job in this organization.
 */
export type SuspendResult = { result: 'ok'; status: JobStatus } | { result: 'lost' } | { result: 'missing' };

/**
 * Why a follow-up was refused.
 *
 * - `missing`      no such job in this organization.
 * - `not_finished` the parent is still queued, running or parked — its run is not over.
 * - `task_done`    the user has declared the task done; the conversation is closed.
 * - `no_session`   the parent has no agent session to continue — every opencode run, and a
 *                  claude-code run that died before its driver reported the session. Starting a
 *                  fresh run would look like a continuation while carrying nothing over.
 * - `forbidden`    the parent was queued by a different account. The child would inherit the
 *                  parent's session, and a session resumes only in the checkout tree it ran in —
 *                  the author's; a member's command may only ever run in their own tree.
 */
export type FollowUpRefusal = 'missing' | 'not_finished' | 'task_done' | 'no_session' | 'forbidden';

/**
 * What a stop request did.
 *
 * - `stopped`   the row was settled `stopped` in place — it was queued (never started), its run
 *               was already parked, or it was running under a lease that has already expired
 *               (nobody holds it, so there is nobody left to deliver to — issue #152); the turn
 *               is over.
 * - `requested` the row is running under a live lease; the worker has been told and will settle
 *               it. The timestamp is the FIRST request, kept on later stops so the answer is
 *               idempotent.
 * - `missing`   no such job in this organization.
 * - `conflict`  the row already ended — there is no turn left to stop.
 */
export type StopResult =
    | { result: 'stopped' }
    | { result: 'requested'; cancelRequestedAt: string }
    | 'missing'
    | { result: 'conflict'; status: JobStatus };

/**
 * What a task removal did.
 *
 * - `ok`        the whole thread is gone and a worktree reclaim is queued. The root the driver
 *               must reclaim — the id, the repo label and the relative workspace path — rides the
 *               answer and the queue row, so the worker never has to touch the job table.
 * - `missing`   no such job in this organization.
 * - `conflict`  a member of the thread is still running. The user stops it first; the worktree a
 *               live runner is editing must not be torn out from under it.
 */
export type RemoveResult =
    | { result: 'ok'; rootJobId: string; repo: string | null; workspacePath: string | null }
    | 'missing'
    | 'conflict';

/** A worktree reclaim a driver just leased. Acking by id removes the row. `leaseExpiresAt` is the
 * expiry the claim granted, read back from the row it was persisted on — the holder keeps the row
 * to it whatever later pollers ask for. */
export interface ReclaimClaim {
    id: string;
    rootJobId: string;
    repo: string | null;
    workspacePath: string | null;
    leaseExpiresAt: string;
}

export interface JobStore {
    /**
     * `createdBy` is a parameter rather than something read off the body, and the route passes the
     * authenticated caller's id. A client-supplied one would be impersonation on the audit trail of
     * a route that runs shell commands.
     *
     * `target` carries the optional repo/executor labels the tasks chat groups and displays by,
     * and — when the task runs a workflow — the resolved workflow: the id, the ENTRY node the
     * thread's first run walks, and the definition SNAPSHOT frozen onto the root row. The snapshot
     * is the graph the whole thread walks: editing the workflow mid-flight changes later tasks,
     * never this one (docs/workflows.md). Null when no workflow resolved, which is the ordinary
     * create and behaves exactly as it did before 027.
     */
    create(
        command: string,
        createdBy: string | null,
        target: {
            repo: string | null;
            executor: string | null;
            /**
             * When the task runs a workflow: the resolved workflow — the id, the NAME frozen on
             * the root row as workflow_name, the ENTRY node the thread's first run walks, the
             * definition SNAPSHOT frozen onto the root row, and the validated launch parameter
             * values (`{{param.*}}` resolves from them on every row of the thread). The route
             * validates the values against the definition's declarations before calling; the
             * store freezes them as given. The name comes off the resolved record, the same trust
             * pattern as `createdBy` — never off the body. Null when no workflow resolved, which
             * is the ordinary create and behaves exactly as it did before 027.
             */
            workflow?: {
                id: string;
                name: string;
                node: string;
                snapshot: WorkflowDefinition;
                params: ParamValues;
            } | null;
        }
    ): Promise<{ id: string }>;
    /**
     * Queues a follow-up on a finished task: a new job that inherits the parent's repo, executor
     * and — the thread's PRIMARY — session ids, linked through `followUpTo`. Atomic and
     * conditional — the insert only lands when the parent is finished, not done, carries a
     * session, and is the caller's own task — so the refusals above are decided in the same
     * statement that would have created the row, never by a read that could race a claim or a
     * completion in between.
     *
     * The thread's labels, session and workflow name are ALL the parent's, taken from the row and
     * never from a body: an adjustment continues the run it adjusts, on the executor that ran it —
     * a conversation switching executors mid-thread is exactly the cross-CLI resume the driver
     * cannot do. On a workflow thread the session copied is the primary (the first resume run's),
     * whatever node ran last, and the follow-up row itself is off-graph — no `workflow_node` —
     * so its completion re-fires the halted node's edges (docs/workflows.md).
     */
    createFollowUp(
        parentId: string,
        command: string,
        createdBy: string | null
    ): Promise<{ id: string } | FollowUpRefusal>;
    /**
     * The user's verdict that the task is done. Terminal tasks only — a moving run is not the
     * user's to finish. Idempotent: marking a done task done again answers the same instant, and
     * the status rides along so the route can echo the task's state without a second read.
     *
     * Done is what frees the task worktree: when the whole thread is already terminal, the same
     * transaction queues a `task_reclaim` row for it — a failed or finished thread that nobody
     * closed keeps its tree, and the done on any one member (the UI marks the head) is what
     * makes it the thread's done. A thread still moving is not queued here; its last completing
     * attempt finds the done in place and reclaims at the verdict.
     *
     * `doneBy` is the authenticated caller's id, passed by the route like `createdBy` on create —
     * never read off a body. Stamped beside `doneAt` with the same coalesce: the second "done"
     * keeps the first writer's actor.
     */
    markDone(
        id: string,
        doneBy: string | null
    ): Promise<{ status: JobStatus; doneAt: string } | 'missing' | 'conflict'>;
    /**
     * The user's stop. A QUEUED row never started and a STANDBY row's run is long gone — both are
     * settled `stopped` right here: the turn is over. A RUNNING row whose lease is still live is
     * stamped `cancel_requested_at` (idempotently) and left running: the driver reads the request
     * on the heartbeat it already sends, kills its runner and settles it with the existing
     * suspend route — the flag IS the stop travelling, and the settle clears it. A RUNNING row
     * whose lease has already expired settles `stopped` here instead (issue #152): nobody holds
     * the lease, and a stamp would wait for a heartbeat nobody will send. A row that already
     * ended refutes with its status.
     *
     * `stoppedBy` is the authenticated caller's id, passed by the route. Stamped at request time
     * with the same first-writer coalesce as the flag it rides beside.
     */
    stop(id: string, stoppedBy: string | null): Promise<StopResult>;
    /**
     * The user's remove. Deletes the WHOLE thread — the root and every follow-up — in one
     * transaction and queues a task_reclaim row for the worktree, so the driver (which is the only
     * thing that can remove the tree and the only thing with a live lease to do work in) reclaims
     * it without the removed thread having any job left to hang the work on. Refuses while any
     * member of the thread is running, under the same per-thread lock the claim takes, so a claim
     * can never slip a running row between the refusal check and the delete.
     *
     * `removedBy` is the authenticated caller's id, passed by the route. It rides the
     * task_reclaim row, because the thread rows are deleted in the same transaction — a
     * removed_by on job would be written and immediately deleted.
     */
    removeThread(id: string, removedBy: string | null): Promise<RemoveResult>;
    /** The driver's poll of the worktree-reclaim queue. The oldest claimable row, or null —
     * claimable by the expiry a previous claim GRANTED it, never by the polling worker's own
     * leaseSeconds. */
    claimReclaim(worker: string, leaseSeconds: number): Promise<ReclaimClaim | null>;
    /** Removes the reclaim row once the driver has actually taken the tree. The claim's worker only. */
    ackReclaim(id: string, worker: string): Promise<'ok' | 'lost' | 'missing'>;
    /** The oldest claimable job, or null when there is none. Never blocks on a live lease. */
    claim(worker: string, leaseSeconds: number): Promise<Claim | null>;
    heartbeat(
        id: string,
        leaseToken: string,
        leaseSeconds: number
    ): Promise<{ result: LeaseResult; leaseExpiresAt: string | null; cancelRequested: boolean }>;
    /**
     * Records the agent session the running attempt is using, so a reader can open it. Lease-guarded
     * like every other worker write: a superseded worker must not relabel the run that replaced it.
     *
     * Called more than once per attempt: the local id is known before the container starts, and the
     * remote one only after the bridge connects. A null `remoteSessionId` therefore leaves whatever
     * is already stored alone rather than clearing it.
     */
    session(id: string, leaseToken: string, sessionId: string, remoteSessionId: string | null): Promise<LeaseResult>;
    /**
     * Streams a rolling tail of the running attempt's output, so the dashboard can show the work
     * while it happens instead of a silent spinner — with the attempt's last sampled vitals riding
     * beside it when the driver has one. Lease-guarded like every other worker write, and REPLACE,
     * never append: the driver owns the tail window, and an unbounded append would grow the row for
     * as long as a session runs. The final complete report overwrites whatever this last stored.
     * A null `runtime` leaves the stored vitals alone — a missed sample costs freshness, not the
     * last good answer.
     */
    progress(id: string, leaseToken: string, output: string, runtime?: RuntimeVitals | null): Promise<LeaseResult>;
    /**
     * Replaces the run's gate state — the checks `.bellows.yaml` declared, executed in the
     * declared environment image. Lease-guarded like every other worker write, and REPLACE, never
     * append: the issue's UI contract is current/last ran only, and this side cannot know where a
     * previous report ended anyway.
     */
    gates(id: string, leaseToken: string, results: GateReport[]): Promise<LeaseResult>;
    /**
     * Re-reads what the job's checkout declares in `.bellows.yaml` — the same read the claim
     * made, made again because the driver's startup sync has just brought the checkout up to the
     * remote default, and the claim's answer predates that. Lease-guarded like every worker
     * route: a worker that lost the job must not steer the run that replaced it. A deployment
     * with no gates reader (or a job with no repo label or author) answers no gates, exactly as
     * its claim did.
     */
    rereadGates(
        id: string,
        leaseToken: string
    ): Promise<
        { result: 'ok'; gates: BellowsConfig | null; gateError: string | null } | { result: 'lost' | 'missing' }
    >;
    /**
     * A publish credential for the run's final push. The claim mints a full-hour installation
     * token and a run can outlive it — observed 2026-09-13 (job 43379d3a): a 1h33m run published
     * with its claim-time token, dead for 34 minutes, and the push died on 401 with the work done
     * and the gates green. The driver asks here, right before the push, and gets the claim's
     * environment resolved NOW: an operator-configured `GITHUB_TOKEN` wins exactly as it does at
     * claim time (a deliberate credential is never silently replaced), and the mint — when there
     * is one — is fresh, not the claim's. Lease-guarded like every worker route: the credential
     * goes only to the worker that holds the run, and only while it still does. A null token —
     * no provider and no configured value — is an answer, not an error: there is nothing fresher
     * than the claim env, so the driver publishes with what it holds.
     */
    publishToken(
        id: string,
        leaseToken: string
    ): Promise<{ result: 'ok'; token: string | null } | { result: 'lost' | 'missing' }>;
    /**
     * Ends a running job's attempt. Lease-guarded, like every other worker write. Where it lands
     * is decided by the stop stamp the heartbeat delivered: under one, the parking IS the user's
     * stop — the row settles `stopped` (terminal, session kept for the follow-up that continues
     * the conversation). Without one, this is the Remote Control idle park: `standby`, the session
     * kept so it can be driven on from the Claude UI.
     */
    suspend(id: string, leaseToken: string): Promise<SuspendResult>;
    /**
     * Records the verdict and answers it with whether the thread is DONE — computed in the same
     * transaction: `threadDone` is true only when every job of the thread — the root and every
     * follow-up — has reached `succeeded`, `failed`, `dead` or `stopped`, AND one of them carries the
     * user's `done_at`. The tree is the user's to free, so a thread that merely finished keeps
     * its worktree (a failed task's tree is exactly what a follow-up continues from); the
     * completing attempt reclaims only when the user has closed the thread. This is the driver's
     * worktree-reclaim signal (issue #47), and it rides the lease-guarded complete rather than a
     * thread read so a worker credential never pulls audit data of jobs it does not hold. The
     * verdict-moment answer also closes the read-after-verdict race: a follow-up inserted after
     * the verdict commits cannot change an answer that was already given.
     */
    complete(
        id: string,
        leaseToken: string,
        result: {
            status: JobOutcome;
            exitCode: number | null;
            output: string | null;
            /**
             * The context the run reached — token total and cost, scraped by the runner from the
             * session database at close. Null when the runner scraped none (claude-code,
             * kubernetes, a failed readout). Merged into the `runtime` vitals, creating them when
             * no sample ever landed, so the finished row carries the context stats even with no
             * CPU sample beside them.
             */
            contextTokens?: number | null;
            contextCostUsd?: number | null;
            /**
             * The agent turns the run's root conversation took, counted by the executor from its
             * own session records at close. Null means UNMEASURED — the read failed, the run was
             * killed before it, or the mode keeps no record — and never zero; a genuine zero is
             * reported as 0. The task statistics treat an unmeasured run as excluded, not empty.
             */
            agentTurns?: number | null;
            /**
             * What the run did, in the agent's own last words — lifted by the same close-time
             * read that counts the turns. Null is UNMEASURED, never empty; a string is the
             * agent's final text, already truncated by the driver and re-bounded by the route.
             */
            summary?: string | null;
            /**
             * The publication the run reports — the PR identity a successful publish landed.
             * Omitted (or null) when the run published nothing, so no `job_pr` row is invented.
             * When present it is recorded in the verdict's own transaction, and its `repo` is
             * cross-checked against the leased job's own repo label: a payload may not claim
             * another org's repository by spelling it in the report.
             */
            publication?: {
                repo: string;
                prNumber: number;
                prUrl: string;
                headBranch: string;
                baseBranch: string;
            } | null;
        }
    ): Promise<{ result: 'ok'; threadDone: boolean } | { result: 'lost' | 'missing' }>;
    /**
     * The whole follow-up chain containing `id` — the root task and every adjustment after it,
     * oldest first. Accepts ANY member of the chain (the UI keeps one URL per conversation, so a
     * member deep in the thread must resolve to the same view): every member carries the same
     * `root_job_id` (022), which is what the read keys on. Null when `id` is not a job here.
     */
    thread(id: string): Promise<Job[] | null>;
    get(id: string): Promise<Job | null>;
    /**
     * Newest first. `output` is not selected — it is unbounded and no list view shows it — and
     * `gates` stays off the same way; `runtime` does travel, a bounded vitals object whose
     * `activity` line is the live summary the nav and task view render (issue #61).
     *
     * `status: 'terminal'` is the one pseudo-value, and its answer is grouped as one row per
     * TASK, not per run (#124): the settled verdicts (`succeeded`/`failed`/`dead`/`stopped` —
     * the same set the thread-done computation uses) are folded by `root_job_id`, so a finished
     * conversation with follow-ups is one row. Identity fields are the ROOT's (id, command,
     * author, created), present-tense fields the chain HEAD's (status, summary, runtime,
     * session, started) — the rule the sidenav's `chainHead` already applies — and the wall
     * clock and completion stamp are the thread's (sum and max over the members); `doneAt`
     * comes from whichever member carries the thread's done. A thread with a member still
     * queued, running or parked is not completed and is excluded whole. Ordering is by the
     * thread's newest completion, and the limit bounds tasks. The per-run lists (no status,
     * one named status) keep their row-per-run contract — the tasks pages and sidenav group on
     * the client.
     */
    list(filter: {
        status?: JobStatus | 'terminal' | undefined;
        repo?: string | undefined;
        limit: number;
    }): Promise<Job[]>;
    /**
     * The task read model (#157): one summary per thread root — identity and authorship from the
     * ROOT row, present tense from the chain HEAD (the newest member, created then id — the
     * sidenav's chainHead rule), bucketed running/review/past exactly as `taskSections()` does in
     * the web layer, including a done task resurrected by a queued follow-up. The response
     * carries the org's whole navigation (counts and previews, immune to the page's filters) and
     * one keyset-paginated page on (activity_at, root_id) — never OFFSET. Cursor validation is
     * the caller's first line of defence and repeated here: a cursor that does not decode under
     * the handed filters throws rather than answering a page of a different question.
     */
    listTasks(filters: TaskListFilters): Promise<TaskListResponse>;
}

/** The page states the task list serves. `attention` is the inbox view: running and review. */
export type TaskState = 'attention' | 'running' | 'review' | 'past';

/** Which section of the task tree a task is in right now — the sidenav's three buckets. */
export type TaskBucket = 'running' | 'review' | 'past';

/**
 * One task: a thread root with the conversation's present tense. Every field is bounded — the
 * command, one activity line, one close-time summary — and nothing here is a run detail: no
 * output tail, no gate state, no runtime object, no session ids. The run's own page is
 * `GET /api/jobs/:id`; this row is what a list of many tasks renders.
 */
export interface TaskSummary {
    /** The root job id — the route target, the same id `GET /api/jobs/:id` answers for. */
    id: string;
    /** The root command; the UI derives the first-line title from it. */
    command: string;
    /** The newest run's status — the thread's present tense, the sidenav's chainHead rule. */
    status: JobStatus;
    /** The head run's stop-request stamp, when a stop has landed but not yet parked. */
    cancelRequestedAt: string | null;
    /** The head run's done stamp — null until the user declares the task done. */
    doneAt: string | null;
    /** The grouping labels the task was queued with, inherited by every follow-up. */
    repo: string | null;
    executor: string | null;
    /** The ROOT's creator, resolved at read time — the person the conversation belongs to. */
    author: UserRef | null;
    /** The head run's live activity line, as last sampled — not gated on still running here. */
    activity: string | null;
    /** The head run's close-time summary — what the newest run did, in the agent's last words. */
    summary: string | null;
    /**
     * The thread's PR wait, when it has one (036): the block's reason ("review", ...), when the
     * wait started, and — when the wait is terminal — why it ended. The open wait is preferred
     * over a terminal one, so a thread waiting for review reads waiting; a finished wait reads
     * what exhausted it. All null for a thread that never entered a wait.
     */
    waitReason: string | null;
    waitingSince: string | null;
    waitTerminalReason: string | null;
    /** The root's creation: when the conversation started. */
    createdAt: string;
    /** The head run's newest of created/started/finished/done — the task's sort key. */
    activityAt: string;
}

/** The org-wide figures a task poll renders beside the list, immune to the page's filters. */
export interface TaskNavigation {
    counts: { running: number; review: number; past: number };
    /** At most three running tasks, newest first — the live work. */
    running: TaskSummary[];
    /** At most five finished-but-undeclared tasks, newest first — the reader's queue. */
    review: TaskSummary[];
}

/** Everything `GET /api/tasks` accepts; `q`, `repo`, `author` arrive normalized from the route. */
export interface TaskListFilters {
    state: TaskState;
    q?: string | undefined;
    repo?: string | undefined;
    /** Compared case-insensitively against the root author's login. */
    author?: string | undefined;
    sort: 'newest' | 'oldest';
    limit: number;
    /** A cursor this list issued; validated against every other filter before use. */
    cursor?: string | undefined;
}

export interface TaskListResponse {
    navigation: TaskNavigation;
    page: { items: TaskSummary[]; nextCursor: string | null };
}
