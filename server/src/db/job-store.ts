import type { Fragment, Sql, TransactionSql } from 'postgres';
import type { BellowsConfig } from '../workspace/bellows.js';

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
     * When the user declared the task done — the verdict no run can make. Null until they say so,
     * and only settable on a finished task; it never replaces the run's own outcome.
     */
    doneAt: string | null;
    /**
     * When a stop was requested on this ROW while it was running — the user's `/stop` landed on a
     * moving run and the worker has not parked it yet. The request is delivered through the
     * heartbeat the worker already sends (`cancelRequested`), and the flag is cleared when the
     * stop happens — parking (suspend) or finishing (complete) — never by the request itself, so a
     * run whose driver died mid-stop is parked as soon as its lease is reclaimed. Null on every
     * job nobody asked to stop.
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
     * Set only when this claim is picking a parked job back up, and it is the whole resume protocol:
     * the worker restores that session instead of starting a new one, and the command is not
     * re-delivered — it was delivered on the first run and is in the transcript.
     */
    resumeSessionId: string | null;
    /**
     * True only when `resumeSessionId` is set AND this claim should still deliver the command into
     * it — a follow-up's first (or crashed) attempt, where the restored transcript is the parent
     * conversation and the command is the new adjustment. False on every parked resume, where the
     * command is already in the transcript and re-delivering it would re-run work somebody may
     * have been driving by hand. Absent on a board that predates follow-ups, so it is read as
     * `?? false` on the driver side.
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
 * - `stopped`   the row was settled `stopped` in place — it was queued (never started) or its run
 *               was already parked; the turn is over.
 * - `requested` the row is running; the worker has been told and will settle it. The timestamp is
 *               the FIRST request, kept on later stops so the answer is idempotent.
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
     * `target` carries the optional repo/executor labels the tasks chat groups and displays by.
     */
    create(
        command: string,
        createdBy: string | null,
        target: { repo: string | null; executor: string | null }
    ): Promise<{ id: string }>;
    /**
     * Queues a follow-up on a finished task: a new job that inherits the parent's repo, executor
     * and session ids, linked through `followUpTo`. Atomic and conditional — the insert only
     * lands when the parent is finished, not done, carries a session, and is the caller's own
     * task — so the refusals above are decided in the same statement that would have created the
     * row, never by a read that could race a claim or a completion in between.
     *
     * The thread's labels and session are ALL the parent's, taken from the row and never from a
     * body: an adjustment continues the run it adjusts, on the executor that ran it — a
     * conversation switching executors mid-thread is exactly the cross-CLI resume the driver
     * cannot do.
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
     */
    markDone(id: string): Promise<{ status: JobStatus; doneAt: string } | 'missing' | 'conflict'>;
    /**
     * The user's stop. A QUEUED row never started and a STANDBY row's run is long gone — both are
     * settled `stopped` right here: the turn is over. A RUNNING row is stamped
     * `cancel_requested_at` (idempotently) and left running: the driver reads the request on the
     * heartbeat it already sends, kills its runner and settles it with the existing suspend route
     * — the flag IS the stop travelling, and the settle clears it. A row that already ended
     * refutes with its status.
     */
    stop(id: string): Promise<StopResult>;
    /**
     * The user's remove. Deletes the WHOLE thread — the root and every follow-up — in one
     * transaction and queues a task_reclaim row for the worktree, so the driver (which is the only
     * thing that can remove the tree and the only thing with a live lease to do work in) reclaims
     * it without the removed thread having any job left to hang the work on. Refuses while any
     * member of the thread is running, under the same per-thread lock the claim takes, so a claim
     * can never slip a running row between the refusal check and the delete.
     */
    removeThread(id: string): Promise<RemoveResult>;
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
    progress(id: string, leaseToken: string, output: string, runtime: RuntimeVitals | null): Promise<LeaseResult>;
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
     */
    list(filter: { status?: JobStatus | undefined; repo?: string | undefined; limit: number }): Promise<Job[]>;
}

interface JobRow {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    max_attempts: number;
    claimed_by: string | null;
    created_by: string | null;
    session_id: string | null;
    remote_session_id: string | null;
    exit_code: number | null;
    output?: string | null;
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
    done_at: Date | null;
    cancel_requested_at: Date | null;
    command_delivered_at: Date | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

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
 * The organization is bound at construction, for the reasons given on createPrStore.
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

    // Inside the factory, so the reads' `workspacePath` derivation closes over the org and the
    // has-a-workspace-root decision — the claim's own `claimPath` rule, shared rather than copied.
    const toJob = (row: JobRow): Job => ({
        id: row.id,
        command: row.command,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        claimedBy: row.claimed_by,
        createdBy: row.created_by,
        sessionId: row.session_id,
        remoteSessionId: row.remote_session_id,
        exitCode: row.exit_code,
        output: row.output ?? null,
        gates: row.gates ?? null,
        runtime: row.runtime ?? null,
        repo: row.repo,
        executor: row.executor,
        followUpTo: row.parent_job_id,
        rootJobId: row.root_job_id,
        doneAt: iso(row.done_at),
        cancelRequestedAt: iso(row.cancel_requested_at),
        // The claim builds the same path only for jobs it hands out; every read carries it too,
        // which is what the task view's status sidebar shows.
        workspacePath: hasWorkspaces && row.created_by ? `${orgId}/${row.created_by}` : null,
        createdAt: row.created_at.toISOString(),
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
    });

    return {
        async create(command, createdBy, target) {
            await gate();
            // id and root_job_id are the SAME uuid, computed once in the select so the column can
            // be not null from insert — the root's root is itself (022).
            const rows = await sql<{ id: string }[]>`
                insert into job (org_id, command, created_by, repo, executor, id, root_job_id)
                select ${orgId}, ${command}, ${createdBy}, ${target.repo}, ${target.executor}, x, x
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
                )
                insert into job (org_id, command, created_by, repo, executor, parent_job_id, session_id, remote_session_id, root_job_id)
                select ${orgId}, ${command}, ${createdBy}, repo, executor, id, session_id, remote_session_id, root_job_id
                from parent
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

        async markDone(id) {
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
                const rows = await tx<{ status: JobStatus; done_at: Date; root_job_id: string }[]>`
                    update job set done_at = coalesce(done_at, now())
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

        async stop(id) {
            await gate();
            // One statement decides the outcome by the status it sees. A QUEUED row never started
            // and a STANDBY row's run is long gone — both are settled `stopped` here: the turn is
            // over, and the session these rows keep is what the follow-up continues. A RUNNING row
            // is stamped `cancel_requested_at` and left running: the request travels on the
            // heartbeat the worker already sends, and the settle that honours it (suspend under
            // the stamp) clears it. coalesce keeps the FIRST request, which is what makes /stop
            // idempotent rather than a rewrite of when it was asked.
            const rows = await sql<{ status: JobStatus; cancel_requested_at: Date | null }[]>`
                update job set
                    status = case
                        when status in ('queued','standby') then 'stopped'
                        else status
                    end,
                    finished_at = case
                        when status in ('queued','standby') then now()
                        else finished_at
                    end,
                    cancel_requested_at = case
                        when status = 'running' then coalesce(cancel_requested_at, now())
                        else cancel_requested_at
                    end
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
                await tx`
                    update job set status = 'dead', finished_at = now(), lease_token = null
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
                                  session_id, repo, parent_job_id, executor,
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

        async removeThread(id) {
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
                    insert into task_reclaim (org_id, root_job_id, repo, workspace_path)
                    values (${orgId}, ${rootJobId}, ${root.repo}, ${workspacePath})
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

        async complete(id, leaseToken, { status, exitCode, output, contextTokens, contextCostUsd }) {
            await gate();
            // The context stats ride the verdict and merge into the runtime vitals — the row keeps
            // its last CPU sample AND gains the context the run reached. A run with no sample at
            // all gets a vitals object holding the stats alone, so "died at a full window" is
            // visible even where no container sample ever landed. Neither stat present → the
            // column is left exactly as the samples left it.
            const context =
                typeof contextTokens === 'number' || typeof contextCostUsd === 'number'
                    ? sql.json({
                          ...(typeof contextTokens === 'number' ? { contextTokens } : {}),
                          ...(typeof contextCostUsd === 'number' ? { contextCostUsd } : {}),
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
                        lease_token = null,
                        -- A stop request that never landed is settled by the run ending: the task
                        -- finished, there is nothing left to park.
                        cancel_requested_at = null,
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
                // The thread's state, read off the root column the row already carries (022) —
                // every member answers to the same root_job_id. The just-updated row's verdict
                // status is visible here, and the aggregate answers in one row: terminal means
                // every member reached `succeeded`/`failed`/`dead`/`stopped`; done means ONE member carries
                // the user's `done_at` (the UI marks the thread's head, so the column can sit on
                // any member). Both must hold before the tree may go.
                const [thread] = await tx<{ total: number; terminal: number; done: number }[]>`
                    select count(*)::int as total,
                           count(*) filter (where status in ('succeeded','failed','dead','stopped'))::int as terminal,
                           count(*) filter (where done_at is not null)::int as done
                    from job
                    where org_id = ${orgId} and root_job_id = ${rows[0].root_job_id}
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
                select id, command, status, attempts, max_attempts, claimed_by, created_by,
                       session_id, remote_session_id, exit_code, output, gates, runtime, repo, executor,
                       parent_job_id, root_job_id, done_at, cancel_requested_at, created_at, started_at, finished_at
                from job
                where org_id = ${orgId}
                  and root_job_id = (select root_job_id from job where org_id = ${orgId} and id = ${id})
                order by created_at, id
            `;
            const [first] = rows;
            return first ? rows.map(toJob) : null;
        },

        async get(id) {
            await gate();
            const rows = await sql<JobRow[]>`
                select id, command, status, attempts, max_attempts, claimed_by, created_by,
                       session_id, remote_session_id, exit_code, output, gates, runtime, repo, executor,
                       parent_job_id, root_job_id, done_at, cancel_requested_at, created_at, started_at, finished_at
                from job where org_id = ${orgId} and id = ${id}
            `;
            const row = rows[0];
            return row ? toJob(row) : null;
        },

        async list({ status, repo, limit }) {
            await gate();
            const rows = await sql<JobRow[]>`
                select id, command, status, attempts, max_attempts, claimed_by, created_by,
                       session_id, remote_session_id, exit_code, runtime, repo, executor,
                       parent_job_id, root_job_id, done_at, cancel_requested_at, created_at, started_at, finished_at
                from job
                where org_id = ${orgId} ${status ? sql`and status = ${status}` : sql``}
                  ${repo ? sql`and repo = ${repo}` : sql``}
                order by created_at desc, id
                limit ${limit}
            `;
            return rows.map(toJob);
        },
    };
}

/** Separates "no such job" from "the lease is not yours" once a guarded update matched nothing. */
async function exists(sql: Sql, orgId: string, id: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`select id from job where org_id = ${orgId} and id = ${id}`;
    return rows.length > 0;
}
