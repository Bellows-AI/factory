/**
 * The `Runner` contract the loop drives and both executors implement — docker in
 * `docker-runner.ts`, kubernetes in `k8s-runner.ts` — plus the executor-neutral output and vitals
 * helpers each one reports through. Nothing here knows which platform is underneath; a name that
 * only one executor needs belongs in that executor's files.
 */

import type { BoardJob, ServiceStatus } from './board.js';
import type { PublishResult, SyncResult, ReclaimResult } from './publish.js';

/**
 * What the board is told afterwards. `timedOut` is reported as a failure, with a reason; `idled` is
 * not a failure at all — the job is parked and keeps its session.
 */
export interface RunOutcome {
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    idled: boolean;
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
     * when no read was attempted (claude-code's Remote Control keeps an interactive
     * conversation no single read may freeze mid-flight). The board stores what arrives: absent
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
}

/**
 * The session a run is to use. `resume` restores an existing one rather than starting it, which is
 * how a parked job picks up where it left off — under the same id, so its link does not move.
 *
 * Null for a runner that takes no session at all: opencode mints its own ids and cannot adopt one
 * (`run --session <id>` continues an existing session, it never creates one with a given id), so
 * there is nothing honest to pass it.
 */
export interface RunSession {
    id: string;
    resume: boolean;
}

export interface Runner {
    /**
     * Runs the job. `onOutput` is the live-output hook: the runner calls it with its newest output
     * tail whenever fresh output arrives, and the loop decides what reaches the board and how
     * often. Optional — a caller that does not stream simply never gets a call.
     */
    run(job: BoardJob, session: RunSession | null, onOutput?: (tail: string) => void): Promise<RunOutcome>;
    /**
     * The Remote Control id the Claude UI addresses this session by, or null while the bridge has
     * not connected yet — which is the ordinary answer for the first few seconds of a run, and the
     * permanent one for a headless job.
     */
    remoteSessionId(job: BoardJob, sessionId: string): Promise<string | null>;
    /**
     * The runner container's vitals right now — the liveness signal the dashboard renders — or
     * null when none can be taken. Sampling failures are the ordinary case (the container can be
     * gone between the ask and the read), so null is "no fresh sample", never an error.
     */
    sampleRuntime(job: BoardJob): Promise<Omit<RuntimeSample, 'sampledAt'> | null>;
    /** Stops a container mid-run. Used when the lease is lost, and on shutdown. */
    kill(job: BoardJob): Promise<void>;
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
     * Prepares the job's task worktree before the run. A STARTING claim syncs it with the
     * remote default: fetch, create the worktree branched off `origin/<default>` (first attempt
     * of the thread) or rebase it onto the new default, keeping its commits. A claim that
     * CONTINUES a session (a follow-up, or a parked job resumed) RESTORES instead: no fetch, no
     * rebase — the tree is kept exactly as the run before it left it, or recreated from the
     * surviving thread branch (issue #58: git operations that touch the remote belong to the
     * task's beginning and end, never its middle). Called before the runner spawns, so a task
     * starts from the code it is meant to continue. Answers { ok: false, reason } rather than
     * throwing; the loop turns that into the verdict.
     */
    syncCheckout(job: BoardJob): Promise<SyncResult>;
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
     * syncCheckout acquires and HOLDS through the run. The loop calls this only on the terminal
     * pre-run refusals that complete the job failed WITHOUT runner.run, where run()'s finally —
     * the ordinary release path — never executes; a refusal that never runs must not hold the
     * checkout. Ownership-checked inside the runner: only the exact claim this attempt still
     * holds is released, never one that moved on. Optional: docker's fence leaves nothing
     * behind to release, so its runner implements nothing and a loop facing it never calls.
     */
    releaseFence?(job: BoardJob): Promise<void>;
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
