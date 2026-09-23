import type { ExecutorType, UserRef } from '@factory-ai/core';
import type { BellowsConfig } from '../workspace/bellows.js';

/**
 * The core job/claim shapes `createJobStore` (job-store.ts) builds on — split out of
 * job-store-types.ts purely to keep every file under the repo's line-count ceiling, re-exported
 * from job-store.ts for every existing import site. No behavior lives here beyond `runtimePatch`,
 * a pure reducer over a vitals report.
 */

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
export function runtimePatch(runtime: RuntimeVitals): Record<string, unknown> {
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
}
