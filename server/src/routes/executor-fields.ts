import { DEFAULT_GATE_FIX_ROUNDS, ERROR_CODES, EXECUTOR_TYPES, MAX_GATE_FIX_ROUNDS } from '@factory-ai/core';
import type { ErrorCode } from '@factory-ai/core';

/**
 * A ceiling on how many executors one person can configure, and (issue 391) on how many
 * organization profiles one organization can hold. Like MAX_REPOS_PER_USER, not a policy about
 * what anybody needs — just the bound that keeps one pasted list from growing without limit.
 */
export const MAX_EXECUTORS_PER_USER = 10;

export const MAX_EXECUTORS_PER_ORG = 10;

/**
 * The one validated executor entry both the personal whole-list PUT and the organization CRUD
 * routes accept (issue 391). Scope and ownership are NOT fields here — they are decided by the
 * route that parses them: the personal PUT writes the caller's rows, the org routes write the
 * organization's, and an entry pretending otherwise is refused before storage, not rewritten.
 */
export interface ExecutorFields {
    name: string;
    type: string;
    config: Record<string, unknown>;
    gateFixRounds: number;
}

/** The refusal codes a `parseExecutorFields` message can name, in one map for both routes. */
export function executorFieldRefusal(message: string): ErrorCode {
    if (message.startsWith('at most')) return ERROR_CODES.TOO_MANY_EXECUTORS;
    if (message.startsWith('unknown executor type')) return ERROR_CODES.BAD_EXECUTOR_TYPE;
    if (message.startsWith('gateFixRounds')) return ERROR_CODES.BAD_EXECUTOR_ROUNDS;
    return ERROR_CODES.BAD_BODY;
}

/**
 * One entry's gate-repair round limit (issue #49): optional, a whole number in 0..10, the code
 * default when absent. A refusal message starts with `gateFixRounds` so the code mapping can name
 * it — the same prefix convention the executor-type refusal uses.
 */
function parseGateFixRounds(item: { name?: unknown; gateFixRounds?: unknown }): number | string {
    if (item.gateFixRounds === undefined) return DEFAULT_GATE_FIX_ROUNDS;
    const rounds = item.gateFixRounds;
    if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 0 || rounds > MAX_GATE_FIX_ROUNDS) {
        return `gateFixRounds for "${item.name}" must be a whole number between 0 and ${MAX_GATE_FIX_ROUNDS}`;
    }
    return rounds;
}

/**
 * The fields every executor payload entry carries: the name/type/config shape, the known type and
 * the round limit. A string return is the refusal message; the caller stops at the first.
 */
export function parseExecutorFields(entry: unknown): ExecutorFields | string {
    const item = entry as {
        name?: unknown;
        type?: unknown;
        config?: unknown;
        gateFixRounds?: unknown;
    };
    if (typeof item?.name !== 'string' || typeof item?.type !== 'string') {
        return 'each entry must be { name: string, type: string, config: object }';
    }
    if (typeof item.config !== 'object' || item.config === null || Array.isArray(item.config)) {
        return `config for "${item.name}" must be a JSON object`;
    }
    if (!(EXECUTOR_TYPES as readonly string[]).includes(item.type)) {
        return `unknown executor type "${item.type}" (known: ${EXECUTOR_TYPES.join(', ')})`;
    }
    const gateFixRounds = parseGateFixRounds(item);
    if (typeof gateFixRounds === 'string') return gateFixRounds;
    return {
        name: item.name,
        type: item.type,
        config: item.config as Record<string, unknown>,
        gateFixRounds,
    };
}
