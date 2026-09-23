import { hashToken, mintToken } from '../src/auth/session.js';
import type { OrgTokenIdentity, PendingSignIn } from '../src/auth/store.js';
import {
    createAuthState,
    ensureOrg,
    findLiveToken,
    keyOf,
    memberOf,
    membershipMethods,
    type AccessTokenRow,
    type AuthState,
    type MemoryAuthStore,
    nowIso,
    sessionMethods,
    STAMP,
    tokenIdOf,
    touch,
    userIdOf,
    viewToken,
} from './helpers-auth-store.js';

/**
 * The rest of memoryAuthStore's methods — access tokens, pending sign-ins, tracked repos and
 * sign-in itself — split out of helpers-auth-store.ts purely because the combined file exceeded
 * the line-count ceiling. See that file for the shared state and the membership/session methods.
 */

function accessTokenMethods(
    state: AuthState
): Pick<
    MemoryAuthStore,
    | 'seedAccessToken'
    | 'accessTokens'
    | 'createAccessToken'
    | 'findPersonalToken'
    | 'findOrgToken'
    | 'listPersonalTokens'
    | 'listOrgTokens'
    | 'revokePersonalToken'
    | 'revokeOrgToken'
> {
    return {
        seedAccessToken(orgId, kind, options = {}) {
            const token = `${kind === 'personal' ? 'fat_' : 'oat_'}seed-${state.accessTokenRows.length + 1}`;
            state.accessTokenRows.push({
                orgId,
                id: tokenIdOf(state.accessTokenRows.length + 1),
                kind,
                userId: options.userId ?? null,
                createdBy: options.createdBy ?? null,
                label: options.label ?? `${kind} token`,
                hash: keyOf(hashToken(token)),
                createdAt: STAMP,
                lastUsedAt: null,
                revokedAt: null,
            });
            return token;
        },

        accessTokens: () =>
            state.accessTokenRows.map((t) => ({
                orgId: t.orgId,
                id: t.id,
                kind: t.kind,
                userId: t.userId,
                label: t.label,
                hashHex: t.hash,
                revoked: t.revokedAt !== null,
            })),

        async createAccessToken(input) {
            const row: AccessTokenRow = {
                orgId: input.orgId,
                id: tokenIdOf(state.accessTokenRows.length + 1),
                kind: input.kind,
                userId: input.userId,
                createdBy: input.createdBy,
                label: input.label,
                hash: keyOf(input.tokenHash),
                createdAt: nowIso(),
                lastUsedAt: null,
                revokedAt: null,
            };
            state.accessTokenRows.push(row);
            return { id: row.id };
        },

        async findPersonalToken(tokenHash) {
            const row = findLiveToken(state, tokenHash, 'personal');
            if (!row || row.userId === null) return null;
            touch(row);
            return memberOf(state, row.userId, row.orgId);
        },

        async findOrgToken(tokenHash): Promise<OrgTokenIdentity | null> {
            const row = findLiveToken(state, tokenHash, 'org');
            if (!row) return null;
            touch(row);
            return { orgId: row.orgId, id: row.id, label: row.label };
        },

        async listPersonalTokens(orgId, userId) {
            return state.accessTokenRows
                .filter((t) => t.orgId === orgId && t.kind === 'personal' && t.userId === userId)
                .map(viewToken);
        },

        async listOrgTokens(orgId) {
            return state.accessTokenRows.filter((t) => t.orgId === orgId && t.kind === 'org').map(viewToken);
        },

        async revokePersonalToken(orgId, userId, id) {
            const row = state.accessTokenRows.find(
                (t) =>
                    t.orgId === orgId &&
                    t.userId === userId &&
                    t.id === id &&
                    t.kind === 'personal' &&
                    t.revokedAt === null
            );
            if (!row) return 'missing';
            row.revokedAt = nowIso();
            return 'revoked';
        },

        async revokeOrgToken(orgId, id) {
            const row = state.accessTokenRows.find(
                (t) => t.orgId === orgId && t.id === id && t.kind === 'org' && t.revokedAt === null
            );
            if (!row) return 'missing';
            row.revokedAt = nowIso();
            return 'revoked';
        },
    };
}

function pendingSignInMethods(
    state: AuthState
): Pick<
    MemoryAuthStore,
    | 'pendingSignIns'
    | 'expirePendingSignIns'
    | 'storedSelection'
    | 'createPendingSignIn'
    | 'findPendingSignIn'
    | 'deletePendingSignIn'
> {
    return {
        pendingSignIns: () =>
            state.pendingRows.map((r) => ({
                githubUserId: r.identity.githubUserId,
                installations: r.installations.map((i) => i.id),
                expiresAt: r.expiresAt,
            })),

        expirePendingSignIns: () => {
            for (const row of state.pendingRows) row.expiresAt = Date.now() - 1;
        },

        async storedSelection(githubUserId) {
            const user = state.users.find((u) => u.githubUserId === githubUserId);
            if (!user) return [];
            return state.members.filter((m) => m.userId === user.id).map((m) => m.orgId);
        },

        async createPendingSignIn(input) {
            // An opaque token like the session's; only its hash is kept, because a pending row
            // completes into a session — it is a bearer credential at rest.
            const token = mintToken();
            state.pendingRows.push({
                tokenHash: keyOf(hashToken(token)),
                identity: { ...input.identity },
                installations: input.installations.map((i) => ({ ...i })),
                returnTo: input.returnTo,
                orgPreference: input.orgPreference,
                expiresAt: input.expiresAt.getTime(),
            });
            return token;
        },

        async findPendingSignIn(tokenHash) {
            const row = state.pendingRows.find((r) => r.tokenHash === keyOf(tokenHash));
            if (!row) return null;
            // Expired rows are lazily spent here, mirroring the SQL store's delete-and-ignore.
            if (row.expiresAt <= Date.now()) {
                state.pendingRows.splice(state.pendingRows.indexOf(row), 1);
                return null;
            }
            const found: PendingSignIn = {
                identity: { ...row.identity },
                installations: row.installations.map((i) => ({ ...i })),
                returnTo: row.returnTo,
                orgPreference: row.orgPreference,
            };
            return found;
        },

        async deletePendingSignIn(tokenHash) {
            const index = state.pendingRows.findIndex((r) => r.tokenHash === keyOf(tokenHash));
            // The SQL claim carries `expires_at > now()` — an expired row answers unclaimed, not
            // spent-on-sight, here too.
            if (index === -1 || state.pendingRows[index]!.expiresAt <= Date.now()) return false;
            state.pendingRows.splice(index, 1);
            return true;
        },
    };
}

function trackedRepoMethods(
    state: AuthState
): Pick<MemoryAuthStore, 'trackedRepos' | 'replaceTrackedRepos' | 'failNextTrackedRepoWrite'> {
    return {
        async trackedRepos(orgId) {
            return state.trackedRepoRows.get(orgId) ?? [];
        },

        async replaceTrackedRepos(orgId, repos) {
            if (state.trackedRepoWritesUntilFailure !== null) {
                if (state.trackedRepoWritesUntilFailure === 0) {
                    state.trackedRepoWritesUntilFailure = null;
                    throw new Error('tracked_repo write failed');
                }
                state.trackedRepoWritesUntilFailure -= 1;
            }
            state.trackedRepoRows.set(orgId, [...repos]);
        },

        failNextTrackedRepoWrite: (afterWrites = 0) => {
            state.trackedRepoWritesUntilFailure = afterWrites;
        },
    };
}

function signInMethod(state: AuthState): Pick<MemoryAuthStore, 'signIn'> {
    return {
        async signIn(identity, orgId, installations) {
            const login = identity.login.toLowerCase();
            const stamp = new Date().toISOString();
            let user = state.users.find((u) => u.githubUserId === identity.githubUserId);
            if (user) {
                // A rename updates the label. It never creates a second account, and it never
                // detaches the membership already bound to this numeric id. Avatar and last sign-in
                // mirror the SQL upsert's `excluded.avatar_url` / `last_login_at = now()`.
                user.login = login;
                user.displayName = identity.displayName;
                user.avatarUrl = identity.avatarUrl;
                user.lastLoginAt = stamp;
            } else {
                user = {
                    id: userIdOf(state.nextId),
                    githubUserId: identity.githubUserId,
                    login,
                    displayName: identity.displayName,
                    avatarUrl: identity.avatarUrl,
                    createdAt: stamp,
                    lastLoginAt: stamp,
                };
                state.nextId += 1;
                state.users.push(user);
            }

            // One installation = one organization: every reported installation gets an org row and
            // a membership for this account (label re-derived, first claim stamped).
            for (const install of installations) {
                // The SQL store upserts `name = excluded.name, installation_id = excluded...` on
                // every sign-in — a renamed installation relabels the org here the same way.
                ensureOrg(state, install.id, install.name, install.id);
                const org = state.orgs.get(install.id)!;
                org.name = install.name;
                org.installationId = install.id;
                const existing = state.members.find((m) => m.orgId === install.id && m.userId === user!.id);
                if (existing) {
                    existing.login = login;
                } else {
                    state.members.push({
                        orgId: install.id,
                        login,
                        userId: user.id,
                        role: 'member',
                        invitedAt: stamp,
                        claimedAt: stamp,
                    });
                }
            }

            // The propagation half: memberships of ANY org GitHub does not report are gone, and
            // with them this account's reach into those orgs — legacy (pre-#99) orgs included,
            // since no installation will ever report them.
            const reported = new Set(installations.map((i) => i.id));
            for (let i = state.members.length - 1; i >= 0; i -= 1) {
                const member = state.members[i]!;
                if (member.userId !== user.id) continue;
                if (!reported.has(member.orgId)) state.members.splice(i, 1);
            }

            const caller = memberOf(state, user.id, orgId);
            if (!caller) throw new Error(`sign-in resolved no membership of "${orgId}" for this account`);
            return caller;
        },
    };
}

export function memoryAuthStore(): MemoryAuthStore {
    const state = createAuthState();
    return {
        ...membershipMethods(state),
        ...sessionMethods(state),
        ...accessTokenMethods(state),
        ...pendingSignInMethods(state),
        ...trackedRepoMethods(state),
        ...signInMethod(state),
    };
}
