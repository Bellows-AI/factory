import type { UserExecutorStore } from '../src/db/user-executor-store.js';
import { DEFAULT_GATE_FIX_ROUNDS } from '@factory-ai/core';

export interface MemoryUserExecutorStore extends UserExecutorStore {
    /** Every row, so a test can assert what a PUT wrote and what a later PUT replaced. */
    rows(): {
        userId: string;
        name: string;
        type: string;
        config: Record<string, unknown>;
        isDefault: boolean;
        gateFixRounds: number;
    }[];
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
        isDefault: boolean;
        gateFixRounds: number;
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
                isDefault: r.isDefault,
                gateFixRounds: r.gateFixRounds,
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
                    isDefault: executor.isDefault ?? false,
                    gateFixRounds: executor.gateFixRounds ?? DEFAULT_GATE_FIX_ROUNDS,
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
                        isDefault: r.isDefault,
                        gateFixRounds: r.gateFixRounds,
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
                    isDefault: r.isDefault,
                    gateFixRounds: r.gateFixRounds,
                    config: structuredClone(r.config),
                }))
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
        },

        async configFor(userId, name) {
            const row = rows.find((r) => r.userId === userId && r.name === name);
            if (!row) return null;
            return {
                type: row.type,
                config: structuredClone(row.config),
                gateFixRounds: row.gateFixRounds,
            };
        },
    };
}
