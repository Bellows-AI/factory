import type { UserExecutorStore } from '../src/db/user-executor-store.js';

export interface MemoryUserExecutorStore extends UserExecutorStore {
    /** Every row, so a test can assert what a PUT wrote and what a later PUT replaced. */
    rows(): { userId: string; name: string; type: string; config: Record<string, unknown> }[];
}

/**
 * An in-memory UserExecutorStore, for the same reason memoryUserRepoStore exists. The SQL behind it
 * is covered by server/test-db, which needs a container.
 */
export function memoryUserExecutorStore(): MemoryUserExecutorStore {
    interface Row {
        userId: string;
        name: string;
        type: string;
        config: Record<string, unknown>;
        createdAt: string;
        updatedAt: string;
    }
    const rows: Row[] = [];
    const at = () => new Date().toISOString();

    return {
        rows: () =>
            rows.map((r) => ({
                userId: r.userId,
                name: r.name,
                type: r.type,
                config: structuredClone(r.config),
            })),

        async replace(userId, executors) {
            for (let i = rows.length - 1; i >= 0; i -= 1) {
                if (rows[i]!.userId === userId) rows.splice(i, 1);
            }
            for (const executor of executors) {
                rows.push({
                    userId,
                    name: executor.name,
                    type: executor.type,
                    config: structuredClone(executor.config),
                    createdAt: at(),
                    updatedAt: at(),
                });
            }
        },

        async list(userId) {
            return (
                rows
                    .filter((r) => r.userId === userId)
                    .map((r) => ({
                        name: r.name,
                        type: r.type,
                        createdAt: r.createdAt,
                        updatedAt: r.updatedAt,
                    }))
                    // The SQL orders the same way; created_at ties break on name.
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
            );
        },

        async listWithConfigs(userId) {
            return rows
                .filter((r) => r.userId === userId)
                .map((r) => ({
                    name: r.name,
                    type: r.type,
                    createdAt: r.createdAt,
                    updatedAt: r.updatedAt,
                    config: structuredClone(r.config),
                }))
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
        },
    };
}
