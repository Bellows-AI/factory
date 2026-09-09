import { readFileSync } from 'node:fs';
import type { BranchHistory, CanonicalPr, TelemetryInput } from '@factory-ai/core';
import { buildApp } from '../src/app.js';
import type { GitHubIdentity, GitHubIdentityClient } from '../src/auth/github.js';
import { SESSION_COOKIE, hashToken, mintToken, sign } from '../src/auth/session.js';
import type { AuthStore, Caller, Role } from '../src/auth/store.js';
import type { AppConfig, AuthConfig } from '../src/config.js';
import type { EnvVarRow, EnvVarStore } from '../src/db/env-var-store.js';
import { stackEnv } from '../src/db/env-var-store.js';
import type { PrStore, SyncState } from '../src/db/pr-store.js';
import type { UserExecutorStore } from '../src/db/user-executor-store.js';
import type { CloneStatus, UserRepo, UserRepoStore } from '../src/db/user-repo-store.js';
import type { ForgeClient, PullRequestsResult } from '../src/forge.js';
import { fixturePayload } from '../src/github/fixture-payload.js';
import { GITHUB_CAPABILITIES, toCanonical } from '../src/github/map.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { createStatsService } from '../src/stats-service.js';
import type { TelemetryClient, TelemetryHealth } from '../src/telemetry/client.js';

const TELEMETRY_FIXTURE = new URL('../../core/test/fixtures/telemetry-sessions.json', import.meta.url);

export const TEST_REPO = 'Bellows-AI/bellows.ai';

let payload: CanonicalPr[] | null = null;
/** Mapped through the adapter, like both real clients do, rather than read pre-canonicalised. */
export function samplePrs(): CanonicalPr[] {
    if (!payload) {
        payload = fixturePayload().map((pr) => toCanonical(pr, TEST_REPO));
    }
    return payload;
}

let telemetryPayload: TelemetryInput | null = null;
export function sampleTelemetry(): TelemetryInput {
    if (!telemetryPayload) {
        telemetryPayload = JSON.parse(readFileSync(TELEMETRY_FIXTURE, 'utf8')) as TelemetryInput;
    }
    return telemetryPayload;
}

export const EMPTY_TELEMETRY: TelemetryInput = {
    sessions: [],
    spans: [],
    splits: [],
    links: [],
    coverage: { from: null, to: null },
};

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
        orgId: 'test-org',
        orgName: 'Test Org',
        // `none` — the code-only no-fetch arm — so the offline suite never constructs a token
        // provider or an App client. The repo list reaches the service through `staticRepoSource`
        // in `harness` instead — which is the same seam `npm run seed` and `verify:ui` use, rather
        // than a test-only one.
        github: { mode: 'none' },
        baseBranch: 'dev',
        bots: ['claude', 'claude[bot]', 'github-actions', 'github-actions[bot]', 'bellows-frontend-fix-bot'],
        syncTtlMs: 60_000,
        port: 0,
        host: '127.0.0.1',
        webRoot: null,
        telemetrySource: 'fixture',
        // Never connected to: the harness injects a store and a telemetry stub directly. It is a
        // literal here because AppConfig requires one, not because anything opens it.
        databaseUrl: 'postgres://factory:factory@127.0.0.1:5432/factory_test',
        telemetryTtlMs: 30_000,
        workspaceRoot: null,
        // Matches loadConfig's default. Note that this is only what the *config* says: the app is
        // built with no auth store at all unless a test passes one, so by default no hook runs.
        auth: { mode: 'none', ingestToken: null },
        ...overrides,
    };
}

export const TEST_SESSION_SECRET = 'test-session-secret-of-at-least-32-chars';

/** A github-mode [auth] block, so a test does not have to restate eleven fields to change one. */
export function githubAuth(overrides: Partial<Extract<AuthConfig, { mode: 'github' }>> = {}): AuthConfig {
    return {
        mode: 'github',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        sessionSecret: TEST_SESSION_SECRET,
        sessionTtlMs: 14 * 24 * 3600 * 1000,
        cookieSecure: false,
        publicUrl: 'http://127.0.0.1:8080',
        bootstrapAdmin: null,
        autoJoinGithubOrg: null,
        ingestToken: null,
        authorizeUrl: 'https://github.test/login/oauth/authorize',
        tokenUrl: 'https://github.test/login/oauth/access_token',
        userUrl: 'https://api.github.test/user',
        ...overrides,
    };
}

export interface StubOptions {
    prs?: () => Promise<PullRequestsResult>;
    /** A single repo's history. The stub wraps it into the per-repo list the client returns. */
    history?: () => Promise<BranchHistory | null>;
    /** The base-branch commits the history is made of. Needed to slice a revert rate by date. */
    commits?: () => { sha: string; committedAt: string; messageHeadline: string }[];
}

export interface Stub extends ForgeClient {
    prCalls: number;
    historyCalls: number;
    /** What the service asked each walk to stop at, so a test can pin the cutoff arithmetic. */
    lastCutoff: Record<string, string> | null;
    lastMode: string | null;
    /** What the service asked each history scan to start from. */
    lastSince: Record<string, string> | null;
}

export function stubClient(options: StubOptions = {}): Stub {
    const stub: Stub = {
        provider: 'github',
        capabilities: GITHUB_CAPABILITIES,
        prCalls: 0,
        historyCalls: 0,
        lastCutoff: null,
        lastMode: null,
        lastSince: null,
        async fetchPullRequests({ mode, cutoff } = {}) {
            stub.prCalls += 1;
            stub.lastMode = mode ?? null;
            stub.lastCutoff = cutoff ?? null;
            if (options.prs) return options.prs();
            return {
                prs: structuredClone(samplePrs()),
                rateLimit: null,
                completed: { [TEST_REPO]: true },
            };
        },
        async fetchBranchHistories(since) {
            stub.historyCalls += 1;
            stub.lastSince = since;
            const history = options.history
                ? await options.history()
                : { branch: 'dev', since: '2026-04-03T00:00:00Z', commits: 515, reverts: 5 };
            return [
                { repo: TEST_REPO, branch: 'dev', history, commits: options.commits?.() ?? [] },
            ];
        },
    };
    return stub;
}

export interface MemoryStore extends PrStore {
    /** Every write the service attempted, so a test can assert what was and was not persisted. */
    saved: CanonicalPr[][];
    recorded: { repo: string; kind: string; watermarkAt: string | null; mode: string }[];
    /** Set to make every method reject, standing in for an unreachable database. */
    broken: boolean;
}

/**
 * An in-memory PrStore. Keeps the offline suite a no-database suite while still exercising the
 * seed, the watermark arithmetic and the failure isolation — the SQL itself is covered by
 * server/test-db, which needs a container.
 */
export function memoryPrStore(seed: {
    prs?: CanonicalPr[];
    commits?: { repo: string; branch: string; sha: string; committedAt: string; messageHeadline: string }[];
    coverage?: { repo: string; branch: string; from: string; commits: number; reverts: number }[];
    sync?: Record<string, Partial<SyncState>>;
    /** The instant a recorded sync is stamped with. Never the real clock: the harness pins time. */
    now?: () => number;
} = {}): MemoryStore {
    const now = seed.now ?? (() => Date.parse('2026-08-21T12:00:00.000Z'));
    let prs = seed.prs ? [...seed.prs] : [];
    const commits = seed.commits ? [...seed.commits] : [];
    const coverage = seed.coverage ? [...seed.coverage] : [];
    const sync: Record<string, SyncState> = {};
    for (const [repo, state] of Object.entries(seed.sync ?? {})) {
        sync[repo] = {
            watermarkAt: null,
            lastSyncAt: null,
            lastFullAt: null,
            syncedEpoch: 0,
            lastRateLimit: null,
            ...state,
        };
    }

    const guard = () => {
        if (store.broken) throw new Error('database is unreachable');
    };

    const store: MemoryStore = {
        saved: [],
        recorded: [],
        broken: false,

        async storedRepos() {
            guard();
            return [...new Set(prs.map((pr) => pr.repo))].sort();
        },

        async loadPullRequests() {
            guard();
            // Same ordering the SQL imposes, and for the same reason: compute() reads
            // stats.meta.window off array position.
            return [...prs].sort(
                (a, b) =>
                    b.createdAt.localeCompare(a.createdAt) ||
                    a.repo.localeCompare(b.repo) ||
                    b.number - a.number,
            );
        },
        async savePullRequests(incoming) {
            guard();
            store.saved.push([...incoming]);
            const byKey = new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]));
            for (const pr of incoming) byKey.set(`${pr.repo}#${pr.number}`, pr);
            prs = [...byKey.values()];
        },
        async loadBranchCommits(_provider, _repos, branch) {
            guard();
            return commits.filter((c) => c.branch === branch);
        },
        async saveBranchHistory(_provider, entry) {
            guard();
            for (const commit of entry.newCommits) {
                if (commits.some((c) => c.repo === entry.repo && c.sha === commit.sha)) continue;
                commits.push({ repo: entry.repo, branch: entry.branch, ...commit });
            }
            const held = coverage.find((c) => c.repo === entry.repo && c.branch === entry.branch);
            if (held) {
                held.from = held.from < entry.coveredFrom ? held.from : entry.coveredFrom;
                held.commits = entry.commits;
                held.reverts = entry.reverts;
            } else {
                coverage.push({
                    repo: entry.repo,
                    branch: entry.branch,
                    from: entry.coveredFrom,
                    commits: entry.commits,
                    reverts: entry.reverts,
                });
            }
        },
        async loadBranchCoverage(_provider, _repos, branch) {
            guard();
            return coverage
                .filter((c) => c.branch === branch)
                .map((c) => ({ ...c, scannedAt: '2026-08-21T12:00:00.000Z' }));
        },
        async readSyncState() {
            guard();
            return structuredClone(sync);
        },
        async oldestOpenUpdatedAt() {
            guard();
            const oldest: Record<string, string> = {};
            for (const pr of prs) {
                if (pr.state !== 'open') continue;
                const held = oldest[pr.repo];
                if (!held || pr.updatedAt < held) oldest[pr.repo] = pr.updatedAt;
            }
            return oldest;
        },
        async recordSync(_provider, repo, kind, update) {
            guard();
            store.recorded.push({ repo, kind, watermarkAt: update.watermarkAt ?? null, mode: update.mode });
            const held = sync[repo] ?? {
                watermarkAt: null,
                lastSyncAt: null,
                lastFullAt: null,
                syncedEpoch: 0,
                lastRateLimit: null,
            };
            sync[repo] = {
                watermarkAt:
                    update.watermarkAt && (!held.watermarkAt || update.watermarkAt > held.watermarkAt)
                        ? update.watermarkAt
                        : held.watermarkAt,
                lastSyncAt: new Date(now()).toISOString(),
                lastFullAt: update.mode === 'full' ? new Date(now()).toISOString() : held.lastFullAt,
                syncedEpoch: Math.max(held.syncedEpoch, update.syncedEpoch),
                lastRateLimit: update.rateLimit ?? held.lastRateLimit,
            };
        },
    };
    return store;
}

export interface MemoryUserRepoStore extends UserRepoStore {
    /** Every row, deselected ones included, so a test can assert nothing was deleted. */
    rows(): { userId: string; owner: string; name: string; status: CloneStatus; deselected: boolean }[];
    /** Puts a row into `cloning` without a queue, to stand in for a process that then died. */
    strand(userId: string, repo: { owner: string; name: string }): void;
}

/**
 * An in-memory UserRepoStore, for the same reason memoryPrStore exists: it keeps the offline suite a
 * no-database suite while still exercising the selection rules, the claim and the restart recovery.
 * The SQL behind it is covered by server/test-db, which needs a container.
 */
export function memoryUserRepoStore(): MemoryUserRepoStore {
    interface Row {
        userId: string;
        owner: string;
        name: string;
        status: CloneStatus;
        error: string | null;
        attempts: number;
        selectedAt: string;
        startedAt: string | null;
        readyAt: string | null;
        deselectedAt: string | null;
    }
    const rows: Row[] = [];
    const at = () => new Date().toISOString();
    const find = (userId: string, repo: { owner: string; name: string }) =>
        rows.find((r) => r.userId === userId && r.owner === repo.owner && r.name === repo.name);
    const view = (row: Row): UserRepo => ({
        owner: row.owner,
        name: row.name,
        status: row.status,
        error: row.error,
        attempts: row.attempts,
        selectedAt: row.selectedAt,
        startedAt: row.startedAt,
        readyAt: row.readyAt,
    });

    return {
        rows: () =>
            rows.map((r) => ({
                userId: r.userId,
                owner: r.owner,
                name: r.name,
                status: r.status,
                deselected: r.deselectedAt !== null,
            })),

        strand(userId, repo) {
            const row = find(userId, repo);
            if (row) row.status = 'cloning';
        },

        async select(userId, repos) {
            for (const repo of repos) {
                const held = find(userId, repo);
                if (held) {
                    held.deselectedAt = null;
                    held.selectedAt = at();
                    // A checkout that is on disk is on disk, whatever a later request says.
                    if (held.status !== 'ready') {
                        held.status = 'queued';
                        held.error = null;
                    }
                    continue;
                }
                rows.push({
                    userId,
                    owner: repo.owner,
                    name: repo.name,
                    status: 'queued',
                    error: null,
                    attempts: 0,
                    selectedAt: at(),
                    startedAt: null,
                    readyAt: null,
                    deselectedAt: null,
                });
            }
            const keep = new Set(repos.map((r) => `${r.owner}/${r.name}`));
            for (const row of rows) {
                if (row.userId !== userId || row.deselectedAt !== null) continue;
                if (!keep.has(`${row.owner}/${row.name}`)) row.deselectedAt = at();
            }
        },

        async list(userId) {
            return rows.filter((r) => r.userId === userId && r.deselectedAt === null).map(view);
        },

        async orphaned(userId) {
            return rows.filter((r) => r.userId === userId && r.deselectedAt !== null).map(view);
        },

        async claimPending(limit) {
            const claimed = rows
                .filter((r) => r.status === 'queued' && r.deselectedAt === null)
                .sort((a, b) => a.selectedAt.localeCompare(b.selectedAt))
                .slice(0, Math.max(0, limit));
            for (const row of claimed) {
                row.status = 'cloning';
                row.startedAt = at();
                row.attempts += 1;
                row.error = null;
            }
            return claimed.map((r) => ({ userId: r.userId, owner: r.owner, name: r.name }));
        },

        async markReady(userId, repo) {
            const row = find(userId, repo);
            if (!row) return;
            row.status = 'ready';
            row.readyAt = at();
            row.error = null;
        },

        async markFailed(userId, repo, error) {
            const row = find(userId, repo);
            if (!row) return;
            row.status = 'failed';
            row.error = error;
        },

        async requeueStranded() {
            const stranded = rows.filter((r) => r.status === 'cloning');
            for (const row of stranded) {
                row.status = 'queued';
                row.error = null;
            }
            return stranded.length;
        },
    };
}

export interface MemoryUserExecutorStore extends UserExecutorStore {
    /** Every row, so a test can assert what a PUT wrote and what a later PUT replaced. */
    rows(): { userId: string; name: string; type: string; config: Record<string, unknown> }[];
}

/**
 * An in-memory UserExecutorStore, for the same reason memoryUserRepoStore exists. The SQL behind it
 * is covered by server/test-db, which needs a container.
 */
export function memoryUserExecutorStore(): MemoryUserExecutorStore {
    interface Row {
        userId: string;
        name: string;
        type: string;
        config: Record<string, unknown>;
        createdAt: string;
        updatedAt: string;
    }
    const rows: Row[] = [];
    const at = () => new Date().toISOString();

    return {
        rows: () =>
            rows.map((r) => ({
                userId: r.userId,
                name: r.name,
                type: r.type,
                config: structuredClone(r.config),
            })),

        async replace(userId, executors) {
            for (let i = rows.length - 1; i >= 0; i -= 1) {
                if (rows[i]!.userId === userId) rows.splice(i, 1);
            }
            for (const executor of executors) {
                rows.push({
                    userId,
                    name: executor.name,
                    type: executor.type,
                    config: structuredClone(executor.config),
                    createdAt: at(),
                    updatedAt: at(),
                });
            }
        },

        async list(userId) {
            return rows
                .filter((r) => r.userId === userId)
                .map((r) => ({
                    name: r.name,
                    type: r.type,
                    createdAt: r.createdAt,
                    updatedAt: r.updatedAt,
                }))
                // The SQL orders the same way; created_at ties break on name.
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
        },
    };
}

export interface MemoryEnvVarStore extends EnvVarStore {
    /**
     * Every row with its REAL values, scope columns included — what the routes' nulled echo
     * deliberately withholds.
     */
    rows(): {
        userId: string | null;
        owner: string | null;
        repoName: string | null;
        name: string;
        value: string;
        isSecret: boolean;
    }[];
    /** Set to make every method reject, standing in for an unreachable database. */
    broken: boolean;
}

/**
 * An in-memory EnvVarStore, for the same reason memoryUserExecutorStore exists: it keeps the
 * offline suite a no-database suite while still exercising the write-only echo, the keep-a-null-
 * secret replace rule and the stacking. The SQL behind it is covered by server/test-db, which
 * needs a container.
 */
export function memoryEnvVarStore(): MemoryEnvVarStore {
    interface Row {
        userId: string | null;
        owner: string | null;
        repoName: string | null;
        name: string;
        value: string;
        isSecret: boolean;
        updatedAt: string;
    }
    const rows: Row[] = [];
    const at = () => new Date().toISOString();

    const store: MemoryEnvVarStore = {
        broken: false,

        rows: () =>
            rows.map((r) => ({
                userId: r.userId,
                owner: r.owner,
                repoName: r.repoName,
                name: r.name,
                value: r.value,
                isSecret: r.isSecret,
            })),

        async listOrg() {
            return rows
                .filter((r) => r.userId === null && r.owner === null)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(view);
        },

        async listWorkspace(userId) {
            return rows
                .filter((r) => r.userId === userId)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(view);
        },

        async listRepo(owner, name) {
            return rows
                .filter((r) => r.owner === owner && r.repoName === name)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(view);
        },

        async listRepos() {
            const grouped: { owner: string; name: string; vars: EnvVarRow[] }[] = [];
            for (const row of rows.filter((r) => r.owner !== null).sort(compareRepoOrder)) {
                let group = grouped.find((g) => g.owner === row.owner && g.name === row.repoName);
                if (!group) {
                    group = { owner: row.owner!, name: row.repoName!, vars: [] };
                    grouped.push(group);
                }
                group.vars.push(view(row));
            }
            return grouped;
        },

        async replaceOrg(vars) {
            replaceRows('org', vars);
        },

        async replaceWorkspace(userId, vars) {
            replaceRows({ userId }, vars);
        },

        async replaceRepo(owner, name, vars) {
            replaceRows({ owner, name }, vars);
        },

        async resolveFor({ userId, repo }, _exec) {
            const pick = (list: Row[]): Record<string, string> =>
                Object.fromEntries(list.map((r) => [r.name, r.value]));
            const [owner, name] = repo ? repo.split('/') : [null, null];
            return stackEnv(
                pick(rows.filter((r) => r.userId === null && r.owner === null)),
                pick(userId ? rows.filter((r) => r.userId === userId) : []),
                pick(owner && name ? rows.filter((r) => r.owner === owner && r.repoName === name) : []),
            );
        },
    };

    function view(row: Row): EnvVarRow {
        return {
            name: row.name,
            // The write-only echo, exactly as the SQL selects it.
            value: row.isSecret ? null : row.value,
            isSecret: row.isSecret,
            updatedAt: row.updatedAt,
        };
    }

    function compareRepoOrder(a: Row, b: Row): number {
        return a.owner!.localeCompare(b.owner!) || a.repoName!.localeCompare(b.repoName!) || a.name.localeCompare(b.name);
    }

    /** The keep-a-null-secret replace, mirroring the store's transaction semantics. */
    function replaceRows(
        scope: 'org' | { userId: string } | { owner: string; name: string },
        vars: readonly { name: string; value: string | null; isSecret: boolean }[],
    ): void {
        if (store.broken) throw new Error('database is unreachable');
        const inScope = (row: Row): boolean => {
            if (scope === 'org') return row.userId === null && row.owner === null;
            if ('userId' in scope) return row.userId === scope.userId;
            return row.owner === scope.owner && row.repoName === scope.name;
        };
        const columns = scopeColumns(scope);
        const keep = new Set(vars.filter((v) => v.isSecret && v.value === null).map((v) => v.name));
        for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (inScope(rows[i]!) && !keep.has(rows[i]!.name)) rows.splice(i, 1);
        }
        for (const v of vars) {
            if (v.value === null) continue;
            rows.push({
                ...columns,
                name: v.name,
                value: v.value,
                isSecret: v.isSecret,
                updatedAt: at(),
            });
        }
    }

    /** The scope columns a row in this scope carries — null for every scope it is not. */
    function scopeColumns(
        scope: 'org' | { userId: string } | { owner: string; name: string },
    ): { userId: string | null; owner: string | null; repoName: string | null } {
        if (scope === 'org') return { userId: null, owner: null, repoName: null };
        if ('userId' in scope) return { userId: scope.userId, owner: null, repoName: null };
        return { userId: null, owner: scope.owner, repoName: scope.name };
    }

    return store;
}

export interface MemoryAuthStore extends AuthStore {
    /**
     * Creates a claimed membership and returns the account, so a test can hold a session without
     * driving the whole OAuth round trip to get one.
     */
    seedMember(orgId: string, login: string, role?: Role): Caller;
    /**
     * The stand-in account AUTH_MODE=none resolves, exactly as migrate()'s ensureLocalUser writes
     * it: github_user_id 0, a value GitHub never issues, and the reserved `__local__` login, which
     * is unrepresentable as a real GitHub login because underscores are not permitted in one.
     */
    seedLocalUser(orgId: string): Caller;
    /** Every live session's user id, so a test can assert one was created — or was not. */
    sessions(): string[];
    seedWorkerToken(orgId: string, name: string, token: string): void;
}

/**
 * An in-memory AuthStore, for the same reason memoryPrStore exists: it keeps the offline suite a
 * no-database suite while still exercising the claim rule, the membership join and the session
 * lifecycle. The SQL behind it is covered by server/test-db, which needs a container.
 */
export function memoryAuthStore(): MemoryAuthStore {
    interface User {
        id: string;
        githubUserId: number;
        login: string;
        displayName: string | null;
    }
    interface Member {
        orgId: string;
        login: string;
        userId: string | null;
        role: Role;
        claimed: boolean;
    }

    const users: User[] = [];
    const members: Member[] = [];
    const sessions = new Map<string, { userId: string; expiresAt: number }>();
    const workerTokens: { orgId: string; id: string; name: string; hash: string; revoked: boolean }[] = [];
    let nextId = 1;

    /**
     * A uuid, like app_user.id. Not cosmetic: that id becomes a workspace path segment and a docker
     * WORKDIR, and both `workspaceDir()` and the driver refuse one that is not a uuid. A store that
     * minted `user-1` would let those assertions pass here and fail against a real database.
     */
    const userId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    const key = (hash: Buffer) => hash.toString('hex');
    const callerFor = (user: User, member: Member): Caller => ({
        user: { id: user.id, githubUserId: user.githubUserId, login: user.login, displayName: user.displayName },
        role: member.role,
    });
    const memberOf = (userId: string, orgId: string): Caller | null => {
        const member = members.find((m) => m.orgId === orgId && m.userId === userId);
        const user = users.find((u) => u.id === userId);
        return member && user ? callerFor(user, member) : null;
    };

    const store: MemoryAuthStore = {
        seedMember(orgId, login, role = 'member') {
            const user: User = {
                id: userId(nextId),
                githubUserId: nextId,
                login: login.toLowerCase(),
                displayName: login,
            };
            nextId += 1;
            users.push(user);
            const member: Member = { orgId, login: user.login, userId: user.id, role, claimed: true };
            members.push(member);
            return callerFor(user, member);
        },

        seedLocalUser(orgId) {
            const user: User = { id: userId(0), githubUserId: 0, login: '__local__', displayName: 'Local' };
            users.push(user);
            const member: Member = {
                orgId,
                login: user.login,
                userId: user.id,
                role: 'admin',
                claimed: true,
            };
            members.push(member);
            return callerFor(user, member);
        },

        sessions: () => [...sessions.values()].map((s) => s.userId),

        seedWorkerToken(orgId, name, token) {
            workerTokens.push({
                orgId,
                id: `worker-${workerTokens.length + 1}`,
                name,
                hash: key(hashToken(token)),
                revoked: false,
            });
        },

        async signIn(identity, orgId, options) {
            const login = identity.login.toLowerCase();
            let user = users.find((u) => u.githubUserId === identity.githubUserId);
            if (user) {
                // A rename updates the label. It never creates a second account, and it never
                // detaches the membership already bound to this numeric id.
                user.login = login;
                user.displayName = identity.displayName;
            } else {
                user = {
                    id: userId(nextId),
                    githubUserId: identity.githubUserId,
                    login,
                    displayName: identity.displayName,
                };
                nextId += 1;
                users.push(user);
            }

            for (const member of members) {
                if (member.login !== login || member.userId !== null) continue;
                if (members.some((m) => m.orgId === member.orgId && m.userId === user.id)) continue;
                member.userId = user.id;
                member.claimed = true;
            }
            const claimed = memberOf(user.id, orgId);
            if (claimed || !options?.autoJoin) return claimed;
            // Mirrors the SQL store's `on conflict do nothing`: an existing row for this login keeps
            // whatever role it has rather than being reset to `member`.
            if (!members.some((m) => m.orgId === orgId && m.login === login)) {
                members.push({ orgId, login, userId: user.id, role: 'member', claimed: true });
            }
            return memberOf(user.id, orgId);
        },

        async createSession(tokenHash, userId, expiresAt) {
            sessions.set(key(tokenHash), { userId, expiresAt: expiresAt.getTime() });
        },

        async findSession(tokenHash, orgId) {
            const session = sessions.get(key(tokenHash));
            if (!session || session.expiresAt <= Date.now()) return null;
            return memberOf(session.userId, orgId);
        },

        async deleteSession(tokenHash) {
            sessions.delete(key(tokenHash));
        },

        async localCaller(orgId) {
            const user = users.find((u) => u.githubUserId === 0);
            return user ? memberOf(user.id, orgId) : null;
        },

        async findWorkerToken(tokenHash) {
            const found = workerTokens.find((t) => t.hash === key(tokenHash) && !t.revoked);
            return found ? { orgId: found.orgId, id: found.id, name: found.name } : null;
        },

        async invite(orgId, login, role) {
            const normalised = login.toLowerCase();
            const held = members.find((m) => m.orgId === orgId && m.login === normalised);
            if (held) {
                held.role = role;
                return 'updated';
            }
            members.push({ orgId, login: normalised, userId: null, role, claimed: false });
            return 'created';
        },

        async removeMember(orgId, login) {
            const normalised = login.toLowerCase();
            const index = members.findIndex((m) => m.orgId === orgId && m.login === normalised);
            if (index === -1) return 'missing';
            const [removed] = members.splice(index, 1);
            for (const [hash, session] of sessions) {
                if (session.userId === removed!.userId) sessions.delete(hash);
            }
            return 'removed';
        },

        async listMembers(orgId) {
            return members
                .filter((m) => m.orgId === orgId)
                .map((m) => ({ login: m.login, role: m.role, claimed: m.claimed }));
        },

        async createWorkerToken(orgId, name, tokenHash) {
            const id = `worker-${workerTokens.length + 1}`;
            workerTokens.push({ orgId, id, name, hash: key(tokenHash), revoked: false });
            return { id };
        },

        async revokeWorkerToken(orgId, name) {
            const found = workerTokens.find((t) => t.orgId === orgId && t.name === name && !t.revoked);
            if (!found) return 'missing';
            found.revoked = true;
            return 'revoked';
        },

        async listWorkerTokens(orgId) {
            return workerTokens
                .filter((t) => t.orgId === orgId)
                .map((t) => ({ name: t.name, createdAt: '2026-08-21T12:00:00.000Z', revoked: t.revoked }));
        },
    };
    return store;
}

/** Mints a live session for `caller` and returns the Cookie header that presents it. */
export async function signedIn(
    store: AuthStore,
    caller: Caller,
    secret = TEST_SESSION_SECRET,
): Promise<string> {
    const token = mintToken();
    await store.createSession(hashToken(token), caller.user.id, new Date(Date.now() + 3600_000));
    return `${SESSION_COOKIE}=${sign(token, secret)}`;
}

export interface IdentityStub extends GitHubIdentityClient {
    /** What the next exchange resolves to. Set per test. */
    next: GitHubIdentity;
    exchanges: string[];
    /** What GitHub says about the auto-join organization. Set per test. */
    orgState: 'active' | 'pending' | 'none';
    /** Every org the callback asked about, so a test can assert it did not ask at all. */
    orgLookups: string[];
}

export function stubIdentityClient(identity?: Partial<GitHubIdentity>): IdentityStub {
    const stub: IdentityStub = {
        next: {
            githubUserId: 4242,
            login: 'octocat',
            displayName: 'The Octocat',
            avatarUrl: null,
            ...identity,
        },
        exchanges: [],
        orgState: 'none',
        orgLookups: [],
        authorizeUrl: (state) => `https://github.test/login/oauth/authorize?state=${state}`,
        async exchange(code) {
            stub.exchanges.push(code);
            return `access-for-${code}`;
        },
        async identity() {
            return stub.next;
        },
        async orgMembership(_accessToken, org) {
            stub.orgLookups.push(org);
            return stub.orgState;
        },
    };
    return stub;
}

export interface TelemetryStubOptions {
    rollups?: () => Promise<TelemetryInput>;
    health?: () => Promise<TelemetryHealth>;
}

export interface TelemetryStub extends TelemetryClient {
    rollupCalls: number;
    healthCalls: number;
}

export function stubTelemetryClient(options: TelemetryStubOptions = {}): TelemetryStub {
    const stub: TelemetryStub = {
        rollupCalls: 0,
        healthCalls: 0,
        async fetchRollups() {
            stub.rollupCalls += 1;
            if (options.rollups) return options.rollups();
            return structuredClone(sampleTelemetry());
        },
        async health() {
            stub.healthCalls += 1;
            if (options.health) return options.health();
            return { status: 'ok', reason: null };
        },
    };
    return stub;
}

export async function harness(options: {
    client: Stub;
    config?: Partial<AppConfig>;
    /** Defaults to the fixture stub, so tests written before telemetry existed still pass. */
    telemetry?: TelemetryStub;
    /**
     * Defaults to an empty in-memory store.
     *
     * The service requires one now, but that requirement is about *persistence being the only
     * source*, not about PostgreSQL: `memoryPrStore()` satisfies `PrStore` in full, so the offline
     * suite stays offline. Tests that care about what is already stored pass a seeded one.
     */
    store?: PrStore;
    /**
     * Absent by default, which builds the app with NO auth at all — no hook, no /api/auth routes.
     *
     * That default is what lets the seventeen route-test files written before accounts existed keep
     * driving `app.inject()` with no cookie. A test that is about auth passes a store explicitly.
     */
    auth?: AuthStore;
    identity?: GitHubIdentityClient;
    /** Which repos this org measures. Defaults to the one the fixture PRs are stamped with. */
    repos?: readonly { owner: string; name: string }[];
    /** Absent by default, which leaves the workspace routes unregistered. */
    userRepos?: UserRepoStore;
    /** Defaults to an empty in-memory store whenever userRepos is given. */
    userExecutors?: UserExecutorStore;
    /** Absent by default, which leaves the env routes unregistered. */
    envVars?: EnvVarStore;
}) {
    const config = testConfig(options.config);
    const telemetry = options.telemetry ?? stubTelemetryClient();
    const repos = staticRepoSource(options.repos ?? [{ owner: 'Bellows-AI', name: 'bellows.ai' }]);
    let clock = Date.parse('2026-08-21T12:00:00.000Z');
    const service = createStatsService({
        config,
        client: options.client,
        repos,
        telemetry,
        store: options.store ?? memoryPrStore(),
        now: () => clock,
    });
    const executors = options.userRepos
        ? (options.userExecutors ?? memoryUserExecutorStore())
        : undefined;
    const app = await buildApp({
        config,
        service,
        repos,
        userRepos: options.userRepos,
        userExecutors: executors,
        envVars: options.envVars,
        auth: options.auth,
        identity: options.identity,
        now: () => clock,
    });
    return {
        app,
        service,
        client: options.client,
        telemetry,
        executors,
        advance: (ms: number) => {
            clock += ms;
        },
        /** Lets the single-flight refresh promise settle without real timers. */
        settle: async () => {
            for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
        },
    };
}
