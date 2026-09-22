import type { Sql } from 'postgres';

export interface DefaultWorkflowSettings {
    readonly reviewReconciliation: boolean;
    readonly mergeConflictAutofix: boolean;
    /** ISO 8601 once a row exists; null while the member has never saved. */
    readonly updatedAt: string | null;
}

/** A missing row means both steps are on — see 035's header. Never written by `get`. */
export const BOTH_ENABLED: DefaultWorkflowSettings = {
    reviewReconciliation: true,
    mergeConflictAutofix: true,
    updatedAt: null,
};

export interface DefaultWorkflowSettingsStore {
    /** The member's saved pair, or `BOTH_ENABLED` when no row exists. Never writes. */
    get(userId: string): Promise<DefaultWorkflowSettings>;
    /** Atomic upsert of the complete pair; answers the stored representation. */
    put(
        userId: string,
        value: { reviewReconciliation: boolean; mergeConflictAutofix: boolean }
    ): Promise<DefaultWorkflowSettings>;
}

interface Row {
    review_reconciliation: boolean;
    merge_conflict_autofix: boolean;
    updated_at: Date;
}

const toSettings = (row: Row): DefaultWorkflowSettings => ({
    reviewReconciliation: row.review_reconciliation,
    mergeConflictAutofix: row.merge_conflict_autofix,
    updatedAt: row.updated_at.toISOString(),
});

/** The organization is bound at construction, for the reason createUserExecutorStore's header gives. */
export function createDefaultWorkflowSettingsStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
}): DefaultWorkflowSettingsStore {
    const gate = async () => {
        if (ready) await ready;
    };

    return {
        async get(userId) {
            await gate();
            const rows = await sql<Row[]>`
                select review_reconciliation, merge_conflict_autofix, updated_at
                from user_workflow_default
                where org_id = ${orgId} and user_id = ${userId}
            `;
            const row = rows[0];
            return row ? toSettings(row) : { ...BOTH_ENABLED };
        },

        async put(userId, value) {
            await gate();
            // A plain upsert, not a transaction: one statement is already atomic, and
            // `updated_at` moves only here — the read path above never inserts a row.
            const rows = await sql<Row[]>`
                insert into user_workflow_default (org_id, user_id, review_reconciliation, merge_conflict_autofix)
                values (${orgId}, ${userId}, ${value.reviewReconciliation}, ${value.mergeConflictAutofix})
                on conflict (org_id, user_id) do update
                    set review_reconciliation = excluded.review_reconciliation,
                        merge_conflict_autofix = excluded.merge_conflict_autofix,
                        updated_at = now()
                returning review_reconciliation, merge_conflict_autofix, updated_at
            `;
            return toSettings(rows[0]!);
        },
    };
}
