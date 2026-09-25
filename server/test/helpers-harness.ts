import { buildApp } from '../src/app.js';
import type { GitHubIdentityClient } from '../src/auth/github.js';
import type { AuthStore } from '../src/auth/store.js';
import { LOCAL_ORG_ID, type AppConfig } from '../src/config.js';
import type { EnvVarStore } from '../src/db/env-var-store.js';
import type { UserExecutorStore } from '../src/db/user-executor-store.js';
import type { WorkflowStore } from '../src/db/workflow-store.js';
import type { UserRepoStore } from '../src/db/user-repo-store.js';
import type { OrgRegistry, OrgRuntime } from '../src/orgs.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { createStatsService } from '../src/stats-service.js';
import type { InstallationRepo } from '../src/github/app-client.js';
import { testConfig } from './helpers-config.js';
import { memoryUserExecutorStore } from './helpers-user-executor-store.js';
import { stubTelemetryClient, type TelemetryStub } from './helpers-telemetry.js';

/**
 * A registry that answers for EVERY org id with one runtime — the single-org shape most route
 * tests want. Tests that need a specific org to exist pass `orgsFor` here or use `harness`.
 */
export function staticRegistry(
    parts: {
        config?: AppConfig;
        repos?: ReturnType<typeof staticRepoSource>;
        telemetry?: TelemetryStub;
        service?: ReturnType<typeof createStatsService>;
        jobs?: OrgRuntime['jobs'];
        workflows?: OrgRuntime['workflows'];
        prs?: OrgRuntime['prs'];
        envVars?: OrgRuntime['envVars'];
        userRepos?: OrgRuntime['userRepos'];
        userExecutors?: OrgRuntime['userExecutors'];
        workflowDefaults?: OrgRuntime['workflowDefaults'];
        cloneQueue?: OrgRuntime['cloneQueue'];
        /** When set, `for()` answers null for every id not in it. */
        orgsFor?: readonly string[];
    } = {}
): OrgRegistry {
    const config = parts.config ?? testConfig();
    const telemetry = parts.telemetry ?? stubTelemetryClient();
    const repos = parts.repos ?? staticRepoSource([]);
    const runtime: OrgRuntime = {
        orgId: LOCAL_ORG_ID,
        repos,
        telemetry,
        service: parts.service ?? createStatsService({ config, repos, telemetry }),
        jobs: parts.jobs,
        workflows: parts.workflows,
        prs: parts.prs,
        envVars: parts.envVars,
        userRepos: parts.userRepos,
        userExecutors: parts.userExecutors,
        workflowDefaults: parts.workflowDefaults,
        cloneQueue: parts.cloneQueue,
    };
    return {
        for: async (orgId) => (parts.orgsFor && !parts.orgsFor.includes(orgId) ? null : runtime),
        list: async () => [{ id: LOCAL_ORG_ID, name: LOCAL_ORG_ID, installationId: null }],
        warmAll: async () => {},
    };
}

const SETTLE_TICKS = 5;

export async function harness({
    config: overrides,
    telemetry: telemetryOption,
    auth,
    identity,
    repos: repoList,
    userRepos,
    userExecutors,
    envVars,
    appSlug,
    installationListing,
    orgsFor,
    workflows,
}: {
    config?: Partial<AppConfig>;
    /** Defaults to the fixture stub, so route tests get a populated payload without a database. */
    telemetry?: TelemetryStub;
    /**
     * Absent by default, which builds the app with NO auth at all — no hook, no /api/auth routes.
     *
     * That default is what lets the route-test files written before accounts existed keep driving
     * `app.inject()` with no cookie. A test that is about auth passes a store explicitly.
     */
    auth?: AuthStore;
    identity?: GitHubIdentityClient;
    /** Which repos this org measures. Defaults to the one the fixture PRs are stamped with. */
    repos?: readonly { owner: string; name: string }[];
    /** Absent by default, which leaves the workspace routes answering 503. */
    userRepos?: UserRepoStore;
    /** Defaults to an empty in-memory store whenever userRepos is given. */
    userExecutors?: UserExecutorStore;
    /** Absent by default, which leaves the env routes answering 503. */
    envVars?: EnvVarStore;
    /** The install-page slug, for the callback's 0-installations redirect. Absent offline. */
    appSlug?: () => Promise<string>;
    /**
     * Repos one installation can see, for the onboarding screen's per-org checkboxes (#125).
     * Absent by default, which leaves the screen reporting repo tracking as unavailable — the
     * offline shape, where there is no App client to ask.
     */
    installationListing?: (installationId: string) => Promise<InstallationRepo[] | null>;
    /**
     * Overrides which org ids the registry answers for. Tests are single-org, so the default
     * answers for EVERY id with the same runtime — the honest shape for a harness that has no
     * database: every route reads the org its caller carries, and here every caller resolves.
     */
    orgsFor?: readonly string[];
    /** Absent by default, which leaves the workflow routes answering 503. */
    workflows?: WorkflowStore;
} = {}) {
    const config = testConfig(overrides);
    const telemetry = telemetryOption ?? stubTelemetryClient();
    const repos = staticRepoSource(repoList ?? [{ owner: 'Bellows-AI', name: 'bellows.ai' }]);
    let clock = Date.parse('2026-08-21T12:00:00.000Z');
    const service = createStatsService({
        config,
        repos,
        telemetry,
        now: () => clock,
    });
    const executors = userRepos ? (userExecutors ?? memoryUserExecutorStore()) : undefined;
    // The same factory the route tests use directly — one registry shape, not two that drift.
    // `service` rides in so the runtime shares the harness's controllable clock.
    const orgs = staticRegistry({
        config,
        repos,
        telemetry,
        service,
        envVars,
        workflows,
        userRepos,
        userExecutors: executors,
        ...(orgsFor ? { orgsFor } : {}),
    });
    const app = await buildApp({
        config,
        orgs,
        auth,
        identity,
        appSlug,
        installationListing,
        now: () => clock,
    });
    return {
        app,
        orgs,
        repos,
        service,
        telemetry,
        executors,
        advance: (ms: number) => {
            clock += ms;
        },
        /** Lets the single-flight refresh promise settle without real timers. */
        settle: async () => {
            for (let i = 0; i < SETTLE_TICKS; i += 1) await new Promise((r) => setImmediate(r));
        },
    };
}
