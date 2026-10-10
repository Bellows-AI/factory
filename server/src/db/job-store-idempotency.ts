/**
 * Durable idempotency for the create, follow-up and retry mutations (issue #589). The key is
 * stamped on the job row the mutation inserted, inside the same transaction, so a response lost
 * after commit is recovered by repeating the request: the lookup finds the row and answers its id.
 */

import type { TransactionSql } from 'postgres';

export type IdempotentOperation = 'create' | 'follow-up' | 'retry';

/** What a request carries to be replayable: its key and the fingerprint of what it asked for. */
export interface IdempotencyInput {
    operation: IdempotentOperation;
    key: string;
    fingerprint: string;
}

/** How long a recorded key keeps replaying; past it the key is cleared and may be reused. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

/** The key was already used for a different request — never replayed, never re-run. */
export class IdempotencyKeyReusedError extends Error {
    constructor() {
        super('This Idempotency-Key was already used for a different request');
        this.name = 'IdempotencyKeyReusedError';
    }
}

/**
 * Serializes every request under one key for the rest of the transaction, so two concurrent
 * duplicates run one after the other and the second finds the first's row. Then clears an expired
 * record of the key and looks for a live one: the row's id when the fingerprint matches, null when
 * the key is free (or the request carried none); a different fingerprint throws.
 */
export async function replayOf(
    tx: TransactionSql,
    orgId: string,
    createdBy: string | null,
    idem: IdempotencyInput | undefined
): Promise<string | null> {
    if (!idem) return null;
    const caller = createdBy ?? '';
    // The unit separator cannot appear in a key (the route's alphabet) nor in an org or user id.
    const scope = [orgId, caller, idem.operation, idem.key].join('\u001f');
    await tx`select pg_advisory_xact_lock(hashtextextended(${scope}::text, 0))`;
    await tx`
        update job
        set idempotency_key = null, idempotency_operation = null,
            idempotency_fingerprint = null, idempotency_at = null
        where org_id = ${orgId} and coalesce(created_by::text, '') = ${caller}
          and idempotency_operation = ${idem.operation} and idempotency_key = ${idem.key}
          and idempotency_at < now() - make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS})
    `;
    const [row] = await tx<{ id: string; idempotency_fingerprint: string }[]>`
        select id, idempotency_fingerprint from job
        where org_id = ${orgId} and coalesce(created_by::text, '') = ${caller}
          and idempotency_operation = ${idem.operation} and idempotency_key = ${idem.key}
    `;
    if (!row) return null;
    if (row.idempotency_fingerprint !== idem.fingerprint) throw new IdempotencyKeyReusedError();
    return row.id;
}

/** Records the key, if the request carried one, on the row this transaction just inserted. */
export async function stampKey(
    tx: TransactionSql,
    orgId: string,
    id: string,
    idem: IdempotencyInput | undefined
): Promise<void> {
    if (!idem) return;
    await tx`
        update job
        set idempotency_operation = ${idem.operation}, idempotency_key = ${idem.key},
            idempotency_fingerprint = ${idem.fingerprint}, idempotency_at = now()
        where org_id = ${orgId} and id = ${id}
    `;
}
