import postgres from 'postgres';
import { buildApp } from './app.js';
import { callbackPath, createGitHubIdentityClient } from './auth/github.js';
import { createAuthStore } from './auth/store.js';
import { LOCAL_ORG_ID, resolveConfig, type GitHubConfig } from './config.js';
import { createAppSlugProvider } from './github/app-token.js';
import { createOrgRegistry } from './orgs.js';
import { createPostgresStore } from './telemetry/store.js';
import { migrate } from './db/migrate.js';

/** The ingest-side parking namespace: sessions no installation org claims land here. */
const UNCLAIMED_ORG = '__unclaimed__';

/**
 * The whole wiring, from config to `listen`. Every entry is this function plus one decision about
 * GitHub: `index.ts` reads the environment, which can only ever produce the App; `offline.ts`
 * passes the code-only `none` arm for the harnesses that run with no credential and no network.
 */
export async function start(options: { github?: GitHubConfig } = {}): Promise<void> {
    const { config } = resolveConfig({ env: process.env, ...(options.github ? { github: options.github } : {}) });
    // The orgs are the App's installations now (#99) — the process is bound to none of them, which
    // is the point. The mode is what a boot should say out loud.
    console.log(
        config.auth.mode === 'github'
            ? '[org] organizations are GitHub App installations, materialized at sign-in'
            : `[org] ${LOCAL_ORG_ID} (local — AUTH_MODE=none)`
    );

    if (config.github.mode === 'app') {
        console.log(`[fetch] GitHub App ${config.github.appId}; installation tokens are minted per organization`);
        // Loud, for the reason the OAuth authorize URL is: an API host that could be redirected in a
        // file shipping with a deployment is somewhere to send a private key, so the only defence is
        // that using one is impossible to miss in the log.
        if (config.github.apiUrl !== 'https://api.github.com') {
            console.warn(`[fetch] NOT using api.github.com: API URL is ${config.github.apiUrl}`);
        }
    } else {
        console.log('[fetch] no GitHub credential: serving stored data only, nothing will be fetched or cloned');
    }

    // One pool, and one `migrate()`, for every feature sharing the schema. Two runners would
    // race each other.
    const sql = postgres(config.databaseUrl, { max: 4 });
    // NOT awaited. Migrations retry with backoff for the better part of a minute while the database
    // container starts, and blocking here would hold the whole dashboard hostage to it. Every consumer
    // gates its own queries on `ready` and reports unavailable until then.
    //
    // Under AUTH_MODE=none it also seeds the local organization and the stand-in account every
    // request is attributed to. Github mode seeds nothing: sign-in materializes the orgs.
    const ready = migrate(sql, {
        localUser: config.auth.mode === 'none',
        log: (m) => console.log(`[migrate] ${m}`),
    });
    ready.catch((e: Error) => console.error(`[migrate] giving up: ${e.message}`));

    // The ingest route's write side exists whenever there is somewhere to put an export — which is
    // always, unless telemetry is switched off outright. The store resolves the org per report: the
    // reporter cannot name one, so github mode matches the repo's owner against the installation
    // orgs' account logins; AUTH_MODE=none is the constant local org.
    const store =
        config.telemetrySource === 'postgres'
            ? createPostgresStore({ sql, orgFor: orgForRepo(sql, ready, config) })
            : undefined;

    console.log(`[persist] ${config.databaseUrl.replace(/\/\/[^@]*@/, '//')}`);

    // Everything per-org is built lazily from here, on the first request that names an org.
    const orgs = createOrgRegistry({ sql, ready, config, withStores: true });

    // Unconditional, for the same reason the job store is: the database is mandatory, so there is
    // always somewhere for accounts to live. buildApp's optional `auth` is for the route tests.
    const authStore = createAuthStore({ sql, ready });
    const identity = config.auth.mode === 'github' ? createGitHubIdentityClient(config.auth) : undefined;

    if (config.auth.mode === 'github') {
        console.log(`[auth] GitHub sign-in, callback ${config.auth.publicUrl}${callbackPath}`);
        console.log(
            '[auth] the App setup URL must point at the /api/auth/github/setup route for the install round trip'
        );
        if (!config.auth.cookieSecure) {
            console.log('[auth] cookie_secure is off: the session cookie will travel over plain http');
        }
        // Loud, because a configurable authorize URL that reached a real deployment would be a phishing
        // vector, and the only defence against that is it being impossible to miss in the log.
        if (config.auth.authorizeUrl !== 'https://github.com/login/oauth/authorize') {
            console.warn(`[auth] NOT using github.com: authorize URL is ${config.auth.authorizeUrl}`);
        }
    } else {
        // Unconditional and blunt, in the register of the "[fetch] no GitHub credential" line above:
        // the whole point of AUTH_MODE being an explicit enum is that nobody arrives here by accident,
        // and the line is what makes staying here a choice too.
        console.log(
            '[auth] AUTH_MODE=none: every route is open to anyone who can reach this port, including POST /api/jobs, which runs shell commands'
        );
    }

    const app = await buildApp({
        config,
        orgs,
        store,
        auth: authStore,
        identity,
        appSlug: config.github.mode === 'app' ? createAppSlugProvider({ github: config.github }).slug : undefined,
        logger: true,
    });

    // Warm every known org's cache at boot so the first visitor does not eat the cold read. Fired,
    // not awaited: a cold database must not hold `listen()`.
    void ready.then(() => orgs.warmAll()).catch(() => {});

    await app.listen({ port: config.port, host: config.host });
}

/**
 * The ingest side's org attribution: which organization does a branch report belong to?
 *
 * A branch report carries a repo, never an org — the reporter is a plugin on somebody's laptop or
 * a collector on the compose network, and neither holds a session. Github mode therefore matches
 * the repo's OWNER against the installation orgs' account logins (the label sign-in stores in
 * `organization.name`, compared case-insensitively because GitHub logins are): exactly one match
 * is that org. Zero, or an ambiguity, is parked in `__unclaimed__` — a legal org_id since 005,
 * outside every dashboard — because attributing a session to the wrong organization is the one
 * mistake this path must never make. AUTH_MODE=none is simply the local org.
 */
function orgForRepo(sql: postgres.Sql, ready: Promise<unknown>, config: ReturnType<typeof resolveConfig>['config']) {
    return async (repo: string): Promise<string> => {
        if (config.auth.mode === 'none') return LOCAL_ORG_ID;
        await ready;
        const owner = repo.split('/')[0]?.toLowerCase() ?? '';
        if (!owner) return UNCLAIMED_ORG;
        const rows = await sql<{ id: string }[]>`
            select id from organization
            where installation_id is not null and lower(name) = ${owner}
        `;
        // Exactly one match is that org. Zero, or an ambiguity (two installations whose accounts
        // share a login should not exist, but the database does not prevent it), is unclaimed.
        return rows.length === 1 ? rows[0]!.id : UNCLAIMED_ORG;
    };
}
