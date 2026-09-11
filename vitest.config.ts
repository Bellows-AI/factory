import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: [
            'core/test/**/*.test.ts',
            'server/test/**/*.test.ts',
            // Every docker call and every board request is injected; the one suite that spawns
            // real processes (the branch reporter's node children, git fixtures, loopback HTTP)
            // still touches nothing but its own temp dirs — offline, no daemon, no network.
            'driver/test/**/*.test.ts',
            // Renders panels with react-dom/server, so no DOM and no browser is needed.
            'web/test/**/*.test.tsx',
            // `.test.ts` too: web/test holds non-component suites (executor config validation)
            // that a `.tsx`-only pattern silently dropped.
            'web/test/**/*.test.ts',
        ],
        pool: 'forks',
        poolOptions: {
            forks: {
                // Default is one fork per core; watch idles hot without a cap.
                minWorkers: 1,
                maxWorkers: 2,
            },
        },
        // Suites inject their own state, so sharing one worker costs nothing.
        isolate: false,
        // A core watch build rewrites core/dist while vitest watches; re-running
        // on it invalidates the module graph for every server/web test.
        watchExclude: ['**/node_modules/**', '**/dist/**'],
        coverage: {
            provider: 'v8',
            // 'lcov' is what Sonar ingests; 'text' is for reading here. Both, or CI is silent.
            reporter: ['text', 'lcov'],
            include: ['core/src/**', 'server/src/**', 'web/src/**', 'driver/src/**'],
            // Measured but never executed by this suite, so they only dilute the percentage.
            exclude: ['**/*.d.ts', 'web/src/main.tsx', 'server/src/index.ts'],
        },
    },
});
