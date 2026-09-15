import postgres from 'postgres';
import { buildApp } from './app.js';
import { callbackPath, createGitHubIdentityClient } from './auth/github.js';
import { runRosterSync } from './auth/reconcile.js';
import { createAuthStore } from './auth/store.js';
import { resolveConfig } from './config.js';
import { createJobStore } from './db/job-store.js';
import { migrate } from './db/migrate.js';
import { storedRepoNames } from './db/stored-repos.js';
import { createUserRepoStore } from './db/user-repo-store.js';
import { createUserRepoAccessStore } from './db/user-repo-access-store.js';
import { createUserExecutorStore } from './db/user-executor-store.js';
import { createEnvVarStore } from './db/env-var-store.js';
import { createCloneQueue } from './workspace/queue.js';
import { readGatesFile } from './workspace/bellows.js';
import { createPostgresTelemetryClient } from './telemetry/postgres-client.js';
import { createPostgresStore } from './telemetry/store.js';
import { createGitHubAppClient } from './github/app-client.js';
import { installationTokenProvider, type InstallationTokenProvider } from './github/app-token.js';
import { createRepoAccessScope } from './github/access-scope.js';
import { createRepoSource } from './github/repo-source.js';
import { createStatsService } from './stats-service.js';
import { createFixtureTelemetryClient, createNullTelemetryClient } from './telemetry/fixture-client.js';
import type { GitHubConfig } from './config.js';

/**
 * How long between roster sweeps. At-login reconciliation only would leave a removed member a
 * working dashboard for up to a session's TTL — two weeks by default — so the sweep is what makes
 * removal land without waiting for the member to sign in again. Two paginated GitHub calls per
 * sweep, against an installation quota of 1,500 an hour.
 */
const ROSTER_SWEEP_MS = 15 * 60 * 1000;

/**
 * The whole wiring, from config to `listen`. Every entry is this function plus one decision about
 * GitHub: `index.ts` reads the environment, which can only ever produce the App; `offline.ts`
 * passes the code-only `none` arm for the harnesses that run with no credential and no network.
 */
export async function start(options: { github?: GitHubConfig } = {}): Promise<void> {
    const { config } = resolveConfig({ env: process.env, ...(options.github ? { github: options.github } : {}) });
    // The id, not just the name: it is the partition every stored row lands in, and a boot pointed at
    // an unexpected one is otherwise silent — the dashboard renders empty and looks like data loss.
    console.log(`[org] ${config.orgName} (${config.orgId})`);

    /*
     * The repo-read credential, and with it the repo list.
     *
     * Without an App (the offline tooling's `none` arm, reachable only in code) there is no provider
     * and no App client, so nothing can fetch by construction rather than by a flag somebody has to
     * remember to check. The repo source then falls back to the repos the database already holds rows
     * for, which is what lets a seeded database be browsed with no credentials and no network — the
     * list has to come from somewhere, because every stored read is scoped by it.
     *
     * The private key is on `config` already: resolveConfig read GITHUB_APP_PRIVATE_KEY_FILE before the
     * validator ran, so there is no second place here that has to know a file might hold it.
     */
    let tokens: InstallationTokenProvider | undefined;
    let appClient;
    if (config.github.mode === 'app') {
        const provider = installationTokenProvider({ github: config.github });
        tokens = provider;
        appClient = createGitHubAppClient(config.github, provider);
        console.log(
            `[fetch] GitHub App ${config.github.appId}, installation ${config.github.installationId ?? 'discovered at first use'}`
        );
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

    console.log(`[persist] ${config.databaseUrl.replace(/\/\/[^@]*@/, '//')}`);

    // After the store, because the `none`-mode fallback reads from it. The repo list is an
    // answer somebody has to be asked for, not a field.
    const repos = createRepoSource({
        client: appClient,
        stored: () => storedRepoNames({ sql, orgId: config.orgId, ready }),
    });

    // Unconditional, unlike the telemetry store: the database is mandatory and the board is not a
    // product option. It gates its own queries on `ready`, so it is safe to build before migrations.
    // `env` is what makes the claim carry the runner environment — resolved here, in the store, not in
    // the route. `githubToken` lays the App's installation token under that env as its base layer, so
    // a runner can orchestrate GitHub (PRs, commits, CI reads) with nothing configured; without a
    // provider — the offline tooling only — the claim mints nothing, exactly as nothing there can fetch.
    const envVarStore = createEnvVarStore({ sql, orgId: config.orgId, ready });
    // Built before the job store, which reads it at claim time (executorConfig below).
    const userExecutorStore = createUserExecutorStore({ sql, orgId: config.orgId, ready });
    const jobStore = createJobStore({
        sql,
        orgId: config.orgId,
        hasWorkspaces: config.workspaceRoot !== null,
        ready,
        env: envVarStore,
        // The claim reads the author's executor row for the executor a task was stamped with, and
        // hands an opencode run the member's pasted config as OPENCODE_CONFIG_CONTENT (docs/env.md).
        executorConfig: userExecutorStore,
        // Gates are read off the server's own workspace mount, per claim, for the job's author and
        // repo label — worktree-first (the thread's worktree, once the driver's sync has created
        // it), falling back to the clone. Without a workspace root nothing was ever checked out, so
        // there is no reader and the claim simply carries no gates — the same shape `env` takes when
        // its store is absent.
        ...(config.workspaceRoot
            ? {
                  gates: {
                      readFor: (workspacePath: string, repo: string, worktreeId: string | null) =>
                          readGatesFile({ root: config.workspaceRoot, workspacePath, repo, worktreeId }),
                  },
              }
            : {}),
        ...(tokens ? { githubToken: tokens } : {}),
    });

    // Unconditional too, and note that this does NOT depend on a workspace root being configured: with
    // none, the routes still answer and report that the feature is off. Only the QUEUE is conditional,
    // because there is nowhere to clone to.
    // Unconditional too, and note that this does NOT depend on a workspace root being configured: with
    // none, the routes still answer and report that the feature is off. Only the QUEUE is conditional,
    // because there is nowhere to clone to.
    const userRepoStore = createUserRepoStore({ sql, orgId: config.orgId, ready });
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

    /*
     * The per-user repo scope.
     *
     * Built only when every input it enumerates with exists: an App installation to ask, and an
     * auto-join org that makes the GitHub organization the membership boundary. Any deployment
     * short of both gets `undefined` — every route then serves the full installation list, which
     * is exactly what served before scoping existed. Offline (`github.mode: 'none'`) there is no
     * client to ask, so there is nothing to derive and nothing to pretend.
     */
    const scope =
        appClient && config.auth.mode === 'github' && config.auth.autoJoinGithubOrg
            ? createRepoAccessScope({
                  appClient,
                  repos,
                  org: config.auth.autoJoinGithubOrg,
                  access: createUserRepoAccessStore({ sql, orgId: config.orgId, ready }),
              })
            : undefined;
    if (scope) {
        console.log(
            "[scope] per-user repo scoping on: repos are intersected with each member's GitHub access at sign-in"
        );
    }

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
                `[auth] members of the GitHub organization "${config.auth.autoJoinGithubOrg}" join on first sign-in; read:org is requested`
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
                        `[auth] "${config.orgId}" has no members, so nobody can sign in. Set auth.bootstrap_admin, or run: npm run invite -- --org ${config.orgId} --login <github-login> --role admin`
                    );
                })
                .catch(() => {});
        }
    } else {
        // Unconditional and blunt, in the register of the "[fetch] no GitHub credential" line above:
        // the whole point of AUTH_MODE being an explicit enum is that nobody arrives here by accident,
        // and the line is what makes staying here a choice too.
        console.log(
            '[auth] AUTH_MODE=none: every route is open to anyone who can reach this port, including POST /api/jobs, which runs shell commands'
        );
    }

    const service = createStatsService({ config, repos, telemetry });
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
        scope,
        logger: true,
    });

    // Warm the cache at boot so the first visitor does not eat the cold read.
    service.ensureFresh();
    // Scoping intersects the stored sets against this list on every read, and a cold snapshot
    // would intersect everything to "nothing" — fail-closed, but a pointless refusal for the
    // window before the first fetch. One call at boot closes it; failure changes nothing, the
    // first scoped read or sign-in warms it anyway.
    if (scope) void repos.list().catch(() => {});

    // Also fired, not awaited. It recovers rows a restart stranded mid-clone and sweeps the partial
    // trees those left behind, then polls — all of which is minutes of network for something no route
    // on the read path needs, so `listen()` must not wait on it.
    //
    // Note what this does NOT do any more: clone anything on its own. Boot checks nothing out. A clone
    // happens only after somebody signs in and chooses repositories.
    cloneQueue?.start().catch((e: Error) => console.error(`[workspace] ${e.message}`));

    // The roster sweep, same posture: fired, never awaited, and failure logged rather than thrown —
    // a dead GitHub costs this feature nothing the last successful sweep did not already cover, and
    // it must not take the dashboard down with it. Admission is never this loop's business; it only
    // removes and re-roles rows auto-join created.
    if (scope) {
        const sweep = async (): Promise<void> => {
            try {
                const roster = await scope.roster();
                const { removed, roled } = await runRosterSync(authStore, config.orgId, roster);
                if (removed.length || roled.length) {
                    console.log(`[scope] roster sync: ${removed.length} removed, ${roled.length} re-roled`);
                }
            } catch (e) {
                console.error(`[scope] roster sync failed: ${(e as Error).message}`);
            }
        };
        void sweep();
        setInterval(() => void sweep(), ROSTER_SWEEP_MS).unref();
    }

    await app.listen({ port: config.port, host: config.host });
}
