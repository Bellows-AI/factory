import { createHash } from 'node:crypto';
import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyKeyReusedError } from '../db/job-store-idempotency.js';
import type { IdempotencyInput, IdempotentOperation } from '../db/job-store-idempotency.js';
import { bad, guard } from './helpers.js';
import { HTTP_CONFLICT, HTTP_CREATED } from './job-limits.js';

/**
 * The request side of durable mutation idempotency (issue #589; docs/jobs.md): the key header,
 * its validation, the canonical request fingerprint, and the answer a replay gets. The store owns
 * the scope (org, caller, operation) and the retention.
 */

/** The request header a client names its logical attempt with. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** Set on the answer to a repeated request: the row already existed, nothing new was made. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Stable JSON: object keys sorted at every depth, so key order never changes a fingerprint. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/**
 * The request's idempotency input, or undefined when it carries no key (the mutation is then not
 * replayable, exactly as before). `request` is what the mutation asks for — everything the route
 * would act on, the target id included — never anything about the caller, which is scope.
 * `ok: false` once a malformed key has been refused on `reply`.
 */
export function idempotencyOf(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: IdempotentOperation,
    asked: unknown
): { ok: true; value: IdempotencyInput | undefined } | { ok: false } {
    const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (raw === undefined) return { ok: true, value: undefined };
    if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
        bad(
            reply,
            ERROR_CODES.BAD_IDEMPOTENCY_KEY,
            'Idempotency-Key must be 8 to 128 characters of letters, digits, ".", "_", ":" or "-"'
        );
        return { ok: false };
    }
    const fingerprint = createHash('sha256')
        .update(canonical([operation, asked]))
        .digest('hex');
    return { ok: true, value: { operation, key: raw, fingerprint } };
}

/** The create's idempotency input: every body field the create acts on, as the client spelled it. */
export function createIdempotencyOf(request: FastifyRequest, reply: FastifyReply, fields: Record<string, unknown>) {
    const { command, repo, executor, executorScope, skills, workflow, workflowParams, jiraConnection } = fields;
    return idempotencyOf(request, reply, 'create', {
        command,
        repo,
        executor,
        executorScope,
        skills,
        workflow,
        workflowParams,
        jiraConnection,
    });
}

/**
 * `guard` for a keyed mutation: a store failure answers 503 as usual, and a key already used for
 * a different request answers 409 here — either way `ok: false` means the reply has been sent.
 */
export async function guardKeyed<T>(
    reply: FastifyReply,
    log: (e: Error) => void,
    run: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
    const result = await guard(reply, log, async () => {
        try {
            return { value: await run() };
        } catch (error) {
            if (error instanceof IdempotencyKeyReusedError) return null;
            throw error;
        }
    });
    if (!result.ok) return { ok: false };
    if (result.value === null) {
        await reply.code(HTTP_CONFLICT).send({
            error: 'This Idempotency-Key was already used for a different request',
            code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        });
        return { ok: false };
    }
    return { ok: true, value: result.value.value };
}

/** The 201 a create-shaped mutation answers; a replay is the same body, marked. */
export function sendQueued(reply: FastifyReply, created: { id: string; replayed?: boolean }) {
    if (created.replayed) reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return reply.code(HTTP_CREATED).send({ id: created.id, status: 'queued' });
}
