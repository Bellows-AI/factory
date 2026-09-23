/**
 * Every shape the job board speaks: the job and claim records, the `JobStore` contract with its
 * result types, the task read model, and the factory's dependencies (`CreateJobStoreDeps`) plus the
 * context every method function receives (`JobStoreContext`). Types only, bar nothing — the
 * behavior is in the sibling `job-store-*.ts` files, which job-store.ts's header maps.
 */

import type { UserRef, ExecutorType } from '@factory-ai/core';
import type { Sql, TransactionSql, Fragment } from 'postgres';
import type { PublicationState } from './pr-lifecycle-store.js';
import type { BellowsConfig } from '../workspace/bellows.js';
import type { WorkflowDefinition, ParamValues } from './workflow-schema.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'stopped';

/** What a worker may report. 'dead' is the board's verdict, never a worker's. */
export type JobOutcome = 'succeeded' | 'failed';

/** Where one declared gate is, right now. 'running' is the worker's claim, the others its verdict. */
export interface GateReport {
    name: string;
    status: 'running' | 'passed' | 'failed';
    exitCode: number | null;
    /** The gate's tail. Bounded by the driver's window; truncated again at the route. */
    output: string | null;
}

/**
 * One declared service of the attempt's `.bellows.yaml`, as the driver's platform reports it:
 * the declared name (the DNS name inside the job), the image, and a lowercase state word —
 * docker's container State, or the pod phase under kubernetes.
 */
export interface ServiceStatus {
    name: string;
    image: string;
    state: string;
}

/**
 * The running attempt's vitals, sampled by the driver off its runner container and reported beside
 * the output tail: whether the container is actually doing work (CPU, memory) and what the agent
 * says it is doing right now (the stream's last line, its tool call most often). Current/last
 * state only — this is the "is it stuck or working" answer, not a sampling history. Null on every
 * job with no sample yet (a fresh attempt, or a kubernetes runner, which reports none).
 */
export interface RuntimeVitals {
    /** Whole-container CPU, percent of one host core; null when it could not be read this round. */
    cpuPercent: number | null;
    /** Resident memory, in MiB; null when it could not be read this round. */
    memUsedMb: number | null;
    /** Resident memory against the container's limit, percent; null when the daemon reports none. */
    memPercent: number | null;
    /** The agent's newest output line, ANSI-stripped and capped — the current tool call, usually. */
    activity: string | null;
    /** When the driver took the sample. A reader can see staleness from this alone. */
    sampledAt: string;
    /**
     * The attempt's declared `.bellows.yaml` services and their current states — present only
     * when the attempt declared any and the driver could read them. Cleared with the numbers on
     * the next claim: the fleet describes the attempt that took the lease.
     */
    services?: ServiceStatus[];
}

export interface Job {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    claimedBy: string | null;
    /**
     * The account that queued this job, or null for one queued before accounts existed.
     *
     * This is the audit trail on a route that runs shell commands, and it is also the seam the
     * per-user Claude credential and per-user workspace work reads: a claim reports it so the driver
     * can resolve them without ever touching the database.
     */
    createdBy: string | null;
    /**
     * Who `createdBy` resolves to — the account labels, joined at read time and never stored on
     * the row: logins and display names go stale, joins do not. Null for a pre-accounts row, and
     * for a job whose author's account has since been deleted (`on delete set null`) — rendered
     * as "unknown" rather than papered over with a synthetic author.
     */
    author: UserRef | null;
    /**
     * Who asked to stop the task — the person's verdict, stamped at REQUEST time (a running row
     * settles later through suspend; the asker is the actor, not the parking that delivered the
     * ask). First asker wins, so a retried click cannot rewrite history. Null on every task
     * nobody has asked to stop.
     */
    stoppedBy: UserRef | null;
    /**
     * Who marked the task done. First writer wins beside `doneAt`, the same idempotence rule.
     * Null on every task closed before attribution existed.
     */
    doneBy: UserRef | null;
    /** The agent session this attempt runs as, once its driver has reported it. */
    sessionId: string | null;
    exitCode: number | null;
    output: string | null;
    /**
     * What the run did, in the agent's own last words — lifted from the session records the
     * executor's close-time read already walks, and reported with the verdict. Null is
     * UNMEASURED (no read, a run cut off before any final text, a row predating the column) —
     * the command above records what was ASKED; this records what was done.
     */
    summary: string | null;
    /**
     * The verification gates this run has run or is running — the checks the job's checkout
     * declares in `.bellows.yaml` and the driver executes in the declared environment image.
     * Current/last state only, replaced on every worker report: the UI deliberately shows no
     * history. Null on every job that predates gates and on any job whose repository declares
     * none.
     */
    gates: GateReport[] | null;
    /**
     * The attempt's last sampled vitals — CPU, memory and the agent's current activity line — as
     * the driver reports them beside the output tail. Null until the first sample lands; left on
     * the row when the run ends, where "was it doing anything when it died" reads off `sampledAt`.
     */
    runtime: RuntimeVitals | null;
    /**
     * The repository (`owner/name`) the task was queued against, and the member's executor name it
     * was stamped with. Both remain audit labels; executor is additionally resolved against the
     * author's current profile at claim time, and the resolved type chooses what the worker runs.
     * See docs/jobs.md.
     */
    repo: string | null;
    executor: string | null;
    /**
     * The finished task this job asks for adjustments on, when it is a follow-up. The tasks chat's
     * conversation thread; null on every job queued before the mechanic and on every first task.
     * A follow-up carries a copy of the parent's session ids from insert, which is what makes the
     * run a continuation of that conversation rather than a fresh start.
     */
    followUpTo: string | null;
    /**
     * The id of the thread's ROOT job — the job itself, unless it is a follow-up, and then the
     * chain's first job. Stored on every row (022): the composite is served, never re-derived by
     * the reader. The worktree (issue #35) is keyed by it, and every member of one conversation
     * carries the same value from insert.
     */
    rootJobId: string;
    /**
     * The workflow node this run walks, when the task runs a workflow (027). Null on every other
     * row — workflow-less tasks, user follow-ups, and every job that predates workflows. This is
     * the graph position: the loop counts and the task view's node labels read it.
     */
    workflowNode: string | null;
    /**
     * The NAME of the workflow the task's thread was launched under, frozen at create (033): the
     * route stamps the resolved record's name onto the root row, and every successor and user
     * follow-up inherits it. This is the reusable process the member chose — `workflowNode` is
     * only a position in its graph. A later rename or delete of the source workflow never
     * rewrites it (no foreign key, no read-time join — `workflow_id`'s audit doctrine), and null
     * is honest on workflow-less tasks and on rows whose definition was already gone.
     */
    workflowName: string | null;
    /**
     * When the user declared the task done — the verdict no run can make. Null until they say so,
     * and only settable on a finished task; it never replaces the run's own outcome.
     */
    doneAt: string | null;
    /**
     * When a stop was requested on this ROW while it was running — the user's `/stop` landed on a
     * moving run and the worker has not parked it yet. The request is delivered through the
     * heartbeat the worker already sends (`cancelRequested`), and the flag is cleared when the
     * stop happens — parking (suspend) or finishing (complete) — never by the request itself. A
     * run whose worker died mid-stop never waits out a reclaim: the claim settles the stamped row
     * `stopped` (issue #152), the stop's own landing, and `/stop` on a row whose lease already
     * expired settles it in place. Null on every job nobody asked to stop.
     */
    cancelRequestedAt: string | null;
    /**
     * Where the author's checkouts are, RELATIVE to the workspace root: `<orgId>/<userId>` — the
     * same field the claim carries, derived here for the reads the dashboard polls so the task
     * view can show it. Null when the job has no author or this deployment has no workspace root,
     * exactly as on the claim: naming a directory that was never created would be worse than
     * saying nothing.
     */
    workspacePath: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    /**
     * The wall clock THIS row's own attempts banked (024) — the executed segments accumulated
     * at the settle points, never the time a queued row sat waiting. The thread's total is
     * `taskWallClockMs` below; this is the run's own figure — the row's own on the per-run
     * reads, the chain head's own on the grouped terminal list. Null where nothing was ever
     * banked for the row — never zero, which would claim a measurement that was never made.
     */
    wallClockMs: number | null;
    /**
     * The wall clock the task's WHOLE thread has banked — every executed segment of every run,
     * accumulated by the board at the settle points (claim, the dead retirement, the verdict,
     * the suspend park) into `wall_clock_ms` and summed over the thread by the read. Served by
     * `thread()` and by the grouped terminal list, whose rows ARE tasks (#124) — the figure the
     * task view's head clock and the recently-completed panel both render. Null where nothing
     * has accumulated — never zero, which would claim a measurement that was never made.
     */
    taskWallClockMs: number | null;
    /**
     * The thread's PR-review wait (036), when it has one — the open wait first, else the most
     * recently active terminal one, the same rule the task-summary read model follows. Carried on
     * every member of the thread alike, since the wait belongs to the ROOT, not the run: the task
     * view renders it beside whichever member it is looking at. Served by `thread()` only — `get`
     * and the per-run lists answer null, exactly as they do for a thread that never waited.
     */
    waitReason: string | null;
    waitingSince: string | null;
    waitTerminalReason: string | null;
}

/**
 * One declared block-helper step, resolved onto a claim (issue #207's transport, #122's first
 * producer): the driver's `HelperPlan` shape by wire convention — this package does not import
 * driver's types, and never needs to; the field names alone are the contract. `input` is resolved
 * here, generically for every helperId alike — today just the thread's recorded PR publication,
 * when it has one.
 */
export interface ClaimHelperPlan {
    helperId: string;
    phase: 'pre' | 'post';
    githubWriting: boolean;
    input: unknown;
}

/** What a worker gets back from a successful claim. The lease token is its proof for later. */
export interface Claim {
    id: string;
    command: string;
    attempts: number;
    leaseToken: string;
    leaseExpiresAt: string;
    /**
     * The executor profile type selected by the task's stamped executor label. Null when the
     * profile no longer exists; the driver reports that as a task failure instead of choosing a
     * deployment-wide CLI.
     */
    executorType: ExecutorType | null;
    /**
     * Who queued the job, so a worker can run it as them. Null for an unattributed job.
     *
     * It was shipped ahead of any consumer so that the per-user work would be a change to the
     * driver alone. `workspacePath` below is the first half of that arriving; the per-user Claude
     * credential is still to come, and this field is what it will read.
     */
    userId: string | null;
    /**
     * Where that person's checkouts are, RELATIVE to the workspace root: `<orgId>/<userId>`.
     *
     * Ready-made rather than a raw id, because each side owns what it knows. The server owns the
     * layout — it is the thing that created the directory — and the driver owns where the volume is
     * mounted, which need not be the same path the server sees. Handing over a uuid would make the
     * driver reimplement a layout it cannot verify.
     *
     * Relative for the same reason: an absolute server-side path is meaningless inside a container
     * that mounts the volume somewhere else.
     *
     * Null when the job has no author, or when this deployment has no workspace root. The driver
     * FAILS such a job rather than falling back — see driver/src/loop.ts.
     */
    workspacePath: string | null;
    /**
     * The id of the thread's ROOT job — the job itself, unless it is a follow-up, and then the
     * chain's first job. Read straight off the row's `root_job_id` column (022). The task worktree
     * (issue #35) is keyed by it, so every attempt of a task and every follow-up resuming its
     * session lands in the same tree, branched off the remote default. The driver cannot walk the
     * chain — the board owns the rows — so the claim is where the root travels.
     */
    rootJobId: string;
    /**
     * Set only when this claim is a follow-up resuming the parent's session: the worker restores
     * that session instead of starting a new one.
     */
    resumeSessionId: string | null;
    /**
     * True only when `resumeSessionId` is set AND this claim should still deliver the command into
     * it — a follow-up's first (or crashed) attempt, where the restored transcript is the parent
     * conversation and the command is the new adjustment. Absent on a board that predates
     * follow-ups, so it is read as `?? false` on the driver side.
     */
    followUp: boolean;
    /**
     * The environment the runner starts with, resolved at claim time for THIS job's author and
     * repo label: org < workspace < repo, the more specific scope winning. Optional — absent on a
     * board built without an env store, which the driver reads as "no environment".
     *
     * Under an app-mode board the environment also carries the minted installation token as its
     * BASE layer (`withMintedToken`): a `GITHUB_TOKEN` configured in any scope wins, and the mint
     * fills only the gap.
     *
     * Deliberately NOT persisted on the job row: `GET /api/jobs/:id` serves output and metadata to
     * every member, and storing the merged values there would publish the very secrets this
     * feature exists to hold.
     */
    env?: Record<string, string>;
    /**
     * The job's `owner/name` label, repeated on the claim so the driver can key the gate
     * environment container and resolve per-repo env without a second lookup. Absent on a board
     * that predates gates, which the driver reads as "no repo".
     */
    repo?: string | null;
    /**
     * The `.bellows.yaml` a checkout declares, read at claim time — the environment image the
     * gates run in and the named commands they run. Null when the repository declares none, which
     * is the ordinary case. Absent on a board built without a gates reader, read as "no gates".
     */
    gates?: BellowsConfig | null;
    /**
     * Why the gates file could not be read or parsed, when it exists but is wrong. A VALUE and not
     * a throw: one repository's typo must fail its own jobs loudly at the driver, never take down
     * the claim route or pass silently as "no gates".
     */
    gateError?: string | null;
    /**
     * Whether the driver may publish after this run's succeeded gated run. ABSENT on a
     * workflow-less claim — the driver reads its absence as "publish", the exact behavior before
     * workflows existed, which is what keeps the no-workflow claim byte-identical. On a workflow
     * row the board decides from the graph: true only for a publish node's run, so a mid-loop
     * review success never pushes (docs/workflows.md).
     */
    publish?: boolean;
    /**
     * Declared pre/post block-helper steps for this node's claim (issue #207/#122), resolved from
     * the snapshot node's own `helperPlans` — absent on every claim outside a block's expansion,
     * which is the ordinary case for every workflow-less and plain `agent`-node task today.
     */
    helperPlans?: ClaimHelperPlan[];
}

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
 * - `ok`      the run left `running`, and `status` says where it landed: `stopped`, the
 *             user's stop landing (the stamp the heartbeat delivered).
 * - `lost`    the job is no longer running under this token — the lease expired and someone else
 *             has it, or the board gave up on it. The caller must stop working.
 * - `missing` no such job in this organization.
 */
export type SuspendResult = { result: 'ok'; status: JobStatus } | { result: 'lost' } | { result: 'missing' };

/**
 * Why a follow-up was refused.
 *
 * - `missing`      no such job in this organization.
 * - `not_finished` the parent is still queued or running — its run is not over.
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
 * - `stopped`   the row was settled `stopped` in place — it was queued (never started), or it
 *               was running under a lease that has already expired (nobody holds it, so there
 *               is nobody left to deliver to — issue #152); the turn
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
     * The user's stop. A QUEUED row never started, so it is settled `stopped` right here: the
     * turn is over. A RUNNING row whose lease is still live is
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
     */
    session(id: string, leaseToken: string, sessionId: string): Promise<LeaseResult>;
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
     * Ends a running job's attempt. Lease-guarded, like every other worker write. The parking IS
     * the user's stop landing — the row settles `stopped` (terminal, session kept for the follow-up
     * that continues the conversation).
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
     * queued or running is not completed and is excluded whole. Ordering is by the
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

/**
 * The organization is bound at construction: it is a constant for the life of the process, and a
 * per-call parameter is one more thing a write path can forget.
 *
 * `hasWorkspaces` is bound the same way, and it decides whether a claim reports a `workspacePath`
 * at all. Without a configured workspace root no directory was ever created, so naming one would
 * hand the driver a path that does not exist — and `docker run -w` silently CREATES a missing
 * workdir, so the runner would start in an empty directory rather than failing the job. That is
 * exactly the case the driver's null check exists to catch, and it only reaches it if the board is
 * honest here.
 */
export interface CreateJobStoreDeps {
    sql: Sql;
    hasWorkspaces?: boolean;
    orgId: string;
    ready?: Promise<unknown>;
    /**
     * The env-var store's resolver, when the deployment stores runner environment. Present in
     * main.ts, absent in the tests that predate it — a claim then simply carries no `env`. The
     * second parameter is the executor the resolver MUST run on: the claim's own transaction, so
     * a claim holds one connection rather than two (a resolver on the pool would let enough
     * concurrent claims wedge the pool against itself).
     */
    env?: {
        resolveFor(
            target: { userId: string | null; repo: string | null },
            exec: Sql | TransactionSql
        ): Promise<Record<string, string>>;
    };
    /**
     * The GitHub App's installation-token provider, laid under the resolved env as the base layer
     * (`withMintedToken`). Present in main.ts under the App — which is every env-booted process —
     * and absent in the offline tooling and the tests that predate it: a board that cannot fetch
     * mints nothing. Declared inline, like
     * `env`, because `db/` must not import from `github/`. Each claim mints FRESH rather than
     * reading the provider's cache, because the credential has to outlive the claim: a runner's
     * env is written once and a run is capped at two hours, so a cached token's remaining
     * five minutes would die mid-run. A mint failure throws, and the same rollback that guards
     * the resolver leaves the job queued with its attempt unburned.
     */
    githubToken?: {
        fresh(): Promise<string>;
    };
    /**
     * The gates reader, when the deployment has a workspace root to read checkouts from. Declared
     * inline like `env`, because `db/` imports nothing from `workspace/` at runtime — a claim
     * hands it the workspace path, the repo label and the thread's root id (the worktree the run
     * edits), and gets the parsed `.bellows.yaml` or the reason the file could not be honoured.
     * Present in main.ts, absent in the tests that predate gates — a claim then simply carries
     * none.
     */
    gates?: {
        readFor(
            workspacePath: string,
            repo: string,
            worktreeId: string | null
        ): Promise<{ config: BellowsConfig | null; error: string | null }>;
    };
    /**
     * The member executor store's claim-time reader. Declared inline like `env`, because `db/`
     * must not import from `db/user-executor-store.ts`'s surface — the claim needs exactly one
     * question answered: the row the task's executor LABEL names. Its type selects the task's
     * runner and its config travels under that runner's config env name. A reader failure throws,
     * and the same rollback that guards the env resolver leaves the job queued with its attempt
     * unburned.
     */
    executorConfig?: {
        configFor(
            userId: string,
            name: string,
            exec: Sql | TransactionSql
        ): Promise<{ type: string; config: Record<string, unknown> } | null>;
    };
    /**
     * The PR lifecycle store, when the deployment records publications and PR waits (036).
     * Declared inline like `env`, because only the completion surface (the publication upsert),
     * the stop/remove sweep (wait cancellation) and the read model (the thread's wait) touch it —
     * the rest of the job store has no opinion of it. Present in main.ts under `withStores`,
     * absent in the tests that predate it: a verdict then simply records no publication.
     */
    prs?: JobStorePrs;
}

/** The PR lifecycle store's claim-time surface — named once so a helper can take it explicitly. */
export interface JobStorePrs {
    recordPublication(
        input: {
            root: string;
            repo: string;
            prNumber: number;
            prUrl: string;
            headBranch: string;
            baseBranch: string;
        },
        exec?: Sql | TransactionSql
    ): Promise<void>;
    /**
     * The thread's recorded publication, when it has one (036) — the structured PR identity a
     * block-helper claim injects generically (see `resolveClaimHelperPlans`), issue #122's
     * merge-conflict-autofix block being the first consumer. Null on a thread that never
     * published.
     */
    publicationOf(root: string, exec?: Sql | TransactionSql): Promise<PublicationState | null>;
    cancelWaitsForRoot(root: string, terminalReason?: string, exec?: Sql | TransactionSql): Promise<number>;
}

/**
 * What every `JobStore` method function closes over: the connection, the bound org, the
 * precompiled SQL fragments, and the optional collaborators. `createJobStore` builds one and each
 * method is a thin delegation to its function in the sibling `job-store-*.ts` files.
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
