import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The component-state specimen's own dev server (redesign plan §1.7, D5). Test-only on purpose:
 * the API serves `web/dist` and nothing else, and a second entry in `web/vite.config.ts` would
 * ship publicly, so the specimen lives outside `web/` and is never built — nothing here lands in
 * `web/dist`.
 *
 * The port mirrors `playwright.config.ts`: Playwright passes SPECIMEN_PORT, and a standalone
 * `npx vite --config e2e/specimen/vite.config.ts` derives it from E2E_PORT_BASE the same way.
 */
const DEFAULT_PORT_BASE = 8123;
const SPECIMEN_PORT_OFFSET = 3;

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..', '..');

export const specimenPort = (env: NodeJS.ProcessEnv): number =>
    Number(env.SPECIMEN_PORT ?? Number(env.E2E_PORT_BASE ?? DEFAULT_PORT_BASE) + SPECIMEN_PORT_OFFSET);

export default defineConfig({
    root: here,
    // the style entry loads its faces from `/fonts/*` (styles.css → styles/fonts.css); without
    // the app's public directory they 404 and
    // the specimen would show fallback type.
    publicDir: join(repo, 'web', 'public'),
    cacheDir: join(repo, 'node_modules', '.vite', 'specimen'),
    plugins: [tailwindcss(), react()],
    // Pre-bundled at startup: discovered on the first page load instead, Vite reloads the page
    // mid-test once it has optimized them, and the first spec to run fails on a detached element.
    optimizeDeps: {
        include: ['react', 'react/jsx-dev-runtime', 'react-dom/client', '@headlessui/react', '@floating-ui/react'],
    },
    server: {
        host: '127.0.0.1',
        port: specimenPort(process.env),
        strictPort: true,
        // Setting `allow` replaces Vite's workspace-root default, so node_modules is listed too.
        fs: { allow: [here, join(repo, 'web', 'src'), join(repo, 'node_modules')] },
    },
});
