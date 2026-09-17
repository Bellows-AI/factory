import { readFileSync } from 'node:fs';
import type { JobRun, TelemetryInput } from '@factory-ai/core';
import { buildApp } from '../src/app.js';
import type { GitHubIdentity, GitHubIdentityClient, InstallationAccount } from '../src/auth/github.js';
import { SESSION_COOKIE, hashToken, mintToken, sign } from '../src/auth/session.js';
import type {
    AuthStore,
    AccessTokenKind,
    AccessTokenView,
    Caller,
    InstallationRef,
    OrgTokenIdentity,
    Role,
} from '../src/auth/store.js';
import { LOCAL_ORG_ID, type AppConfig, type AuthConfig } from '../src/config.js';
import type { EnvVarRow, EnvVarStore } from '../src/db/env-var-store.js';
import { stackEnv } from '../src/db/env-var-store.js';
import type { UserExecutorStore } from '../src/db/user-executor-store.js';
import type { WorkflowStore } from '../src/db/workflow-store.js';
import type { CloneStatus, UserRepo, UserRepoStore } from '../src/db/user-repo-store.js';
import type { OrgRuntime } from '../src/orgs.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import { createStatsService } from '../src/stats-service.js';
import type { TelemetryClient, TelemetryHealth } from '../src/telemetry/client.js';

const TELEMETRY_FIXTURE = new URL('../../core/test/fixtures/telemetry-sessions.json', import.meta.url);

export const TEST_REPO = 'Bellows-AI/bellows.ai';

let telemetryPayload: TelemetryInput | null = null;
export function sampleTelemetry(): TelemetryInput {
    if (!telemetryPayload) {
        telemetryPayload = JSON.parse(readFileSync(TELEMETRY_FIXTURE, 'utf8')) as TelemetryInput;
    }
    return telemetryPayload;
}

export const EMPTY_TELEMETRY: TelemetryInput = {
    sessions: [],
    coverage: { from: null, to: null },
};

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
        // `none` — the code-only no-fetch arm — so the offline suite never constructs a token
        // provider or an App client. The repo list reaches the service through `staticRepoSource`
        // in `harness` instead — which is the same seam `npm run seed` and `verify:ui` use, rather
        // than a test-only one. There is no orgId/orgName any more (#99): the orgs live in the
        // store and the registry, and the tests that name one use 'test-org' explicitly.
        github: { mode: 'none' },
        port: 0,
        host: '127.0.0.1',
        webRoot: null,
        telemetrySource: 'fixture',
        // Never connected to: the harness injects a telemetry stub directly. It is a literal here
        // because AppConfig requires one, not because anything opens it.
        databaseUrl: 'postgres://factory:factory@127.0.0.1:5432/factory_test',
        telemetryTtlMs: 30_000,
        workspaceRoot: null,
        // Matches loadConfig's default. Note that this is only what the *config* says: the app is
        // built with no auth store at all unless a test passes one, so by default no hook runs.
        auth: { mode: 'none', ingestToken: null },
        // No webhook secret, so no installation webhook route — the tests that want one set it.
        webhookSecret: null,
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
        ingestToken: null,
        authorizeUrl: 'https://github.test/login/oauth/authorize',
        tokenUrl: 'https://github.test/login/oauth/access_token',
        userUrl: 'https://api.github.test/user',
        ...overrides,
    };
}

export interface MemoryUserRepoStore extends UserRepoStore {
    /** Every row, deselected ones included, so a test can assert nothing was deleted. */
    rows(): { userId: string; owner: string; name: string; status: CloneStatus; deselected: boolean }[];
    /** Puts a row into `cloning` without a queue, to stand in for a process that then died. */
    strand(userId: string, repo: { owner: string; name: string }): void;
}

/**
 * An in-memory UserRepoStore: it keeps the offline suite a no-database suite while still
 * exercising the selection rules, the claim and the restart recovery. The SQL behind it is covered
 * by server/test-db, which needs a container.
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
            return (
                rows
                    .filter((r) => r.userId === userId)
                    .map((r) => ({
                        name: r.name,
                        type: r.type,
                        createdAt: r.createdAt,
                        updatedAt: r.updatedAt,
                    }))
                    // The SQL orders the same way; created_at ties break on name.
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
            );
        },

        async listWithConfigs(userId) {
            return rows
                .filter((r) => r.userId === userId)
                .map((r) => ({
                    name: r.name,
                    type: r.type,
                    createdAt: r.createdAt,
                    updatedAt: r.updatedAt,
                    config: structuredClone(r.config),
                }))
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
                pick(owner && name ? rows.filter((r) => r.owner === owner && r.repoName === name) : [])
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
        return (
            a.owner!.localeCompare(b.owner!) || a.repoName!.localeCompare(b.repoName!) || a.name.localeCompare(b.name)
        );
    }

    /** The keep-a-null-secret replace, mirroring the store's transaction semantics. */
    function replaceRows(
        scope: 'org' | { userId: string } | { owner: string; name: string },
        vars: readonly { name: string; value: string | null; isSecret: boolean }[]
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
    function scopeColumns(scope: 'org' | { userId: string } | { owner: string; name: string }): {
        userId: string | null;
        owner: string | null;
        repoName: string | null;
    } {
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
     * Attaches an EXISTING account to an org — the shape of a membership row written before the
     * current sign-in path existed (pre-#99), which signIn's sweep has to remove. Unlike
     * seedMember, no account is created: the point is a membership of the signing-in user.
     */
    seedMembership(orgId: string, userId: string): void;
    /**
     * The stand-in account AUTH_MODE=none resolves, exactly as migrate()'s ensureLocalUser writes
     * it: github_user_id 0, a value GitHub never issues, and the reserved `__local__` login, which
     * is unrepresentable as a real GitHub login because underscores are not permitted in one.
     */
    seedLocalUser(orgId: string): Caller;
    /**
     * Plants an organization row, so a test can name an org that exists without anybody being a
     * member of it — the 403 case — or an installation org without running a sign-in.
     */
    seedOrg(id: string, name?: string, installationId?: string): void;
    /**
     * Removes one membership directly, standing in for the sign-in-time propagation a real
     * deployment gets from GitHub no longer reporting an installation. A test utility, not a
     * store method: production deletes memberships through the webhook's removeMember and
     * signIn's sweep, never this.
     */
    removeMembership(orgId: string, userId: string): void;
    /** Every live session's user id, so a test can assert one was created — or was not. */
    sessions(): string[];
    seedWorkerToken(orgId: string, name: string, token: string): void;
    /**
     * Plants an access token and returns its plaintext, so a test can present the Bearer header
     * without driving the settings route to mint one.
     */
    seedAccessToken(
        orgId: string,
        kind: AccessTokenKind,
        options?: { userId?: string; createdBy?: string; label?: string }
    ): string;
    /** Every access token row with its hash, so a test can assert what is stored at rest. */
    accessTokens(): {
        orgId: string;
        id: string;
        kind: AccessTokenKind;
        userId: string | null;
        label: string;
        hashHex: string;
        revoked: boolean;
    }[];
}

/**
 * An in-memory AuthStore: it keeps the offline suite a no-database suite while still exercising
 * the claim rule, the membership join and the session lifecycle. The SQL behind it is covered by
 * server/test-db, which needs a container.
 */
export function memoryAuthStore(): MemoryAuthStore {
    interface User {
        id: string;
        githubUserId: number;
        login: string;
        displayName: string | null;
        avatarUrl: string | null;
        createdAt: string;
        lastLoginAt: string | null;
    }
    interface Org {
        id: string;
        name: string;
        installationId: string | null;
    }
    interface Member {
        orgId: string;
        login: string;
        userId: string;
        role: Role;
        invitedAt: string;
        claimedAt: string;
    }

    const users: User[] = [];
    const orgs = new Map<string, Org>();
    const members: Member[] = [];
    const sessions = new Map<string, { userId: string; orgId: string; expiresAt: number }>();
    const workerTokens: { orgId: string; id: string; name: string; hash: string; revoked: boolean }[] = [];
    interface AccessTokenRow {
        orgId: string;
        id: string;
        kind: AccessTokenKind;
        userId: string | null;
        createdBy: string | null;
        label: string;
        hash: string;
        createdAt: string;
        lastUsedAt: string | null;
        revokedAt: string | null;
    }
    const accessTokenRows: AccessTokenRow[] = [];
    let nextId = 1;

    /** A fixed stamp, the same trick listWorkerTokens uses: timestamps are not what most tests vary. */
    const STAMP = '2026-08-21T12:00:00.000Z';

    /**
     * A uuid, like app_user.id. Not cosmetic: that id becomes a workspace path segment and a docker
     * WORKDIR, and both `workspaceDir()` and the driver refuse one that is not a uuid. A store that
     * minted `user-1` would let those assertions pass here and fail against a real database.
     */
    const userId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    // A uuid for access-token rows too — a different leading segment, so it can never be mistaken
    // for a user id. The revoke route validates the shape, and a store that minted `access-1`
    // would pass here and fail against a real database.
    const tokenId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    const key = (hash: Buffer) => hash.toString('hex');
    const orgNameOf = (orgId: string): string => orgs.get(orgId)?.name ?? orgId;
    const callerFor = (user: User, member: Member): Caller => ({
        user: {
            id: user.id,
            githubUserId: user.githubUserId,
            login: user.login,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            createdAt: user.createdAt,
            lastLoginAt: user.lastLoginAt,
        },
        org: { id: member.orgId, name: orgNameOf(member.orgId) },
        membership: { invitedAt: member.invitedAt, claimedAt: member.claimedAt },
        role: member.role,
    });
    const memberOf = (userId: string, orgId: string): Caller | null => {
        const member = members.find((m) => m.orgId === orgId && m.userId === userId);
        const user = users.find((u) => u.id === userId);
        return member && user ? callerFor(user, member) : null;
    };
    const ensureOrg = (id: string, name?: string, installationId?: string | null): Org => {
        const existing = orgs.get(id);
        if (existing) return existing;
        const org: Org = { id, name: name ?? id, installationId: installationId ?? null };
        orgs.set(id, org);
        return org;
    };
    const viewToken = (row: AccessTokenRow): AccessTokenView => ({
        id: row.id,
        label: row.label,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
    });
    const findLiveToken = (tokenHash: Buffer, kind: AccessTokenKind): AccessTokenRow | undefined =>
        accessTokenRows.find((t) => t.hash === key(tokenHash) && t.kind === kind && t.revokedAt === null);
    // The SQL store throttles the stamp to one rewrite a minute — an access token rides the
    // dashboard's two-second poll — and the memory store mirrors that contract, not the write rate.
    const touch = (row: AccessTokenRow) => {
        if (row.lastUsedAt === null || Date.now() - Date.parse(row.lastUsedAt) >= 60_000) {
            row.lastUsedAt = now();
        }
    };
    const now = () => new Date().toISOString();

    const store: MemoryAuthStore = {
        seedMember(orgId, login, role = 'member') {
            ensureOrg(orgId);
            const user: User = {
                id: userId(nextId),
                githubUserId: nextId,
                login: login.toLowerCase(),
                displayName: login,
                avatarUrl: null,
                createdAt: STAMP,
                lastLoginAt: STAMP,
            };
            nextId += 1;
            users.push(user);
            const member: Member = {
                orgId,
                login: user.login,
                userId: user.id,
                role,
                invitedAt: STAMP,
                claimedAt: STAMP,
            };
            members.push(member);
            return callerFor(user, member);
        },

        seedMembership(orgId, userId) {
            ensureOrg(orgId);
            const user = users.find((u) => u.id === userId);
            if (!user) throw new Error(`seedMembership: no account ${userId} to attach to "${orgId}"`);
            members.push({
                orgId,
                login: user.login,
                userId,
                role: 'member',
                invitedAt: STAMP,
                claimedAt: STAMP,
            });
        },

        seedLocalUser(orgId) {
            ensureOrg(orgId);
            const user: User = {
                id: userId(0),
                githubUserId: 0,
                login: '__local__',
                displayName: 'Local',
                avatarUrl: null,
                createdAt: STAMP,
                lastLoginAt: STAMP,
            };
            users.push(user);
            const member: Member = {
                orgId,
                login: user.login,
                userId: user.id,
                role: 'admin',
                invitedAt: STAMP,
                claimedAt: STAMP,
            };
            members.push(member);
            return callerFor(user, member);
        },

        seedOrg(id, name, installationId) {
            ensureOrg(id, name, installationId);
        },

        removeMembership(orgId, userId) {
            const index = members.findIndex((m) => m.orgId === orgId && m.userId === userId);
            if (index !== -1) members.splice(index, 1);
        },

        async removeMember(orgId, githubUserId) {
            // The webhook deletes by the numeric id — THE identity — so the lookup goes through
            // the account, exactly as the SQL joins app_user on github_user_id.
            const user = users.find((u) => u.githubUserId === githubUserId);
            if (!user) return false;
            const index = members.findIndex((m) => m.orgId === orgId && m.userId === user.id);
            if (index === -1) return false;
            members.splice(index, 1);
            return true;
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

        seedAccessToken(orgId, kind, options = {}) {
            const token = `${kind === 'personal' ? 'fat_' : 'oat_'}seed-${accessTokenRows.length + 1}`;
            accessTokenRows.push({
                orgId,
                id: tokenId(accessTokenRows.length + 1),
                kind,
                userId: options.userId ?? null,
                createdBy: options.createdBy ?? null,
                label: options.label ?? `${kind} token`,
                hash: key(hashToken(token)),
                createdAt: STAMP,
                lastUsedAt: null,
                revokedAt: null,
            });
            return token;
        },

        accessTokens: () =>
            accessTokenRows.map((t) => ({
                orgId: t.orgId,
                id: t.id,
                kind: t.kind,
                userId: t.userId,
                label: t.label,
                hashHex: t.hash,
                revoked: t.revokedAt !== null,
            })),

        async signIn(identity, orgId, installations) {
            const login = identity.login.toLowerCase();
            const now = new Date().toISOString();
            let user = users.find((u) => u.githubUserId === identity.githubUserId);
            if (user) {
                // A rename updates the label. It never creates a second account, and it never
                // detaches the membership already bound to this numeric id. Avatar and last sign-in
                // mirror the SQL upsert's `excluded.avatar_url` / `last_login_at = now()`.
                user.login = login;
                user.displayName = identity.displayName;
                user.avatarUrl = identity.avatarUrl;
                user.lastLoginAt = now;
            } else {
                user = {
                    id: userId(nextId),
                    githubUserId: identity.githubUserId,
                    login,
                    displayName: identity.displayName,
                    avatarUrl: identity.avatarUrl,
                    createdAt: now,
                    lastLoginAt: now,
                };
                nextId += 1;
                users.push(user);
            }

            // One installation = one organization: every reported installation gets an org row and
            // a membership for this account (label re-derived, first claim stamped).
            for (const install of installations) {
                // The SQL store upserts `name = excluded.name, installation_id = excluded...` on
                // every sign-in — a renamed installation relabels the org here the same way.
                ensureOrg(install.id, install.name, install.id);
                const org = orgs.get(install.id)!;
                org.name = install.name;
                org.installationId = install.id;
                const existing = members.find((m) => m.orgId === install.id && m.userId === user!.id);
                if (existing) {
                    existing.login = login;
                } else {
                    members.push({
                        orgId: install.id,
                        login,
                        userId: user.id,
                        role: 'member',
                        invitedAt: now,
                        claimedAt: now,
                    });
                }
            }

            // The propagation half: memberships of ANY org GitHub does not report are gone, and
            // with them this account's reach into those orgs — legacy (pre-#99) orgs included,
            // since no installation will ever report them.
            const reported = new Set(installations.map((i) => i.id));
            for (let i = members.length - 1; i >= 0; i -= 1) {
                const member = members[i]!;
                if (member.userId !== user.id) continue;
                if (!reported.has(member.orgId)) members.splice(i, 1);
            }

            const caller = memberOf(user.id, orgId);
            if (!caller) throw new Error(`sign-in resolved no membership of "${orgId}" for this account`);
            return caller;
        },

        async createSession(tokenHash, userId, expiresAt, orgId) {
            sessions.set(key(tokenHash), { userId, orgId, expiresAt: expiresAt.getTime() });
        },

        async findSession(tokenHash) {
            const session = sessions.get(key(tokenHash));
            if (!session || session.expiresAt <= Date.now()) return null;
            return memberOf(session.userId, session.orgId);
        },

        async updateSessionOrg(tokenHash, orgId) {
            const session = sessions.get(key(tokenHash));
            if (!session) return false;
            if (!members.some((m) => m.orgId === orgId && m.userId === session.userId)) return false;
            session.orgId = orgId;
            return true;
        },

        async deleteSession(tokenHash) {
            sessions.delete(key(tokenHash));
        },

        async findOrg(orgId) {
            const org = orgs.get(orgId);
            return org ? { id: org.id, name: org.name } : null;
        },

        async membershipsOf(userId) {
            return members
                .filter((m) => m.userId === userId)
                .map((m) => ({ id: m.orgId, name: orgNameOf(m.orgId) }))
                .sort((a, b) => a.name.localeCompare(b.name));
        },

        async legacyOrgs() {
            return [...orgs.values()]
                .filter((org) => org.installationId === null)
                .map((org) => ({ id: org.id, name: org.name }))
                .sort((a, b) => a.id.localeCompare(b.id));
        },

        async adoptTarget() {
            const installed = [...orgs.values()].filter((org) => org.installationId !== null);
            return installed.length === 1 ? { id: installed[0]!.id } : null;
        },

        async localCaller(orgId) {
            const user = users.find((u) => u.githubUserId === 0);
            return user ? memberOf(user.id, orgId) : null;
        },

        async findWorkerToken(tokenHash) {
            const found = workerTokens.find((t) => t.hash === key(tokenHash) && !t.revoked);
            return found ? { orgId: found.orgId, id: found.id, name: found.name } : null;
        },

        async createAccessToken(input) {
            const row: AccessTokenRow = {
                orgId: input.orgId,
                id: tokenId(accessTokenRows.length + 1),
                kind: input.kind,
                userId: input.userId,
                createdBy: input.createdBy,
                label: input.label,
                hash: key(input.tokenHash),
                createdAt: now(),
                lastUsedAt: null,
                revokedAt: null,
            };
            accessTokenRows.push(row);
            return { id: row.id };
        },

        async findPersonalToken(tokenHash) {
            const row = findLiveToken(tokenHash, 'personal');
            if (!row || row.userId === null) return null;
            touch(row);
            return memberOf(row.userId, row.orgId);
        },

        async findOrgToken(tokenHash): Promise<OrgTokenIdentity | null> {
            const row = findLiveToken(tokenHash, 'org');
            if (!row) return null;
            touch(row);
            return { orgId: row.orgId, id: row.id, label: row.label };
        },

        async listPersonalTokens(orgId, userId) {
            return accessTokenRows
                .filter((t) => t.orgId === orgId && t.kind === 'personal' && t.userId === userId)
                .map(viewToken);
        },

        async listOrgTokens(orgId) {
            return accessTokenRows.filter((t) => t.orgId === orgId && t.kind === 'org').map(viewToken);
        },

        async revokePersonalToken(orgId, userId, id) {
            const row = accessTokenRows.find(
                (t) =>
                    t.orgId === orgId &&
                    t.userId === userId &&
                    t.id === id &&
                    t.kind === 'personal' &&
                    t.revokedAt === null
            );
            if (!row) return 'missing';
            row.revokedAt = now();
            return 'revoked';
        },

        async revokeOrgToken(orgId, id) {
            const row = accessTokenRows.find(
                (t) => t.orgId === orgId && t.id === id && t.kind === 'org' && t.revokedAt === null
            );
            if (!row) return 'missing';
            row.revokedAt = now();
            return 'revoked';
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

/** Mints a live session for `caller` — in the caller's own org — and returns the Cookie header. */
export async function signedIn(store: AuthStore, caller: Caller, secret = TEST_SESSION_SECRET): Promise<string> {
    const token = mintToken();
    await store.createSession(hashToken(token), caller.user.id, new Date(Date.now() + 3600_000), caller.org.id);
    return `${SESSION_COOKIE}=${sign(token, secret)}`;
}

export interface IdentityStub extends GitHubIdentityClient {
    /** What the next exchange resolves to. Set per test. */
    next: GitHubIdentity;
    exchanges: string[];
    /** The standing `installations()` answer, until a queued one-shot overrides it. */
    installationsAnswer: InstallationAccount[];
    /** One-shot answers, consumed first — for flows whose answer CHANGES between sign-ins. */
    installationsQueue: InstallationAccount[][];
    /** When set, the next `installations()` throws instead — GitHub could not be asked. */
    installationsError?: Error;
    /** Every installations call, so a test can assert it happened (or did not). */
    installationsCalls: string[];
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
        installationsAnswer: [],
        installationsQueue: [],
        installationsCalls: [],
        authorizeUrl: (state) => `https://github.test/login/oauth/authorize?state=${state}`,
        async exchange(code) {
            stub.exchanges.push(code);
            return `access-for-${code}`;
        },
        async identity() {
            return stub.next;
        },
        async installations() {
            stub.installationsCalls.push('installations');
            if (stub.installationsError) throw stub.installationsError;
            return stub.installationsQueue.shift() ?? stub.installationsAnswer;
        },
    };
    return stub;
}

/** Shorthand: one installation, the common case. */
export const oneInstallation = (id: string, account = 'acme'): InstallationAccount[] => [{ id, account }];

/** Installation refs as the store's signIn takes them. */
export const refsOf = (installations: readonly InstallationAccount[]): InstallationRef[] =>
    installations.map((i) => ({ id: i.id, name: i.account ?? i.id }));

export interface TelemetryStubOptions {
    rollups?: () => Promise<TelemetryInput>;
    /** The run rows one fetch returns beside the rollups; empty unless a test feeds some. */
    runs?: () => JobRun[];
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
            // The stub mirrors the real shape: ONE fetch returns both lists, and every range
            // and scope is served from re-aggregating them.
            return {
                input: options.rollups ? await options.rollups() : structuredClone(sampleTelemetry()),
                runs: options.runs ? options.runs() : [],
            };
        },
        async health() {
            stub.healthCalls += 1;
            if (options.health) return options.health();
            return { status: 'ok', reason: null };
        },
    };
    return stub;
}

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
        envVars?: OrgRuntime['envVars'];
        userRepos?: OrgRuntime['userRepos'];
        userExecutors?: OrgRuntime['userExecutors'];
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
        envVars: parts.envVars,
        userRepos: parts.userRepos,
        userExecutors: parts.userExecutors,
        cloneQueue: parts.cloneQueue,
    };
    return {
        for: async (orgId) => (parts.orgsFor && !parts.orgsFor.includes(orgId) ? null : runtime),
        list: async () => [{ id: LOCAL_ORG_ID, name: LOCAL_ORG_ID, installationId: null }],
        warmAll: async () => {},
    };
}

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
        now: () => clock,
    });
    return {
        app,
        service,
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
