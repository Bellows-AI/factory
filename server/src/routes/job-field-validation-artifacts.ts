import { ERROR_CODES } from '@factory-ai/core';
import type { ArtifactKind } from '../db/job-store-types.js';
import { ARTIFACT_KINDS, ARTIFACT_READ_LIMIT_DEFAULT, ARTIFACT_READ_LIMIT_MAX } from './job-limits.js';

/**
 * The artifact upload/read field validation (issue #325), split out of `job-field-validation.ts`
 * for that file's line budget — the same split the job-handlers files exist for.
 */

export interface ArtifactFields {
    kind: ArtifactKind;
    attempt: number;
    content: string;
    truncated: boolean;
}

/**
 * The artifact upload's body, minus the lease token the handler checks beside the route resolution
 * (the handleOutput precedent — the token check is the handler's, the field checks are ours).
 * `attempt` is the driver's own attempt counter, positive because the claim mints attempt 1 first.
 * Content bounds are the route's job, not this validator's: the handler slices, so a validator cap
 * here would only duplicate the constant.
 */
export function validateArtifactBody(
    fields: Record<string, unknown>
): { ok: true; value: ArtifactFields } | { ok: false; code: string; message: string } {
    const { kind, attempt, content, truncated } = fields;
    if (typeof kind !== 'string' || !ARTIFACT_KINDS.includes(kind as ArtifactKind)) {
        return {
            ok: false,
            code: ERROR_CODES.BAD_ARTIFACT,
            message: `kind must be one of ${ARTIFACT_KINDS.join(', ')}`,
        };
    }
    if (!Number.isInteger(attempt) || (attempt as number) < 1) {
        return { ok: false, code: ERROR_CODES.BAD_ATTEMPT, message: 'attempt must be a positive integer' };
    }
    if (typeof content !== 'string') {
        return { ok: false, code: ERROR_CODES.BAD_ARTIFACT, message: 'content must be a string' };
    }
    if (truncated !== undefined && typeof truncated !== 'boolean') {
        return { ok: false, code: ERROR_CODES.BAD_ARTIFACT, message: 'truncated must be a boolean' };
    }
    return {
        ok: true,
        value: { kind: kind as ArtifactKind, attempt: attempt as number, content, truncated: truncated === true },
    };
}

/**
 * The artifact read's query (issue #325): `attempt`, `offset` and `limit`, all optional —
 * defaults answer "newest attempt, from the start, one page". The same digit-string shape check
 * `validateWaitQuery` uses: Fastify hands query values over as strings (or arrays, for repeated
 * keys), so a shape refusal is a 400, never a NaN walking into the store.
 */
export function validateArtifactReadQuery(query: {
    attempt?: unknown;
    offset?: unknown;
    limit?: unknown;
}):
    | { ok: true; value: { attempt: number | null; offset: number; limit: number } }
    | { ok: false; code: string; message: string } {
    const intOr = (raw: unknown, min: number, max: number): number | null => {
        if (raw === undefined) return null;
        if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return NaN;
        const value = Number(raw);
        if (value < min || value > max) return NaN;
        return value;
    };
    const attempt = intOr(query.attempt, 1, Number.MAX_SAFE_INTEGER);
    if (Number.isNaN(attempt)) {
        return { ok: false, code: ERROR_CODES.BAD_ATTEMPT, message: 'attempt must be a positive integer' };
    }
    const offset = intOr(query.offset, 0, Number.MAX_SAFE_INTEGER);
    if (Number.isNaN(offset)) {
        return { ok: false, code: ERROR_CODES.BAD_OFFSET, message: 'offset must be a non-negative integer' };
    }
    const limit = intOr(query.limit, 1, ARTIFACT_READ_LIMIT_MAX);
    if (Number.isNaN(limit)) {
        return {
            ok: false,
            code: ERROR_CODES.BAD_LIMIT,
            message: `limit must be an integer 1..${ARTIFACT_READ_LIMIT_MAX}`,
        };
    }
    return {
        ok: true,
        value: {
            attempt,
            offset: offset ?? 0,
            limit: limit ?? ARTIFACT_READ_LIMIT_DEFAULT,
        },
    };
}
