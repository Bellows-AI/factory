import type { Sql, TransactionSql } from 'postgres';
import { DEFAULT_GATE_FIX_ROUNDS, ORG_SCOPE, USER_SCOPE, type ExecutorScope } from '@factory-ai/core';

/**
 * One executor profile: a member's personal row (`userId` set) or an organization-wide row the
 * administrators manage and every member may select (issue 391). The table is one, with sibling
 * scopes — 027_workflows.sql's shape — so the nullness of the owner is the scope, and a scope
 * column would say the same thing twice.
 */
export interface ExecutorProfile {
    /** The surrogate key (047): org CRUD and scope changes address rows by it. */
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    /**
     * The default workflow's gate-repair round limit this row launches with (issue #49): bounded
     * 0-10, 3 when unset, 0 disables automatic repair. Read once at launch, frozen onto the
     * thread's root row — editing it later changes later tasks, never a running thread.
     */
    readonly gateFixRounds: number;
    /**
     * The administrator who created (or last promoted) an org-scope row — an audit fact, not an
     * ownership. Null on personal rows, whose `userId`-keyed whole-list PUT has no creator apart
     * from the owner.
     */
    readonly createdBy: string | null;
    /**
     * Taken out of service (issue 440): still listed, configured and owned, but not selectable, not
     * a valid default, and refused at submission and claim. Resuming clears it.
     */
    readonly suspended: boolean;
}

/** What `configFor` answers: the row's type, the raw config the member pasted, its round limit and whether it is suspended. */
export interface UserExecutorConfig {
    readonly type: string;
    readonly config: Record<string, unknown>;
    readonly gateFixRounds: number;
    readonly suspended: boolean;
}

/**
 * A member's default-executor preference (issue 391): names a profile by scope and name — not by
 * the surrogate id, because `replace()` still delete-and-reinserts the personal list and an
 * id-keyed link would be severed by every save. Resolved through `resolvedDefault`, whose chain
 * covers a preference whose profile was removed.
 */
export interface ExecutorDefault {
    readonly scope: ExecutorScope;
    readonly name: string;
}

export interface UserExecutorStore {
    /**
     * Replaces a member's whole PERSONAL executor list.
     *
     * The body of `PUT /api/workspace/executors` is the entire list, so this is delete-then-insert:
     * replaying the same body changes nothing, which is what makes the route a PUT. Unlike
     * user_repo there is nothing to preserve — a row tracks no disk state, so "keeping" an omitted
     * executor would only contradict the body the member just sent. Org-scope rows are never
     * touched: they belong to the organization, and the admin CRUD routes are their only writers.
     */
    replace(
        userId: string,
        executors: readonly {
            name: string;
            type: string;
            config: Record<string, unknown>;
            gateFixRounds?: number;
            /** Omitted: the suspension a row of the same name already carried survives the rewrite. */
            suspended?: boolean;
        }[]
    ): Promise<void>;
    /** Removes one of the member's OWN personal rows by id. False when the id names no such row. */
    removePersonal(userId: string, id: string): Promise<boolean>;
    /** Suspends or resumes one of the member's OWN personal rows. Null when the id names no such row. */
    setPersonalSuspended(userId: string, id: string, suspended: boolean): Promise<ExecutorProfile | null>;
    /** Suspends or resumes an org-scope row. Null when the id names no org row of this organization. */
    setOrgSuspended(id: string, suspended: boolean): Promise<ExecutorProfile | null>;
    list(userId: string): Promise<ExecutorProfile[]>;
    /**
     * The whole list WITH its pasted configs — the on-demand read the workspace's edit dialog
     * opens with. `list()` deliberately never selects `config` because it feeds a two-second poll;
     * this is the member asking for their own rows back so an executor can be edited, and it is
     * fetched once per dialog open, never polled.
     */
    listWithConfigs(userId: string): Promise<(ExecutorProfile & { config: Record<string, unknown> })[]>;
    /**
     * The one executor row a task selection names, WITH its pasted config — the claim-time read
     * the job store makes to hand a runner the member's own executor configuration
     * (`OPENCODE_CONFIG_CONTENT` / `CLAUDE_CODE_CONFIG_CONTENT`). The scope disambiguates a
     * personal and an org row sharing a name; there is no cross-scope fallback, because a
     * selection names its scope explicitly. `list()` deliberately never selects `config`, because
     * it feeds a two-second poll; this is the one read that must, and it runs on the claim's
     * transaction for the same reason the env resolver does: a claim holds one connection, so
     * enough concurrent claims can never wedge the pool against itself.
     */
    configFor(
        userId: string,
        name: string,
        scope?: ExecutorScope,
        exec?: Sql | TransactionSql
    ): Promise<UserExecutorConfig | null>;

    /** The organization's profiles, in management order. Never carries configs — poll-shaped. */
    listOrg(): Promise<ExecutorProfile[]>;
    /** The org profiles WITH configs — the admin list's read, the edit dialog's opening state. */
    listOrgWithConfigs(): Promise<(ExecutorProfile & { config: Record<string, unknown> })[]>;
    /** Creates an org-scope row. Duplicate name in the org scope surfaces as the name index. */
    createOrg(input: {
        name: string;
        type: string;
        config: Record<string, unknown>;
        gateFixRounds?: number;
        createdBy: string;
    }): Promise<ExecutorProfile & { config: Record<string, unknown> }>;
    /**
     * Edits an org-scope row in place. Null when the id names no org row of this organization —
     * a personal row is not addressable through the org CRUD surface.
     */
    updateOrg(
        id: string,
        patch: { name?: string; type?: string; config?: Record<string, unknown>; gateFixRounds?: number }
    ): Promise<(ExecutorProfile & { config: Record<string, unknown> }) | null>;
    /** Removes an org-scope row. False when the id names no org row of this organization. */
    deleteOrg(id: string): Promise<boolean>;
    /**
     * Moves one row between scopes: a member's own personal row up to org scope (issue 391), or an
     * org row down into the calling admin's personal list. Only the caller's OWN personal row
     * promotes — the update's WHERE clause holds that, so the route's caller is the enforcement.
     * A name already taken in the target scope surfaces as the name index.
     */
    changeScope(id: string, to: ExecutorScope, userId: string): Promise<ExecutorProfile | null>;
    /** How many org-scope rows the organization holds — the cap check's read. */
    orgCount(): Promise<number>;

    /** The member's stored preference, verbatim. Null when unset. */
    defaultOf(userId: string): Promise<ExecutorDefault | null>;
    /**
     * Stores the member's preference. Refuses a preference naming no profile in that scope — the
     * route answers 404 for a selection the member cannot resolve, and this is the check under it —
     * and a suspended one (`ExecutorSuspendedError`, a 409).
     */
    setDefault(userId: string, def: ExecutorDefault): Promise<void>;
    /**
     * The preference as the composer may act on it, through the deterministic fallback chain: the
     * stored preference while it still resolves to an ACTIVE row, then the first active personal
     * row by position, then the first active org row by position, then null. A removed or
     * suspended profile's preference falls through — it is never silently re-pointed at another
     * row, and a suspended one stays stored so resuming restores it.
     */
    resolvedDefault(userId: string): Promise<ExecutorDefault | null>;
}

/**
 * What `setDefault` is not (issue 391): the one refusal it raises, thrown when the preference
 * names no profile in the named scope. The route maps it to a 404; anything else it throws is a
 * failure, not an answer, and must reach the error handler as one.
 */
export class ExecutorDefaultNotFoundError extends Error {}

/** `setDefault`'s other refusal (issue 440): the preference names a suspended profile. The route maps it to a 409. */
export class ExecutorSuspendedError extends Error {}

interface Row {
    id: string;
    name: string;
    type: string;
    created_at: Date;
    updated_at: Date;
    gate_fix_rounds: number;
    created_by: string | null;
    suspended: boolean;
}

const toExecutorProfile = (row: Row): ExecutorProfile => ({
    id: row.id,
    name: row.name,
    type: row.type,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    gateFixRounds: row.gate_fix_rounds,
    createdBy: row.created_by,
    suspended: row.suspended,
});

/** `replace()`'s transaction body: the member's personal list, delete-then-insert. */
async function replacePersonalRows(
    tx: TransactionSql,
    orgId: string,
    userId: string,
    executors: Parameters<UserExecutorStore['replace']>[1]
): Promise<void> {
    // Read before the delete: an entry that does not say otherwise keeps the suspension its
    // same-named predecessor carried (issue 440).
    const suspendedNames = new Set(
        (
            await tx<{ name: string }[]>`
                select name from executor_profile
                where org_id = ${orgId} and user_id = ${userId} and suspended
            `
        ).map((row) => row.name)
    );
    await tx`
        delete from executor_profile
        where org_id = ${orgId} and user_id = ${userId}
    `;
    if (!executors.length) return;
    // `position` is the member's own order, taken from the array index. It has to be stored rather
    // than inferred: this is one transaction, so every row lands with the same `now()` and a
    // created_at sort is a total tie (041's header).
    const rows = executors.map((executor, index) => ({
        org_id: orgId,
        user_id: userId,
        name: executor.name,
        type: executor.type,
        config: executor.config as never,
        gate_fix_rounds: executor.gateFixRounds ?? DEFAULT_GATE_FIX_ROUNDS,
        position: index,
        suspended: executor.suspended ?? suspendedNames.has(executor.name),
    }));
    await tx`
        insert into executor_profile
            ${tx(rows, 'org_id', 'user_id', 'name', 'type', 'config', 'gate_fix_rounds', 'position', 'suspended')}
    `;
}

/**
 * The by-id writes (issue 440) address a row by its id AND its owner — `owner` null is the org
 * scope — so another member's id, an org id reached through the personal door and an id from
 * another organization all match nothing.
 */
async function deleteOwnedRow(
    sql: Sql,
    { orgId, id, owner }: { orgId: string; id: string; owner: string }
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        delete from executor_profile
        where org_id = ${orgId} and id = ${id} and user_id = ${owner}
        returning id
    `;
    return rows.length > 0;
}

async function setSuspendedRow(
    sql: Sql,
    { orgId, id, owner, suspended }: { orgId: string; id: string; owner: string | null; suspended: boolean }
): Promise<ExecutorProfile | null> {
    const rows = await sql<Row[]>`
        update executor_profile set suspended = ${suspended}, updated_at = now()
        where org_id = ${orgId} and id = ${id} and user_id is not distinct from ${owner}
        returning id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended
    `;
    return rows[0] ? toExecutorProfile(rows[0]) : null;
}

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

    /** The next `position` at the end of the given scope's list — org rows and each member's rows. */
    const nextPosition = async (exec: Sql | TransactionSql, userId: string | null): Promise<number> => {
        const rows = await exec<{ next: number }[]>`
            select coalesce(max(position) + 1, 0) as next
            from executor_profile
            where org_id = ${orgId} and user_id is not distinct from ${userId}
        `;
        return rows[0]?.next ?? 0;
    };

    return {
        async replace(userId, executors) {
            await gate();
            await sql.begin((tx) => replacePersonalRows(tx, orgId, userId, executors));
        },

        async removePersonal(userId, id) {
            await gate();
            return deleteOwnedRow(sql, { orgId, id, owner: userId });
        },

        async setPersonalSuspended(userId, id, suspended) {
            await gate();
            return setSuspendedRow(sql, { orgId, id, owner: userId, suspended });
        },

        async setOrgSuspended(id, suspended) {
            await gate();
            return setSuspendedRow(sql, { orgId, id, owner: null, suspended });
        },

        async list(userId) {
            await gate();
            // `config` is deliberately not selected: the routes echo these rows on every poll, and
            // pasted config may hold credentials.
            const rows = await sql<Row[]>`
                select id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended
                from executor_profile
                where org_id = ${orgId} and user_id = ${userId}
                order by position asc, name asc
            `;
            return rows.map(toExecutorProfile);
        },

        async listWithConfigs(userId) {
            await gate();
            const rows = await sql<(Row & { config: Record<string, unknown> })[]>`
                select id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, config
                from executor_profile
                where org_id = ${orgId} and user_id = ${userId}
                order by position asc, name asc
            `;
            return rows.map((row) => ({ ...toExecutorProfile(row), config: row.config }));
        },

        async configFor(userId, name, scope = USER_SCOPE, exec = sql) {
            await gate();
            // The scope's ownership plus the name names at most one row — the org scope keys on a
            // NULL owner, the personal scope on the caller's id — so the read cannot be ambiguous,
            // and a name that exists in the other scope is simply not this selection's answer.
            const rows = await (exec as Sql)<
                { type: string; config: Record<string, unknown>; gate_fix_rounds: number; suspended: boolean }[]
            >`
                select type, config, gate_fix_rounds, suspended
                from executor_profile
                where org_id = ${orgId}
                  and user_id is not distinct from ${scope === USER_SCOPE ? userId : null}
                  and name = ${name}
            `;
            const row = rows[0];
            return row
                ? { type: row.type, config: row.config, gateFixRounds: row.gate_fix_rounds, suspended: row.suspended }
                : null;
        },

        async listOrg() {
            await gate();
            const rows = await sql<Row[]>`
                select id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended
                from executor_profile
                where org_id = ${orgId} and user_id is null
                order by position asc, name asc
            `;
            return rows.map(toExecutorProfile);
        },

        async listOrgWithConfigs() {
            await gate();
            const rows = await sql<(Row & { config: Record<string, unknown> })[]>`
                select id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, config
                from executor_profile
                where org_id = ${orgId} and user_id is null
                order by position asc, name asc
            `;
            return rows.map((row) => ({ ...toExecutorProfile(row), config: row.config }));
        },

        async createOrg(input) {
            await gate();
            const position = await nextPosition(sql, null);
            const rows = await sql<(Row & { config: Record<string, unknown> })[]>`
                insert into executor_profile (org_id, user_id, name, type, config, gate_fix_rounds, position, created_by)
                values (
                    ${orgId}, null, ${input.name}, ${input.type}, ${input.config as never},
                    ${input.gateFixRounds ?? DEFAULT_GATE_FIX_ROUNDS}, ${position}, ${input.createdBy}
                )
                returning id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, config
            `;
            const row = rows[0];
            if (!row) throw new Error('createOrg returned no row');
            return { ...toExecutorProfile(row), config: row.config };
        },

        async updateOrg(id, patch) {
            await gate();
            const rows = await sql<(Row & { config: Record<string, unknown> })[]>`
                update executor_profile set
                    name = coalesce(${patch.name ?? null}, name),
                    type = coalesce(${patch.type ?? null}, type),
                    config = coalesce(${patch.config ? (patch.config as never) : null}, config),
                    gate_fix_rounds = coalesce(${patch.gateFixRounds ?? null}, gate_fix_rounds),
                    updated_at = now()
                where org_id = ${orgId} and id = ${id} and user_id is null
                returning id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended, config
            `;
            const row = rows[0];
            return row ? { ...toExecutorProfile(row), config: row.config } : null;
        },

        async deleteOrg(id) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                delete from executor_profile
                where org_id = ${orgId} and id = ${id} and user_id is null
                returning id
            `;
            return rows.length > 0;
        },

        async changeScope(id, to, userId) {
            await gate();
            if (to === USER_SCOPE) {
                // Org row down into the calling admin's personal list, at the end of it.
                const rows = await sql.begin(async (tx) => {
                    const position = await nextPosition(tx, userId);
                    return tx<Row[]>`
                        update executor_profile set
                            user_id = ${userId}, position = ${position}, created_by = null, updated_at = now()
                        where org_id = ${orgId} and id = ${id} and user_id is null
                        returning id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended
                    `;
                });
                const row = rows[0];
                return row ? toExecutorProfile(row) : null;
            }
            // The caller's OWN personal row up to org scope. `user_id = ${userId}` in the WHERE is
            // the ownership enforcement at the row: another member's row does not match, and the
            // route's caller check rests on this.
            const rows = await sql.begin(async (tx) => {
                const position = await nextPosition(tx, null);
                return tx<Row[]>`
                    update executor_profile set
                        user_id = null, position = ${position}, created_by = ${userId}, updated_at = now()
                    where org_id = ${orgId} and id = ${id} and user_id = ${userId}
                    returning id, name, type, created_at, updated_at, gate_fix_rounds, created_by, suspended
                `;
            });
            const row = rows[0];
            return row ? toExecutorProfile(row) : null;
        },

        async orgCount() {
            await gate();
            const rows = await sql<{ count: number }[]>`
                select count(*)::int as count from executor_profile
                where org_id = ${orgId} and user_id is null
            `;
            return rows[0]?.count ?? 0;
        },

        async defaultOf(userId) {
            await gate();
            const rows = await sql<{ scope: ExecutorScope; name: string }[]>`
                select scope, name from user_executor_default
                where org_id = ${orgId} and user_id = ${userId}
            `;
            const row = rows[0];
            return row ? { scope: row.scope, name: row.name } : null;
        },

        async setDefault(userId, def) {
            await gate();
            await sql.begin(async (tx) => {
                // The preference must name an accessible profile NOW: a member cannot select —
                // even by default — a profile they could not have picked in the first place.
                const named = await tx<{ name: string; suspended: boolean }[]>`
                    select name, suspended from executor_profile
                    where org_id = ${orgId}
                      and user_id is not distinct from ${def.scope === USER_SCOPE ? userId : null}
                      and name = ${def.name}
                `;
                if (!named[0]) {
                    throw new ExecutorDefaultNotFoundError(`No ${def.scope} executor named "${def.name}"`);
                }
                if (named[0].suspended) {
                    throw new ExecutorSuspendedError(`The ${def.scope} executor "${def.name}" is suspended`);
                }
                await tx`
                    insert into user_executor_default (org_id, user_id, scope, name)
                    values (${orgId}, ${userId}, ${def.scope}, ${def.name})
                    on conflict (org_id, user_id) do update
                    set scope = excluded.scope, name = excluded.name, updated_at = now()
                `;
            });
        },

        async resolvedDefault(userId) {
            await gate();
            const stored = await this.defaultOf(userId);
            const configured = stored ? await this.configFor(userId, stored.name, stored.scope) : null;
            if (stored && configured && !configured.suspended) {
                return stored;
            }
            // The fallback chain, deterministic: first active personal row by position, then first
            // active org row. A member who never chose keeps "selected first on new tasks" semantics.
            const personal = (await this.list(userId)).find((row) => !row.suspended);
            if (personal) return { scope: USER_SCOPE, name: personal.name };
            const orgRow = (await this.listOrg()).find((row) => !row.suspended);
            if (orgRow) return { scope: ORG_SCOPE, name: orgRow.name };
            return null;
        },
    };
}
