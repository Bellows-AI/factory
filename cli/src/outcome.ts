/**
 * The CLI's result contract: every command ends in exactly one outcome, each outcome owns one exit
 * code, and `--json` prints one envelope for it on stdout — nothing else — whether the command
 * succeeded, the board refused it, or the command line never parsed.
 *
 * An outcome describes how the COMMAND ended, not whether the work is ready to ship: a `succeeded`
 * wait means the run's verdict was `succeeded`, nothing about a pull request, a stage or a review.
 */

export const EXIT_OK = 0;
/** The board answered and refused (or answered something this client cannot read). */
export const EXIT_REFUSED = 1;
/** Bad usage or configuration — nothing was sent to the board. */
export const EXIT_USAGE = 2;
/** A wait spent its whole budget with the thread still moving. */
export const EXIT_TIMEOUT = 3;
/** The awaited run ended `failed` or `dead`. */
export const EXIT_TASK_FAILED = 4;
/** The awaited run was stopped on the board — a remote cancellation. */
export const EXIT_CANCELLED = 5;
/** The thread is parked on a workflow wait that nothing a wait can do will move. */
export const EXIT_NEEDS_ATTENTION = 6;
/** The board could not be reached at all. */
export const EXIT_UNREACHABLE = 7;
/** This process was interrupted locally (SIGINT/SIGTERM) — the task on the board is untouched. */
export const EXIT_INTERRUPTED = 130;

/** The outcome vocabulary, spelled once; the envelope's `outcome` is one of these. */
export const OUTCOME = {
    ok: 'ok',
    succeeded: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
    needsAttention: 'needs_attention',
    timeout: 'timeout',
    refused: 'refused',
    unreachable: 'unreachable',
    usage: 'usage',
    interrupted: 'interrupted',
} as const;

export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

/** The one exit code each outcome owns. */
export const EXIT_CODE_OF: Record<Outcome, number> = {
    ok: EXIT_OK,
    succeeded: EXIT_OK,
    failed: EXIT_TASK_FAILED,
    cancelled: EXIT_CANCELLED,
    needs_attention: EXIT_NEEDS_ATTENTION,
    timeout: EXIT_TIMEOUT,
    refused: EXIT_REFUSED,
    unreachable: EXIT_UNREACHABLE,
    usage: EXIT_USAGE,
    interrupted: EXIT_INTERRUPTED,
};

/** What a failure carries: the message, and the board's code and HTTP status when it answered. */
export interface ErrorDetail {
    message: string;
    code: string | null;
    status: number | null;
}

/**
 * The `--json` document. `ok` is `exitCode === 0`; `data` is the command's payload (present
 * whenever the board answered, including a failed wait), `error` is present when the command
 * itself failed. `command` is null when the argv named none.
 */
export interface Envelope {
    ok: boolean;
    command: string | null;
    outcome: Outcome;
    exitCode: number;
    data: unknown;
    error: ErrorDetail | null;
}

/** What one command hands back to `run`, which alone decides how it is printed. */
export interface CommandResult {
    outcome: Outcome;
    data?: unknown;
    error?: ErrorDetail;
    /** The human rendering — `--json` ignores it, so prose never contaminates the envelope. */
    stdout?: string;
    stderr?: string;
}

export function envelopeOf(command: string | null, result: CommandResult): Envelope {
    const exitCode = EXIT_CODE_OF[result.outcome];
    return {
        ok: exitCode === EXIT_OK,
        command,
        outcome: result.outcome,
        exitCode,
        data: result.data ?? null,
        error: result.error ?? null,
    };
}
