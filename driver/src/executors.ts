/**
 * The executor types the board may assign to one claim.
 *
 * Copied from core rather than imported: the driver is an HTTP client with no dependency on the
 * server's package graph (AGENTS.md). Keep this union in lockstep with core/src/executors.ts.
 */
export const EXECUTOR_TYPES = ['claude-code', 'opencode'] as const;
export type ExecutorType = (typeof EXECUTOR_TYPES)[number];

/** The executor types by name, destructured from the one list so no second copy can drift. */
export const [CLAUDE_CODE, OPENCODE] = EXECUTOR_TYPES;

export function isExecutorType(value: unknown): value is ExecutorType {
    return typeof value === 'string' && EXECUTOR_TYPES.includes(value as ExecutorType);
}
