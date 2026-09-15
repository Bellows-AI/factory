import type { FastifyPluginAsync } from 'fastify';
import { createUserResolver } from '../auth/plugin.js';
import type { GitHubIdentityClient } from '../auth/github.js';
import type { RepoAccessScope } from '../github/access-scope.js';
import { ensureUserWorkspace } from '../workspace/provision.js';
import { workspaceDir } from '../workspace/reconcile.js';
import {
    OAUTH_COOKIE,
    SESSION_COOKIE,
    decodeState,
    encodeState,
    hashToken,
    mintToken,
    oauthCookieOptions,
    safeReturnPath,
    sessionCookieOptions,
    sign,
    statesMatch,
    unsign,
} from '../auth/session.js';
import type { AuthStore } from '../auth/store.js';
import type { AppConfig } from '../config.js';

export interface AuthRouteDeps {
    config: AppConfig;
    store: AuthStore;
    /** Absent under AUTH_MODE=none, where there is no exchange to make. */
    identity?: GitHubIdentityClient | undefined;
    /**
     * The per-user repo scope. Absent whenever scoping cannot be computed — no GitHub App, no
     * auto-join — and every route then serves the full installation list.
     */
    scope?: RepoAccessScope | undefined;
}

/**
 * Why the callback redirects on failure instead of returning JSON.
 *
 * It is reached by a top-level browser navigation from github.com. A `403 {"error":…}` body is a
 * dead end for the human sitting in front of it — there is no page, no way back, and nothing that
 * says what to do. A redirect carrying a reason lands them on the app, which can explain.
 */
const failure = (returnTo: string, reason: string): string =>
    `${safeReturnPath(returnTo)}?auth_error=${encodeURIComponent(reason)}`;

export const authRoutes =
    ({ config, store, identity, scope }: AuthRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const { auth } = config;
        const resolveUser = createUserResolver({ config, store });

        app.get('/api/auth/me', async (request, reply) => {
            const caller = await resolveUser(request).catch(() => null);
            if (!caller) {
                return reply.code(401).send({ error: 'Sign in required', code: 'UNAUTHENTICATED' });
            }
            return reply.code(200).send({
                user: {
                    id: caller.user.id,
                    login: caller.user.login,
                    name: caller.user.displayName,
                    // The identity and the avatar, for the settings page's read-only identity
                    // section. Under AUTH_MODE=none these are 0 and null — facts, not display
                    // hints; the page decides what a stand-in account looks like.
                    githubUserId: caller.user.githubUserId,
                    avatarUrl: caller.user.avatarUrl,
                },
                role: caller.role,
                membership: caller.membership,
                account: {
                    createdAt: caller.user.createdAt,
                    lastLoginAt: caller.user.lastLoginAt,
                },
                organization: { id: config.orgId, name: config.orgName },
                // Null when workspaces are switched off — "off" is a configuration somebody chose,
                // the same answer /api/workspace gives. Read-only: computing a path must not
                // provision the directory, which GET /api/workspace already does idempotently.
                workspacePath:
                    config.workspaceRoot === null
                        ? null
                        : workspaceDir(config.workspaceRoot, config.orgId, caller.user.id),
                // So the SPA knows whether to offer a sign-out at all: under AUTH_MODE=none there is
                // no session to end, and a button that cannot work is worse than no button.
                mode: auth.mode,
            });
        });

        if (auth.mode !== 'github' || !identity) return;
        const secret = auth.sessionSecret;
        const cookie = sessionCookieOptions(auth.cookieSecure, Math.floor(auth.sessionTtlMs / 1000));

        app.get('/api/auth/github', async (request, reply) => {
            const returnTo = safeReturnPath((request.query as { returnTo?: string }).returnTo);
            const state = encodeState(returnTo, secret);
            // The same signed value goes to GitHub and into the cookie; the callback requires both
            // and that they match. GitHub echoes the one it was given, so an attacker who starts a
            // flow in their own browser cannot make a victim's browser complete it — the victim's
            // cookie holds a different nonce.
            reply.setCookie(OAUTH_COOKIE, state, oauthCookieOptions(auth.cookieSecure));
            return reply.redirect(identity.authorizeUrl(state), 302);
        });

        app.get('/api/auth/github/callback', async (request, reply) => {
            const query = request.query as { code?: string; state?: string; error?: string };
            const cookied = request.cookies[OAUTH_COOKIE];
            // Single-use: cleared whatever happens, so a replayed callback finds no cookie.
            reply.clearCookie(OAUTH_COOKIE, oauthCookieOptions(auth.cookieSecure));

            const decoded = decodeState(cookied, secret);
            const returnTo = decoded?.returnTo ?? '/';

            // GitHub sends `error=access_denied` when somebody declines the consent screen. That is
            // an ordinary outcome, not a fault, and it must not read as one.
            if (query.error) return reply.redirect(failure(returnTo, 'denied'), 302);
            if (!decoded || !statesMatch(query.state, cookied)) {
                return reply.redirect(failure(returnTo, 'state'), 302);
            }
            if (!query.code) return reply.redirect(failure(returnTo, 'state'), 302);

            let caller;
            try {
                const accessToken = await identity.exchange(query.code);
                const who = await identity.identity(accessToken);
                caller = await store.signIn(who, config.orgId);
                /*
                 * The GitHub organization is the source of truth for a row auto-join created.
                 *
                 * Asked when nobody has a row yet — the original admission path — and again on
                 * every sign-in of a row that was itself auto-joined, which is how leaving the org
                 * ends access and how a role change follows the member, without an admin here
                 * having to mirror GitHub by hand. An invited row is never checked: an admin named
                 * this person, so GitHub is not consulted, and "the ordinary member pays no extra
                 * GitHub call" survives for exactly the population it was coined for.
                 */
                if (auth.autoJoinGithubOrg && (!caller || caller.autoJoined)) {
                    const membership = await identity.orgMembership(accessToken, auth.autoJoinGithubOrg);
                    if (membership.state !== 'active') {
                        // `pending` and `none` both end the row: the store's claim and its role were
                        // GitHub's to give, and GitHub now says they are gone. removeMember also
                        // deletes the sessions, so even the cookie this browser is about to receive
                        // would not survive the next request.
                        if (caller) await store.removeMember(config.orgId, who.login);
                        caller = null;
                    } else if (!caller) {
                        // GitHub has confirmed the organization — the store is told to create the
                        // membership, it never decides to.
                        caller = await store.signIn(who, config.orgId, {
                            autoJoin: true,
                            role: membership.role,
                        });
                    } else if (caller.role !== membership.role) {
                        // Only ever reached for an auto_joined row — an invited caller never got
                        // here — so re-deriving the role cannot stomp what an invite granted.
                        await store.updateMemberRole(config.orgId, who.login, membership.role);
                        caller = { ...caller, role: membership.role };
                    }
                }
            } catch (e) {
                request.log.error({ err: e }, 'github sign-in failed');
                return reply.redirect(failure(returnTo, 'github'), 302);
            }

            // The account exists — the identity is a fact — but nobody invited it here. Reported as
            // its own reason, because "your login failed" and "you are not a member of this
            // organization" send the reader to completely different places.
            if (!caller) return reply.redirect(failure(returnTo, 'no_membership'), 302);

            /*
             * The workspace directory, and only the directory.
             *
             * A `mkdir` is microseconds, so signing in can afford it; a clone is minutes, so signing
             * in cannot, and nothing is cloned until this person picks repositories. A member who
             * signs in once and never returns therefore costs an empty directory and nothing else.
             *
             * A failure here must not block the sign-in: the workspace is one feature of the
             * dashboard, and a full disk should not turn into "you cannot log in". GET
             * /api/workspace calls the same function, so a session that got here without one
             * recovers on its first visit to the page.
             */
            try {
                ensureUserWorkspace({
                    root: config.workspaceRoot,
                    orgId: config.orgId,
                    userId: caller.user.id,
                    login: caller.user.login,
                    githubUserId: caller.user.githubUserId,
                    // The one moment a GitHub rename can have happened since the last visit.
                    rewriteBreadcrumb: true,
                });
            } catch (e) {
                request.log.error({ err: e }, 'workspace provisioning failed');
            }

            const token = mintToken();
            // The cookie's Max-Age and the row's expires_at describe the same instant: the first
            // stops the browser sending it, the second stops this server honouring a copy of it that
            // no browser is enforcing.
            await store.createSession(hashToken(token), caller.user.id, new Date(Date.now() + auth.sessionTtlMs));
            reply.setCookie(SESSION_COOKIE, sign(token, secret), cookie);

            /*
             * The per-user repo scope, recomputed while the credential is fresh.
             *
             * Runs after the session exists, because the credential decision has already happened:
             * a GitHub hiccup here must degrade to "the last computed scope still applies", which a
             * log line says, never to "sign-in failed", which a throw would say. The scope is
             * derived data — this is the refresh, not the source of truth.
             */
            if (scope) {
                try {
                    await scope.refreshUser(caller.user.id, caller.user.login);
                } catch (e) {
                    request.log.error({ err: e }, 'repo access refresh failed; keeping the last computed scope');
                }
            }

            return reply.redirect(returnTo, 302);
        });

        // POST, not GET. A GET logout is CSRF-able by any third-party image tag, and link
        // prefetchers fire it just by hovering.
        app.post('/api/auth/logout', async (request, reply) => {
            const token = unsign(request.cookies[SESSION_COOKIE], secret);
            if (token) await store.deleteSession(hashToken(token));
            reply.clearCookie(SESSION_COOKIE, cookie);
            // 204 whether or not there was a session: "already signed out" is the desired end state,
            // so reporting it as a failure would give the client an error it cannot act on.
            return reply.code(204).send();
        });
    };
