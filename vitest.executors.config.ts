import { defineConfig } from 'vitest/config';

/**
 * Focused, offline coverage gate for the board/driver/telemetry control plane. Database lease
 * semantics remain in `npm run test:db`; real Docker and cluster boundaries remain in
 * `npm run test:jobs` and `npm run test:k8s`.
 */
export default defineConfig({
    test: {
        include: [
            'driver/test/**/*.test.ts',
            'server/test/routes.jobs.test.ts',
            'server/test/routes.ingest.test.ts',
            'server/test/routes.telemetry.test.ts',
            'server/test/telemetry.fixture-client.test.ts',
            'server/test/telemetry.otlp.test.ts',
            'core/test/telemetry*.test.ts',
        ],
        pool: 'forks',
        poolOptions: {
            forks: {
                minWorkers: 1,
                maxWorkers: 2,
            },
        },
        testTimeout: 30_000,
        hookTimeout: 30_000,
        isolate: false,
        watchExclude: ['**/node_modules/**', '**/dist/**'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            include: [
                'driver/src/**',
                'server/src/routes/jobs.ts',
                'server/src/routes/ingest.ts',
                'server/src/telemetry/**',
                'core/src/telemetry.ts',
            ],
            // Entrypoints and content-injected container scripts execute in other processes, so
            // V8 cannot attribute them here. Their behavior is exercised by scripts/image suites.
            exclude: [
                '**/*.d.ts',
                'driver/src/index.ts',
                'driver/src/scripts/**',
                // These stores require the real Timescale suite rather than an offline fake.
                'server/src/telemetry/postgres-client.ts',
                'server/src/telemetry/store.ts',
            ],
            thresholds: {
                lines: 90,
                statements: 90,
                functions: 90,
                branches: 85,
            },
        },
    },
});
