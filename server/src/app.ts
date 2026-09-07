import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { GitHubIdentityClient } from './auth/github.js';
import { registerAuth } from './auth/plugin.js';
import type { AuthStore } from './auth/store.js';
import type { AppConfig } from './config.js';
import type { EnvVarStore } from './db/env-var-store.js';
import type { JobStore } from './db/job-store.js';
import type { UserExecutorStore } from './db/user-executor-store.js';
import type { UserRepoStore } from './db/user-repo-store.js';
import type { RepoSource } from './github/repo-source.js';
import { createFactsCache } from './workspace/facts.js';
import type { CloneQueue } from './workspace/queue.js';
import { workspaceRoutes } from './routes/workspace.js';
import { authRoutes } from './routes/auth.js';
import { envRoutes } from './routes/env.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { jobRoutes } from './routes/jobs.js';
import { repoRoutes } from './routes/repos.js';
import { statsRoutes } from './routes/stats.js';
import type { StatsService } from './stats-service.js';
import type { TelemetryStore } from './telemetry/store.js';

export interface AppDeps {
    config: AppConfig;
    service: StatsService;
    /**
     * The repositories the GitHub App installation reports. Required, because under
     * GITHUB_MODE=none it is a source that reports an empty list rather than an absent one — the
     * picker then says "nothing is installed", which is the truth, where a missing route would say
     * nothing at all.
     */
    repos: RepoSource;
    /** Absent unless there is somewhere to write, so the ingest routes simply do not exist. */
    store?: TelemetryStore | undefined;
    /** Same bargain: no job board without a store behind it, so the routes are not registered. */
    jobs?: JobStore | undefined;
    /**
     * Per-member checkouts. Same bargain again — without a store the routes do not exist.
     *
     * Note that an absent WORKSPACE ROOT is a different thing entirely: the routes still exist and
     * answer 200 with `root: null`, so the page can say the feature is off. Only an absent STORE
     * removes them, and that is the route tests' mode.
     */
    userRepos?: UserRepoStore | undefined;
    /** Rides the same registration bargain as userRepos — no store, no routes. */
    userExecutors?: UserExecutorStore | undefined;
    /**
     * Environment variables and secrets for runners. Unconditional in index.ts — the database is
     * mandatory — but optional here, so the route tests that predate it stay as they are.
     */
    envVars?: EnvVarStore | undefined;
    /** Absent in the route tests, where nothing should start cloning. */
    cloneQueue?: CloneQueue | undefined;
    /**
     * Absent means no auth at all — no hook, no /api/auth routes, every route open.
     *
     * This is the ROUTE TESTS' mode, not a deployment's: index.ts always supplies one, because the
     * database is mandatory and there is therefore always somewhere for accounts to live. It exists
     * so the seventeen route-test files that predate accounts keep driving the app with no cookie,
     * and it is the same bargain `store` and `jobs` already make.
     *
     * A deployment that wants everything open sets AUTH_MODE=none, which is a different thing: the
     * hook still runs and still resolves a caller, so there is one code path rather than two.
     */
    auth?: AuthStore | undefined;
    /** The OAuth exchange. Absent under AUTH_MODE=none, where there is nothing to exchange with. */
    identity?: GitHubIdentityClient | undefined;
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
        "img-src 'self' data:",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

/** No `listen` here — that split is what lets the route tests drive the app in-process. */
export async function buildApp({
    config,
    service,
    repos,
    store,
    jobs,
    userRepos,
    userExecutors,
    envVars,
    cloneQueue,
    auth,
    identity,
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

    await app.register(healthRoutes(config));
    if (auth) await app.register(authRoutes({ config, store: auth, identity }));
    await app.register(statsRoutes(config, service, now));
    await app.register(repoRoutes(repos));
    if (store) await app.register(ingestRoutes(store));
    if (jobs) await app.register(jobRoutes(jobs));
    if (envVars) await app.register(envRoutes({ store: envVars, repos }));
    if (userRepos) {
        await app.register(
            workspaceRoutes({
                config,
                store: userRepos,
                executors: userExecutors ?? null,
                repos,
                // One cache per app, not per request: the whole point of it is that a poll every
                // two seconds does not become a `git log` and a directory walk every two seconds.
                facts: createFactsCache(now),
                queue: cloneQueue ?? null,
            }),
        );
    }

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
