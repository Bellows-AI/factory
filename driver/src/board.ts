import type { EvidencePolicy, GatesOutcome, ReviewEvidence } from './evidence-policy.js';
import { type ExecutorType, isExecutorType } from './executors.js';
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE, LEASE_LOST_CODE, NOT_FOUND_CODE } from './http.js';
import type { HelperPlan } from './helpers.js';

/**
 * One declared service of the attempt's `.bellows.yaml`, as the platform reports it right now:
 * the declared name (the DNS name inside the job), the image, and a lowercase state word —
 * docker's container State, or the pod phase under kubernetes. Platform-native on purpose:
 * `restarting` and `pending` carry real, platform-specific meaning the panel renders verbatim.
 */
export interface ServiceStatus {
    name: string;
    image: string;
    state: string;
    /**
     * Why a dead service died (issue #487), read once when the sampler first sees it dead: the
     * exit code, the platform's word for the ending, its last log lines, and the fix a known
     * signature points at. Absent while the service lives.
     */
    exitCode?: number | null;
    reason?: string | null;
    logTail?: string;
    hint?: string;
}

export interface BoardJob {
    id: string;
    command: string;
    attempts: number;
    /**
     * The board's claim sequence for this row: bumped by every claim and never refunded, unlike
     * `attempts` (issue #559). What the kubernetes checkout claim orders contenders by.
     */
    claimSeq: number;
    leaseToken: string;
    leaseExpiresAt: string;
    /**
     * The CLI/image family selected by this task's executor profile. Null means the stamped
     * executor no longer resolves; the loop fails that task explicitly instead of choosing a
     * process-wide fallback.
     */
    executorType: ExecutorType | null;
    /**
     * Why the board refuses to launch this task's executor (a suspended profile): the loop fails
     * the task with this sentence before any runner starts, on docker and kubernetes alike.
     */
    executorRefusal: string | null;
    /**
     * Why the task's selected skills cannot run (issue #545): a skill the board lacks, or a
     * connection its environment does not authorize — env NAMES only, never a value. The loop
     * fails the task `config` with this sentence before any runner starts, on docker and
     * kubernetes alike.
     */
    skillRefusal: string | null;
    /**
     * The board-owned Factory execution context (issue #244) — the master-prompt.ts renderer's
     * text, delivered through the executor's own system-instruction channel, never concatenated
     * into `command`. Read defensively as `?? null`, like every board field: a board that predates
     * the feature, or a render failure, both mean the loop must refuse the launch explicitly
     * rather than run the agent with no Factory execution context (see loop-run.ts).
     */
    masterPrompt: string | null;
    /**
     * This claim's node and Factory-managed capabilities (issue #509), delivered per turn
     * (master-prompt.ts) so `masterPrompt` stays the same for every claim of a thread. Absent when
     * the board sent no non-empty string.
     */
    turnContext?: string;
    /**
     * Set when this claim is a follow-up resuming its parent's session: the runner restores that
     * session rather than starting one. Read defensively as `?? null`.
     */
    resumeSessionId: string | null;
    /**
     * True when this claim resumes a session AND should still deliver the command into it — a
     * follow-up on a finished task, whose restored transcript is the parent conversation and whose
     * command is the new adjustment.
     * Read defensively like everything else here: a board that predates follow-ups omits it.
     */
    followUp: boolean;
    /**
     * The account that queued the job, or null for an unattributed one.
     *
     * Still not read here — the per-user Claude credential is what will read it. `workspacePath`
     * below is what the workspace half turned into. Read defensively, like `resumeSessionId`,
     * because a board that predates the field omits it.
     */
    userId: string | null;
    /**
     * Where that person's checkouts live, relative to the mounted workspace volume.
     *
     * `<org>/<user id>`, built by the board. A ready-made path rather than the raw `userId` because
     * the board owns the layout — it is what created the directory — and this process owns only the
     * mount point. Reimplementing `<org>/<uuid>` here would be a second copy of a rule this side
     * cannot verify.
     *
     * Null when the job has no author or the board has no workspace root, and a null is FAILED
     * rather than fallen back from. See dockerArgs.
     */
    workspacePath: string | null;
    /**
     * The id of the thread's ROOT job — the job itself, unless it is a follow-up, and then the
     * chain's first job. The task worktree (issue #35) is keyed by it, so every attempt of a task
     * and every follow-up resuming its session lands in the same tree, branched off the remote
     * default. Read defensively like everything else here: a board that predates the field omits
     * it, and the job is then its own root — the correct answer for every non-follow-up.
     */
    rootJobId?: string | null;
    /**
     * The thread ROOT job's command — the job's own, unless it is a follow-up. The publisher reads
     * the task's issue from it: the run that publishes is often a follow-up ("both OK") whose own
     * command names nothing.
     */
    rootCommand: string;
    /**
     * The environment the board resolved for this job — org < workspace < repo, secrets included.
     * Read defensively (`?? {}` at claim): a board that predates the field omits it, and the
     * runner's environment is then exactly what this process's own configuration forwards.
     */
    env?: Record<string, string>;
    /**
     * The job's `owner/name` label — the checkout the job's gates are declared in, and the key the
     * gate environment container is filed under. Read defensively: a board that predates gates
     * omits it.
     */
    repo?: string | null;
    /**
     * The gates the job's checkout declares in `.bellows.yaml`, read by the board at claim time:
     * the environment image they run in and the named commands. Null when the repository declares
     * none — the ordinary case. Absent on a board that predates gates, read as "no gates".
     */
    gates?: { image: string; setup?: string; gates: readonly { name: string; command: string }[] } | null;
    /**
     * Why the gates file exists but could not be honoured. The loop fails such a job outright —
     * running the work while pretending its gates do not exist is the one outcome worse than the
     * failure.
     */
    gateError?: string | null;
    /**
     * Which tree the claim's gates answer was read from (issue #444): the task worktree, or the
     * base clone — every first claim's, whose checked-out files may lag. The loop refuses to gate
     * on a 'clone' answer its post-sync re-read could not replace. Absent reads as "no refusal".
     */
    gatesSource?: 'worktree' | 'clone';
    /**
     * The evidence the repository requires before this work may publish (`policy`), and the
     * thread's review evidence as of the claim (`review`). Absent means nothing is required —
     * today's behaviour. Enforced in `evidence-policy.ts` at the draft and end-of-run publish.
     */
    policy?: EvidencePolicy;
    review?: ReviewEvidence;
    /**
     * Present only on a named reviewer's claim (issue #549): the snapshot ref its worktree starts
     * from and the wall-clock budget its profile grants. Such a run opens no publish or question
     * relay, runs no gates and never publishes — the board decided that when it handed the claim out.
     */
    reviewRun?: { profile: string; ref: string; timeoutMinutes: number };
    /**
     * The ad-hoc gate credentials the LOOP mints for this attempt (`BELLOWS_GATE_URL` /
     * `BELLOWS_GATE_TOKEN`) — set just before spawn, never by the board, which is why it sits
     * beside `env` rather than inside it: the reserved-name filter that keeps a member's claim
     * env from spoofing these names must not strip the driver's own.
     */
    gateEnv?: Record<string, string>;
    /**
     * Whether the driver may publish after this run's succeeded gated run. The BOARD's decision —
     * on a workflow task only the graph's publish node may push (docs/workflows.md), so a mid-loop
     * review success never does. Read defensively like every board field: ABSENT means a board
     * that predates the flag, which published every succeeded gated run — so absent is read as
     * "publish", and every claim without the field behaves byte-identically to before it existed.
     */
    publish?: boolean;
    /**
     * `false` when the claimed workflow node launches no agent (issue #503): the loop runs the
     * node's helpers, gates and publish without a runner session. Absent means an agent node.
     */
    agent?: false;
    /**
     * Declared pre/post block-helper steps for this row's node (issue #207) — an expanded
     * workflow `block` node's runtime plan, when its compiler produced one. Read defensively like
     * every board field added after launch: absent on a board that predates the field, and on
     * every claim of a workflow-less or `agent`-node task, which is the ordinary case — nothing
     * here is populated by any producer yet (docs/workflows.md), so this stays empty on every real
     * claim until a future issue threads a real plan through the compiler and the claim.
     */
    helperPlans?: HelperPlan[];
}

/** Whether the board still recognises this worker as the holder of the job. */
export type LeaseState = 'held' | 'lost';

/**
 * The job statuses the board answers a lease lookup with — the row statuses of
 * `POST /api/jobs/leases`, copied rather than imported (this package depends on nothing).
 * `succeeded`, `failed`, `dead` and `stopped` are the terminal set; `queued` and `running` are
 * the live ones.
 */
export type BoardJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'stopped';

/**
 * One row of the batched lease lookup the orphan reaper sweeps with (issue #301): the job's
 * status and its CURRENT lease token, or null when the row holds no live lease — the answer
 * that marks every labelled object of the job as a dead attempt's.
 */
export interface BoardLease {
    id: string;
    status: BoardJobStatus;
    leaseToken: string | null;
}

/**
 * How many job ids one `POST /api/jobs/leases` may carry — the same bound the server's route
 * enforces, copied here because this package imports nothing from the server. The reaper chunks
 * its sweep by it.
 */
export const LEASE_BATCH_MAX = 100;

const BOARD_JOB_STATUSES: readonly BoardJobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'dead', 'stopped'];

/** The shape of every id this board speaks — job ids and lease tokens alike. */
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How one heartbeat landed.
 *
 * `held` carries the stop flag the board set on a Stop while this attempt was running: the driver
 * kills its container and hands the row back — the board settles the turn `stopped`
 * (docs/jobs.md).
 * `lost` is the pre-existing 409 — the lease was reclaimed and the run must die. `removed` is the
 * board answering 404, which only a Remove can have produced (the thread's rows are gone); the
 * container dies and nothing is parked or reported — there is nobody left to park against.
 * `held` also carries `answeredQuestions`: every question of this lease the board has an answer for,
 * on every beat — the driver applies them idempotently.
 */
export type HeartbeatVerdict =
    | { result: 'held'; cancelRequested: boolean; answeredQuestions?: AnsweredQuestion[] }
    | 'lost'
    | 'removed';

/** One option of a question the agent asked. Copied from the board's `AskedQuestion` — no `core` import. */
export interface AskedQuestion {
    question: string;
    header: string;
    multiSelect: boolean;
    options: { label: string; description?: string }[];
}

/** The answer to one asked question: the question text → the member's answer. */
export interface AnsweredQuestion {
    questionId: string;
    answers: Record<string, string>;
}

/**
 * How the board took a question report: `held` (stored, or already stored), `refused` (the
 * attempt already holds its question limit — 429), `lost` (409) or `removed` (404).
 */
export type QuestionVerdict = 'held' | 'refused' | 'lost' | 'removed';

/**
 * How the board settled an expiry: the question `expired`, or an answer won the race and comes back
 * `answered` — the board decides. `lost` and `removed` are the lease verdicts, as for a heartbeat.
 */
export type QuestionExpiry =
    | { state: 'expired' }
    | { state: 'answered'; answers: Record<string, string> }
    | 'lost'
    | 'removed';

/** What the caller asks of the board for one review: the driver measured `revision` and froze it under `ref`. */
export interface ReviewRequest {
    key: string;
    profile: string;
    revision: string;
    ref: string;
}

/**
 * One review as the board reports it (issue #549): the review row's own status, the verdict read
 * from its output's final marker (`none` until a succeeded run ends on one), its findings, the
 * revision it is bound to, and the THREAD's review evidence as the policy validator sees it now —
 * which the loop adopts as `job.review`. Copied from the board's `ReviewView`; no `core` import.
 */
export interface ReviewReport {
    id: string;
    key: string;
    profile: string;
    status: BoardJobStatus;
    verdict: 'clean' | 'blockers' | 'none';
    revision: string;
    findings: string | null;
    failureKind: FailureKind | null;
    evidence: ReviewEvidence;
}

/**
 * How the board took a review request or read: the review (`created` when the request started a
 * new one), a `refused` with the board's own reason (an undeclared profile, a workflow task, a bad
 * ref, no such key), or the lease verdicts `lost` and `removed`.
 */
export type ReviewAnswer =
    | { result: 'ok'; review: ReviewReport; created: boolean }
    | { result: 'refused'; reason: string }
    | { result: 'lost' | 'removed' };

/**
 * The structured terminal reason of a run (issue #339): what class of ending the verdict records,
 * reported with the verdict and stored by the board as `job.failure_kind`. Null — the field off
 * the wire — means "not a failure": a success, or a row older than the column. Copied here rather
 * than imported because this package depends on nothing.
 */
export type FailureKind =
    | 'timeout'
    | 'cache_lost'
    | 'blocked'
    | 'gate'
    | 'publish'
    | 'helper'
    | 'services'
    | 'config'
    | 'policy'
    | 'runner_error';

/**
 * The attempt's evidence record, reported with the verdict: the tree fingerprint the run started
 * from, the one its gates assessed, and how the declared gates ended (copied from the board's
 * `evidence-policy.ts`).
 */
export interface VerdictEvidence {
    treeBefore: string | null;
    treeAfter: string | null;
    gates: GatesOutcome;
}

/**
 * One row of the board's removed-thread queue (issue #41): a Remove deleted the thread and left
 * the tree for somebody to take down. The lease claims the row so the reclaim is mutually
 * exclusive with a live attempt's startup sync; the row is deleted when the work is acked.
 */
export interface Reclaim {
    /** The queue row's own id — the lease token acking the removal produces. */
    id: string;
    /** The thread whose tree the removed job left behind. */
    rootJobId: string;
    /** The checkout the thread's worktree belonged to, when the removed job named one. */
    repo: string | null;
    workspacePath: string | null;
    leaseExpiresAt: string;
}

/** What acking a reclaim answered: consumed, or another worker already has it. */
export type ReclaimAck = 'ok' | 'lost' | 'missing';

/**
 * The runner container's vitals at one sample, plus the agent's current activity line — what the
 * board stores beside the output tail and the task view renders as the "is it working" answer.
 * Shapes the board's own validation; the driver sends only samples it took. The numbers are null
 * when they could not be read this round (a cluster with no metrics-server, for one) — a sample
 * may carry service states with no numbers beside them, never the reverse.
 */
export interface RuntimeReport {
    cpuPercent: number | null;
    memUsedMb: number | null;
    memPercent: number | null;
    activity: string | null;
    sampledAt: string;
    /** The attempt's declared `.bellows.yaml` services and their current states, when it declared any. */
    services?: ServiceStatus[];
}

export interface Board {
    /** Null means the queue is empty, which is the ordinary case, not an error. */
    claim(worker: string): Promise<BoardJob | null>;
    heartbeat(job: BoardJob): Promise<HeartbeatVerdict>;
    /** Reports one question the agent asked (`POST /api/jobs/:id/question`); a repeat of a stored id is `held`. */
    question(job: BoardJob, questionId: string, questions: AskedQuestion[]): Promise<QuestionVerdict>;
    /** Gives up waiting on a question (`POST /api/jobs/:id/question-expire`); the board decides the race with an answer. */
    expireQuestion(job: BoardJob, questionId: string): Promise<QuestionExpiry>;
    /** Starts a named reviewer's separate run (`POST /api/jobs/:id/review`); a repeated key answers the stored review. */
    requestReview(job: BoardJob, request: ReviewRequest): Promise<ReviewAnswer>;
    /** Reads the review asked for under `key` and the thread's review evidence (`POST /api/jobs/:id/review-read`). */
    readReview(job: BoardJob, key: string): Promise<ReviewAnswer>;
    /**
     * Claims one row of the removed-thread queue put there by a Remove (issue #41): the thread's
     * rows are gone and the tree is this worker's to take down. Null means the queue is empty.
     * The claim leases the row so the reclaim that follows holds the checkout against a live
     * attempt's startup sync for its duration.
     */
    claimReclaim(worker: string): Promise<Reclaim | null>;
    /**
     * Tells the board the removed thread's tree was reclaimed, so the row leaves the queue
     * instead of being offered again. `lost` means the lease ran out under this worker — another
     * worker holds the row now and its tree is this worker's no longer.
     */
    ackReclaim(id: string, worker: string): Promise<ReclaimAck>;
    /**
     * Streams a rolling tail of the runner's output while the job runs, so the dashboard shows the
     * work instead of a spinner. `runtime` rides beside it when the driver has a fresh sample of
     * the container's vitals; absent means none this round, and the board keeps the last one.
     * Best-effort by contract: a failure here costs freshness, never the run — the complete report
     * carries the final tail.
     */
    progress(job: BoardJob, output: string, runtime?: RuntimeReport): Promise<LeaseState>;
    /**
     * Replaces the job's gate state — what is running, what passed, what failed — so the task view
     * can show the checks while they happen. Best-effort by contract, like `progress`: a failure
     * costs freshness, never the run, and a `409` here is not a kill order.
     */
    gates(
        job: BoardJob,
        results: readonly {
            name: string;
            status: 'running' | 'passed' | 'failed';
            exitCode: number | null;
            output: string | null;
        }[]
    ): Promise<LeaseState>;
    /** Tells the board which agent session this attempt runs as; null clears one that never ran. */
    session(job: BoardJob, sessionId: string | null): Promise<LeaseState>;
    /**
     * Uploads one run artifact (issue #325) — the full-run log or the agent transcript of this
     * attempt — to the board, while the lease is still live. Best-effort by contract, like
     * `progress`: a failure costs retention, never the run, and a `409` here is not a kill
     * order — the upload is retention, never a verdict.
     */
    artifact(
        job: BoardJob,
        upload: { kind: 'log' | 'transcript'; attempt: number; content: string; truncated: boolean }
    ): Promise<LeaseState>;
    /**
     * Re-reads the gates the job's checkout declares NOW. The claim read the file before the
     * driver's startup sync freshened the checkout, so a repository whose gates file just arrived
     * would run ungated for its whole first task if the stale answer stood. Null — a refused,
     * lost, or failed answer — keeps the claim's decision; freshness is worth a request, not a
     * error path. An aborted `signal` (the attempt's stand-down) cancels the request; the answer is null.
     */
    rereadGates(
        job: BoardJob,
        signal?: AbortSignal
    ): Promise<{ gates: BoardJob['gates']; gateError: string | null } | null>;
    /**
     * A credential to publish this job's work with, fresh enough for the push. The claim env's
     * GITHUB_TOKEN was minted at claim time and a long run can outlive it — observed 2026-09-13:
     * a 1h33m run's publish died on its expired claim token with the work done and the gates
     * green. Null — a refused, lost, or failed answer, or the board holding nothing fresher —
     * keeps the claim env; freshness is worth a request, not an error path (the rereadGates
     * contract).
     */
    publishToken(job: BoardJob): Promise<string | null>;
    /** Parks the job: its container is gone, but it is not finished and keeps its session. */
    suspend(job: BoardJob): Promise<LeaseState>;
    /**
     * Hands a pre-run claim back after checkout contention (issue #559): the board requeues it with
     * its attempt refunded and its next claim deferred — or settles it stopped when a Stop got
     * there first. `lost` when the lease is no longer this attempt's.
     */
    requeue(job: BoardJob): Promise<LeaseState>;
    /**
     * Asks the board what it thinks of a batch of job ids (issue #301): each known id's status
     * and CURRENT lease token. Unknown ids are ABSENT from the answer — that absence is the
     * board saying "no such job here", which is exactly the fact a reaper acts on. Null — a
     * refused, failed, or malformed answer — means "the board cannot answer", and the reaper
     * reaps nothing on it: absence must be proven, never guessed.
     */
    leases(ids: readonly string[]): Promise<BoardLease[] | null>;
    /**
     * Reports the verdict. `contextTokens` / `contextCostUsd` ride beside it when the runner
     * scraped them out of the session database — the context the run reached and what it cost,
     * stored beside the attempt's vitals on the board. `agentTurns` rides when the runner
     * counted the run's root-conversation assistant response cycles at close — a number only:
     * an unmeasured read is omitted, and the board stores null, never zero. `summary` rides
     * when the close-time read lifted the run's last words — what the run did, for the
     * recently-completed view; omitted stays null on the board. The answer carries
     * `threadDone` — whether
     * EVERY job of the task's thread is terminal ('succeeded'/'failed'/'dead'/'stopped') AND the user has
     * closed the thread (a `done_at` on some member), computed by the board in the SAME
     * lease-guarded transaction as the verdict — which is the signal a worker uses right after a
     * verdict to decide the task worktree can be reclaimed (issue #47). A follow-up still
     * queued or running keeps it false; so does a thread that finished but was never
     * declared done — a failed task's tree is exactly what its next turn continues from, and the
     * tree is the user's to free.
     */
    complete(
        job: BoardJob,
        result: {
            status: 'succeeded' | 'failed';
            exitCode: number | null;
            output: string;
            contextTokens?: number | null;
            contextCostUsd?: number | null;
            agentTurns?: number | null;
            summary?: string | null;
            /**
             * The structured terminal reason (issue #339): why a failed run failed — the timeout
             * kill, a cache loss, a blocked agent, a failed gate, an unlanded publish, a failed
             * helper, or the runner erroring. Absent when the run succeeded, so the board stores null and the
             * row stays queryable as "not a failure".
             */
            failureKind?: FailureKind;
            /**
             * Whether the task tree differs from the one the startup sync left, read only after
             * a declared gate failed. Absent is unknown; the board rests a gate-fix edge on false.
             */
            treeChanged?: boolean;
            /** The revision-bound evidence record; absent when the attempt measured none. */
            evidence?: VerdictEvidence;
            /**
             * What the publish landed, when a publish did: the board's only trusted record of a
             * thread's repository — review traffic and the thread's wait key on it. Omitted when
             * the run published nothing.
             */
            publication?: {
                repo: string;
                prNumber: number;
                prUrl: string;
                headBranch: string;
                baseBranch: string;
            } | null;
        }
    ): Promise<{ state: LeaseState; threadDone: boolean }>;
}

type Fetch = typeof globalThis.fetch;

const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const ERROR_BODY_PREVIEW_LENGTH = 200;

/** Whether a row of the leases answer is fully readable — every field present and well-shaped. */
const isLeaseRow = (row: unknown): row is BoardLease => {
    const lease = row as Partial<BoardLease> | null;
    return (
        typeof lease?.id === 'string' &&
        UUID_SHAPE.test(lease.id) &&
        BOARD_JOB_STATUSES.includes(lease.status as BoardJobStatus) &&
        (lease.leaseToken === null || (typeof lease.leaseToken === 'string' && UUID_SHAPE.test(lease.leaseToken)))
    );
};

/**
 * The readable rows of a leases answer. FAIL-CLOSED: one row the driver cannot read nulls the
 * WHOLE answer — a partially-trusted answer would read the dropped rows as "unknown to board",
 * which is a reap verdict, and a server/driver version skew must never manufacture one.
 */
const parseLeaseRows = (rows: unknown[]): BoardLease[] | null =>
    rows.every(isLeaseRow) ? (rows as BoardLease[]) : null;

/**
 * The whole leases exchange — best-effort by contract: a refused, failed, or malformed answer is
 * null ("board cannot answer"), never a partial list the reaper would act on.
 */
const bestEffortLeases = async (
    post: (path: string, body: unknown, allow404?: boolean) => Promise<Response>,
    ids: readonly string[]
): Promise<BoardLease[] | null> => {
    try {
        const response = await post('/api/jobs/leases', { ids: [...ids] });
        if (!response.ok) return null;
        const bodyJson = (await response.json()) as { jobs?: unknown };
        return Array.isArray(bodyJson.jobs) ? parseLeaseRows(bodyJson.jobs) : null;
    } catch {
        return null;
    }
};

/**
 * The verdict's POST body: every measured field rides, and absent stays absent — the never-zero
 * contract is the driver's to keep on the wire too. Extracted from `complete` so the client
 * method stays a round trip, not a payload builder.
 */
function completeBody({
    status,
    exitCode,
    output,
    contextTokens,
    contextCostUsd,
    agentTurns,
    summary,
    failureKind,
    treeChanged,
    evidence,
    publication,
}: Parameters<Board['complete']>[1]): Record<string, unknown> {
    return {
        status,
        exitCode,
        output,
        ...(typeof contextTokens === 'number' ? { contextTokens } : {}),
        ...(typeof contextCostUsd === 'number' ? { contextCostUsd } : {}),
        // A number only: null and absent both stay off the wire, and the board stores
        // unmeasured — the never-zero contract is the driver's to keep too.
        ...(typeof agentTurns === 'number' ? { agentTurns } : {}),
        ...(summary ? { summary } : {}),
        // The structured failure reason, when there is one (issue #339); absent stays null.
        ...(failureKind ? { failureKind } : {}),
        // Measured only after a failed gate; unknown stays off the wire.
        ...(typeof treeChanged === 'boolean' ? { treeChanged } : {}),
        // What the gates and the review assessed, for the board's completion check.
        ...(evidence ? { evidence } : {}),
        // The identity of what was published, when anything was — the board keys review
        // traffic and the thread's wait on it.
        ...(publication ? { publication } : {}),
    };
}

/** The verdict POST carries the lease token beside the payload, like every worker write. */
const completeWireBody = (job: BoardJob, result: Parameters<Board['complete']>[1]): Record<string, unknown> => ({
    leaseToken: job.leaseToken,
    ...completeBody(result),
});

/** A claim text field read defensively: the string the board sent, else null. */
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The claim's `gatesSource` when it is one of the two known trees, else absent. */
const knownGatesSource = (value: unknown): Pick<BoardJob, 'gatesSource'> =>
    value === 'worktree' || value === 'clone' ? { gatesSource: value } : {};

/** The claim's `turnContext` when it is a non-empty string, else absent. */
const knownTurnContext = (value: unknown): Pick<BoardJob, 'turnContext'> =>
    typeof value === 'string' && value.length > 0 ? { turnContext: value } : {};

/** A heartbeat the board held: the stop flag, and every question of the lease the board has an answer for. */
async function heldBeat(response: Response): Promise<HeartbeatVerdict> {
    const body = (await response.json()) as { cancelRequested?: boolean; answeredQuestions?: unknown };
    const answered = Array.isArray(body.answeredQuestions) ? (body.answeredQuestions as AnsweredQuestion[]) : [];
    return { result: 'held', cancelRequested: body.cancelRequested === true, answeredQuestions: answered };
}

/** The board's answer to a question report, read as a verdict. */
function questionVerdictOf(response: Response): QuestionVerdict {
    if (response.status === HTTP_TOO_MANY_REQUESTS) return 'refused';
    if (response.status === HTTP_CONFLICT) return 'lost';
    return response.status === HTTP_NOT_FOUND ? 'removed' : 'held';
}

/** The board's answer to an expiry: the lease verdicts, an answer that won the race, or `expired`. */
async function questionExpiryOf(response: Response): Promise<QuestionExpiry> {
    if (response.status === HTTP_CONFLICT) return 'lost';
    if (response.status === HTTP_NOT_FOUND) return 'removed';
    const body = (await response.json()) as { state?: string; answers?: Record<string, string> };
    return body.state === 'answered' && body.answers
        ? { state: 'answered', answers: body.answers }
        : { state: 'expired' };
}

const HTTP_BAD_REQUEST = 400;
const HTTP_CREATED = 201;

/**
 * The board's answer to a review request or read. A 409 is two things here — the lease verdict, and
 * a refusal such as an undeclared profile — so the code in the body decides; a 404 is the removed
 * thread, or a key nothing was asked under.
 */
async function reviewAnswerOf(response: Response): Promise<ReviewAnswer> {
    if (response.ok) {
        return {
            result: 'ok',
            review: (await response.json()) as ReviewReport,
            created: response.status === HTTP_CREATED,
        };
    }
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    if (body.code === LEASE_LOST_CODE) return { result: 'lost' };
    if (response.status === HTTP_NOT_FOUND && body.code === NOT_FOUND_CODE) return { result: 'removed' };
    return {
        result: 'refused',
        reason: typeof body.error === 'string' ? body.error : `the board answered ${response.status}`,
    };
}

/**
 * The one POST every board call goes through: the JSON headers, the board secret when there is one,
 * and the status policy. 409 is a verdict, not a failure; 404 is a verdict too for the calls that
 * ask for one (a heartbeat against a removed thread, an ack for a row that left the queue); `allow`
 * names any further status a call reads as an answer (a question report's 429). Everything else
 * outside 2xx is the board being broken or the driver being wrong, and neither should be swallowed
 * into a silent no-op.
 */
function createPost({ url, token, fetch }: { url: string; token: string | undefined; fetch: Fetch }) {
    return async (
        path: string,
        body: unknown,
        allow404 = false,
        { signal, allow = [] }: { signal?: AbortSignal | undefined; allow?: readonly number[] } = {}
    ): Promise<Response> => {
        const response = await fetch(`${url}${path}`, {
            method: 'POST',
            headers: {
                [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
                // Omitted rather than sent empty: a board with no auth would otherwise see a Bearer
                // header with nothing in it, which is a credential that failed rather than one that
                // was never offered.
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
        });
        if (
            !response.ok &&
            response.status !== HTTP_CONFLICT &&
            !(allow404 && response.status === HTTP_NOT_FOUND) &&
            !allow.includes(response.status)
        ) {
            throw new Error(
                `${path} answered ${response.status}: ${(await response.text()).slice(0, ERROR_BODY_PREVIEW_LENGTH)}`
            );
        }
        return response;
    };
}

/** The two named-reviewer calls (issue #549): both lease-fenced, both reading a 400 as the board's refusal. */
function reviewCalls(post: ReturnType<typeof createPost>): Pick<Board, 'requestReview' | 'readReview'> {
    const allow = [HTTP_BAD_REQUEST];
    return {
        async requestReview(job, request) {
            const body = { leaseToken: job.leaseToken, ...request };
            return reviewAnswerOf(await post(`/api/jobs/${job.id}/review`, body, true, { allow }));
        },
        async readReview(job, key) {
            const body = { leaseToken: job.leaseToken, key };
            return reviewAnswerOf(await post(`/api/jobs/${job.id}/review-read`, body, true, { allow }));
        },
    };
}

export function createBoard({
    url,
    leaseSeconds,
    token,
    fetch = globalThis.fetch,
}: {
    url: string;
    leaseSeconds: number;
    /**
     * The shared board secret, when the board requires one. Empty against a board with AUTH_MODE=none.
     *
     * This is the driver's entire share of authentication: one header. It stays that way on purpose
     * — this process depends on nothing, `core` included, because it is a client of an HTTP board
     * and giving it the server's types would hand a process that needs only `fetch` and `docker` the
     * whole server dependency tree.
     */
    token?: string | undefined;
    fetch?: Fetch;
}): Board {
    const post = createPost({ url, token, fetch });

    return {
        async claim(worker) {
            const response = await post('/api/jobs/claim', { worker, leaseSeconds });
            if (response.status === HTTP_NO_CONTENT) return null;
            // Destructured out rather than left in the base spread: an invalid (non-array) value
            // must not survive under exactOptionalPropertyTypes, which refuses assigning
            // `undefined` to this optional property directly — the conditional spread below is
            // the only way to represent "absent".
            const { helperPlans, gatesSource, turnContext, ...rest } = (await response.json()) as Partial<BoardJob>;
            const claimed = rest;
            return {
                ...(claimed as BoardJob),
                ...(Array.isArray(helperPlans) ? { helperPlans } : {}),
                ...knownGatesSource(gatesSource),
                ...knownTurnContext(turnContext),
                masterPrompt: textOrNull(claimed.masterPrompt),
                resumeSessionId: claimed.resumeSessionId ?? null,
                followUp: claimed.followUp ?? false,
                userId: claimed.userId ?? null,
                workspacePath: claimed.workspacePath ?? null,
                rootJobId: claimed.rootJobId ?? null,
                executorType: isExecutorType(claimed.executorType) ? claimed.executorType : null,
                executorRefusal: textOrNull(claimed.executorRefusal),
                skillRefusal: textOrNull(claimed.skillRefusal),
                env: claimed.env ?? {},
            };
        },

        async heartbeat(job) {
            const response = await post(
                `/api/jobs/${job.id}/heartbeat`,
                {
                    leaseToken: job.leaseToken,
                    leaseSeconds,
                },
                true
            );
            // The 404 only a Remove can have produced: the thread's rows are gone, so the answer
            // is "die and report nothing" — there is nothing left to park against or hand a
            // verdict to. Read after the 409 check is redundant (they are exclusive statuses);
            // both are verdicts, and a defensive read keeps a future where the board blurs them
            // into a decision this side of the fence.
            if (response.status === HTTP_NOT_FOUND) return 'removed';
            if (response.status === HTTP_CONFLICT) return 'lost';
            return heldBeat(response);
        },

        async question(job, questionId, questions) {
            const body = { leaseToken: job.leaseToken, questionId, questions };
            const allow = [HTTP_TOO_MANY_REQUESTS];
            return questionVerdictOf(await post(`/api/jobs/${job.id}/question`, body, true, { allow }));
        },

        async expireQuestion(job, questionId) {
            const body = { leaseToken: job.leaseToken, questionId };
            return questionExpiryOf(await post(`/api/jobs/${job.id}/question-expire`, body, true));
        },

        ...reviewCalls(post),

        async claimReclaim(worker) {
            const response = await post('/api/reclaims/claim', { worker, leaseSeconds });
            if (response.status === HTTP_NO_CONTENT) return null;
            return (await response.json()) as Reclaim;
        },

        async ackReclaim(id, worker) {
            const response = await post(`/api/reclaims/${id}/ack`, { worker }, true);
            // 409 means this worker's lease on the row ran out — another worker holds it now.
            // 404 means the row already left the queue (acked elsewhere, or the delete landed).
            if (response.status === HTTP_CONFLICT) return 'lost';
            if (response.status === HTTP_NOT_FOUND) return 'missing';
            return 'ok';
        },

        async progress(job, output, runtime) {
            const response = await post(`/api/jobs/${job.id}/output`, {
                leaseToken: job.leaseToken,
                output,
                ...(runtime ? { runtime } : {}),
            });
            return response.status === HTTP_CONFLICT ? 'lost' : 'held';
        },

        async gates(job, results) {
            const response = await post(`/api/jobs/${job.id}/gates`, {
                leaseToken: job.leaseToken,
                gates: results,
            });
            return response.status === HTTP_CONFLICT ? 'lost' : 'held';
        },

        async session(job, sessionId) {
            const response = await post(`/api/jobs/${job.id}/session`, {
                leaseToken: job.leaseToken,
                sessionId,
            });
            return response.status === HTTP_CONFLICT ? 'lost' : 'held';
        },

        async artifact(job, upload) {
            const response = await post(`/api/jobs/${job.id}/artifact`, {
                leaseToken: job.leaseToken,
                ...upload,
            });
            return response.status === HTTP_CONFLICT ? 'lost' : 'held';
        },

        async rereadGates(job, signal) {
            try {
                const lease = { leaseToken: job.leaseToken };
                const response = await post(`/api/jobs/${job.id}/gates-reread`, lease, false, { signal });
                if (!response.ok) return null;
                const body = (await response.json()) as { gates?: BoardJob['gates']; gateError?: string | null };
                return { gates: body.gates ?? null, gateError: body.gateError ?? null };
            } catch {
                return null;
            }
        },

        async publishToken(job) {
            try {
                const response = await post(`/api/jobs/${job.id}/publish-token`, { leaseToken: job.leaseToken });
                if (!response.ok) return null;
                const body = (await response.json()) as { GITHUB_TOKEN?: string | null };
                return typeof body.GITHUB_TOKEN === 'string' && body.GITHUB_TOKEN ? body.GITHUB_TOKEN : null;
            } catch {
                return null;
            }
        },

        async suspend(job) {
            const response = await post(`/api/jobs/${job.id}/suspend`, { leaseToken: job.leaseToken });
            return response.status === HTTP_CONFLICT ? 'lost' : 'held';
        },

        async requeue(job) {
            // 404: the thread was removed behind the requeue — nothing left to hand back.
            const response = await post(`/api/jobs/${job.id}/requeue`, { leaseToken: job.leaseToken }, true);
            return response.status === HTTP_CONFLICT ? 'lost' : 'held';
        },

        async leases(ids) {
            return bestEffortLeases(post, ids);
        },

        async complete(job, result) {
            const response = await post(`/api/jobs/${job.id}/complete`, completeWireBody(job, result));
            // 409 is a verdict, not a failure: the lease is gone and with it any say over the
            // thread — the done answer is false, not unknown.
            if (response.status === HTTP_CONFLICT) return { state: 'lost', threadDone: false };
            // Read defensively, like every other board field: anything but a literal true —
            // absent, false, a body that is not the shape we asked for — means "the user may
            // still want this thread's tree", which is the only safe reading of an unclear answer.
            const body = (await response.json()) as { threadDone?: boolean };
            return { state: 'held', threadDone: body.threadDone === true };
        },
    };
}
