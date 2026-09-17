import type { FastifyPluginAsync } from 'fastify';
import { createUserResolver } from '../auth/plugin.js';
import type { GitHubIdentityClient } from '../auth/github.js';
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
     * The App slug, for building the install-page redirect when an account can see no
     * installations. Absent offline — the code-only no-fetch arm cannot ask GitHub, so the
     * 0-installation path reports `install` instead.
     */
    appSlug?: (() => Promise<string>) | undefined;
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

/** An installation id is a decimal string and nothing else — the org ids are installation ids. */
const INSTALLATION_ID = /^\d+$/;

export const authRoutes =
    ({ config, store, identity, appSlug }: AuthRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const { auth } = config;
        const resolveUser = createUserResolver({ config, store });

        app.get('/api/auth/me', async (request, reply) => {
            const caller = await resolveUser(request).catch(() => null);
            if (!caller) {
                // 200, not 401. This is the SPA's session probe, and the browser logs every 4xx as
                // a console error even when the client handles it — the login screen would open
                // with red rows in the devtools of everybody not signed in. `authenticated: false`
                // says the same thing without the noise; the data routes keep their real 401s.
                return reply.code(200).send({ authenticated: false });
            }
            return reply.code(200).send({
                authenticated: true,
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
                // The org the session is bound to, and every org this account could switch to —
                // the selector renders both, and POST /api/auth/org moves between them.
                organization: caller.org,
                organizations: await store.membershipsOf(caller.user.id),
                // Null when workspaces are switched off — "off" is a configuration somebody chose,
                // the same answer /api/workspace gives. Read-only: computing a path must not
                // provision the directory, which GET /api/workspace already does idempotently.
                workspacePath:
                    config.workspaceRoot === null
                        ? null
                        : workspaceDir(config.workspaceRoot, caller.org.id, caller.user.id),
                // So the SPA knows whether to offer a sign-out at all: under AUTH_MODE=none there is
                // no session to end, and a button that cannot work is worse than no button.
                mode: auth.mode,
            });
        });

        if (auth.mode !== 'github' || !identity) return;
        const secret = auth.sessionSecret;
        const cookie = sessionCookieOptions(auth.cookieSecure, Math.floor(auth.sessionTtlMs / 1000));

        app.get('/api/auth/github', async (request, reply) => {
            const query = request.query as { returnTo?: string; org?: string };
            const returnTo = safeReturnPath(query.returnTo);
            // A deep link can ask to land in a specific organization. It rides the signed state —
            // one signature covers destination and org — and is only a preference: the callback
            // validates it against the installations GitHub reports, and falls back to the first.
            const org = query.org && INSTALLATION_ID.test(query.org) ? query.org : undefined;
            const state = encodeState(returnTo, secret, org);
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
                // THE MEMBERSHIP DECISION. What this account can see is what it may sign into;
                // store.signIn materializes every reported installation as an organization and a
                // membership, and drops memberships of installations it no longer reports.
                const installations = await identity.installations(accessToken);
                if (installations.length === 0) {
                    // The ordinary first-run state, not a fault: the App exists but is installed
                    // nowhere this account can see. GitHub's own install page is where that is
                    // fixed — and its setup URL sends the browser back here once it is done.
                    try {
                        const slug = await appSlug?.();
                        if (!slug) throw new Error('no slug provider');
                        return reply.redirect(`https://github.com/apps/${slug}/installations/new`, 302);
                    } catch (e) {
                        request.log.error({ err: e }, 'could not resolve the App slug for the install redirect');
                        return reply.redirect(failure(returnTo, 'install'), 302);
                    }
                }
                // First reported installation, unless the sign-in was FOR another one this account
                // can actually see. Anything else silently falls back — a stale deep link is a
                // preference, never an error page.
                const selected =
                    decoded.org && installations.some((install) => install.id === decoded.org)
                        ? decoded.org
                        : installations[0]!.id;
                caller = await store.signIn(
                    who,
                    selected,
                    installations.map((install) => ({ id: install.id, name: install.account ?? install.id }))
                );
            } catch (e) {
                request.log.error({ err: e }, 'github sign-in failed');
                return reply.redirect(failure(returnTo, 'github'), 302);
            }

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
                    orgId: caller.org.id,
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
            // no browser is enforcing. The row carries the org it was created in — the whole
            // session reads from there until POST /api/auth/org says otherwise.
            await store.createSession(
                hashToken(token),
                caller.user.id,
                new Date(Date.now() + auth.sessionTtlMs),
                caller.org.id
            );
            reply.setCookie(SESSION_COOKIE, sign(token, secret), cookie);

            return reply.redirect(returnTo, 302);
        });

        /*
         * The GitHub App setup URL lands here (#99).
         *
         * The operator points the App's Setup URL at `<publicUrl>/api/auth/github/setup`; GitHub
         * redirects to it after the install page. `setup_action=install` with an installation id
         * means an installation now exists — (re)start the sign-in round trip, which is where the
         * real identity and the membership materialization happen. Arriving WITHOUT an
         * installation id means the person came back without installing, which the sign-in screen
         * reports as its own outcome rather than as a failure.
         */
        app.get('/api/auth/github/setup', async (request, reply) => {
            const query = request.query as { installation_id?: string };
            if (query.installation_id && INSTALLATION_ID.test(query.installation_id)) {
                // The org rides along as the sign-in's preference, so the session lands in the
                // installation that was JUST created rather than whichever GitHub reports first.
                return reply.redirect(`/api/auth/github?org=${query.installation_id}`, 302);
            }
            return reply.redirect('/?auth_error=install_cancelled', 302);
        });

        /*
         * Switching organizations.
         *
         * The selector's write. Membership is verified here — a session cannot be moved to an org
         * its user cannot see — and the session row is what changes, so every subsequent request
         * resolves the caller through the new org while the credential itself stays the same.
         */
        app.post('/api/auth/org', { bodyLimit: 4096 }, async (request, reply) => {
            const caller = await resolveUser(request).catch(() => null);
            if (!caller) return reply.code(401).send({ error: 'Sign in required', code: 'UNAUTHENTICATED' });

            const body = request.body as { orgId?: unknown } | undefined;
            const orgId = typeof body?.orgId === 'string' ? body.orgId.trim() : '';
            if (!orgId) return reply.code(400).send({ error: 'orgId is required', code: 'BAD_ORG' });

            const org = await store.findOrg(orgId);
            if (!org) return reply.code(400).send({ error: `Unknown organization "${orgId}"`, code: 'UNKNOWN_ORG' });

            const memberships = await store.membershipsOf(caller.user.id);
            if (!memberships.some((membership) => membership.id === orgId)) {
                return reply.code(403).send({ error: 'You are not a member of this organization', code: 'FORBIDDEN' });
            }

            const token = unsign(request.cookies[SESSION_COOKIE], secret);
            if (!token) {
                // Registered in github mode only, so this is a caller with no session cookie at
                // all — the same 401 class the hook answers for every other route.
                return reply.code(400).send({ error: 'No session to switch', code: 'NO_SESSION' });
            }
            const moved = await store.updateSessionOrg(hashToken(token), orgId);
            // The membership check above passed, so false means it vanished concurrently — same
            // answer either way.
            if (!moved) {
                return reply.code(403).send({ error: 'You are not a member of this organization', code: 'FORBIDDEN' });
            }
            return reply.code(200).send({ organization: org });
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
