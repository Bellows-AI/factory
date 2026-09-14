import type { Sql, TransactionSql } from 'postgres';

export interface UserExecutor {
    readonly name: string;
    readonly type: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/** What `configFor` answers: the row's type and the raw config the member pasted. */
export interface UserExecutorConfig {
    readonly type: string;
    readonly config: Record<string, unknown>;
}

export interface UserExecutorStore {
    /**
     * Replaces a member's whole executor list.
     *
     * The body of `PUT /api/workspace/executors` is the entire list, so this is delete-then-insert:
     * replaying the same body changes nothing, which is what makes the route a PUT. Unlike
     * user_repo there is nothing to preserve — a row tracks no disk state, so "keeping" an omitted
     * executor would only contradict the body the member just sent.
     */
    replace(
        userId: string,
        executors: readonly { name: string; type: string; config: Record<string, unknown> }[]
    ): Promise<void>;
    list(userId: string): Promise<UserExecutor[]>;
    /**
     * The whole list WITH its pasted configs — the on-demand read the workspace's edit dialog
     * opens with. `list()` deliberately never selects `config` because it feeds a two-second poll;
     * this is the member asking for their own rows back so an executor can be edited, and it is
     * fetched once per dialog open, never polled.
     */
    listWithConfigs(userId: string): Promise<(UserExecutor & { config: Record<string, unknown> })[]>;
    /**
     * The one executor row a task label names, WITH its pasted config — the claim-time read the
     * job store makes to hand a runner the member's own executor configuration
     * (`OPENCODE_CONFIG_CONTENT`). `list()` deliberately never selects `config`, because it feeds
     * a two-second poll; this is the one read that must, and it runs on the claim's transaction
     * for the same reason the env resolver does: a claim holds one connection, so enough
     * concurrent claims can never wedge the pool against itself.
     */
    configFor(userId: string, name: string, exec?: Sql | TransactionSql): Promise<UserExecutorConfig | null>;
}

interface Row {
    name: string;
    type: string;
    created_at: Date;
    updated_at: Date;
}

const toUserExecutor = (row: Row): UserExecutor => ({
    name: row.name,
    type: row.type,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
});

/** The organization is bound at construction, for the reason createUserRepoStore's header gives. */
export function createUserExecutorStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
}): UserExecutorStore {
    const gate = async () => {
        if (ready) await ready;
    };

    return {
        async replace(userId, executors) {
            await gate();
            await sql.begin(async (tx) => {
                await tx`
                    delete from user_executor
                    where org_id = ${orgId} and user_id = ${userId}
                `;
                if (executors.length) {
                    const rows = executors.map((executor) => ({
                        org_id: orgId,
                        user_id: userId,
                        name: executor.name,
                        type: executor.type,
                        config: executor.config as never,
                    }));
                    await tx`
                        insert into user_executor ${tx(rows, 'org_id', 'user_id', 'name', 'type', 'config')}
                    `;
                }
            });
        },

        async list(userId) {
            await gate();
            // `config` is deliberately not selected: the routes echo these rows on every poll, and
            // pasted config may hold credentials.
            const rows = await sql<Row[]>`
                select name, type, created_at, updated_at
                from user_executor
                where org_id = ${orgId} and user_id = ${userId}
                order by created_at asc, name asc
            `;
            return rows.map(toUserExecutor);
        },

        async listWithConfigs(userId) {
            await gate();
            const rows = await sql<(Row & { config: Record<string, unknown> })[]>`
                select name, type, created_at, updated_at, config
                from user_executor
                where org_id = ${orgId} and user_id = ${userId}
                order by created_at asc, name asc
            `;
            return rows.map((row) => ({ ...toUserExecutor(row), config: row.config }));
        },

        async configFor(userId, name, exec = sql) {
            await gate();
            // The primary key is (org_id, user_id, name), so a label names at most one row per
            // member — the read cannot be ambiguous.
            const rows = await (exec as Sql)<{ type: string; config: Record<string, unknown> }[]>`
                select type, config
                from user_executor
                where org_id = ${orgId} and user_id = ${userId} and name = ${name}
            `;
            const row = rows[0];
            return row ? { type: row.type, config: row.config } : null;
        },
    };
}
