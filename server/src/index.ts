import postgres from 'postgres';
import { buildApp } from './app.js';
import { callbackPath, createGitHubIdentityClient } from './auth/github.js';
import { createAuthStore } from './auth/store.js';
import { resolveConfig } from './config.js';
import { createJobStore } from './db/job-store.js';
import { migrate } from './db/migrate.js';
import { createPrStore } from './db/pr-store.js';
import { createUserRepoStore } from './db/user-repo-store.js';
import { createUserExecutorStore } from './db/user-executor-store.js';
import { createEnvVarStore } from './db/env-var-store.js';
import { createCloneQueue } from './workspace/queue.js';
import { createPostgresTelemetryClient } from './telemetry/postgres-client.js';
import { createPostgresStore } from './telemetry/store.js';
import { createGitHubClient } from './github/client.js';
import { createGitHubAppClient } from './github/app-client.js';
import { installationTokenProvider } from './github/app-token.js';
import { createRepoSource } from './github/repo-source.js';
import type { TokenProvider } from './github/token.js';
import { createStatsService } from './stats-service.js';
import { createFixtureTelemetryClient, createNullTelemetryClient } from './telemetry/fixture-client.js';

const { config } = resolveConfig();
// The id, not just the name: it is the partition every stored row lands in, and a boot pointed at
// an unexpected one is otherwise silent — the dashboard renders empty and looks like data loss.
console.log(`[org] ${config.orgName} (${config.orgId})`);

/*
 * The repo-read credential, and with it the repo list.
 *
 * Under `none` there is no provider and no App client, so nothing can fetch by construction rather
 * than by a flag somebody has to remember to check. The repo source then falls back to the repos the
 * database already holds rows for, which is what lets a seeded database be browsed with no
 * credentials and no network — the list has to come from somewhere, because every stored read is
 * scoped by it.
 *
 * The private key is on `config` already: resolveConfig read GITHUB_APP_PRIVATE_KEY_FILE before the
 * validator ran, so there is no second place here that has to know a file might hold it.
 */
let tokens: TokenProvider | undefined;
let appClient;
if (config.github.mode === 'app') {
    const provider = installationTokenProvider({ github: config.github });
    tokens = provider;
    appClient = createGitHubAppClient(config.github, provider);
    console.log(
        `[fetch] GitHub App ${config.github.appId}, installation ${config.github.installationId ?? 'discovered at first use'}`,
    );
    // Loud, for the reason the OAuth authorize URL is: an API host that could be redirected in a
    // file shipping with a deployment is somewhere to send a private key, so the only defence is
    // that using one is impossible to miss in the log.
    if (config.github.apiUrl !== 'https://api.github.com') {
        console.warn(`[fetch] NOT using api.github.com: API URL is ${config.github.apiUrl}`);
    }
} else {
    console.log('[fetch] GITHUB_MODE=none: serving stored data only, nothing will be fetched or cloned');
}

// One pool, and one `migrate()`, for both the telemetry store and the PR store. They are
// independent features sharing a schema, and two runners would race each other.
const sql = postgres(config.databaseUrl, { max: 4 });
// NOT awaited. Migrations retry with backoff for the better part of a minute while the database
// container starts, and blocking here would hold the whole dashboard hostage to it. Every consumer
// gates its own queries on `ready` and reports unavailable until then.
//
// orgId is required: migrate() also adopts pre-organization rows into it, and that adoption is the
// only thing standing between a warm database and an empty dashboard.
//
// It also seeds the organization row, the bootstrap admin, and — under AUTH_MODE=none — the stand-in
// account every request is attributed to. All of those read the config, so none of them can live in
// a .sql file.
const ready = migrate(sql, {
    orgId: config.orgId,
    orgName: config.orgName,
    bootstrapAdmin: config.auth.mode === 'github' ? config.auth.bootstrapAdmin : null,
    localUser: config.auth.mode === 'none',
    log: (m) => console.log(`[migrate] ${m}`),
});
ready.catch((e: Error) => console.error(`[migrate] giving up: ${e.message}`));

// `off` is a product choice — render no AI panels — not a way to avoid the database, which is why
// it survives while the fixture source did not.
const telemetry =
    config.telemetrySource === 'off'
        ? createNullTelemetryClient()
        : config.telemetrySource === 'fixture'
          ? createFixtureTelemetryClient()
          : createPostgresTelemetryClient({ sql, orgId: config.orgId, ready });

// The ingest route is registered off this, so it exists whenever there is somewhere to put an
// export — which is now always, unless telemetry is switched off outright.
const store = config.telemetrySource === 'postgres' ? createPostgresStore({ sql, orgId: config.orgId }) : undefined;

const prStore = createPrStore({ sql, orgId: config.orgId, ready });
console.log(`[persist] ${config.databaseUrl.replace(/\/\/[^@]*@/, '//')}`);

// After the store, because the `none`-mode fallback reads from it. The GitHub client is built off
// this rather than off the config, which is the whole shape of the change: the repo list is an
// answer somebody has to be asked for, not a field.
const repos = createRepoSource({
    client: appClient,
    stored: () => prStore.storedRepos('github'),
});
const client = createGitHubClient({ config, repos, tokens });

// Unconditional, unlike the telemetry store: the database is mandatory and the board is not a
// product option. It gates its own queries on `ready`, so it is safe to build before migrations.
// `env` is what makes the claim carry the runner environment — resolved here, in the store, not in
// the route.
const envVarStore = createEnvVarStore({ sql, orgId: config.orgId, ready });
const jobStore = createJobStore({
    sql,
    orgId: config.orgId,
    hasWorkspaces: config.workspaceRoot !== null,
    ready,
    env: envVarStore,
});

// Unconditional too, and note that this does NOT depend on a workspace root being configured: with
// none, the routes still answer and report that the feature is off. Only the QUEUE is conditional,
// because there is nowhere to clone to.
const userRepoStore = createUserRepoStore({ sql, orgId: config.orgId, ready });
const userExecutorStore = createUserExecutorStore({ sql, orgId: config.orgId, ready });
const cloneQueue = config.workspaceRoot
    ? createCloneQueue({
          store: userRepoStore,
          root: config.workspaceRoot,
          orgId: config.orgId,
          tokens,
          log: (m) => console.log(`[workspace] ${m}`),
      })
    : undefined;

// Unconditional, for the same reason the job store is: the database is mandatory, so there is
// always somewhere for accounts to live. buildApp's optional `auth` is for the route tests.
const authStore = createAuthStore({ sql, ready });
const identity = config.auth.mode === 'github' ? createGitHubIdentityClient(config.auth) : undefined;

if (config.auth.mode === 'github') {
    console.log(`[auth] GitHub sign-in, callback ${config.auth.publicUrl}${callbackPath}`);
    if (!config.auth.cookieSecure) {
        console.log('[auth] cookie_secure is off: the session cookie will travel over plain http');
    }
    // Loud, because a configurable authorize URL that reached a real deployment would be a phishing
    // vector, and the only defence against that is it being impossible to miss in the log.
    if (config.auth.authorizeUrl !== 'https://github.com/login/oauth/authorize') {
        console.warn(`[auth] NOT using github.com: authorize URL is ${config.auth.authorizeUrl}`);
    }
    if (config.auth.autoJoinGithubOrg) {
        console.log(
            `[auth] members of the GitHub organization "${config.auth.autoJoinGithubOrg}" join on first sign-in; read:org is requested`,
        );
    }
    // The upgrade lockout, caught before somebody spends an afternoon on it: after 010 an existing
    // database has rows, no users and no memberships, and every route then 401s with nothing said.
    // Not a lockout when auto-join is on, though — an empty roster is the expected state there,
    // because the first member of the GitHub org to sign in creates their own row.
    if (!config.auth.autoJoinGithubOrg) {
        void ready
            .then(() => authStore.listMembers(config.orgId))
            .then((members) => {
                if (members.length) return;
                console.warn(
                    `[auth] "${config.orgId}" has no members, so nobody can sign in. Set auth.bootstrap_admin, or run: npm run invite -- --org ${config.orgId} --login <github-login> --role admin`,
                );
            })
            .catch(() => {});
    }
} else {
    // Unconditional and blunt, in the register of the "[fetch] no GITHUB_TOKEN" line above: the
    // whole point of AUTH_MODE being an explicit enum is that nobody arrives here by accident, and
    // the line is what makes staying here a choice too.
    console.log(
        '[auth] AUTH_MODE=none: every route is open to anyone who can reach this port, including POST /api/jobs, which runs shell commands',
    );
}

const service = createStatsService({ config, client, repos, telemetry, store: prStore });
const app = await buildApp({
    config,
    service,
    repos,
    store,
    jobs: jobStore,
    userRepos: userRepoStore,
    userExecutors: userExecutorStore,
    envVars: envVarStore,
    cloneQueue,
    auth: authStore,
    identity,
    logger: true,
});

// Fired, not awaited: prime() waits on the migration promise, and awaiting it here would
// recreate exactly the hostage-taking that not awaiting migrate() avoids. ensureFresh() returns
// early while it is in flight, so the seed cannot lose a race with a full walk.
service.prime().catch((e: Error) => console.error(`[persist] prime failed: ${e.message}`));

// Warm the cache at boot so the first visitor does not eat the cold fetch.
service.ensureFresh();

// Also fired, not awaited. It recovers rows a restart stranded mid-clone and sweeps the partial
// trees those left behind, then polls — all of which is minutes of network for something no route
// on the read path needs, so `listen()` must not wait on it.
//
// Note what this does NOT do any more: clone anything on its own. Boot checks nothing out. A clone
// happens only after somebody signs in and chooses repositories.
cloneQueue?.start().catch((e: Error) => console.error(`[workspace] ${e.message}`));

await app.listen({ port: config.port, host: config.host });
