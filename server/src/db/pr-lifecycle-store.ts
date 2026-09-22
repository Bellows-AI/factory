import type { Sql, TransactionSql } from 'postgres';

/**
 * The shared exec handle every method accepts: the pool, or a transaction the CALLER opened (the
 * verdict's `sql.begin` above all). A method called with the pool opens its own transaction when
 * it needs atomicity across statements; called with a transaction it reuses the caller's, so the
 * publication identity and the verdict commit — or roll back — together.
 */
export type PrExec = Sql | TransactionSql;

/** The structured publication identity, as the driver's completion report carries it. */
export interface StructuredPublication {
    repo: string;
    prNumber: number;
    prUrl: string;
    headBranch: string;
    baseBranch: string;
}

/** The same identity bound to the thread it belongs to — the `job_pr` row (036). */
export interface PublicationInput extends StructuredPublication {
    root: string;
}

/** One durable wait's state, as the block layer and the read model read it (036). */
export interface WaitState {
    reason: string;
    repo: string;
    prNumber: number;
    /** Review deliveries folded and not yet claimed; the block's wake-up count. */
    pending: number;
    /** The last folded delivery's GUID — the wait's bounded event cursor. */
    lastDeliveryId: string | null;
    activeAt: string;
    /** Set, with `cancelledAt`, at most one of the two — a terminal wait has exactly one stamp. */
    completedAt: string | null;
    cancelledAt: string | null;
    /** Why the wait ended — the read model's terminal/exhausted reason. Null while active. */
    terminalReason: string | null;
    lastEventAt: string | null;
}

/** What one supported GitHub delivery did to the org's waits. */
export type DeliveryOutcome = 'folded' | 'duplicate' | 'unmatched';

export interface PrLifecycleStore {
    /**
     * Records — or overwrites — the thread's publication identity. Idempotent: a re-publish of
     * the same PR refreshes the row, a later publish replaces it, and the row exists only for
     * executions that actually published. Callers run it inside the verdict transaction.
     */
    recordPublication(input: PublicationInput, exec?: PrExec): Promise<void>;
    publicationOf(root: string, exec?: PrExec): Promise<PublicationState | null>;
    /**
     * Enters (or re-enters) a named wait for the thread. A wait for the same reason that already
     * exists stays active (idempotent); one that is terminal — finished or cancelled — starts a
     * fresh cycle that clears the counter and the delivery cursor.
     */
    enterWait(
        input: { root: string; reason: string; repo: string; prNumber: number },
        exec?: PrExec
    ): Promise<WaitState>;
    /** Ends the wait as completed. Idempotent: an already-terminal wait is not rewritten. */
    finishWait(root: string, reason: string, terminalReason?: string, exec?: PrExec): Promise<boolean>;
    /** Ends the wait as cancelled. Idempotent, like `finishWait`. */
    cancelWait(root: string, reason: string, terminalReason?: string, exec?: PrExec): Promise<boolean>;
    /** Cancels every open wait of a thread — the task-stop / task-remove sweep. Returns the count. */
    cancelWaitsForRoot(root: string, terminalReason?: string, exec?: PrExec): Promise<number>;
    /** Cancels every open wait addressed to a repository's PR — the PR-close/merge sweep. Returns the count. */
    cancelForRepoPr(repo: string, prNumber: number, terminalReason?: string, exec?: PrExec): Promise<number>;
    /**
     * Folds one GitHub delivery. The delivery GUID is the dedupe key: a redelivery inserts
     * nothing and folds nothing. A new delivery folds into EVERY open wait addressed to the same
     * (repo, prNumber) — the org's threads waiting on that PR — and answers `folded`; one with no
     * matching open wait is still recorded, for redelivery silence, and answers `unmatched`.
     */
    recordDelivery(
        delivery: { deliveryId: string; event: string; action: string; repo: string; prNumber: number },
        exec?: PrExec
    ): Promise<DeliveryOutcome>;
    /**
     * Atomically claims the wait's folded deliveries: the pending count returns and resets to
     * zero in the same lock, so a delivery landing DURING the claim folds on top of zero and is
     * caught by the next claim — the coalesce the block protocol relies on.
     */
    claimReview(
        root: string,
        reason: string,
        exec?: PrExec
    ): Promise<{ pending: number; lastDeliveryId: string | null }>;
    /** The thread's wait: the open one, or the most recently terminal one when none is open. */
    waitOf(root: string, exec?: PrExec): Promise<WaitState | null>;
}

/** The `job_pr` row in its read shape, with times resolved by the caller that needs them. */
export interface PublicationState {
    repo: string;
    prNumber: number;
    prUrl: string;
    headBranch: string;
    baseBranch: string;
}

interface WaitRow {
    reason: string;
    repo: string;
    pr_number: number;
    pending: number;
    last_delivery_id: string | null;
    active_at: Date | string;
    completed_at: Date | string | null;
    cancelled_at: Date | string | null;
    terminal_reason: string | null;
    last_event_at: Date | string | null;
}

const waitState = (row: WaitRow): WaitState => ({
    reason: row.reason,
    repo: row.repo,
    prNumber: row.pr_number,
    pending: row.pending,
    lastDeliveryId: row.last_delivery_id,
    activeAt: (row.active_at instanceof Date ? row.active_at : new Date(row.active_at)).toISOString(),
    completedAt: stampOf(row.completed_at),
    cancelledAt: stampOf(row.cancelled_at),
    terminalReason: row.terminal_reason,
    lastEventAt: stampOf(row.last_event_at),
});

const stampOf = (value: Date | string | null): string | null =>
    value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

export function createPrLifecycleStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
}): PrLifecycleStore {
    const gate = async () => {
        if (ready) await ready;
    };
    const conn = (exec?: PrExec): Sql => (exec ?? sql) as Sql;

    // runInTx keeps the atomic pair (record-then-fold, select-lock-then-reset) intact whether the
    // caller handed a transaction (its commit owns the atomicity) or the pool (the method's own
    // transaction does).
    const runInTx = async <T>(fn: (tx: TransactionSql) => Promise<T>, exec?: PrExec): Promise<T> => {
        if (exec !== undefined) return fn(exec as TransactionSql);
        const begin = sql.begin as (cb: (tx: TransactionSql) => Promise<T>) => Promise<T>;
        return begin(fn);
    };

    return {
        async recordPublication(input, exec) {
            await gate();
            await conn(exec)`insert into job_pr (org_id, root_job_id, repo, pr_number, pr_url, head_branch, base_branch)
                       values (${orgId}, ${input.root}, ${input.repo}, ${input.prNumber}, ${input.prUrl}, ${input.headBranch}, ${input.baseBranch})
                       on conflict (org_id, root_job_id) do update set
                           repo = excluded.repo,
                           pr_number = excluded.pr_number,
                           pr_url = excluded.pr_url,
                           head_branch = excluded.head_branch,
                           base_branch = excluded.base_branch,
                           updated_at = now()`;
        },

        async publicationOf(root, exec) {
            await gate();
            const rows = await conn(exec)<
                { repo: string; pr_number: number; pr_url: string; head_branch: string; base_branch: string }[]
            >`
                select repo, pr_number, pr_url, head_branch, base_branch
                from job_pr
                where org_id = ${orgId} and root_job_id = ${root}
            `;
            const row = rows[0];
            if (!row) return null;
            return {
                repo: row.repo,
                prNumber: row.pr_number,
                prUrl: row.pr_url,
                headBranch: row.head_branch,
                baseBranch: row.base_branch,
            };
        },

        async enterWait({ root, reason, repo, prNumber }, exec) {
            await gate();
            await conn(exec)`
                insert into workflow_wait (org_id, root_job_id, reason, repo, pr_number)
                values (${orgId}, ${root}, ${reason}, ${repo}, ${prNumber})
                on conflict (org_id, root_job_id, reason) do update set
                    -- A TERMINAL wait re-entered starts a NEW cycle: the reason waits again from a
                    -- clean counter and cursor, whatever the previous cycle folded. An ACTIVE wait
                    -- re-entered is a no-op — its folded deliveries are not thrown away.
                    repo = excluded.repo,
                    pr_number = excluded.pr_number,
                    active_at = now(),
                    completed_at = null,
                    cancelled_at = null,
                    terminal_reason = null,
                    pending = 0,
                    last_delivery_id = null,
                    last_event_at = null
                where workflow_wait.completed_at is not null or workflow_wait.cancelled_at is not null
            `;
            const rows = await conn(exec)<WaitRow[]>`
                select reason, repo, pr_number, pending, last_delivery_id, active_at,
                       completed_at, cancelled_at, terminal_reason, last_event_at
                from workflow_wait
                where org_id = ${orgId} and root_job_id = ${root} and reason = ${reason}
            `;
            // The upsert always leaves a row — the primary key makes this unreachable, and the
            // non-null assertion is the receipt the store's shape promises.
            return waitState(rows[0]!);
        },

        async finishWait(root, reason, terminalReason, exec) {
            await gate();
            const rows = await conn(exec)<{ root_job_id: string }[]>`
                update workflow_wait set
                    completed_at = coalesce(completed_at, now()),
                    terminal_reason = coalesce(terminal_reason, ${terminalReason ?? null})
                where org_id = ${orgId} and root_job_id = ${root} and reason = ${reason}
                  and completed_at is null and cancelled_at is null
                returning root_job_id
            `;
            return rows[0] !== undefined;
        },

        async cancelWait(root, reason, terminalReason, exec) {
            await gate();
            const rows = await conn(exec)<{ root_job_id: string }[]>`
                update workflow_wait set
                    cancelled_at = coalesce(cancelled_at, now()),
                    terminal_reason = coalesce(terminal_reason, ${terminalReason ?? null})
                where org_id = ${orgId} and root_job_id = ${root} and reason = ${reason}
                  and completed_at is null
                returning root_job_id
            `;
            return rows[0] !== undefined;
        },

        async cancelWaitsForRoot(root, terminalReason, exec) {
            await gate();
            const rows = await conn(exec)<{ root_job_id: string }[]>`
                update workflow_wait set
                    cancelled_at = coalesce(cancelled_at, now()),
                    terminal_reason = coalesce(terminal_reason, ${terminalReason ?? null})
                where org_id = ${orgId} and root_job_id = ${root}
                  and completed_at is null and cancelled_at is null
                returning root_job_id
            `;
            return rows.length;
        },

        async cancelForRepoPr(repo, prNumber, terminalReason, exec) {
            await gate();
            const rows = await conn(exec)<{ root_job_id: string }[]>`
                update workflow_wait set
                    cancelled_at = coalesce(cancelled_at, now()),
                    terminal_reason = coalesce(terminal_reason, ${terminalReason ?? null})
                where org_id = ${orgId} and repo = ${repo} and pr_number = ${prNumber}
                  and completed_at is null and cancelled_at is null
                returning root_job_id
            `;
            return rows.length;
        },

        async recordDelivery({ deliveryId, event, action, repo, prNumber }, exec) {
            await gate();
            // The insert-or-conflict is the whole gate: only the runner of the insert folds, so a
            // redelivery that races the original still folds exactly once.
            return runInTx(async (tx) => {
                const [recorded] = await tx<{ delivery_id: string }[]>`
                    insert into github_delivery (delivery_id, event, action, repo, pr_number)
                    values (${deliveryId}, ${event}, ${action}, ${repo}, ${prNumber})
                    on conflict (delivery_id) do nothing
                    returning delivery_id
                `;
                if (!recorded) return 'duplicate';

                await tx`delete from github_delivery where seen_at < now() - interval '7 days'`;

                const [wait] = await tx<{ root_job_id: string }[]>`
                    update workflow_wait set
                        pending = pending + 1,
                        last_delivery_id = ${deliveryId},
                        last_event_at = now()
                    where org_id = ${orgId}
                      and repo = ${repo}
                      and pr_number = ${prNumber}
                      and completed_at is null
                      and cancelled_at is null
                    returning root_job_id
                `;
                return wait === undefined ? 'unmatched' : 'folded';
            }, exec);
        },

        async claimReview(root, reason, exec) {
            await gate();
            return runInTx(async (tx) => {
                // The lock is the claim: deliveries fold (`pending = pending + 1`) against this
                // row, serialize behind it, and anything that lands after this statement reads the
                // reset zero. The claimed count is the pre-reset value, returned beside the cursor
                // the block resumes from.
                const [row] = await tx<{ pending: number; last_delivery_id: string | null }[]>`
                    select pending, last_delivery_id
                    from workflow_wait
                    where org_id = ${orgId} and root_job_id = ${root} and reason = ${reason}
                      and completed_at is null and cancelled_at is null
                    for update
                `;
                if (!row) return { pending: 0, lastDeliveryId: null };
                await tx`
                    update workflow_wait set pending = 0
                    where org_id = ${orgId} and root_job_id = ${root} and reason = ${reason}
                `;
                return { pending: row.pending, lastDeliveryId: row.last_delivery_id };
            }, exec);
        },

        async waitOf(root, exec) {
            await gate();
            const rows = await conn(exec)<WaitRow[]>`
                select reason, repo, pr_number, pending, last_delivery_id, active_at,
                       completed_at, cancelled_at, terminal_reason, last_event_at
                from workflow_wait
                where org_id = ${orgId} and root_job_id = ${root}
                -- The open wait first, then the most recently active terminal one — the one
                -- summary a task's read model can show.
                order by (completed_at is null and cancelled_at is null) desc, active_at desc
                limit 1
            `;
            return rows[0] ? waitState(rows[0]) : null;
        },
    };
}
