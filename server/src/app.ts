import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { GitHubIdentityClient } from './auth/github.js';
import { registerAuth } from './auth/plugin.js';
import type { AuthStore } from './auth/store.js';
import type { AppConfig } from './config.js';
import type { InstallationRepo } from './github/app-client.js';
import type { OrgRegistry } from './orgs.js';
import { createFactsCache } from './workspace/facts.js';
import { authRoutes } from './routes/auth.js';
import { envRoutes } from './routes/env.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { jobRoutes } from './routes/jobs.js';
import { repoRoutes } from './routes/repos.js';
import { statsRoutes } from './routes/stats.js';
import { taskRoutes } from './routes/tasks.js';
import { tokenRoutes } from './routes/tokens.js';
import { webhookRoutes } from './routes/webhook.js';
import { workflowRoutes } from './routes/workflows.js';
import { workspaceRoutes } from './routes/workspace.js';
import type { TelemetryStore } from './telemetry/store.js';

export interface AppDeps {
    config: AppConfig;
    /**
     * The per-org runtimes: the routes resolve the CALLER's org through it and take the repo
     * source, telemetry and stats service from there (#99). In tests, `orgs.for` answers for any
     * org with the same runtime, which keeps the single-org route tests honest about one thing:
     * every route reads the org the caller carries, never a process constant.
     */
    orgs: OrgRegistry;
    /** Absent unless there is somewhere to write, so the ingest routes simply do not exist. */
    store?: TelemetryStore | undefined;
    /**
     * Absent means no auth at all — no hook, no /api/auth routes, every route open.
     *
     * This is the ROUTE TESTS' mode, not a deployment's: main.ts always supplies one, because the
     * database is mandatory and there is therefore always somewhere for accounts to live. It exists
     * so the seven route-test files that predate accounts keep driving the app with no cookie,
     * and it is the same bargain `store` already makes.
     *
     * A deployment that wants everything open sets AUTH_MODE=none, which is a different thing: the
     * hook still runs and still resolves a caller, so there is one code path rather than two.
     */
    auth?: AuthStore | undefined;
    /**
     * The branch route's lease-pair verifier, threaded through to the auth hook. main.ts builds it
     * from the job store's SQL; the tests that exercise the runner credential stub it.
     */
    orgOfLease?: ((jobId: string, leaseToken: string) => Promise<string | null>) | undefined;
    /**
     * The worker routes' org resolvers, threaded through to the auth hook beside `orgOfLease`:
     * where the shared board secret authenticates a call, the org comes from the row its URL
     * names. main.ts builds both from the job store's SQL.
     */
    orgOfJob?: ((jobId: string) => Promise<string | null>) | undefined;
    orgOfReclaim?: ((reclaimId: string) => Promise<string | null>) | undefined;
    /** The OAuth exchange. Absent under AUTH_MODE=none, where there is nothing to exchange with. */
    identity?: GitHubIdentityClient | undefined;
    /** The App slug provider — the install-page redirect. Absent offline, where it cannot ask. */
    appSlug?: (() => Promise<string>) | undefined;
    /**
     * Repos one installation can see, for the onboarding screen (#125). Absent means the screen
     * reports repo tracking as unavailable — the offline shape, where there is no App client.
     */
    installationListing?: ((installationId: string) => Promise<InstallationRepo[] | null>) | undefined;
    /** Preset ranges are a lookback from now, so the routes need the same injection point. */
    now?: () => number;
    logger?: boolean;
}

// Set as a response header rather than a <meta> tag so dev can allow the Vite HMR
// websocket without a different index.html.
function csp(dev: boolean): string {
    const connect = dev ? "'self' ws:" : "'self'";
    return [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        `connect-src ${connect}`,
        // avatars.githubusercontent.com is where GitHub serves the profile pictures the user menu
        // and settings page render. One pinned host, never a wildcard.
        "img-src 'self' data: https://avatars.githubusercontent.com",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

/** No `listen` here — that split is what lets the route tests drive the app in-process. */
export async function buildApp({
    config,
    orgs,
    store,
    auth,
    orgOfLease,
    orgOfJob,
    orgOfReclaim,
    identity,
    appSlug,
    installationListing,
    now = Date.now,
    logger = false,
}: AppDeps): Promise<FastifyInstance> {
    const app = Fastify({ logger });

    const header = csp(config.webRoot === null);
    app.addHook('onSend', async (_request, reply) => {
        reply.header('Content-Security-Policy', header);
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'no-referrer');
    });

    // Before every route, so nothing can be registered ahead of the wall by accident. Without a
    // store the property is still decorated, so `request.auth` reads the same everywhere rather than
    // being absent in one configuration and null in another.
    if (auth) await registerAuth(app, { config, store: auth, orgOfLease, orgOfJob, orgOfReclaim });
    else app.decorateRequest('auth', null);

    await app.register(healthRoutes());
    if (auth) {
        await app.register(authRoutes({ config, store: auth, orgs, identity, appSlug, installationListing }));
        // The mint/list/revoke routes are github-mode only. Under `none` the hook ignores every
        // credential, so a token minted here would be inert at best — and a live personal
        // credential the day the same database flips to `github`. The settings page hides both
        // sections for exactly this reason; the API matches it.
        if (config.auth.mode !== 'none') {
            await app.register(tokenRoutes({ store: auth }));
        }
        // The installation webhook exists exactly when its secret does — its credential IS the
        // HMAC signature, so without one there is nothing to verify and no route may answer.
        if (config.webhookSecret) {
            await app.register(webhookRoutes({ store: auth, orgs, secret: config.webhookSecret }));
        }
    }
    await app.register(statsRoutes(config, orgs, auth, now));
    await app.register(repoRoutes({ config, orgs }));
    if (store) await app.register(ingestRoutes(store));
    // The board and the workflow definitions it resolves against: per-org runtimes, the routes
    // answering 503 for an org the registry has no store for — the same bargain as the env routes.
    await app.register(jobRoutes({ orgs }));
    await app.register(taskRoutes({ orgs }));
    await app.register(workflowRoutes({ orgs }));
    await app.register(envRoutes({ config, orgs }));
    await app.register(
        workspaceRoutes({
            config,
            orgs,
            // One cache per app, not per request: the whole point of it is that a poll every
            // two seconds does not become a `git log` and a directory walk every two seconds.
            facts: createFactsCache(now),
        })
    );

    if (config.webRoot) {
        const { default: fastifyStatic } = await import('@fastify/static');
        await app.register(fastifyStatic, { root: config.webRoot });
        app.setNotFoundHandler(async (request, reply) => {
            if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
            return reply.sendFile('index.html');
        });
    }

    return app;
}
