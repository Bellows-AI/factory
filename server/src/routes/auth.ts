import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createUserResolver } from '../auth/plugin.js';
import type { GitHubIdentity, GitHubIdentityClient } from '../auth/github.js';
import { createGitHubAppClient, type InstallationRepo } from '../github/app-client.js';
import { installationTokenProvider } from '../github/app-token.js';
import {
    OAUTH_COOKIE,
    OAUTH_TTL_SECONDS,
    PENDING_COOKIE,
    SESSION_COOKIE,
    decodeState,
    encodeState,
    hashToken,
    oauthCookieOptions,
    pendingCookieOptions,
    safeReturnPath,
    sessionCookieOptions,
    sign,
    statesMatch,
    unsign,
} from '../auth/session.js';
import type { AuthStore, Caller, InstallationRef } from '../auth/store.js';
import type { AppConfig } from '../config.js';
import type { OrgRegistry } from '../orgs.js';
import { workspaceDir } from '../workspace/reconcile.js';
import { registerOnboardingRoutes } from './auth-onboarding.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_FORBIDDEN,
    HTTP_FOUND,
    HTTP_NO_CONTENT,
    HTTP_OK,
    HTTP_UNAUTHORIZED,
    HTTP_UNAVAILABLE,
    INSTALLATION_ID,
    type ListInstallationRepos,
    MS_PER_SECOND,
    type SessionDeps,
    startSession,
} from './auth-shared.js';

/** `/api/auth/org`'s body is one id string; no payload needs more than a control route's headroom. */
const ORG_SWITCH_BODY_LIMIT = 4096;

export interface AuthRouteDeps {
    config: AppConfig;
    store: AuthStore;
    /**
     * The per-org runtimes, for one job: invalidating an org's cached repo source when its
     * tracked-repo allowlist is rewritten (#125), so a reselect is served on the next read
     * instead of when the ten-minute TTL happens to run out.
     */
    orgs?: OrgRegistry | undefined;
    /** Absent under AUTH_MODE=none, where there is no exchange to make. */
    identity?: GitHubIdentityClient | undefined;
    /**
     * The App slug, for building the install-page redirect when an account can see no
     * installations. Absent offline — the code-only no-fetch arm cannot ask GitHub, so the
     * 0-installation path reports `install` instead.
     */
    appSlug?: (() => Promise<string>) | undefined;
    /**
     * Repos one installation can see, for the onboarding screen (#125). Absent means the screen
     * reports repo tracking as unavailable — the offline shape, where there is no App client to
     * ask. Built from the config when not injected: one transient per-installation client per
     * call, exactly the shape the org registry builds for a materialized org — the difference is
     * that onboarding lists repos for an installation that has no org row yet.
     */
    installationListing?: ((installationId: string) => Promise<InstallationRepo[] | null>) | undefined;
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

type DecodedState = { returnTo: string; org: string | null; reselect: boolean };

async function redirectToInstallPage(
    request: FastifyRequest,
    reply: FastifyReply,
    appSlug: (() => Promise<string>) | undefined,
    returnTo: string
): Promise<void> {
    // The ordinary first-run state, not a fault: the App exists but is installed nowhere this
    // account can see. GitHub's own install page is where that is fixed — and its setup URL
    // sends the browser back here once it is done.
    try {
        const slug = await appSlug?.();
        if (!slug) throw new Error('no slug provider');
        reply.redirect(`https://github.com/apps/${slug}/installations/new`, HTTP_FOUND);
    } catch (e) {
        request.log.error({ err: e }, 'could not resolve the App slug for the install redirect');
        reply.redirect(failure(returnTo, 'install'), HTTP_FOUND);
    }
}

interface CallbackCtx {
    identity: GitHubIdentityClient;
    appSlug: (() => Promise<string>) | undefined;
    store: AuthStore;
    secret: string;
    cookieSecure: boolean;
}

interface PendingParkInfo {
    who: GitHubIdentity;
    reported: InstallationRef[];
    returnTo: string;
    orgPreference: string | null;
}

async function parkPendingSignIn(ctx: CallbackCtx, reply: FastifyReply, info: PendingParkInfo): Promise<void> {
    const token = await ctx.store.createPendingSignIn({
        identity: info.who,
        installations: info.reported,
        returnTo: info.returnTo,
        orgPreference: info.orgPreference,
        // The row and the pending cookie describe the same instant, for the same reason the
        // session cookie's Max-Age and its row's expires_at do.
        expiresAt: new Date(Date.now() + OAUTH_TTL_SECONDS * MS_PER_SECOND),
    });
    reply.setCookie(PENDING_COOKIE, sign(token, ctx.secret), pendingCookieOptions(ctx.cookieSecure));
    reply.redirect('/onboarding', HTTP_FOUND);
}

interface CallbackInput {
    decoded: DecodedState;
    returnTo: string;
    code: string;
}

/**
 * Exchanges the OAuth code for the identity and its installation report, then decides between the
 * three outcomes the callback's block comment describes: the install page, the onboarding park, or
 * a straight sign-in. `kind: 'handled'` means the reply has already been sent (a redirect); the
 * caller only has to start the session on `kind: 'caller'`.
 */
async function resolveCallbackCaller(
    ctx: CallbackCtx,
    request: FastifyRequest,
    reply: FastifyReply,
    input: CallbackInput
): Promise<{ kind: 'caller'; caller: Caller } | { kind: 'handled' }> {
    const { decoded, returnTo, code } = input;
    const accessToken = await ctx.identity.exchange(code);
    const who = await ctx.identity.identity(accessToken);
    // THE FULL REPORT, loudly complete. Since #125 this is no longer automatically the membership
    // set: it is what the selection is validated against, what the stored choice is pruned with,
    // and what signIn materializes from — signIn removes what this list does not name, so a
    // truncated one is as corrosive as ever (see github.ts's page cap).
    const installations = await ctx.identity.installations(accessToken);
    if (installations.length === 0) {
        await redirectToInstallPage(request, reply, ctx.appSlug, returnTo);
        return { kind: 'handled' };
    }
    const reported = installations.map((install) => ({ id: install.id, name: install.account ?? install.id }));
    // The account's stored choice, intersected with what GitHub still reports — the membership
    // rows ARE the stored selection (#125), and the sweep has already kept it honest. Anything
    // GitHub stopped reporting drops out here.
    const stored = await ctx.store.storedSelection(who.githubUserId);
    const remembered = stored.filter((id) => reported.some((install) => install.id === id));

    // THE SELECTION STEP. A first sign-in — no stored choice — with two or more installations
    // parks the round trip and asks what to track; so does an explicit `?reselect=1`, whatever the
    // report's size — for a single-installation account that link is the only lever on
    // `tracked_repo`, since completion is the only production writer of it. A first sign-in with
    // one installation has nothing to choose, whatever was asked.
    if ((remembered.length === 0 && reported.length >= 2) || decoded.reselect) {
        await parkPendingSignIn(ctx, reply, { who, reported, returnTo, orgPreference: decoded.org });
        return { kind: 'handled' };
    }

    // Straight in: the remembered selection in report order, or the one installation when nothing
    // is stored. First reported installation, unless the sign-in was FOR another one this account
    // can actually see — a stale deep link is a preference, never an error page.
    const selection = remembered.length > 0 ? reported.filter((ref) => remembered.includes(ref.id)) : reported;
    const selected =
        decoded.org && selection.some((install) => install.id === decoded.org) ? decoded.org : selection[0]!.id;
    const caller = await ctx.store.signIn(who, selected, selection);
    return { kind: 'caller', caller };
}

/**
 * `resolveCallbackCaller`, with the "github sign-in failed" catch folded in — kept separate so the
 * route handler itself carries no try/catch (and the complexity that comes with one).
 */
async function resolveCallbackCallerSafely(
    ctx: CallbackCtx,
    request: FastifyRequest,
    reply: FastifyReply,
    input: CallbackInput
): Promise<{ kind: 'caller'; caller: Caller } | { kind: 'handled' }> {
    try {
        return await resolveCallbackCaller(ctx, request, reply, input);
    } catch (e) {
        request.log.error({ err: e }, 'github sign-in failed');
        reply.redirect(failure(input.returnTo, 'github'), HTTP_FOUND);
        return { kind: 'handled' };
    }
}

interface CallbackDeps {
    ctx: CallbackCtx;
    sessionDeps: SessionDeps;
}

async function handleGithubCallback(deps: CallbackDeps, request: FastifyRequest, reply: FastifyReply) {
    const { ctx, sessionDeps } = deps;
    const query = request.query as { code?: string; state?: string; error?: string };
    const cookied = request.cookies[OAUTH_COOKIE];
    // Single-use: cleared whatever happens, so a replayed callback finds no cookie.
    reply.clearCookie(OAUTH_COOKIE, oauthCookieOptions(ctx.cookieSecure));

    const decoded = decodeState(cookied, ctx.secret);
    const returnTo = decoded?.returnTo ?? '/';

    // GitHub sends `error=access_denied` when somebody declines the consent screen. That is an
    // ordinary outcome, not a fault, and it must not read as one.
    if (query.error) return reply.redirect(failure(returnTo, 'denied'), HTTP_FOUND);
    if (!decoded || !statesMatch(query.state, cookied)) {
        return reply.redirect(failure(returnTo, 'state'), HTTP_FOUND);
    }
    if (!query.code) return reply.redirect(failure(returnTo, 'state'), HTTP_FOUND);

    const outcome = await resolveCallbackCallerSafely(ctx, request, reply, { decoded, returnTo, code: query.code });
    if (outcome.kind === 'handled') return reply;

    await startSession(sessionDeps, request, reply, outcome.caller);
    return reply.redirect(returnTo, HTTP_FOUND);
}

function isMemberOf(memberships: readonly { id: string }[], orgId: string): boolean {
    return memberships.some((membership) => membership.id === orgId);
}

/**
 * The caller behind a request, or a refusal already sent.
 *
 * `resolveUser` answers null for "no credential, or one that does not resolve" and THROWS when the
 * session store could not be reached. The `.catch(() => null)` this replaces collapsed the two, so
 * a database outage was reported to every signed-in browser as "you are not signed in" — with
 * nothing in the logs to say otherwise. A store failure is now a logged 503; an absent or invalid
 * credential still gets each route's own answer, which is not the same answer in both.
 *
 * The exception stays in the log and never reaches the requester: a store error message carries
 * connection strings, hostnames and query text, and these two routes answer anyone who can reach
 * the port. The caller is told the session store is unavailable, which is all it can act on.
 */
async function resolvedCaller(
    resolveUser: (request: FastifyRequest) => Promise<Caller | null>,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<{ ok: true; caller: Caller | null } | { ok: false }> {
    try {
        return { ok: true, caller: await resolveUser(request) };
    } catch (err) {
        request.log.error({ err }, 'session resolve failed');
        await reply
            .code(HTTP_UNAVAILABLE)
            .send({ error: 'The session store is unavailable', code: ERROR_CODES.UNAVAILABLE });
        return { ok: false };
    }
}

interface SwitchOrgCtx {
    store: AuthStore;
    secret: string;
    resolveUser: (request: FastifyRequest) => Promise<Caller | null>;
}

/**
 * Switching organizations (the selector's write). Membership is verified here — a session cannot
 * be moved to an org its user cannot see — and the session row is what changes, so every
 * subsequent request resolves the caller through the new org while the credential itself stays
 * the same.
 */
async function handleSwitchOrg(ctx: SwitchOrgCtx, request: FastifyRequest, reply: FastifyReply) {
    const { store, secret, resolveUser } = ctx;
    const resolved = await resolvedCaller(resolveUser, request, reply);
    if (!resolved.ok) return reply;
    const caller = resolved.caller;
    if (!caller)
        return reply.code(HTTP_UNAUTHORIZED).send({ error: 'Sign in required', code: ERROR_CODES.UNAUTHENTICATED });

    const body = request.body as { orgId?: unknown } | undefined;
    const orgId = typeof body?.orgId === 'string' ? body.orgId.trim() : '';
    if (!orgId) return reply.code(HTTP_BAD_REQUEST).send({ error: 'orgId is required', code: ERROR_CODES.BAD_ORG });

    const org = await store.findOrg(orgId);
    if (!org) {
        return reply
            .code(HTTP_BAD_REQUEST)
            .send({ error: `Unknown organization "${orgId}"`, code: ERROR_CODES.UNKNOWN_ORG });
    }

    const memberships = await store.membershipsOf(caller.user.id);
    if (!isMemberOf(memberships, orgId)) {
        return reply
            .code(HTTP_FORBIDDEN)
            .send({ error: 'You are not a member of this organization', code: ERROR_CODES.FORBIDDEN });
    }

    const token = unsign(request.cookies[SESSION_COOKIE], secret);
    if (!token) {
        // Registered in github mode only, so this is a caller with no session cookie at all — the
        // same 401 class the hook answers for every other route.
        return reply.code(HTTP_BAD_REQUEST).send({ error: 'No session to switch', code: ERROR_CODES.NO_SESSION });
    }
    const moved = await store.updateSessionOrg(hashToken(token), orgId);
    // The membership check above passed, so false means it vanished concurrently — same answer
    // either way.
    if (!moved) {
        return reply
            .code(HTTP_FORBIDDEN)
            .send({ error: 'You are not a member of this organization', code: ERROR_CODES.FORBIDDEN });
    }
    return reply.code(HTTP_OK).send({ organization: org });
}

export const authRoutes =
    ({ config, store, orgs, identity, appSlug, installationListing }: AuthRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const { auth } = config;
        const resolveUser = createUserResolver({ config, store });

        // The onboarding screen's repo read (#125). Not injected means built from the config —
        // the App arm — or absent, which the screen renders as "repo tracking unavailable".
        const appGithub = config.github;
        const defaultListing =
            appGithub.mode === 'app'
                ? (installationId: string) =>
                      createGitHubAppClient(appGithub, installationTokenProvider({ github: appGithub, installationId }))
                          .listRepositories()
                          .then((listing) => [...listing.repos])
                : undefined;
        const listInstallationRepos: ListInstallationRepos = installationListing ?? defaultListing;

        app.get('/api/auth/me', async (request, reply) => {
            const resolved = await resolvedCaller(resolveUser, request, reply);
            if (!resolved.ok) return reply;
            const caller = resolved.caller;
            if (!caller) {
                // 200, not 401. This is the SPA's session probe, and the browser logs every 4xx as
                // a console error even when the client handles it — the login screen would open
                // with red rows in the devtools of everybody not signed in. `authenticated: false`
                // says the same thing without the noise; the data routes keep their real 401s.
                return reply.code(HTTP_OK).send({ authenticated: false });
            }
            return reply.code(HTTP_OK).send({
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
        const cookie = sessionCookieOptions(auth.cookieSecure, Math.floor(auth.sessionTtlMs / MS_PER_SECOND));
        const sessionDeps: SessionDeps = {
            workspaceRoot: config.workspaceRoot,
            sessionTtlMs: auth.sessionTtlMs,
            secret,
            cookie,
            store,
        };
        const callbackCtx: CallbackCtx = { identity, appSlug, store, secret, cookieSecure: auth.cookieSecure };

        app.get('/api/auth/github', async (request, reply) => {
            const query = request.query as { returnTo?: string; org?: string; reselect?: string };
            const returnTo = safeReturnPath(query.returnTo);
            // A deep link can ask to land in a specific organization. It rides the signed state —
            // one signature covers destination and org — and is only a preference: the callback
            // validates it against the installations GitHub reports, and falls back to the first.
            const org = query.org && INSTALLATION_ID.test(query.org) ? query.org : undefined;
            // `reselect=1` asks to re-open the selection screen even though the account already
            // has a stored choice (#125) — the only surface for changing it, because the GitHub
            // user token that enumerated the installations is discarded at sign-in and cannot be
            // re-asked outside an OAuth round trip.
            const state = encodeState(returnTo, secret, org, query.reselect === '1');
            // The same signed value goes to GitHub and into the cookie; the callback requires both
            // and that they match. GitHub echoes the one it was given, so an attacker who starts a
            // flow in their own browser cannot make a victim's browser complete it — the victim's
            // cookie holds a different nonce.
            reply.setCookie(OAUTH_COOKIE, state, oauthCookieOptions(auth.cookieSecure));
            return reply.redirect(identity.authorizeUrl(state), HTTP_FOUND);
        });

        app.get('/api/auth/github/callback', (request, reply) =>
            handleGithubCallback({ ctx: callbackCtx, sessionDeps }, request, reply)
        );

        registerOnboardingRoutes(app, {
            store,
            orgs,
            secret,
            cookieSecure: auth.cookieSecure,
            sessionDeps,
            listInstallationRepos,
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
                // The org rides along as the sign-in's preference, and reselect makes an existing
                // account reopen the choice instead of silently reusing the membership set from
                // before this installation existed. Completion still decides what to materialize.
                return reply.redirect(`/api/auth/github?org=${query.installation_id}&reselect=1`, HTTP_FOUND);
            }
            return reply.redirect('/?auth_error=install_cancelled', HTTP_FOUND);
        });

        app.post('/api/auth/org', { bodyLimit: ORG_SWITCH_BODY_LIMIT }, (request, reply) =>
            handleSwitchOrg({ store, secret, resolveUser }, request, reply)
        );

        // POST, not GET. A GET logout is CSRF-able by any third-party image tag, and link
        // prefetchers fire it just by hovering.
        app.post('/api/auth/logout', async (request, reply) => {
            const token = unsign(request.cookies[SESSION_COOKIE], secret);
            if (token) await store.deleteSession(hashToken(token));
            reply.clearCookie(SESSION_COOKIE, cookie);
            // 204 whether or not there was a session: "already signed out" is the desired end state,
            // so reporting it as a failure would give the client an error it cannot act on.
            return reply.code(HTTP_NO_CONTENT).send();
        });
    };
