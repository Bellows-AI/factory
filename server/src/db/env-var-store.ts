import type { Fragment, Sql, TransactionSql } from 'postgres';

/**
 * One entry in a PUT body. `value: null` is legal ONLY for a secret, and means "keep whatever is
 * stored" — the write-only escape hatch that lets a browser edit a scope's list without ever
 * seeing, or re-sending, the secret values it holds. A name omitted from the body deletes the row.
 */
export interface EnvVarEntry {
    name: string;
    value: string | null;
    isSecret: boolean;
}

/** What the list routes echo. A secret's `value` is null for every caller — see listScoped. */
export interface EnvVarRow extends EnvVarEntry {
    readonly updatedAt: string;
}

export interface EnvVarStore {
    listOrg(): Promise<EnvVarRow[]>;
    listWorkspace(userId: string): Promise<EnvVarRow[]>;
    listRepo(owner: string, name: string): Promise<EnvVarRow[]>;
    /** Every repo scope's rows, grouped, for the page's per-repository editors. */
    listRepos(): Promise<{ owner: string; name: string; vars: EnvVarRow[] }[]>;
    replaceOrg(vars: readonly EnvVarEntry[]): Promise<void>;
    replaceWorkspace(userId: string, vars: readonly EnvVarEntry[]): Promise<void>;
    replaceRepo(owner: string, name: string, vars: readonly EnvVarEntry[]): Promise<void>;
    /**
     * The merged environment one claim carries: org < workspace < repo, the more specific scope
     * winning a name collision. `userId` null contributes no workspace level (an unattributed
     * job); `repo` null contributes no repo level. Returns real values — secrets included —
     * because injection is what they are for; every other read path goes through the list
     * methods, which never echo one.
     *
     * `exec` lets a caller run the read on an executor it already holds (the job store's claim
     * passes its transaction, so a claim holds one connection, never two) — the pool by default.
     */
    resolveFor(
        target: { userId: string | null; repo: string | null },
        exec?: Sql | TransactionSql,
    ): Promise<Record<string, string>>;
}

interface Row {
    name: string;
    value: string | null;
    is_secret: boolean;
    updated_at: Date;
}

const toRow = (row: Row): EnvVarRow => ({
    name: row.name,
    value: row.value,
    isSecret: row.is_secret,
    updatedAt: row.updated_at.toISOString(),
});

/**
 * The stacking rule, in one place and pure: `org` first, `workspace` over it, `repo` over that —
 * the issue's "everything should stack upon each other", and the GitHub Actions precedence
 * (repository beats organization). Exported because a rule this load-bearing is pinned by the
 * offline suite, which cannot reach the SQL that feeds it.
 */
export function stackEnv(
    org: Record<string, string>,
    workspace: Record<string, string>,
    repo: Record<string, string>,
): Record<string, string> {
    return { ...org, ...workspace, ...repo };
}

/**
 * Which of the three scopes a method call addresses. One shape, so the list and the replace paths
 * share their where-clauses instead of restating them — and so a fourth scope, if one ever lands,
 * is a case here and not a search for every query in the file.
 */
type Scope =
    | { kind: 'org' }
    | { kind: 'workspace'; userId: string }
    | { kind: 'repo'; owner: string; name: string };

/**
 * The scope's predicate, built off whichever executor (pool or transaction) will run it — a
 * fragment is bound to nothing, but building it from the transaction's own tag keeps every
 * parameter inside the one prepared statement.
 */
const scopeWhere = (exec: Sql | TransactionSql, scope: Scope): Fragment => {
    switch (scope.kind) {
        case 'org':
            return exec`and user_id is null and repo_owner is null`;
        case 'workspace':
            return exec`and user_id = ${scope.userId}`;
        case 'repo':
            return exec`and repo_owner = ${scope.owner} and repo_name = ${scope.name}`;
    }
};

/**
 * The organization is bound at construction, for the reason createPrStore's header gives.
 *
 * `ready` gates every query, the way every other store built in index.ts does: migrations retry
 * with backoff while the database container starts, and a boot that raced them would answer 503s
 * for a moment rather than crash.
 */
export function createEnvVarStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
}): EnvVarStore {
    const gate = async () => {
        if (ready) await ready;
    };

    /**
     * The read the page gets. A secret's value is nulled out IN THE SELECT, not dropped on the way
     * through JavaScript — the row still travels (name, updatedAt, the fact that it is a secret),
     * only the value is withheld, which is what lets the UI render "set" without holding it.
     */
    const listScoped = async (scope: Scope): Promise<EnvVarRow[]> => {
        const rows = await sql<Row[]>`
            select name,
                   case when is_secret then null else value end as value,
                   is_secret, updated_at
            from env_var
            where org_id = ${orgId} ${scopeWhere(sql, scope)}
            order by name asc
        `;
        return rows.map(toRow);
    };

    /**
     * The one replace, parameterised by scope — delete-then-insert inside a transaction, the
     * user-executor-store shape. The difference is the keep set: a whole-list PUT must not force
     * the client to re-send secret values it can never read, so a secret whose incoming entry
     * carries `value: null` survives the delete and is NOT re-inserted. Omitted names still
     * delete; non-secret rows never survive (their value is readable, so a client editing the
     * scope always has it to send back).
     */
    const replaceScoped = async (scope: Scope, vars: readonly EnvVarEntry[]): Promise<void> => {
        await gate();
        await sql.begin(async (tx) => {
            const keep = vars.filter((v) => v.isSecret && v.value === null).map((v) => v.name);
            if (keep.length) {
                await tx`
                    delete from env_var
                    where org_id = ${orgId} ${scopeWhere(tx, scope)}
                      and name not in ${tx(keep)}
                `;
            } else {
                await tx`
                    delete from env_var where org_id = ${orgId} ${scopeWhere(tx, scope)}
                `;
            }
            const insert = vars.filter((v) => v.value !== null);
            if (insert.length) {
                // The scope columns ride on every row: null for the scopes a row is not in, the
                // scope check enforcing exactly one set.
                const rows = insert.map((v) => ({
                    org_id: orgId,
                    user_id: scope.kind === 'workspace' ? scope.userId : null,
                    repo_owner: scope.kind === 'repo' ? scope.owner : null,
                    repo_name: scope.kind === 'repo' ? scope.name : null,
                    name: v.name,
                    value: v.value as string,
                    is_secret: v.isSecret,
                }));
                await tx`
                    insert into env_var ${tx(rows, 'org_id', 'user_id', 'repo_owner', 'repo_name', 'name', 'value', 'is_secret')}
                `;
            }
        });
    };

    return {
        async listOrg() {
            await gate();
            return listScoped({ kind: 'org' });
        },

        async listWorkspace(userId) {
            await gate();
            return listScoped({ kind: 'workspace', userId });
        },

        async listRepo(owner, name) {
            await gate();
            return listScoped({ kind: 'repo', owner, name });
        },

        async listRepos() {
            await gate();
            const rows = await sql<(Row & { repo_owner: string; repo_name: string })[]>`
                select repo_owner, repo_name, name,
                       case when is_secret then null else value end as value,
                       is_secret, updated_at
                from env_var
                where org_id = ${orgId} and repo_owner is not null
                order by repo_owner asc, repo_name asc, name asc
            `;
            const grouped: { owner: string; name: string; vars: EnvVarRow[] }[] = [];
            for (const row of rows) {
                let group = grouped.find((g) => g.owner === row.repo_owner && g.name === row.repo_name);
                if (!group) {
                    group = { owner: row.repo_owner, name: row.repo_name, vars: [] };
                    grouped.push(group);
                }
                group.vars.push(toRow(row));
            }
            return grouped;
        },

        async replaceOrg(vars) {
            await replaceScoped({ kind: 'org' }, vars);
        },

        async replaceWorkspace(userId, vars) {
            await replaceScoped({ kind: 'workspace', userId }, vars);
        },

        async replaceRepo(owner, name, vars) {
            await replaceScoped({ kind: 'repo', owner, name }, vars);
        },

        async resolveFor({ userId, repo }, exec = sql) {
            await gate();
            const [owner, name] = repo ? repo.split('/') : [null, null];
            // One round trip for all three levels. The predicates degrade on their own: a null
            // userId makes `user_id = null` never true, so an unattributed job reads no workspace
            // level — the same for a null repo. The scope check guarantees a row matched by the
            // workspace arm is a workspace row, so the case below can label it.
            const rows = await (exec as Sql)<{ name: string; value: string; scope: 'org' | 'workspace' | 'repo' }[]>`
                select name, value,
                       case
                           when user_id is not null then 'workspace'
                           when repo_owner is not null then 'repo'
                           else 'org'
                       end as scope
                from env_var
                where org_id = ${orgId}
                  and (
                      (user_id is null and repo_owner is null)
                      or user_id = ${userId}
                      or (repo_owner = ${owner} and repo_name = ${name})
                  )
            `;
            const pick = (scope: string): Record<string, string> =>
                Object.fromEntries(rows.filter((row) => row.scope === scope).map((row) => [row.name, row.value]));
            return stackEnv(pick('org'), pick('workspace'), pick('repo'));
        },
    };
}
