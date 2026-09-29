/**
 * The executor types a member may configure.
 *
 * The single list both the server's route check and the web UI's picker render from — two
 * hand-maintained lists are how a future type lands enabled in one and rejected by the other. The
 * `user_executor.type` check constraint must list the same values: 012_user_executors.sql created
 * it, 013_opencode_executor_type.sql rewrote it to add opencode, and adding the next value means
 * another migration AND this array in the same change, because altering a check on a populated
 * table is a rewrite (006's job_status_ck rule).
 */
export const EXECUTOR_TYPES = ['claude-code', 'opencode'] as const;

export type ExecutorType = (typeof EXECUTOR_TYPES)[number];

/** The executor types by name, destructured from the one list so no second copy can drift. */
export const [CLAUDE_CODE, OPENCODE] = EXECUTOR_TYPES;

/**
 * The default-workflow gate-repair round limit (issue #49): how many bounded gate-fix rounds an
 * ordinary task may spend repairing a failed gate before the thread rests. A value of zero turns
 * automatic gate repair off — the graph falls back to today's no-edge shape. The board reads the
 * per-member value off the selected executor row at launch and freezes it onto the thread's root
 * row with the snapshot; a mid-flight settings edit changes later tasks, never a running thread.
 */
export const DEFAULT_GATE_FIX_ROUNDS = 3;

/** The upper bound any stored `gate_fix_rounds` may take, matching the review-reconcile block's 1-10. */
export const MAX_GATE_FIX_ROUNDS = 10;
