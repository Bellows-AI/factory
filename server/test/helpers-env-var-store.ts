import type { EnvVarRow, EnvVarStore } from '../src/db/env-var-store.js';
import { stackEnv } from '../src/db/env-var-store.js';

export interface MemoryEnvVarStore extends EnvVarStore {
    /**
     * Every row with its REAL values, scope columns included — what the routes' nulled echo
     * deliberately withholds.
     */
    rows(): {
        userId: string | null;
        owner: string | null;
        repoName: string | null;
        name: string;
        value: string;
        isSecret: boolean;
    }[];
    /** Set to make every method reject, standing in for an unreachable database. */
    broken: boolean;
}

/**
 * An in-memory EnvVarStore, for the same reason memoryUserExecutorStore exists: it keeps the
 * offline suite a no-database suite while still exercising the write-only echo, the keep-a-null-
 * secret replace rule and the stacking. The SQL behind it is covered by server/test-db, which
 * needs a container.
 */
export function memoryEnvVarStore(): MemoryEnvVarStore {
    interface Row {
        userId: string | null;
        owner: string | null;
        repoName: string | null;
        name: string;
        value: string;
        isSecret: boolean;
        updatedAt: string;
    }
    const rows: Row[] = [];
    const at = () => new Date().toISOString();

    const store: MemoryEnvVarStore = {
        broken: false,

        rows: () =>
            rows.map((r) => ({
                userId: r.userId,
                owner: r.owner,
                repoName: r.repoName,
                name: r.name,
                value: r.value,
                isSecret: r.isSecret,
            })),

        async listOrg() {
            return rows
                .filter((r) => r.userId === null && r.owner === null)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(view);
        },

        async listWorkspace(userId) {
            return rows
                .filter((r) => r.userId === userId)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(view);
        },

        async listRepo(owner, name) {
            return rows
                .filter((r) => r.owner === owner && r.repoName === name)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(view);
        },

        async listRepos() {
            const grouped: { owner: string; name: string; vars: EnvVarRow[] }[] = [];
            for (const row of rows.filter((r) => r.owner !== null).sort(compareRepoOrder)) {
                let group = grouped.find((g) => g.owner === row.owner && g.name === row.repoName);
                if (!group) {
                    group = { owner: row.owner!, name: row.repoName!, vars: [] };
                    grouped.push(group);
                }
                group.vars.push(view(row));
            }
            return grouped;
        },

        async replaceOrg(vars) {
            replaceRows('org', vars);
        },

        async replaceWorkspace(userId, vars) {
            replaceRows({ userId }, vars);
        },

        async replaceRepo(owner, name, vars) {
            replaceRows({ owner, name }, vars);
        },

        async resolveFor({ userId, repo }, _exec) {
            const pick = (list: Row[]): Record<string, string> =>
                Object.fromEntries(list.map((r) => [r.name, r.value]));
            const [owner, name] = repo ? repo.split('/') : [null, null];
            return stackEnv(
                pick(rows.filter((r) => r.userId === null && r.owner === null)),
                pick(userId ? rows.filter((r) => r.userId === userId) : []),
                pick(owner && name ? rows.filter((r) => r.owner === owner && r.repoName === name) : [])
            );
        },
    };

    function view(row: Row): EnvVarRow {
        return {
            name: row.name,
            // The write-only echo, exactly as the SQL selects it.
            value: row.isSecret ? null : row.value,
            isSecret: row.isSecret,
            updatedAt: row.updatedAt,
        };
    }

    function compareRepoOrder(a: Row, b: Row): number {
        return (
            a.owner!.localeCompare(b.owner!) || a.repoName!.localeCompare(b.repoName!) || a.name.localeCompare(b.name)
        );
    }

    /** The keep-a-null-secret replace, mirroring the store's transaction semantics. */
    function replaceRows(
        scope: 'org' | { userId: string } | { owner: string; name: string },
        vars: readonly { name: string; value: string | null; isSecret: boolean }[]
    ): void {
        if (store.broken) throw new Error('database is unreachable');
        const inScope = (row: Row): boolean => {
            if (scope === 'org') return row.userId === null && row.owner === null;
            if ('userId' in scope) return row.userId === scope.userId;
            return row.owner === scope.owner && row.repoName === scope.name;
        };
        const columns = scopeColumns(scope);
        const keep = new Set(vars.filter((v) => v.isSecret && v.value === null).map((v) => v.name));
        for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (inScope(rows[i]!) && !keep.has(rows[i]!.name)) rows.splice(i, 1);
        }
        for (const v of vars) {
            if (v.value === null) continue;
            rows.push({
                ...columns,
                name: v.name,
                value: v.value,
                isSecret: v.isSecret,
                updatedAt: at(),
            });
        }
    }

    /** The scope columns a row in this scope carries — null for every scope it is not. */
    function scopeColumns(scope: 'org' | { userId: string } | { owner: string; name: string }): {
        userId: string | null;
        owner: string | null;
        repoName: string | null;
    } {
        if (scope === 'org') return { userId: null, owner: null, repoName: null };
        if ('userId' in scope) return { userId: scope.userId, owner: null, repoName: null };
        return { userId: null, owner: scope.owner, repoName: scope.name };
    }

    return store;
}
