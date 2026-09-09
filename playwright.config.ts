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
const AUTH_PORT = 8124;
const IDP_PORT = 8125;
const E2E_LOGIN = 'e2e-user';

const shared = {
    WEB_ROOT: `${root}web/dist`,
    TELEMETRY_SOURCE: 'postgres',
    BASE_BRANCH: 'dev',
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
            // Seeded first, and every run: the assertions read the numbers the generator produces,
            // and a stale database from an older generator would fail in a way that looks like a UI
            // bug.
            command: 'npm run build && npm run seed && node server/dist/offline.js',
            // /api/health never touches GitHub or the database, so it reports ready immediately —
            // the cold fixture fetch is awaited in the spec instead.
            url: `http://127.0.0.1:${PORT}/api/health`,
            cwd: root,
            env: {
                ...shared,
                PORT: String(PORT),
                DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_e2e',
                ORG_ID: 'e2e-org',
                ORG_NAME: 'E2E Org',
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
            env: { STUB_IDP_PORT: String(IDP_PORT), STUB_IDP_LOGIN: E2E_LOGIN },
            reuseExistingServer: false,
            stdout: 'ignore',
            stderr: 'pipe',
        },
        {
            // A separate database from the one above, so the invite this seeds cannot change what
            // the visual check renders.
            command: 'npm run build && npm run seed && node server/dist/offline.js',
            url: `http://127.0.0.1:${AUTH_PORT}/api/health`,
            cwd: root,
            env: {
                ...shared,
                PORT: String(AUTH_PORT),
                DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_auth_e2e',
                ORG_ID: 'auth-e2e-org',
                ORG_NAME: 'Auth E2E Org',
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
                // An UNCLAIMED invite. First sign-in binds it, which is the half of the flow most
                // worth driving in a browser.
                SEED_INVITE_LOGIN: E2E_LOGIN,
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
