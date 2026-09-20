import type { Fragment, Sql, TransactionSql } from 'postgres';
import type { UserRef } from '@factory-ai/core';
import type { BellowsConfig } from '../workspace/bellows.js';
import { decodeCursor, encodeCursor } from './task-summary.js';
import { type CompletedRun, nextTransition, primarySessionId } from './workflow-engine.js';
import { type ParamValues, type WorkflowDefinition, isPublishNode, nodeOf } from './workflow-schema.js';

export type JobStatus = 'queued' | 'running' | 'standby' | 'succeeded' | 'failed' | 'dead' | 'stopped';
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

/**
 * The key-wise patch one vitals report applies to the stored `runtime` jsonb. Null numbers are
 * "not read this round" — left OUT, so the last good sample stays (the missed-sample rule, now
 * per part) — and a missing `services` key means the fleet half did not change and stays too.
 * `activity`, `sampledAt` and `memPercent` are always written: null is legitimate data for each.
 */
function runtimePatch(runtime: RuntimeVitals): Record<string, unknown> {
    return {
        ...(runtime.cpuPercent !== null ? { cpuPercent: runtime.cpuPercent } : {}),
        ...(runtime.memUsedMb !== null ? { memUsedMb: runtime.memUsedMb } : {}),
        memPercent: runtime.memPercent,
        activity: runtime.activity,
        sampledAt: runtime.sampledAt,
        ...(runtime.services ? { services: runtime.services } : {}),
    };
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
    /**
     * The Remote Control session claude.ai addresses this run by (`cse_…`), once the bridge has
     * connected and the driver has read it back. Null for every headless job.
     */
    remoteSessionId: string | null;
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
     * was stamped with. Grouping metadata for the tasks chat, nullable for every job that predates
     * it; neither is validated against the member's configured rows and neither changes what a
     * worker runs. See docs/jobs.md.
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
}

/** What a worker gets back from a successful claim. The lease token is its proof for later. */
export interface Claim {
    id: string;
    command: string;
    attempts: number;
    leaseToken: string;
    leaseExpiresAt: string;
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
             * When the task runs a workflow: the resolved workflow — the id, the ENTRY node the
             * thread's first run walks, the definition SNAPSHOT frozen onto the root row, and the
             * validated launch parameter values (`{{param.*}}` resolves from them on every row of
             * the thread). The route validates the values against the definition's declarations
             * before calling; the store freezes them as given. Null when no workflow resolved,
             * which is the ordinary create and behaves exactly as it did before 027.
             */
            workflow?: { id: string; node: string; snapshot: WorkflowDefinition; params: ParamValues } | null;
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
     * The thread's labels and session are ALL the parent's, taken from the row and never from a
     * body: an adjustment continues the run it adjusts, on the executor that ran it — a
     * conversation switching executors mid-thread is exactly the cross-CLI resume the driver
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

interface JobRow {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    max_attempts: number;
    claimed_by: string | null;
    created_by: string | null;
    /** The authorship joins (see authorJoin): app_user labels for created_by/stopped_by/done_by. */
    creator_id: string | null;
    creator_login: string | null;
    creator_name: string | null;
    creator_avatar_url: string | null;
    stopper_id: string | null;
    stopper_login: string | null;
    stopper_name: string | null;
    stopper_avatar_url: string | null;
    doner_id: string | null;
    doner_login: string | null;
    doner_name: string | null;
    doner_avatar_url: string | null;
    stopped_by: string | null;
    done_by: string | null;
    session_id: string | null;
    remote_session_id: string | null;
    exit_code: number | null;
    output?: string | null;
    /** Absent from reads before 028 filled it; null is unmeasured, never empty. */
    summary?: string | null;
    /** Absent from the list() select — a list view shows no checks, and bounded is not free. */
    gates?: GateReport[] | null;
    /**
     * On list() rows: the vitals object is a few hundred bytes, and the task tree and the tab
     * strip render `runtime.activity` as the task's live summary — the tabs' "what is it doing"
     * answer. Unlike `output`, whose unbounded tail would tank every poll for a line no list view
     * draws.
     */
    runtime?: RuntimeVitals | null;
    repo: string | null;
    executor: string | null;
    parent_job_id: string | null;
    root_job_id: string;
    /** The row's graph position (027); null on workflow-less rows and user follow-ups. */
    workflow_node: string | null;
    done_at: Date | null;
    cancel_requested_at: Date | null;
    command_delivered_at: Date | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
    /** Selected by every read (the list and detail serve it); bigint reads back as a string. */
    wall_clock_ms?: string | null;
    /** Only thread() and the grouped terminal list select it; bigint (and the sum over it) read
     * back as a string. */
    task_wall_clock_ms?: string | null;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * One row of the task summary read — the `task` CTE's projection. Page rows arrive as parsed
 * postgres rows (timestamps as Date); the navigation previews arrive inside json, where the same
 * columns read back as strings — every stamp is accepted in either shape.
 */
interface TaskRow {
    id: string;
    command: string;
    repo: string | null;
    executor: string | null;
    created_at: Date | string;
    status: JobStatus;
    done_at: Date | string | null;
    cancel_requested_at: Date | string | null;
    summary: string | null;
    runtime: RuntimeVitals | null;
    activity_at: Date | string;
    creator_id: string | null;
    creator_login: string | null;
    creator_name: string | null;
    creator_avatar_url: string | null;
}

/** A stamp from either engine: a parsed Date from the row, an ISO string out of the json. */
const stampOf = (value: Date | string | null): string | null =>
    value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * Lays the minted installation token under the claim's stacked environment, in one place and pure
 * — the `stackEnv` precedent: a rule this load-bearing is pinned by the offline suite, which cannot
 * reach the claim that runs it.
 *
 * The mint is the BASE layer. A `GITHUB_TOKEN` configured in any env scope (org, workspace, repo)
 * wins over it, because that value is something an operator deliberately chose and silently
 * replacing a credential with a different one is a failure nobody notices; the mint fills only the
 * gap. No mint (the offline tooling builds no provider) changes nothing at all, so a board that
 * cannot fetch still reads exactly as it did.
 */
export function withMintedToken(
    minted: string | undefined,
    resolved: Record<string, string> | undefined
): Record<string, string> | undefined {
    if (minted === undefined) return resolved;
    return { GITHUB_TOKEN: minted, ...resolved };
}

/**
 * The branch-ingest credential's verifier, and the ONE job query in this module that is org-less —
 * deliberately, because its whole purpose is to say which org a request is speaking for: the
 * runner's reporter presents the job it claimed and that attempt's lease token, and the pair's
 * answer IS the org. `createJobStore` binds the org at construction; this resolver must run before
 * any org is known, which is why it is a factory of its own and not a store method.
 *
 * No status filter, but nothing unbounded either. The reporter's final `--once` sample lands
 * seconds after the verdict, and `complete` retains the lease token for exactly that reason (the
 * only settle point that does — dead and suspend clear theirs, because those attempts end without
 * a verdict whose tail matters). The pair is attempt-scoped regardless: a reclaim rotates the
 * token on the row (`gen_random_uuid`), so a superseded attempt's pair stops resolving the moment
 * the job is handed to its replacement and cannot write into the winner's org.
 *
 * Two bounds keep retention honest. The pair resolves from the job row alone — no membership
 * join, because the runner is not a person — so a pair captured from a runner's env would
 * otherwise outlive its author's removal from the org indefinitely: nothing prunes completed
 * jobs, and a claimed-but-never-settled row would keep resolving forever too. So a finished job
 * resolves only within an hour of the verdict (the tail sample needs seconds; this has orders of
 * magnitude to spare), and an UNFINISHED job resolves only while its lease is live — a lease that
 * expired without a reclaim is a run that died, and its captured pair dies with it.
 */
export const LEASE_TAIL_GRACE = '1 hour';

export function createOrgOfLease({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown>;
}): (jobId: string, leaseToken: string) => Promise<string | null> {
    return async (jobId, leaseToken) => {
        if (ready) await ready;
        const rows = await sql<{ org_id: string }[]>`
            select org_id from job
            where id = ${jobId} and lease_token = ${leaseToken}
              and (
                  (finished_at is not null and finished_at > now() - ${LEASE_TAIL_GRACE}::interval)
                  or
                  (finished_at is null and lease_expires_at > now())
              )
        `;
        return rows[0]?.org_id ?? null;
    };
}

/**
 * Two more org-less resolvers beside `createOrgOfLease`, for the worker routes under the shared
 * board secret: the secret authenticates the DRIVER, so the org a call operates on is read from
 * the row its URL names — the job for the `/api/jobs/:id/…` routes, the queued worktree removal
 * for the reclaim ack. Unbounded by lease or status, unlike the pair above: the secret already
 * answered the authorization question, and this is routing — a heartbeat on a finished job must
 * still find its board to answer 404 through.
 */
export function createOrgOfJob({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown>;
}): (jobId: string) => Promise<string | null> {
    return async (jobId) => {
        if (ready) await ready;
        const rows = await sql<{ org_id: string }[]>`select org_id from job where id = ${jobId}`;
        return rows[0]?.org_id ?? null;
    };
}

export function createOrgOfReclaim({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown>;
}): (reclaimId: string) => Promise<string | null> {
    return async (reclaimId) => {
        if (ready) await ready;
        const rows = await sql<{ org_id: string }[]>`select org_id from task_reclaim where id = ${reclaimId}`;
        return rows[0]?.org_id ?? null;
    };
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
export function createJobStore({
    sql,
    orgId,
    hasWorkspaces = true,
    ready,
    env,
    githubToken,
    gates: gatesReader,
    executorConfig,
}: {
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
     * The member executor store's claim-time reader, when the deployment stores executor
     * configuration. Declared inline like `env`, because `db/` must not import from
     * `db/user-executor-store.ts`'s surface — the claim needs exactly one question answered: the
     * row the task's executor LABEL names, with the config the member pasted. Only an `opencode`-type
     * row is applied — its config travels as `OPENCODE_CONFIG_CONTENT`, the env name opencode
     * merges over its baked configuration (verified against the pinned runner image), which is how
     * the member's model and provider choice reach the run. A `claude-code` row has no consumer
     * yet and is read only to be skipped. A reader failure throws, and the same rollback that
     * guards the env resolver leaves the job queued with its attempt unburned.
     */
    executorConfig?: {
        configFor(
            userId: string,
            name: string,
            exec: Sql | TransactionSql
        ): Promise<{ type: string; config: Record<string, unknown> } | null>;
    };
}): JobStore {
    const gate = async () => {
        if (ready) await ready;
    };

    // The wall-clock banking, shared by every settle point that ends (or supersedes) an executed
    // segment: add the segment `started_at → now()` to what the row has banked. Built from the
    // pool handle and used inside transactions, like the claim's sameThreadRunning fragment. The
    // SET expression reads the PRE-update row, so it composes beside `started_at = now()` in the
    // claim — the superseded segment is banked in the same statement that resets the stamp,
    // which is the only moment it can be. `greatest` ignores nulls, so a row that never started
    // measures zero, and a clock never runs backwards.
    const wallTick = sql`coalesce(wall_clock_ms, 0) + greatest(0, (extract(epoch from (now() - started_at)) * 1000)::bigint)`;

    // Inside the factory, so the reads' `workspacePath` derivation closes over the org and the
    // has-a-workspace-root decision — the claim's own `claimPath` rule, shared rather than copied.

    // The authorship joins, shared by get/thread/list: created_by, stopped_by and done_by resolve
    // to app_user labels at read time, never denormalised onto the job row (logins and display
    // names go stale; the join does not). Left joins on nullable uuids — a pre-accounts row or an
    // unstamped action joins to nothing and reads as null, never a synthetic author. `job.` is
    // qualified on the columns app_user also has (id, created_at); every other selected column
    // exists only on job.
    const authorJoin = sql`
        left join app_user cu on cu.id = job.created_by
        left join app_user su on su.id = job.stopped_by
        left join app_user du on du.id = job.done_by
    `;
    const authorColumns = sql`
        , cu.id as creator_id, cu.github_login as creator_login, cu.display_name as creator_name
        , cu.avatar_url as creator_avatar_url
        , su.id as stopper_id, su.github_login as stopper_login, su.display_name as stopper_name
        , su.avatar_url as stopper_avatar_url
        , du.id as doner_id, du.github_login as doner_login, du.display_name as doner_name
        , du.avatar_url as doner_avatar_url
    `;

    // The task summary's columns once the `task` CTE has named them — selected again inside every
    // navigation-preview and page subquery, which read the derived set rather than the tables.
    const taskPreviewColumns = sql`
        id, command, repo, executor, created_at, status, done_at, cancel_requested_at,
        summary, runtime, activity_at, creator_id, creator_login, creator_name, creator_avatar_url
    `;

    // A left join answers null columns when the uuid matched nothing; a matched row always has
    // its login (not null in app_user), so id+login is the honest presence test.
    const userRef = (
        id: string | null,
        login: string | null,
        name: string | null,
        avatarUrl: string | null
    ): UserRef | null => (id === null || login === null ? null : { id, login, name, avatarUrl });

    const toJob = (row: JobRow): Job => ({
        id: row.id,
        command: row.command,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        claimedBy: row.claimed_by,
        createdBy: row.created_by,
        author: userRef(row.creator_id, row.creator_login, row.creator_name, row.creator_avatar_url),
        stoppedBy: userRef(row.stopper_id, row.stopper_login, row.stopper_name, row.stopper_avatar_url),
        doneBy: userRef(row.doner_id, row.doner_login, row.doner_name, row.doner_avatar_url),
        sessionId: row.session_id,
        remoteSessionId: row.remote_session_id,
        exitCode: row.exit_code,
        output: row.output ?? null,
        summary: row.summary ?? null,
        gates: row.gates ?? null,
        runtime: row.runtime ?? null,
        repo: row.repo,
        executor: row.executor,
        followUpTo: row.parent_job_id,
        rootJobId: row.root_job_id,
        workflowNode: row.workflow_node ?? null,
        doneAt: iso(row.done_at),
        cancelRequestedAt: iso(row.cancel_requested_at),
        // The claim builds the same path only for jobs it hands out; every read carries it too,
        // which is what the task view's status sidebar shows.
        workspacePath: hasWorkspaces && row.created_by ? `${orgId}/${row.created_by}` : null,
        createdAt: row.created_at.toISOString(),
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        wallClockMs: row.wall_clock_ms == null ? null : Number(row.wall_clock_ms),
        taskWallClockMs: row.task_wall_clock_ms == null ? null : Number(row.task_wall_clock_ms),
    });

    // The task summary mapper. Deliberately NOT toJob with synthetic fields: a summary is a
    // different shape with a different contract — bounded fields only, run detail (output, gates,
    // the runtime object, session ids) left behind, and the head's activity line carried alone.
    const toTask = (row: TaskRow): TaskSummary => ({
        id: row.id,
        command: row.command,
        status: row.status,
        cancelRequestedAt: stampOf(row.cancel_requested_at),
        doneAt: stampOf(row.done_at),
        repo: row.repo,
        executor: row.executor,
        author: userRef(row.creator_id, row.creator_login, row.creator_name, row.creator_avatar_url),
        activity: row.runtime?.activity ?? null,
        summary: row.summary,
        // Both are NOT NULL in the schema — created_at by the column, activity_at through
        // greatest() with created_at in it.
        createdAt: stampOf(row.created_at)!,
        activityAt: stampOf(row.activity_at)!,
    });

    return {
        async create(command, createdBy, target) {
            await gate();
            // id and root_job_id are the SAME uuid, computed once in the select so the column can
            // be not null from insert — the root's root is itself (022). The workflow triple rides
            // the same insert when a workflow resolved: workflow_id names what the task walks,
            // workflow_node is the entry the first run carries, the snapshot freezes the graph onto
            // the root — where every transition decision reads it — and workflow_params freezes the
            // validated launch values beside it (030). All null on a workflow-less create,
            // byte-identical to the pre-027 insert.
            const rows = await sql<{ id: string }[]>`
                insert into job (org_id, command, created_by, repo, executor, id, root_job_id, workflow_id, workflow_node, workflow_snapshot, workflow_params)
                select ${orgId}, ${command}, ${createdBy}, ${target.repo}, ${target.executor}, x, x,
                       ${target.workflow?.id ?? null},
                       ${target.workflow?.node ?? null},
                       ${target.workflow ? sql.json(target.workflow.snapshot as never) : null},
                       ${target.workflow ? sql.json(target.workflow.params as never) : null}
                from (select gen_random_uuid() as x) s
                returning id
            `;
            return { id: rows[0]!.id };
        },

        async createFollowUp(parentId, command, createdBy) {
            await gate();
            // One conditional insert: the select carries every precondition (finished, not done,
            // has a session, same org), so a follow-up can never land on a parent that fails one.
            // The select also takes the parent row's lock, which is what makes a racing markDone
            // impossible to answer from a stale snapshot: under READ COMMITTED, whichever statement
            // gets the lock second re-checks the qualifications against the row's newest committed
            // version — a done parent yields no row and the read below answers task_done, never a
            // done task with queued follow-up work. The author predicate is null-safe (`is not
            // distinct from`): a null caller may only follow up a parent with no author — the
            // state every pre-accounts task is in — and an authored parent refuses a caller with
            // no account, which is the read below's forbidden answer. The session ids AND the
            // executor are copied at insert, which is what makes the claim resume the parent
            // conversation, on the executor that ran it, without any new claim-side rule. The
            // parent's root_job_id comes across with them — the child joins the SAME conversation
            // (022), whether its parent is a root or a mid-chain turn.
            //
            // WHICH session: a pre-workflow thread copies the PARENT's session — the newest run's,
            // the conversation chaining forward exactly as it always has. A workflow thread copies
            // its PRIMARY session — the first `resume`-policy run's, read off the root's snapshot
            // (design.md Decision 3): the newest row of a workflow thread is often a fresh-eyes
            // review, whose session is a side branch, and a follow-up must continue the thread,
            // not the branch. The coalesce answers the parent's session when no resume run has
            // reported one yet, so the refusal shape below never changes.
            const rows = await sql<{ id: string }[]>`
                with parent as (
                    select id, repo, executor, session_id, remote_session_id, root_job_id
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
                insert into job (org_id, command, created_by, repo, executor, parent_job_id, session_id, remote_session_id, root_job_id)
                select ${orgId}, ${command}, ${createdBy}, parent.repo, parent.executor, parent.id,
                       coalesce(primary_session.session_id, parent.session_id),
                       coalesce(primary_session.remote_session_id, parent.remote_session_id),
                       parent.root_job_id
                from parent, root, primary_session
                returning id
            `;
            if (rows[0]) return { id: rows[0]!.id };
            // Nothing inserted — one of the five preconditions failed, and which one decides the
            // answer the route turns into a status code. Forbidden is last: a sessionless parent
            // answers the truer no_session whoever asks, and a parent with no author falls through
            // the author check rather than refusing.
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
        },

        async markDone(id, doneBy) {
            await gate();
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
                // The thread is one indexed read off the root column (022), and the ROOT row
                // carries the labels the reclaim is addressed by — the same fields removeThread
                // queues. Terminal only: a member still queued, parked or running keeps the tree
                // (its verdict will reclaim); one member done (this one, usually — the UI marks
                // the head) is what makes the done a THREAD's done and not one turn's.
                const [thread] = await tx<{ total: number; terminal: number }[]>`
                    select count(*)::int as total,
                           count(*) filter (where status in ('succeeded','failed','dead','stopped'))::int as terminal
                    from job
                    where org_id = ${orgId} and root_job_id = ${row.root_job_id}
                `;
                if (thread && thread.total > 0 && thread.total === thread.terminal) {
                    const [root] = await tx<{ repo: string | null; created_by: string | null }[]>`
                        select repo, created_by from job
                        where org_id = ${orgId} and id = ${row.root_job_id}
                    `;
                    const workspacePath = hasWorkspaces && root?.created_by ? `${orgId}/${root.created_by}` : null;
                    // Idempotent against a row already queued (an earlier done, or a concurrent
                    // one): one tree, one reclaim. The claim-ack cycle removes the row; until
                    // then a duplicate insert would only re-offer an already-removed tree, so
                    // the guard is tidiness, not correctness.
                    await tx`
                        insert into task_reclaim (org_id, root_job_id, repo, workspace_path)
                        select ${orgId}, ${row.root_job_id}, ${root?.repo ?? null}, ${workspacePath}
                        where not exists (
                            select 1 from task_reclaim
                            where org_id = ${orgId} and root_job_id = ${row.root_job_id}
                        )
                    `;
                }
                return { status: row.status, doneAt: row.done_at.toISOString() };
            });
        },

        async stop(id, stoppedBy) {
            await gate();
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
            const rows = await sql<{ status: JobStatus; cancel_requested_at: Date | null }[]>`
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
                returning status, cancel_requested_at
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
            return row.cancel_requested_at !== null
                ? { result: 'requested', cancelRequestedAt: row.cancel_requested_at.toISOString() }
                : { result: 'stopped' };
        },

        async claim(worker, leaseSeconds) {
            await gate();

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
            return sql.begin(async (tx) => {
                // Retire what has burned its attempts, before looking for work. Without this a
                // command that kills its worker is reclaimed every time its lease expires, forever.
                // The dead attempt's segment banks here: the row ran for real before its worker
                // went quiet, and the retirement must not erase it. A stamped row never reaches
                // this sweep — the settle above has already landed it `stopped`, which is the
                // verdict a stop is (issue #152): dead is for attempts that failed on their own.
                await tx`
                    update job set status = 'dead', finished_at = now(), lease_token = null,
                                   wall_clock_ms = ${wallTick}
                    where org_id = ${orgId} and status = 'running'
                      and lease_expires_at <= now() and attempts >= max_attempts
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
                            wall_clock_ms    = case when started_at is null then wall_clock_ms else ${wallTick} end,
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
                    // as the base layer, and its failure rolls back exactly the same way.
                    const resolvedEnv = env
                        ? await env.resolveFor({ userId: row.created_by, repo: row.repo }, tx)
                        : undefined;
                    // The mint fills only the gap: when the stacked env already carries a
                    // GITHUB_TOKEN, the mint would be discarded — so it is not made at all, rather
                    // than spend a GitHub call and leave a live token nothing holds.
                    let claimEnv =
                        githubToken && resolvedEnv?.GITHUB_TOKEN === undefined
                            ? withMintedToken(await githubToken.fresh(), resolvedEnv)
                            : resolvedEnv;
                    // The executor label a task was queued with names a row in the AUTHOR's own
                    // executor list (docs/workspace.md), and for an opencode row the pasted config
                    // IS the run's model and provider choice. It rides the claim env under the
                    // name opencode merges over its baked configuration, applied LAST so the
                    // synthesized value wins a collision with a member env var — the name is
                    // reserved at PUT besides. A label matching nothing — an executor deleted
                    // after the task was queued, or free text typed into the chat — runs exactly
                    // as an unlabelled job always has; so does a claude-code row, which has no
                    // consumer yet. A row whose config is not an object is skipped for the same
                    // availability reason the resolver failure is NOT: refusing the claim would
                    // retry a broken row forever.
                    if (executorConfig && row.executor !== null && row.created_by !== null) {
                        const configured = await executorConfig.configFor(row.created_by, row.executor, tx);
                        const member = configured?.config;
                        if (
                            configured?.type === 'opencode' &&
                            member !== null &&
                            typeof member === 'object' &&
                            !Array.isArray(member)
                        ) {
                            // `permission` is the runner's fence, baked into the image and patched
                            // by its entrypoint — the one key the member does not get to set: a
                            // pasted `external_directory: allow` would open every member's tree
                            // to this run. Everything else travels verbatim.
                            const { permission: _fence, ...rest } = member;
                            claimEnv = { ...(claimEnv ?? {}), OPENCODE_CONFIG_CONTENT: JSON.stringify(rest) };
                        }
                    }
                    // Read off the filesystem, inside the claim but OFF the transaction's tables: a
                    // broken `.bellows.yaml` travels to the driver as `gateError` — the job fails at
                    // the worker with the reason, where the run's author can see it — rather than as
                    // a 503 that would retry the claim forever. Gates ride only when the job has both
                    // a repo label (the checkout the file lives in) and a workspace to read it from.
                    // The reader is handed the thread root, because the worktree the run edits — and
                    // the gates file it must satisfy — is keyed by it.
                    let claimGates: BellowsConfig | null = null;
                    let gateError: string | null = null;
                    const claimPath = hasWorkspaces && row.created_by ? `${orgId}/${row.created_by}` : null;
                    if (gatesReader && row.repo && claimPath) {
                        const read = await gatesReader.readFor(claimPath, row.repo, rootJobId);
                        if (read.error) gateError = read.error;
                        else claimGates = read.config;
                    }

                    /*
                     * The workflow read: the graph's per-node decisions, computed off the ROOT row's
                     * snapshot. `publish` is the board's answer to "may this run push" — true only
                     * out of a publish node, false on every other workflow node, and ABSENT (the
                     * field simply not sent) on a workflow-less row, which the driver reads as
                     * "publish": the exact behavior before 027, so no-workflow claims stay
                     * byte-identical. A node may also opt its run out of the gates — a fresh-eyes
                     * review need not pay suite minutes, and must not fail the thread on a gate it
                     * did not touch — in which case neither gates nor a gate error ride the claim.
                     */
                    let publish: boolean | undefined;
                    if (row.workflow_node !== null) {
                        const [root] = await tx<{ workflow_snapshot: WorkflowDefinition | null }[]>`
                            select workflow_snapshot from job
                            where org_id = ${orgId} and id = ${rootJobId}
                        `;
                        const snapshot = root?.workflow_snapshot ?? null;
                        if (snapshot === null) {
                            // A node without a snapshot cannot happen on a live thread (the
                            // transition insert always copies the id and the root carries the
                            // snapshot); answering "do not publish" is the safe arm of the branch.
                            publish = false;
                        } else {
                            publish = isPublishNode(snapshot, row.workflow_node);
                            if (nodeOf(snapshot, row.workflow_node)?.gates === false) {
                                claimGates = null;
                                gateError = null;
                            }
                        }
                    }
                    return {
                        id: row.id,
                        command: row.command,
                        attempts: row.attempts,
                        leaseToken: row.lease_token,
                        leaseExpiresAt: row.lease_expires_at.toISOString(),
                        userId: row.created_by,
                        // Built here rather than in the route, because this is where the org is bound. Null
                        // for an unattributed job — no member, so no workspace — and null when this
                        // deployment has no workspace root, where no directory exists to point at.
                        workspacePath: claimPath,
                        rootJobId,
                        // Survived the case above, so this claim is a resume.
                        resumeSessionId: row.session_id,
                        followUp: row.follow_up,
                        ...(claimEnv ? { env: claimEnv } : {}),
                        ...(row.repo !== null ? { repo: row.repo } : {}),
                        ...(claimGates || gateError ? { gates: claimGates, gateError: gateError } : {}),
                        ...(publish !== undefined ? { publish } : {}),
                    };
                }
            });
        },

        async heartbeat(id, leaseToken, leaseSeconds) {
            await gate();
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
        },

        async session(id, leaseToken, sessionId, remoteSessionId) {
            await gate();
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
        },

        async progress(id, leaseToken, output, runtime: RuntimeVitals | null = null) {
            await gate();
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
        },

        async gates(id, leaseToken, results) {
            await gate();
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
        },

        async rereadGates(id, leaseToken) {
            await gate();
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
            const workspacePath = hasWorkspaces && row.created_by ? `${orgId}/${row.created_by}` : null;
            if (!gatesReader || !row.repo || !workspacePath) {
                return { result: 'ok', gates: null, gateError: null };
            }
            // The worktree the run edits is keyed by the thread's root, not by this row — the
            // column read (022) answers for it directly.
            const read = await gatesReader.readFor(workspacePath, row.repo, row.root_job_id);
            return { result: 'ok', gates: read.config, gateError: read.error };
        },

        async publishToken(id, leaseToken) {
            await gate();
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
        },

        async suspend(id, leaseToken) {
            await gate();
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
        },

        async removeThread(id, removedBy) {
            await gate();
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
                if (members.some((member) => member.status === 'running')) return 'conflict';

                // The rows are gone for good — nothing joins through job.id at claim time (the
                // claim copies its session labels onto its own row), so deleting the audit trail is
                // the removal, not a cleanup that orphans something.
                await tx`
                    delete from job
                    where org_id = ${orgId} and id = any(${members.map((m) => m.id)})
                `;

                // Queue the worktree reclaim. The driver polls this queue — nothing is holding a
                // lease on a removed thread, so no live driver would ever notice the deletion
                // otherwise — and takes the tree down, acking the row when it has. Same relative
                // path the claim derives, empty labels included: a tree keyed only on the root id
                // still gets reclaimed, pointing at nothing additional is fine.
                const workspacePath = hasWorkspaces && root.created_by ? `${orgId}/${root.created_by}` : null;
                await tx`
                    insert into task_reclaim (org_id, root_job_id, repo, workspace_path, removed_by)
                    values (${orgId}, ${rootJobId}, ${root.repo}, ${workspacePath}, ${removedBy})
                `;

                return { result: 'ok', rootJobId, repo: root.repo, workspacePath };
            });
        },

        async claimReclaim(worker, leaseSeconds) {
            await gate();
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
        },

        async ackReclaim(id, worker) {
            await gate();
            // The claim's worker only, and the row id the claim handed back is the whole proof — a
            // reclaim's lease token IS its id. A foreign ack is refused rather than deleting a
            // row somebody else's driver is mid-reclaim on.
            const rows = await sql<{ id: string }[]>`
                delete from task_reclaim
                where org_id = ${orgId} and id = ${id} and claimed_by = ${worker}
                returning id
            `;
            if (rows[0]) return 'ok';
            const present = await sql<
                { id: string }[]
            >`select id from task_reclaim where org_id = ${orgId} and id = ${id}`;
            return present[0] ? 'lost' : 'missing';
        },

        async complete(
            id,
            leaseToken,
            { status, exitCode, output, contextTokens, contextCostUsd, agentTurns, summary }
        ) {
            await gate();
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
            // One transaction, because the terminality answer must describe the thread AS THE
            // VERDICT lands: the walk below runs on the same connection, where the just-updated
            // row's new status is visible and no follow-up inserted after the commit can be.
            return sql.begin(async (tx) => {
                const rows = await tx<{ id: string; root_job_id: string }[]>`
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
                        -- The close-time turn count: a number lands, and an absent one overwrites
                        -- to null — the report is the attempt's whole verdict, and a retried
                        -- report that lost its read must not inherit the killed attempt's count.
                        agent_turns = ${typeof agentTurns === 'number' ? agentTurns : null},
                        -- The close-time summary, same overwrite rule: the verdict replaces
                        -- whatever the attempt left, it never merges with one.
                        summary = ${typeof summary === 'string' ? summary : null},
                        runtime     = ${context === null ? sql`runtime` : sql`coalesce(runtime, '{}'::jsonb) || ${context}`}
                    where org_id = ${orgId} and id = ${id}
                      and status = 'running' and lease_token = ${leaseToken}
                    returning id, root_job_id
                `;
                if (!rows[0]) {
                    // A report from a worker whose lease was reclaimed is refused, not merged: the
                    // job is someone else's now, and the two runs did different work.
                    return { result: (await exists(sql, orgId, id)) ? 'lost' : 'missing' };
                }
                const completedId = rows[0]!.id;
                const rootJobId = rows[0]!.root_job_id;

                /*
                 * The workflow transition, when this thread walks a graph — decided HERE, in the
                 * verdict's transaction (docs/workflows.md): the driver reports one verdict and the
                 * board inserts the next row, or rests the thread. A workflow-less thread has no
                 * snapshot on its root and skips all of this: its completes behave byte-identically
                 * to before 027.
                 */
                const [root] = await tx<
                    {
                        workflow_id: string | null;
                        workflow_snapshot: WorkflowDefinition | null;
                        workflow_params: ParamValues | null;
                        command: string;
                        created_by: string | null;
                        repo: string | null;
                    }[]
                >`
                    select workflow_id, workflow_snapshot, workflow_params, command, created_by, repo from job
                    where org_id = ${orgId} and id = ${rootJobId}
                `;
                if (root?.workflow_snapshot) {
                    // The same per-root advisory lock the claim takes: a transition insert must not
                    // interleave with a claim's select-lock-claim of this thread, or two rows of
                    // one thread could end up claimed against the one-worktree guarantee.
                    await tx`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;

                    // The whole thread, oldest first — the audit trail the decision derives from:
                    // loop counts are row counts per node (dead rows included), the halted node is
                    // the newest carried node, the primary session is the first resume run's, and
                    // the placeholder tails are prior rows' stored outputs.
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
                    // The completed row's stored state: the UPDATE above just landed the verdict
                    // columns, so `gates` and `output` here are THIS run's — what the edge rules
                    // evaluate against (gate-failed reads the stored reports; markers read the tail).
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
                        // The launch values frozen on the root (030): `{{param.*}}` resolves from
                        // them on every row of the thread, and `{{command}}` from the root's own
                        // command — for a workflow thread, the interpolated entry prompt.
                        params: root.workflow_params ?? {},
                        command: root.command,
                        rows: engineRows,
                        completed: completedRun,
                    });
                    if (transition.action === 'insert') {
                        // A resume node carries the thread's PRIMARY session from insert (design.md
                        // Decision 3); a fresh node carries none and mints its own at claim. The
                        // row is an ordinary queued job: the driver claims it through the existing
                        // lease/fence machinery, `max_attempts` governing it individually.
                        const session =
                            transition.session === 'resume'
                                ? primarySessionId(root.workflow_snapshot, engineRows)
                                : null;
                        await tx`
                            insert into job (org_id, command, created_by, repo, executor, parent_job_id, session_id, root_job_id, workflow_id, workflow_node)
                            values (${orgId}, ${transition.command}, ${root.created_by}, ${completed?.repo ?? root.repo},
                                    ${completed?.executor ?? null}, ${completedId}, ${session}, ${rootJobId},
                                    ${root.workflow_id}, ${transition.node.name})
                        `;
                    }
                    // `rest` lands nothing: an exhausted loop, an unmatched verdict or marker
                    // absence leaves the thread where the run ended — visible and follow-up-able,
                    // never silently continued (docs/workflows.md).
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
        },

        async thread(id) {
            await gate();
            // The named row's root_job_id is the whole resolution (022): every member of the
            // conversation carries the same value, so the chain is one indexed read, oldest
            // first. If two adjustments ever landed on one parent, both come back in creation
            // order — the conversation still reads top to bottom. An absent id resolves nothing
            // and the read answers null.
            const rows = await sql<JobRow[]>`
                select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
                       session_id, remote_session_id, exit_code, output, gates, runtime, repo, executor,
                       parent_job_id, root_job_id, workflow_node, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
                       -- The task's overall wall clock, summed over the thread the WHERE already
                       -- scoped: every member carries the total, so the view reads it off any of
                       -- them. A sum over all-null banks is null — nothing measurable, never zero.
                       sum(wall_clock_ms) over () as task_wall_clock_ms,
                       wall_clock_ms, summary
                       ${authorColumns}
                from job ${authorJoin}
                where org_id = ${orgId}
                  and root_job_id = (select root_job_id from job where org_id = ${orgId} and id = ${id})
                order by job.created_at, job.id
            `;
            const [first] = rows;
            return first ? rows.map(toJob) : null;
        },

        async get(id) {
            await gate();
            const rows = await sql<JobRow[]>`
                select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
                       session_id, remote_session_id, exit_code, output, gates, runtime, repo, executor,
                       parent_job_id, root_job_id, workflow_node, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
                       summary, wall_clock_ms
                       ${authorColumns}
                from job ${authorJoin}
                where org_id = ${orgId} and job.id = ${id}
            `;
            const row = rows[0];
            return row ? toJob(row) : null;
        },

        async list({ status, repo, limit }) {
            await gate();
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
                           job.workflow_node as workflow_node,
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
                return rows.map(toJob);
            }
            const rows = await sql<JobRow[]>`
                select job.id, command, status, attempts, max_attempts, claimed_by, created_by,
                       session_id, remote_session_id, exit_code, runtime, repo, executor,
                       parent_job_id, root_job_id, done_at, cancel_requested_at, job.created_at, started_at, finished_at,
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
            return rows.map(toJob);
        },

        async listTasks(filters) {
            await gate();
            // The route already refused cursors that do not decode under the handed filters; a
            // store call that carries one anyway is a programming error, thrown rather than
            // answered with a page of a different question.
            const cursor = filters.cursor === undefined ? null : decodeCursor(filters.cursor, filters);
            if (filters.cursor !== undefined && cursor === null) throw new Error('invalid task cursor');
            const newest = filters.sort === 'newest';

            // One statement, one derived set. `head` resolves each thread's newest run exactly as
            // the sidenav's chainHead does (created desc, id desc); `task` keeps one row per ROOT
            // — the root row for identity and authorship, the head for the present tense — and
            // computes the bucket and the activity stamp once, so the state filter, the counts
            // and the previews cannot disagree. Navigation reads the set UNFILTERED (org-wide,
            // rule of the read model); the page reads it under every filter, paginated by keyset
            // on (activity_at, id) — direction flips with the sort, never an OFFSET.
            const stateWhere = {
                attention: sql`not (terminal and done_at is not null)`,
                running: sql`not terminal`,
                review: sql`terminal and done_at is null`,
                past: sql`terminal and done_at is not null`,
            }[filters.state];
            const pageOrder = newest ? sql`activity_at desc, id desc` : sql`activity_at asc, id asc`;
            const cursorWhere =
                cursor === null
                    ? sql``
                    : newest
                      ? sql`and (activity_at, id) < (${cursor.activityAt}::timestamptz, ${cursor.rootId}::uuid)`
                      : sql`and (activity_at, id) > (${cursor.activityAt}::timestamptz, ${cursor.rootId}::uuid)`;

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
                           (h.status in ('succeeded', 'failed', 'dead', 'stopped')) as terminal,
                           cu.id as creator_id, cu.github_login as creator_login,
                           cu.display_name as creator_name, cu.avatar_url as creator_avatar_url
                    from head h
                    join job r on r.org_id = ${orgId} and r.id = h.root_job_id
                    left join app_user cu on cu.id = r.created_by
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
                                ${filters.q === undefined ? sql`` : sql`and strpos(lower(command), lower(${filters.q})) > 0`}
                                ${filters.repo === undefined ? sql`` : sql`and repo = ${filters.repo}`}
                                ${filters.author === undefined ? sql`` : sql`and lower(creator_login) = lower(${filters.author})`}
                                ${cursorWhere}
                              order by ${pageOrder}
                              limit ${filters.limit + 1}) p
                    ) as page
            `;

            // Fetch limit + 1: the extra row is the only honest nextCursor signal — a page filled
            // exactly is not — and the cursor is minted from the last row RETURNED.
            const pageRows = (row?.page ?? []).map(toTask);
            const items = pageRows.slice(0, filters.limit);
            const last = items[items.length - 1];
            return {
                navigation: {
                    counts: row?.counts ?? { running: 0, review: 0, past: 0 },
                    running: (row?.running_preview ?? []).map(toTask),
                    review: (row?.review_preview ?? []).map(toTask),
                },
                page: {
                    items,
                    nextCursor:
                        pageRows.length > filters.limit && last !== undefined
                            ? encodeCursor({
                                  sort: filters.sort,
                                  state: filters.state,
                                  q: filters.q,
                                  repo: filters.repo,
                                  author: filters.author,
                                  activityAt: last.activityAt,
                                  rootId: last.id,
                              })
                            : null,
                },
            };
        },
    };
}

/** Separates "no such job" from "the lease is not yours" once a guarded update matched nothing. */
async function exists(sql: Sql, orgId: string, id: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`select id from job where org_id = ${orgId} and id = ${id}`;
    return rows.length > 0;
}
