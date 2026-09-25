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
