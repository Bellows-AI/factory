import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { GitHubIdentityClient } from './auth/github.js';
import { registerAuth } from './auth/plugin.js';
import type { AuthStore } from './auth/store.js';
import type { AppConfig } from './config.js';
import type { OrgRegistry } from './orgs.js';
import { createFactsCache } from './workspace/facts.js';
import { authRoutes } from './routes/auth.js';
import { envRoutes } from './routes/env.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { jobRoutes } from './routes/jobs.js';
import { repoRoutes } from './routes/repos.js';
import { statsRoutes } from './routes/stats.js';
import { tokenRoutes } from './routes/tokens.js';
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
    /** The OAuth exchange. Absent under AUTH_MODE=none, where there is nothing to exchange with. */
    identity?: GitHubIdentityClient | undefined;
    /** The App slug provider — the install-page redirect. Absent offline, where it cannot ask. */
    appSlug?: (() => Promise<string>) | undefined;
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
    identity,
    appSlug,
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
    if (auth) await registerAuth(app, { config, store: auth });
    else app.decorateRequest('auth', null);

    await app.register(healthRoutes());
    if (auth) {
        await app.register(authRoutes({ config, store: auth, identity, appSlug }));
        // The mint/list/revoke routes are github-mode only. Under `none` the hook ignores every
        // credential, so a token minted here would be inert at best — and a live personal
        // credential the day the same database flips to `github`. The settings page hides both
        // sections for exactly this reason; the API matches it.
        if (config.auth.mode !== 'none') {
            await app.register(tokenRoutes({ store: auth }));
        }
    }
    await app.register(statsRoutes(config, orgs, auth, now));
    await app.register(repoRoutes({ config, orgs }));
    if (store) await app.register(ingestRoutes(store));
    await app.register(jobRoutes({ orgs }));
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
