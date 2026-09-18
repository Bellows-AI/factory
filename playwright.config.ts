import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8123;

/**
 * The auth check runs on its own server, on its own port, against its own database.
 *
 * Not folded into the one above: dashboard.spec.ts is the visual regression check and every one of
 * its assertions predates accounts, so putting a login wall in front of it would mean editing all
 * of them for a change that is not about the dashboard. Two servers is cheaper than that, and it
 * also keeps a boot with AUTH_MODE=none under test, which is the mode `npm run seed`, the route
 * harness and scripts/test-jobs.sh all depend on.
 */
export const AUTH_PORT = 8124;
const IDP_PORT = 8125;
const E2E_LOGIN = 'e2e-user';
/**
 * A fresh GitHub identity every run. The seed leaves auth tables alone, so a fixed id would keep
 * its stored selection between runs and the selection screen (issue 125) would only ever be
 * driven on the first run against a fresh database. A per-run id makes every run's first sign-in
 * a first sign-in; the login stays the same, and rows accumulate only in the disposable database.
 * Full millisecond precision — a modulus would make two runs collide by birthday bound and the
 * second would inherit the first's stored selection.
 */
const E2E_USER_ID = 420000 + Date.now();

const shared = {
    WEB_ROOT: `${root}web/dist`,
    TELEMETRY_SOURCE: 'postgres',
};

/**
 * The built SPA is served by the API rather than by Vite, so the suite exercises the same
 * single-origin arrangement as production and needs no proxy rule.
 *
 * It stays offline — no credential, no quota, no network — but no longer by replaying an HTTP
 * payload. The database is the only source the app reads, so the check seeds a disposable one and
 * browses that. Both servers boot the OFFLINE entry, `server/dist/offline.js`: the same server
 * built with the code-only no-fetch arm, so nothing is constructed to fetch with, the page renders
 * purely from what was seeded, and `loadConfig` permits the disposable database precisely because
 * nothing can be lost to it.
 *
 * Requires a running container:  docker compose up -d timescale
 */
export default defineConfig({
    testDir: './e2e',
    outputDir: './artifacts/ui/trace',
    // A visual check that passes on a retry is not a visual check.
    retries: 0,
    // One worker, and this is not about speed: the auth project's spec files sign in as the SAME
    // stub account, so the first sign-in's selection screen (issue 125) and the stored choice the
    // later sign-ins reuse must not race each other. Serial is the deterministic arrangement.
    workers: 1,
    reporter: [['list']],
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        viewport: { width: 1440, height: 1000 },
        screenshot: 'off',
        trace: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            testIgnore: /(auth|workspace)\.spec\.ts/,
            use: { ...devices['Desktop Chrome'] },
        },
        {
            // Both specs need a signed-in member, and workspace.spec.ts also needs a server with a
            // real ORG_WORKSPACE_ROOT — which the open board deliberately does not have, so that a
            // picker never appears in the visual check.
            name: 'auth',
            testMatch: /(auth|workspace)\.spec\.ts/,
            use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${AUTH_PORT}` },
        },
    ],
    webServer: [
        {
            // Reset, then seeded, every run: the seed is additive and every run generates fresh
            // session ids, so without the truncate the databases accumulate one generator window
            // per run and the cold stats fetch eventually outlives the test timeout — a failure
            // that looks like a UI bug. e2e/reset-db.mjs carries the seed's disposable-name rule.
            command: 'node e2e/reset-db.mjs && npm run build && npm run seed && node server/dist/offline.js',
            // /api/health never touches GitHub or the database, so it reports ready immediately —
            // the cold stats fetch is awaited in the spec instead.
            url: `http://127.0.0.1:${PORT}/api/health`,
            cwd: root,
            env: {
                ...shared,
                PORT: String(PORT),
                DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_e2e',
            },
            timeout: 180_000,
            // Never reuse: a server left over from a previous edit would verify stale code, which
            // is the one failure mode a visual check exists to catch.
            reuseExistingServer: false,
            stdout: 'ignore',
            stderr: 'pipe',
        },
        {
            command: 'node e2e/stub-idp.mjs',
            url: `http://127.0.0.1:${IDP_PORT}/user`,
            cwd: root,
            // Two installations, so the first sign-in of the run has something to choose on the
            // selection screen (issue 125) — one would sign straight in, which the specs that
            // follow the first rely on.
            env: {
                STUB_IDP_PORT: String(IDP_PORT),
                STUB_IDP_LOGIN: E2E_LOGIN,
                STUB_IDP_USER_ID: String(E2E_USER_ID),
                STUB_IDP_INSTALLATIONS: '999999,888888',
            },
            reuseExistingServer: false,
            stdout: 'ignore',
            stderr: 'pipe',
        },
        {
            // A separate database from the one above, so the invite this seeds cannot change what
            // the visual check renders.
            command: 'node e2e/reset-db.mjs && npm run build && npm run seed && node server/dist/offline.js',
            url: `http://127.0.0.1:${AUTH_PORT}/api/health`,
            cwd: root,
            env: {
                ...shared,
                PORT: String(AUTH_PORT),
                DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_auth_e2e',
                AUTH_MODE: 'github',
                GITHUB_OAUTH_CLIENT_ID: 'stub-client-id',
                GITHUB_OAUTH_CLIENT_SECRET: 'stub-client-secret',
                SESSION_SECRET: 'an-e2e-session-secret-of-at-least-32-chars',
                PUBLIC_URL: `http://127.0.0.1:${AUTH_PORT}`,
                // The three overrides that point the exchange at the stub. Environment only — and
                // the server logs loudly when they are in use, because a configurable authorize
                // URL reaching a real deployment would be a phishing vector.
                GITHUB_OAUTH_AUTHORIZE_URL: `http://127.0.0.1:${IDP_PORT}/login/oauth/authorize`,
                GITHUB_OAUTH_TOKEN_URL: `http://127.0.0.1:${IDP_PORT}/login/oauth/access_token`,
                GITHUB_OAUTH_USER_URL: `http://127.0.0.1:${IDP_PORT}/user`,
                // First sign-in materializes the installation the stub reports as the member's
                // organization — the half of the flow most worth driving in a browser (#99).
                // A REAL workspace root, so signing in provisions a real directory and the
                // Workspace page has something to report. Under artifacts/ and never under $HOME:
                // this run creates directories, and it must not do that anywhere a developer
                // keeps work. The open board above deliberately has none, which is what keeps a
                // picker from ever appearing in the visual check.
                ORG_WORKSPACE_ROOT: `${root}artifacts/e2e-workspaces`,
            },
            timeout: 180_000,
            reuseExistingServer: false,
            stdout: 'ignore',
            stderr: 'pipe',
        },
    ],
});
