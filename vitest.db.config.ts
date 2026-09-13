import { defineConfig } from 'vitest/config';

/**
 * Deliberately separate from vitest.config.ts. `npm test` must stay offline and DB-free, so
 * the SQL and the migration runner have no coverage there — a real tradeoff, written down in
 * AGENTS.md rather than left to be discovered.
 *
 *     docker compose up -d timescale
 *     DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db
 */
export default defineConfig({
    test: {
        include: ['server/test-db/**/*.test.ts'],
        pool: 'forks',
        // Migrations and a shared schema: parallel files would race each other.
        fileParallelism: false,
        testTimeout: 30_000,
    },
});
