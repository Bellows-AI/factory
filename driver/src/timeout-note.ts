/**
 * The kill note a timed-out run leaves in its output tail (issue #339).
 *
 * `[driver] killed after Nms` on its own cannot tell a run that hung from one that was still
 * making progress when the wall clock ran out. What the driver holds at the moment of the kill —
 * the age of the last output line, the ad-hoc gate server's latest verdicts, the agent's last
 * activity line — is folded into the note, so the reader of a failed task no longer needs raw
 * SQL against three sources to answer "was it working?".
 *
 * Pure text shaping: no I/O, no imports. The loop supplies the facts; this module only words them.
 */

/** A run whose newest output line is older than this reads as idle at kill time. */
export const STILL_ACTIVE_AFTER_MS = 120_000;

/** The latest ad-hoc gate run the shared gate server recorded for one gate name. */
export interface GateRunNote {
    name: string;
    exitCode: number | null;
    /** When the run completed, ISO 8601. */
    at: string;
}

/** What the output pump can say about the run's liveness at any moment. */
export interface TimeoutActivity {
    /** Epoch ms of the last CHANGED tail; null = no output ever arrived. */
    lastOutputAt: number | null;
    /** The agent's current activity line, derived from the newest tail; null when there is none. */
    activity: string | null;
}

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
/** `padStart` width for the minutes half of `2h03m`. */
const PAD_WIDTH = 2;
/** Where the HH:MM:SS clock lives in an ISO 8601 stamp. */
const ISO_CLOCK_START = 11;
const ISO_CLOCK_END = 19;

/** A short human age: `34s` under a minute, `12m` under an hour, `2h03m` past it. */
export function formatAge(ms: number): string {
    const seconds = Math.floor(ms / MS_PER_SECOND);
    if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    const rest = minutes % MINUTES_PER_HOUR;
    return `${hours}h${String(rest).padStart(PAD_WIDTH, '0')}m`;
}

/** One gate's clause inside the note: passed with its stamp, or failed with its exit. */
function gatePhrase(run: GateRunNote, stamp: (iso: string) => string): string {
    if (run.exitCode === 0) return `${run.name} passed at ${stamp(run.at)}`;
    return run.exitCode === null ? `${run.name} failed` : `${run.name} failed (exit ${run.exitCode})`;
}

const clockStamp = (iso: string): string => iso.slice(ISO_CLOCK_START, ISO_CLOCK_END);

/**
 * The kill note. Active vs idle keys on the age of the newest CHANGED tail against
 * `STILL_ACTIVE_AFTER_MS`; the gate clause quotes the latest verdict per gate name and stamps
 * the newest completion; the activity clause quotes the agent's last words. Clauses are joined
 * with `, ` and each is omitted when the driver holds nothing for it.
 */
export function timeoutNote(
    jobTimeoutMs: number,
    activity: TimeoutActivity,
    gateRuns: readonly GateRunNote[],
    now: number
): string {
    const clauses: string[] = [];
    if (activity.lastOutputAt === null) {
        clauses.push('idle: no output');
    } else {
        const age = now - activity.lastOutputAt;
        clauses.push(
            age < STILL_ACTIVE_AFTER_MS
                ? `still active: last output ${formatAge(age)} ago`
                : `idle: no output for ${formatAge(age)}`
        );
    }
    if (gateRuns.length > 0) {
        // The gate server keeps one entry per name — its latest run — so a re-run replaces.
        const latest = new Map<string, GateRunNote>();
        for (const run of gateRuns) latest.set(run.name, run);
        const runs = [...latest.values()];
        const allPassed = runs.every((run) => run.exitCode === 0);
        clauses.push(
            allPassed
                ? `gates ${runs.map((run) => run.name).join('+')} passed at ${clockStamp(
                      runs.reduce((newest, run) => (run.at > newest ? run.at : newest), runs[0]!.at)
                  )}`
                : `gates ${runs.map((run) => gatePhrase(run, clockStamp)).join(', ')}`
        );
    }
    if (activity.activity !== null) clauses.push(`last activity "${activity.activity}"`);
    return `[driver] killed after ${jobTimeoutMs}ms — ${clauses.join(', ')}`;
}
