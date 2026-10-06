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
 * The executor profile scopes (issue 391): a profile belongs either to one member (`user`) or to
 * the organization (`org`), managed by its administrators and selectable by every member. The
 * stored values on `executor_profile.user_id`'s nullness and `job.executor_scope`, and the wire
 * value a task selection stamps — the workflows API spells its scopes the same way.
 */
export const EXECUTOR_SCOPES = ['user', 'org'] as const;

export type ExecutorScope = (typeof EXECUTOR_SCOPES)[number];

/** The scopes by name, destructured from the one list so no second copy can drift. */
export const [USER_SCOPE, ORG_SCOPE] = EXECUTOR_SCOPES;

/**
 * The sentence a suspended profile is refused with (issue 440) — at submission (409) and at claim
 * (the task fails before a runner starts) — one spelling so the two cannot drift.
 */
export const executorSuspendedMessage = (scope: ExecutorScope, name: string): string =>
    `The ${scope === ORG_SCOPE ? 'organization' : 'personal'} executor "${name}" is suspended. ` +
    'Resume it or choose another executor, then start a new task.';

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

/**
 * The top-level config keys the board strips before a member's executor config reaches its runner
 * (issue 183): claude-code's git guard hook and baked plugin install, opencode's permission fence.
 * One list for the claim that strips them and the dialog that warns about them (#261), so the
 * warning cannot promise a key the runner would honor or miss one it drops.
 */
export const RUNNER_MANAGED_KEYS: Record<ExecutorType, readonly string[]> = {
    [CLAUDE_CODE]: ['hooks', 'enabledPlugins', 'extraKnownMarketplaces'],
    [OPENCODE]: ['permission'],
};
