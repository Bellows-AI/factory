import type { GitHubIdentity } from '../src/auth/github.js';
import type { AccessTokenKind, AccessTokenView, AuthStore, Caller, InstallationRef, Role } from '../src/auth/store.js';

/**
 * An in-memory AuthStore: it keeps the offline suite a no-database suite while still exercising
 * the claim rule, the membership join and the session lifecycle. The SQL behind it is covered by
 * server/test-db, which needs a container.
 *
 * The store's methods are built by a handful of small factories over one shared, mutable `state` —
 * split by domain (membership, sessions, access tokens, pending sign-ins, tracked repos, sign-in
 * itself) so no single function carries the whole store.
 */
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
    /** Every pending sign-in row, in creation order — who it is for and what was reported. */
    pendingSignIns(): { githubUserId: number; installations: string[]; expiresAt: number }[];
    /** Ages every pending row past its expiry, standing in for the TTL a real wait would run. */
    expirePendingSignIns(): void;
    /**
     * Arms replaceTrackedRepos to throw on a chosen write: the next `afterWrites` calls succeed,
     * then one throws — standing in for a database failure mid-completion, so a test can hold the
     * route at the exact write whose failure would otherwise leave a half-materialized sign-in
     * behind, with earlier writes already landed.
     */
    failNextTrackedRepoWrite(afterWrites?: number): void;
}

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

export interface AccessTokenRow {
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

export interface PendingRow {
    tokenHash: string;
    identity: GitHubIdentity;
    installations: InstallationRef[];
    returnTo: string;
    orgPreference: string | null;
    expiresAt: number;
}

export interface AuthState {
    users: User[];
    orgs: Map<string, Org>;
    members: Member[];
    sessions: Map<string, { userId: string; orgId: string; expiresAt: number }>;
    accessTokenRows: AccessTokenRow[];
    pendingRows: PendingRow[];
    trackedRepoRows: Map<string, string[]>;
    trackedRepoWritesUntilFailure: number | null;
    nextId: number;
}

/** A fixed stamp: timestamps are not what most tests vary. */
export const STAMP = '2026-08-21T12:00:00.000Z';
const TOUCH_THROTTLE_MS = 60_000;

export function createAuthState(): AuthState {
    return {
        users: [],
        orgs: new Map(),
        members: [],
        sessions: new Map(),
        accessTokenRows: [],
        pendingRows: [],
        trackedRepoRows: new Map(),
        trackedRepoWritesUntilFailure: null,
        nextId: 1,
    };
}

const UUID_SEGMENT_WIDTH = 12;

/**
 * A uuid, like app_user.id. Not cosmetic: that id becomes a workspace path segment and a docker
 * WORKDIR, and both `workspaceDir()` and the driver refuse one that is not a uuid. A store that
 * minted `user-1` would let those assertions pass here and fail against a real database.
 */
export const userIdOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(UUID_SEGMENT_WIDTH, '0')}`;
// A uuid for access-token rows too — a different leading segment, so it can never be mistaken
// for a user id. The revoke route validates the shape, and a store that minted `access-1`
// would pass here and fail against a real database.
export const tokenIdOf = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(UUID_SEGMENT_WIDTH, '0')}`;

export const keyOf = (hash: Buffer) => hash.toString('hex');
export const nowIso = () => new Date().toISOString();

function orgNameOf(state: AuthState, orgId: string): string {
    return state.orgs.get(orgId)?.name ?? orgId;
}

function callerFor(state: AuthState, user: User, member: Member): Caller {
    return {
        user: {
            id: user.id,
            githubUserId: user.githubUserId,
            login: user.login,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            createdAt: user.createdAt,
            lastLoginAt: user.lastLoginAt,
        },
        org: { id: member.orgId, name: orgNameOf(state, member.orgId) },
        membership: { invitedAt: member.invitedAt, claimedAt: member.claimedAt },
        role: member.role,
    };
}

export function memberOf(state: AuthState, userId: string, orgId: string): Caller | null {
    const member = state.members.find((m) => m.orgId === orgId && m.userId === userId);
    const user = state.users.find((u) => u.id === userId);
    return member && user ? callerFor(state, user, member) : null;
}

export function ensureOrg(state: AuthState, id: string, name?: string, installationId?: string | null): Org {
    const existing = state.orgs.get(id);
    if (existing) return existing;
    const org: Org = { id, name: name ?? id, installationId: installationId ?? null };
    state.orgs.set(id, org);
    return org;
}

export function viewToken(row: AccessTokenRow): AccessTokenView {
    return {
        id: row.id,
        label: row.label,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
    };
}

export function findLiveToken(state: AuthState, tokenHash: Buffer, kind: AccessTokenKind): AccessTokenRow | undefined {
    return state.accessTokenRows.find((t) => t.hash === keyOf(tokenHash) && t.kind === kind && t.revokedAt === null);
}

// The SQL store throttles the stamp to one rewrite a minute — an access token rides the
// dashboard's two-second poll — and the memory store mirrors that contract, not the write rate.
export function touch(row: AccessTokenRow): void {
    if (row.lastUsedAt === null || Date.now() - Date.parse(row.lastUsedAt) >= TOUCH_THROTTLE_MS) {
        row.lastUsedAt = nowIso();
    }
}

export function membershipMethods(
    state: AuthState
): Pick<
    MemoryAuthStore,
    | 'seedMember'
    | 'seedMembership'
    | 'seedLocalUser'
    | 'seedOrg'
    | 'removeMembership'
    | 'removeMember'
    | 'findOrg'
    | 'membershipsOf'
    | 'localCaller'
> {
    return {
        seedMember(orgId, login, role = 'member') {
            ensureOrg(state, orgId);
            const user: User = {
                id: userIdOf(state.nextId),
                githubUserId: state.nextId,
                login: login.toLowerCase(),
                displayName: login,
                avatarUrl: null,
                createdAt: STAMP,
                lastLoginAt: STAMP,
            };
            state.nextId += 1;
            state.users.push(user);
            const member: Member = {
                orgId,
                login: user.login,
                userId: user.id,
                role,
                invitedAt: STAMP,
                claimedAt: STAMP,
            };
            state.members.push(member);
            return callerFor(state, user, member);
        },

        seedMembership(orgId, userId) {
            ensureOrg(state, orgId);
            const user = state.users.find((u) => u.id === userId);
            if (!user) throw new Error(`seedMembership: no account ${userId} to attach to "${orgId}"`);
            state.members.push({
                orgId,
                login: user.login,
                userId,
                role: 'member',
                invitedAt: STAMP,
                claimedAt: STAMP,
            });
        },

        seedLocalUser(orgId) {
            ensureOrg(state, orgId);
            const user: User = {
                id: userIdOf(0),
                githubUserId: 0,
                login: '__local__',
                displayName: 'Local',
                avatarUrl: null,
                createdAt: STAMP,
                lastLoginAt: STAMP,
            };
            state.users.push(user);
            const member: Member = {
                orgId,
                login: user.login,
                userId: user.id,
                role: 'admin',
                invitedAt: STAMP,
                claimedAt: STAMP,
            };
            state.members.push(member);
            return callerFor(state, user, member);
        },

        seedOrg(id, name, installationId) {
            ensureOrg(state, id, name, installationId);
        },

        removeMembership(orgId, userId) {
            const index = state.members.findIndex((m) => m.orgId === orgId && m.userId === userId);
            if (index !== -1) state.members.splice(index, 1);
        },

        async removeMember(orgId, githubUserId) {
            // The webhook deletes by the numeric id — THE identity — so the lookup goes through
            // the account, exactly as the SQL joins app_user on github_user_id.
            const user = state.users.find((u) => u.githubUserId === githubUserId);
            if (!user) return false;
            const index = state.members.findIndex((m) => m.orgId === orgId && m.userId === user.id);
            if (index === -1) return false;
            state.members.splice(index, 1);
            return true;
        },

        async findOrg(orgId) {
            const org = state.orgs.get(orgId);
            return org ? { id: org.id, name: org.name } : null;
        },

        async membershipsOf(userId) {
            return state.members
                .filter((m) => m.userId === userId)
                .map((m) => ({ id: m.orgId, name: orgNameOf(state, m.orgId) }))
                .sort((a, b) => a.name.localeCompare(b.name));
        },

        async localCaller(orgId) {
            const user = state.users.find((u) => u.githubUserId === 0);
            return user ? memberOf(state, user.id, orgId) : null;
        },
    };
}

export function sessionMethods(
    state: AuthState
): Pick<MemoryAuthStore, 'sessions' | 'createSession' | 'findSession' | 'updateSessionOrg' | 'deleteSession'> {
    return {
        sessions: () => [...state.sessions.values()].map((s) => s.userId),

        async createSession(tokenHash, userId, expiresAt, orgId) {
            state.sessions.set(keyOf(tokenHash), { userId, orgId, expiresAt: expiresAt.getTime() });
        },

        async findSession(tokenHash) {
            const session = state.sessions.get(keyOf(tokenHash));
            if (!session || session.expiresAt <= Date.now()) return null;
            return memberOf(state, session.userId, session.orgId);
        },

        async updateSessionOrg(tokenHash, orgId) {
            const session = state.sessions.get(keyOf(tokenHash));
            if (!session) return false;
            if (!state.members.some((m) => m.orgId === orgId && m.userId === session.userId)) return false;
            session.orgId = orgId;
            return true;
        },

        async deleteSession(tokenHash) {
            state.sessions.delete(keyOf(tokenHash));
        },
    };
}

// The rest of the store — access tokens, pending sign-ins, tracked repos, sign-in itself, and the
// `memoryAuthStore` factory that composes every method group — lives in
// helpers-auth-store-credentials.ts, split out purely because the combined file exceeded the
// line-count ceiling.
