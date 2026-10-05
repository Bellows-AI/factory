/**
 * The `Runner` contract the loop drives and both executors implement — docker in
 * `docker-runner.ts`, kubernetes in `k8s-runner.ts` — plus the executor-neutral output and vitals
 * helpers each one reports through. Nothing here knows which platform is underneath; a name that
 * only one executor needs belongs in that executor's files.
 */

import type { BoardJob, ServiceStatus } from './board.js';
import type { HelperPlan, HelperResult } from './helpers.js';
import type { PublishResult, SyncResult, ReclaimResult } from './publish.js';

/** What the board is told afterwards. `timedOut` is reported as a failure, with a reason. */
export interface RunOutcome {
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    /**
     * False only when the runner knows the container never ran — the daemon refused to accept
     * it. The docker runner does not guess from the shared stderr stream, where the CLI's errors
     * and the command's own output are indistinguishable: on an exit 125 it asks the daemon
     * whether the container exists, and a container that exists ran, whatever it printed. A
     * kubernetes runner always reports started, because a resolved outcome there means the pod
     * was created, ran and exited. The shared loop interprets no exit codes: a run that started
     * and exited 125 is a verdict, reported like any other.
     */
    started: boolean;
    /**
     * True when the runner refused the job before the agent ran — a `.bellows.yaml` the parser
     * rejects. The verdict is final (`started: true`), but no work happened, so the loop runs no
     * gates against it: a gate over an untouched checkout reports noise (a `vitest: not found`
     * exit 127) under the refusal that actually explains the failure.
     */
    refused?: boolean;
    /**
     * The session the run actually used, when the runner could only know it after the fact —
     * opencode mints its own (`ses_…`) and the runner scrapes it out of the session database the
     * run left behind. Null for claude-code, whose session is minted up front and reported
     * before the container starts, and for every run whose scrape found nothing.
     */
    sessionId?: string | null;
    /**
     * The finish reason opencode recorded for the run's LAST root assistant message — `stop` for
     * a run that ended itself, `length` for one that hit the model's context limit mid-task.
     * Undefined when no scrape happened (claude-code, or an opencode run whose scrape never
     * ran); null when the scrape ran but read nothing. A zero exit code with a finish reason
     * that is not `stop` is a run that STOPPED TALKING, not one that finished — the loop
     * reports it failed rather than letting the exit code call a truncated run a success.
     */
    finishReason?: string | null;
    /**
     * The context the run reached, read from the same session database as `finishReason`: the
     * last root assistant message's token total — the model's window fill at the run's end — and
     * the sum of the per-message costs. Undefined when no scrape happened; null when the scrape
     * read nothing. Reported with the verdict and stored beside the attempt's vitals, where a
     * run that died at a full window tells its own story.
     */
    contextTokens?: number | null;
    costUsd?: number | null;
    /**
     * Why the post-run session scrape failed, when it failed: the readout's own error line, the
     * docker rejection, or null when it answered nothing at all. The loop logs it beside the
     * empty-scrape notice, because a lost session presents later as "this task cannot take a
     * follow-up" and the reason is the only way to tell a broken query from an empty database.
     * Undefined for claude-code, which never scrapes.
     */
    readoutError?: string | null;
    /**
     * The last provider error the scraped session recorded — the rejection the provider returned
     * as the run's dying word (an HTTP 429 rate limit, observed 2026-09-11, cutting a run off
     * mid-tool-call with exit 0). Lifted from the session database beside the finish reason; set
     * only when the scrape found the session, and absent for claude-code, which never scrapes.
     * The loop names it in the premature-stop note, because a finish reason of `tool-calls` says
     * the run stopped talking without saying what stopped it.
     */
    providerError?: string | null;
    /**
     * Why the cache watch killed the run, when it did — the observed turns, so the verdict the
     * author reads names what the provider stopped doing instead of just "failed". Undefined
     * when the watch is off or never fired; never set by claude-code, and the watch itself is
     * docker-only (config refuses it under EXECUTOR=kubernetes).
     */
    cacheLost?: string | null;
    /**
     * The run's agent turns — one assistant response cycle in the run's ROOT conversation,
     * counted from the session's own records at close (opencode: the session database the
     * readout walks; claude-code: the transcript on the workspaces volume). Null when the read
     * ran and could not measure — the transcript was gone, or the container died first; absent
     * when no read was attempted. The board stores what arrives: absent
     * and null both land as null — unmeasured, never zero.
     */
    agentTurns?: number | null;
    /**
     * What the run did, in the agent's own last words — the run's final assistant text, read
     * from the same records as `agentTurns` (opencode: the session database's part rows;
     * claude-code: the transcript's text blocks), collapsed to one line by the script. Null
     * when the read ran and found none — a run cut off mid-tool-call has no final text; absent
     * when no read was attempted. Reported with the verdict and stored on the job row, where
     * the recently-completed view shows what a task did without opening its output.
     */
    summary?: string | null;
    /**
     * The agent's blocked report, read with `summary` but BEFORE its collapse: the text after
     * `FACTORY_BLOCKED:` when the final message's last line starts with it. Absent otherwise.
     */
    blockedLine?: string;
    /**
     * The run's full output, tail-kept at ARTIFACT_LIMIT bytes (issue #325) — the artifact the
     * loop uploads to the board at close, where the rolling tail the verdict carries is only the
     * end of the run. Absent when the runner captured none (a refused start, a kubernetes pod
     * whose log was already gone) — no artifact is uploaded, never an empty one.
     */
    fullLog?: string;
    /** True when the full-log accumulator cut bytes off the head to hold the cap. */
    logTruncated?: boolean;
    /**
     * The agent session transcript of THIS run (the per-run delta, the same bound the turn
     * count keeps), exported from the executor's own records at close — claude's session JSONL,
     * opencode's reshaped message view — tail-kept at ARTIFACT_LIMIT bytes. Absent when no read
     * ran or answered: no artifact, never an empty one.
     */
    transcript?: string;
    /** True when the transcript export dropped its head to hold the cap. */
    transcriptTruncated?: boolean;
}

/**
 * The session a run is to use. `resume` restores an existing one rather than starting it, which is
 * how a follow-up continues its parent's conversation — under the same id.
 *
 * Null for a runner that takes no session at all: opencode mints its own ids and cannot adopt one
 * (`run --session <id>` continues an existing session, it never creates one with a given id), so
 * there is nothing honest to pass it.
 */
export interface RunSession {
    id: string;
    resume: boolean;
}

/** One declared service found dead: its status, how it ended, and what it last printed. */
export interface DeadService extends ServiceStatus {
    exitCode: number | null;
    /** The platform's word for the ending — the kubelet's `reason`, docker's `OOMKilled` or error. */
    reason: string | null;
    logTail: string;
}

/** How many of a dead service's last log lines the verdict quotes. */
export const SERVICE_LOG_TAIL_LINES = 20;

/** The states a platform reports for a declared service that is gone: docker's, then the pod phases. */
export const DEAD_SERVICE_STATES: ReadonlySet<string> = new Set(['exited', 'dead', 'failed', 'succeeded']);

/** What an entrypoint prints when it cannot drop to its own user under the runners' capability drop. */
const CAPABILITY_DROP_SIGNATURE = /failed switching to|(?:chown|gosu|su-exec)\b[^\n]*operation not permitted/i;

/**
 * The fix for a service that died on the capability-drop signature (issue #487), or null. Services
 * start with every capability dropped, so a stock image that chowns its data dir or switches user
 * as root cannot boot.
 */
export function serviceHint(logTail: string): string | null {
    if (!CAPABILITY_DROP_SIGNATURE.test(logTail)) return null;
    return (
        'the service starts with every capability dropped, so its entrypoint cannot chown or switch user — ' +
        'declare `user: "uid:gid"` (a non-root user the image runs as) or `unhardened: true` on it in .bellows.yaml'
    );
}

export interface Runner {
    /**
     * Runs the job. `onOutput` is the live-output hook: the runner calls it with its newest output
     * tail whenever fresh output arrives, and the loop decides what reaches the board and how
     * often. Optional — a caller that does not stream simply never gets a call.
     */
    run(job: BoardJob, session: RunSession | null, onOutput?: (tail: string) => void): Promise<RunOutcome>;
    /**
     * The runner container's vitals right now — the liveness signal the dashboard renders — or
     * null when none can be taken. Sampling failures are the ordinary case (the container can be
     * gone between the ask and the read), so null is "no fresh sample", never an error.
     */
    sampleRuntime(job: BoardJob): Promise<Omit<RuntimeSample, 'sampledAt'> | null>;
    /**
     * The attempt's declared services that are no longer running — exited, whatever the code —
     * each with its exit, the platform's reason and its last log lines. The loop asks right
     * before the declared gates: a gate against a dead service fails on an environment the
     * agent cannot fix (issue #423). Empty when services are off or every one is alive; a read
     * that fails throws, and the loop runs the gates as if it had answered empty.
     */
    deadServices(job: BoardJob): Promise<DeadService[]>;
    /** Stops a container mid-run. Used when the lease is lost, and on shutdown. */
    kill(job: BoardJob): Promise<void>;
    /**
     * Tears down the attempt's `.bellows.yaml` services. run() starts the fleet and deliberately
     * leaves it up: the declared gates run after it and are what test against those services, so
     * the loop calls this once the gates are done — and on every other way the attempt ends,
     * run() thrown included. Attempt-scoped and idempotent, like every teardown here.
     */
    releaseServices(job: BoardJob): Promise<void>;
    /**
     * Publishes the work the run produced: task branch (when the checkout sits on the default
     * one), commit, push, and a PR. The deterministic end of a task — a succeeded verdict may not
     * describe work that exists only in a local checkout. The loop decides WHEN this is called (a
     * succeeded run, gates passed, and nothing else); a runner that cannot publish answers the
     * refusal in the result — or does not implement the method at all, which the loop reads as
     * "this platform does not publish". `publishToken` is the board's publish-fresh credential
     * (the claim's can be an hour past expiry by push time); both transports lay it over the
     * claim env through withPublishToken, so neither can drift.
     */
    publishGit?(job: BoardJob, publishToken?: string): Promise<PublishResult>;
    /**
     * The task tree's fingerprint now (`probeTreeFingerprint`): the probe step over the same
     * transport `publishGit` uses, read only after a declared gate failed. Null is unknown.
     * Optional, like `publishGit`: a runner without it reports no tree change at all. `signal`
     * is the attempt's stand-down: an aborted probe tears its container or aux Job down.
     */
    probeTree?(job: BoardJob, signal?: AbortSignal): Promise<string | null>;
    /**
     * Prepares the job's task worktree before the run. A STARTING claim syncs it with the
     * remote default: fetch, create the worktree branched off `origin/<default>` (first attempt
     * of the thread) or rebase it onto the new default, keeping its commits. A claim that
     * CONTINUES a session (a follow-up) RESTORES instead: no fetch, no
     * rebase — the tree is kept exactly as the run before it left it, or recreated from the
     * surviving thread branch (issue #58: git operations that touch the remote belong to the
     * task's beginning and end, never its middle). Called before the runner spawns, so a task
     * starts from the code it is meant to continue. Answers { ok: false, reason } rather than
     * throwing; the loop turns that into the verdict — except a reason carrying the script's
     * transient marker (TRANSIENT_SYNC_REASON, issue #307: lock contention on the shared
     * checkout), which is infrastructure: the loop leaves the job to its lease and no verdict
     * lands. An aborted `signal` (the attempt's stand-down) detaches the docker client only: a sync
     * writes the worktree, so it is never killed mid-write, and kubernetes does not take the signal
     * at all — the abandoned sync finishes and `releaseAbandonedSync` hands its claim back.
     */
    syncCheckout(job: BoardJob, signal?: AbortSignal): Promise<SyncResult>;
    /**
     * Reclaims the task worktree after the thread's LAST job is terminal: removes the per-thread
     * tree and prunes its admin entry, so a finished or deleted task does not leave its tree
     * squatting on the member volume forever (issue #47). Best-effort by contract: the loop calls
     * it after a verdict precisely because the verdict is already safe on the board — a reclaim
     * that refuses (a path that is not the sync's own worktree, a daemon that says no) must never
     * turn a done task back into a failed one, and the loop logs and moves on. Refusal keeps the
     * tree by design: the script it runs deletes only what the sync itself created, and the
     * surviving factory/<root> branch lets a later follow-up recreate the tree with a fresh sync.
     */
    reclaimWorktree(job: BoardJob): Promise<ReclaimResult>;
    /**
     * Hands back whatever the startup sync's fence took — the kubernetes checkout claim, which
     * syncCheckout acquires and HOLDS through the run. The loop calls this (`handBackFence`) on
     * every exit that never reaches runner.run — a terminal refusal, a stand-down, a throw — where
     * run()'s finally, the ordinary release path, never executes; an attempt that never runs must
     * not hold the checkout. Ownership-checked inside the runner: only the exact claim this attempt still
     * holds is released, never one that moved on. Optional: docker's fence leaves nothing
     * behind to release, so its runner implements nothing and a loop facing it never calls.
     */
    releaseFence?(job: BoardJob): Promise<void>;
    /**
     * Deletes the checkout claim of a job the board no longer knows as live (issue #344): a
     * driver that died holding the claim leaked it, and when the leaked holder's thread is later
     * removed, its reclaim is refused by that claim forever — nothing else can see a bare
     * ConfigMap, so the reclaim loop is the only cleaner. Ownership-safe by construction: the
     * delete carries the uid of the exact object this call read, and answers true only when that
     * object is the one that went. Optional: kubernetes only — docker's fence leaves no claim
     * object behind to reap, so its runner implements nothing and the loop never calls.
     */
    reapOrphanedClaim?(job: BoardJob): Promise<boolean>;
    /**
     * Runs one declared block-helper step (issue #207): an allowlisted, board-owned script an
     * expanded workflow `block` node names to run before or after its agent turn. `token` is a
     * fresh GitHub installation token, minted by the loop immediately before a github-writing
     * helper (`plan.githubWriting`); a read-only helper gets none and the transport runs it with
     * the claim env untouched. Optional: a job with no `helperPlans` never calls it, and a runner
     * that does not implement one simply cannot run helpers — the same "this platform does not
     * support it" reading `publishGit`'s optionality already carries. An aborted `signal` (the
     * attempt's stand-down) ends a kubernetes helper's poll and reaps its Job; on docker it
     * detaches the client and the container is removed by name, a github-writing one included.
     */
    runHelper?(job: BoardJob, plan: HelperPlan, token?: string, signal?: AbortSignal): Promise<HelperResult>;
}

/**
 * The most of a runner's output this process will hold in memory — the board truncates too; this
 * is about not holding an unbounded string in the first place. Exported because the kubernetes
 * runner's transport uses it as its sliding-window bound.
 */
export const BYTES_PER_KIB = 1024;
const OUTPUT_LIMIT_KIB = 64;
export const OUTPUT_LIMIT = OUTPUT_LIMIT_KIB * BYTES_PER_KIB;

/**
 * The full-run log and transcript artifact cap (issue #325): how much of a run's output the
 * driver keeps for the board's artifact upload, tail-kept — a run that fails says why at the
 * end, and the head is banner. The server's route re-bounds the stored content to the same
 * figure; the value is copied there, per this package's zero-dependency rule.
 */
const ARTIFACT_LIMIT_KIB = 512;
export const ARTIFACT_LIMIT = ARTIFACT_LIMIT_KIB * BYTES_PER_KIB;

/**
 * The tail of a runner's output that is safe to put on a complete POST. The board refuses a body
 * over its 128 KiB limit, and JSON escaping can inflate text up to six bytes per byte of log — a
 * control character becomes `\u0001` — so the bound is 16 KiB of UTF-8: 96 KiB fully escaped, plus
 * the rest of the report, still fits. Capping by CHARACTERS instead — 64 KiB of them, the naive
 * reading of OUTPUT_LIMIT — could triple that with CJK text and sextuple it with control
 * characters, and the refused report would leave the job to its lease and re-run finished work:
 * the one outcome worse than a short log.
 */
const REPORT_LIMIT_KIB = 16;
const REPORT_BYTE_LIMIT = REPORT_LIMIT_KIB * BYTES_PER_KIB;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8');

/**
 * The last `limit` UTF-8 bytes of `text`, as a string. A multibyte character cut at the boundary
 * decodes to one U+FFFD — at most three extra bytes, once — which is why the bound is stated in
 * bytes and not approximated by a character count.
 */
export function tailBytes(text: string, limit: number): string {
    const bytes = ENCODER.encode(text);
    if (bytes.length <= limit) return text;
    return DECODER.decode(bytes.subarray(bytes.length - limit));
}

/** The tail of a runner's log that fits a complete POST, whatever the log contained. */
export function reportTail(logText: string): string {
    return tailBytes(logText, REPORT_BYTE_LIMIT);
}

/**
 * Tail-keeps `text` to `limit` UTF-8 bytes, answering whether a cut happened — the accumulator
 * and artifact reads' shape (issue #325), where the truncated flag must be earned by an actual
 * cut, never guessed. The same byte-true rule as `tailBytes`, plus the flag.
 */
export function tailKept(text: string, limit: number): { content: string; truncated: boolean } {
    const bytes = ENCODER.encode(text);
    if (bytes.length <= limit) return { content: text, truncated: false };
    return { content: DECODER.decode(bytes.subarray(bytes.length - limit)), truncated: true };
}

/**
 * The runner container's vitals at one sample: the "is it actually doing anything" answer the
 * dashboard renders beside the output tail. Taken with `docker stats --no-stream` — the same
 * daemon access every other per-attempt operation here uses.
 */
export interface RuntimeSample {
    /** Whole-container CPU, percent of one host core; can exceed 100 on multi-core hosts. */
    cpuPercent: number | null;
    /** Resident memory, in MiB. */
    memUsedMb: number | null;
    /** Resident memory against the container's limit, percent; null when the daemon reports none. */
    memPercent: number | null;
    /**
     * The attempt's declared services and their current states — present only when the attempt
     * declared any and their states could be read.
     */
    services?: ServiceStatus[];
    /** When the sample was taken, stamped by the sampler. A reader sees staleness from this. */
    sampledAt: string;
}

/** How many characters of one output line the activity report may carry. */
const ACTIVITY_LIMIT = 200;

/** Strips ANSI/OSC escapes — the stream is a CLI's, and the board renders it as text. */
export function stripAnsi(text: string): string {
    // CSI sequences, OSC sequences (BEL- or ST-terminated), and any other lone escape.
    return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g, '');
}

/**
 * The agent's current activity, read off the newest output tail: its last non-empty line, escapes
 * stripped and capped. That line is the tool call most of the time (`→ Read src/x.ts`,
 * `$ npm test`), which is exactly the "is it working, and on what" answer wanted here. A heuristic
 * by design — the stream is the CLI's to format, and parsing deeper would couple this process to
 * one renderer's redraws.
 */
export function currentActivity(tail: string | null): string | null {
    if (tail === null) return null;
    const lines = stripAnsi(tail).split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!.trim();
        if (line) return line.slice(0, ACTIVITY_LIMIT);
    }
    return null;
}

/**
 * Joins the two reads a vitals sample is made of — the runner's CPU/memory and the attempt's
 * service fleet — under the rule that a failed read costs its half, never the sample. An empty
 * or failed fleet is NO KEY at all, so a job whose attempt declared no services puts exactly the
 * pre-services wire shape out; unreadable vitals are null numbers beside real service states,
 * because the fleet must not depend on the metrics API (a kind cluster runs none). Both halves
 * gone → null, "no fresh sample", exactly the answer a failed read has always answered.
 */
export function composeRuntimeSample(
    vitals: Pick<RuntimeSample, 'cpuPercent' | 'memUsedMb' | 'memPercent'> | null,
    services: ServiceStatus[] | null | undefined
): Omit<RuntimeSample, 'sampledAt'> | null {
    const fleet = services && services.length > 0 ? services : undefined;
    if (!vitals && !fleet) return null;
    return {
        cpuPercent: vitals?.cpuPercent ?? null,
        memUsedMb: vitals?.memUsedMb ?? null,
        memPercent: vitals?.memPercent ?? null,
        ...(fleet ? { services: fleet } : {}),
    };
}
