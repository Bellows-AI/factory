import type { Sql } from 'postgres';
import type { AppConfig } from './config.js';
import { createEnvVarStore, type EnvVarStore } from './db/env-var-store.js';
import { createJobStore, type JobStore } from './db/job-store.js';
import { storedRepoNames } from './db/stored-repos.js';
import { createUserExecutorStore, type UserExecutorStore } from './db/user-executor-store.js';
import { createUserRepoStore, type UserRepoStore } from './db/user-repo-store.js';
import { createGitHubAppClient } from './github/app-client.js';
import { installationTokenProvider } from './github/app-token.js';
import { createRepoSource, type RepoSource } from './github/repo-source.js';
import { createWorkflowStore, type WorkflowStore } from './db/workflow-store.js';
import { createStatsService, type StatsService } from './stats-service.js';
import { createPostgresTelemetryClient } from './telemetry/postgres-client.js';
import { createFixtureTelemetryClient, createNullTelemetryClient } from './telemetry/fixture-client.js';
import type { TelemetryClient } from './telemetry/client.js';
import { createCloneQueue, type CloneQueue } from './workspace/queue.js';
import { readGatesFile } from './workspace/bellows.js';

/**
 * Everything one organization needs at runtime, built lazily and cached.
 *
 * Since #99 the org is a property of the caller, but every store below still binds its org at
 * construction — that is their shape, and per-call org parameters would thread a column through
 * several hundred query sites for no second implementation. The registry is how both stay true:
 * construction happens PER ORG, on first request from one, and the result is cached for the life
 * of the process. The cache is safe unbounded because an org id IS an installation id — a stable
 * database key that is never re-pointed — and the population is bounded by the installations the
 * App has.
 */
export interface OrgRuntime {
    orgId: string;
    /** The org's own repo list: one cached installation client's answer, or the stored fallback. */
    repos: RepoSource;
    telemetry: TelemetryClient;
    /** The org's stats cache, over the org's repos and telemetry. */
    service: StatsService;
    /** Present in the live server; absent in route tests that pass no stores. */
    jobs?: JobStore | undefined;
    /** The workflow definitions (027) this org's tasks may walk; present with the other stores. */
    workflows?: WorkflowStore | undefined;
    envVars?: EnvVarStore | undefined;
    userRepos?: UserRepoStore | undefined;
    userExecutors?: UserExecutorStore | undefined;
    cloneQueue?: CloneQueue | undefined;
}

export interface OrgRegistry {
    /** The runtime for an organization row, or null when no such row exists. */
    for(orgId: string): Promise<OrgRuntime | null>;
    /** Every organization row — the ingest resolver's matching set. */
    list(): Promise<{ id: string; name: string; installationId: string | null }[]>;
    /** Warms every existing org's stats cache, once migrations have landed. */
    warmAll(): Promise<void>;
}

export interface OrgRegistryDeps {
    sql: Sql;
    ready: Promise<unknown>;
    config: AppConfig;
    /** False in the route-test mode: the stats routes resolve, the stores stay unregistered. */
    withStores: boolean;
}

export function createOrgRegistry({ sql, ready, config, withStores }: OrgRegistryDeps): OrgRegistry {
    const runtimes = new Map<string, Promise<OrgRuntime | null>>();

    const build = async (orgId: string): Promise<OrgRuntime | null> => {
        await ready;
        const rows = await sql<{ id: string; name: string; installation_id: string | null }[]>`
            select id, name, installation_id::text as installation_id from organization where id = ${orgId}
        `;
        const row = rows[0];
        if (!row) return null;

        // The repo-read credential, per org: minted from THIS org's installation, never a
        // process-wide one. Offline there is no App to mint from, and the stored fallback keeps
        // a seeded database browsable — the same bargain the single-org repo source made.
        let client: ReturnType<typeof createGitHubAppClient> | undefined;
        let tokens: ReturnType<typeof installationTokenProvider> | undefined;
        if (config.github.mode === 'app' && row.installation_id !== null) {
            tokens = installationTokenProvider({ github: config.github, installationId: row.installation_id });
            client = createGitHubAppClient(config.github, tokens);
        }

        const repos = createRepoSource({
            client,
            stored: () => storedRepoNames({ sql, orgId, ready }),
        });

        const telemetry =
            config.telemetrySource === 'off'
                ? createNullTelemetryClient()
                : config.telemetrySource === 'fixture'
                  ? createFixtureTelemetryClient()
                  : createPostgresTelemetryClient({ sql, orgId, ready });

        const runtime: OrgRuntime = {
            orgId,
            repos,
            telemetry,
            service: createStatsService({ config, repos, telemetry }),
        };

        if (withStores) {
            const envVars = createEnvVarStore({ sql, orgId, ready });
            const userExecutors = createUserExecutorStore({ sql, orgId, ready });
            const userRepos = createUserRepoStore({ sql, orgId, ready });
            const cloneQueue = config.workspaceRoot
                ? createCloneQueue({
                      store: userRepos,
                      root: config.workspaceRoot,
                      orgId,
                      tokens,
                      log: (m) => console.log(`[workspace] ${m}`),
                  })
                : undefined;
            const jobs = createJobStore({
                sql,
                orgId,
                hasWorkspaces: config.workspaceRoot !== null,
                ready,
                env: envVars,
                executorConfig: userExecutors,
                // Gates are read off the server's own workspace mount, per claim, for the job's
                // author and repo label — worktree-first, falling back to the clone.
                ...(config.workspaceRoot
                    ? {
                          gates: {
                              readFor: (workspacePath: string, repo: string, worktreeId: string | null) =>
                                  readGatesFile({ root: config.workspaceRoot!, workspacePath, repo, worktreeId }),
                          },
                      }
                    : {}),
                // The claim mints the org's installation token under the runner env as its base
                // layer. Per-org here is the whole point: a runner gets the installation of the
                // org whose board it is working, and no other.
                ...(tokens ? { githubToken: tokens } : {}),
            });
            runtime.envVars = envVars;
            runtime.userExecutors = userExecutors;
            runtime.userRepos = userRepos;
            runtime.cloneQueue = cloneQueue;
            runtime.jobs = jobs;
            // Workflow definitions (027): the process a task walks, stored per scope inside this
            // org. The base `fix-issue` workflow seeds here too — org-level and the org's
            // default, idempotent by name and default-slot, fired with the same posture as the
            // clone queue: not awaited, because no route on the read path needs it, and a task
            // queued in the seeding's first seconds simply resolves no default yet.
            const workflows = createWorkflowStore({ sql, orgId, ready });
            runtime.workflows = workflows;
            void workflows.seedBase().catch((e: Error) => console.error(`[workflows] seed failed: ${e.message}`));
            // Fired, not awaited: recovering stranded clones is minutes of network no route on
            // the read path needs. The org's queue only starts once — with the org's runtime.
            void cloneQueue?.start().catch((e: Error) => console.error(`[workspace] ${e.message}`));
        }

        return runtime;
    };

    return {
        for(orgId) {
            let runtime = runtimes.get(orgId);
            if (!runtime) {
                runtime = build(orgId)
                    .then((built) => {
                        // Do not cache a MISS either: `for` is called with principal-carried ids
                        // (FK-guaranteed today), but a caller that asks before the org row lands
                        // would otherwise remember null for the process's whole life.
                        if (built === null) runtimes.delete(orgId);
                        return built;
                    })
                    .catch((e: Error) => {
                        // Do not cache a failure either: the next request retries, and the log
                        // line is what tells the operator which org could not be built.
                        console.error(`[org] runtime for "${orgId}" failed: ${e.message}`);
                        runtimes.delete(orgId);
                        return null;
                    });
                runtimes.set(orgId, runtime);
            }
            return runtime;
        },

        async list() {
            await ready;
            const rows = await sql<{ id: string; name: string; installation_id: string | null }[]>`
                select id, name, installation_id::text as installation_id from organization order by name
            `;
            return rows.map((row) => ({ id: row.id, name: row.name, installationId: row.installation_id }));
        },

        async warmAll() {
            await ready;
            for (const org of await this.list()) {
                const rt = await this.for(org.id);
                rt?.service.ensureFresh();
            }
        },
    };
}
