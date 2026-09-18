import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createUserResolver } from '../auth/plugin.js';
import type { GitHubIdentityClient } from '../auth/github.js';
import { createGitHubAppClient, type InstallationRepo } from '../github/app-client.js';
import { installationTokenProvider } from '../github/app-token.js';
import { ensureUserWorkspace } from '../workspace/provision.js';
import { workspaceDir } from '../workspace/reconcile.js';
import {
    OAUTH_COOKIE,
    OAUTH_TTL_SECONDS,
    PENDING_COOKIE,
    SESSION_COOKIE,
    decodeState,
    encodeState,
    hashToken,
    mintToken,
    oauthCookieOptions,
    pendingCookieOptions,
    safeReturnPath,
    sessionCookieOptions,
    sign,
    statesMatch,
    unsign,
} from '../auth/session.js';
import type { AuthStore, Caller, PendingSignIn } from '../auth/store.js';
import type { AppConfig } from '../config.js';
import type { OrgRegistry } from '../orgs.js';

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

/** An installation id is a decimal string and nothing else — the org ids are installation ids. */
const INSTALLATION_ID = /^\d+$/;

/** One installation as the onboarding screen receives it: its stored narrowing, if it has one. */
interface PendingInstallation {
    id: string;
    account: string;
    tracked: string[] | null;
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
        const listInstallationRepos: ((installationId: string) => Promise<InstallationRepo[] | null>) | undefined =
            installationListing ?? defaultListing;

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
                // The database's pre-upgrade organizations (#123) — adoption territory, not the
                // directory, so the SPA can surface `npm run adopt` where their symptom shows.
                // Guarded on the mode: AUTH_MODE=none's local org legitimately has no
                // installation and must not report itself as legacy. `adoptInto` names the sole
                // installation org only when exactly one exists — the pairing is filled in by
                // the deployment only where it cannot be a guess.
                legacyOrganizations: auth.mode === 'github' ? await store.legacyOrgs() : [],
                adoptInto: auth.mode === 'github' ? await store.adoptTarget() : null,
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
            return reply.redirect(identity.authorizeUrl(state), 302);
        });

        /*
         * The tail every sign-in shares: the workspace directory and the session row.
         *
         * The workspace part — a `mkdir` is microseconds, so signing in can afford it; a clone is
         * minutes, so signing in cannot, and nothing is cloned until this person picks
         * repositories. A failure here must not block the sign-in: the workspace is one feature of
         * the dashboard, and a full disk should not turn into "you cannot log in". GET
         * /api/workspace calls the same function, so a session that got here without one recovers
         * on its first visit to the page.
         *
         * The session part — the cookie's Max-Age and the row's expires_at describe the same
         * instant: the first stops the browser sending it, the second stops this server honouring
         * a copy of it that no browser is enforcing. The row carries the org it was created in —
         * the whole session reads from there until POST /api/auth/org says otherwise.
         */
        const startSession = async (request: FastifyRequest, reply: FastifyReply, caller: Caller): Promise<void> => {
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
            await store.createSession(
                hashToken(token),
                caller.user.id,
                new Date(Date.now() + auth.sessionTtlMs),
                caller.org.id
            );
            reply.setCookie(SESSION_COOKIE, sign(token, secret), cookie);
        };

        /*
         * The pending sign-in behind the cookie, or null. The cookie holds a signed opaque token;
         * the row is keyed by its hash — the same at-rest rule as the session cookie — and the
         * signature is rejected before any database round trip.
         */
        const pendingFrom = async (
            request: FastifyRequest
        ): Promise<{ token: string; pending: PendingSignIn } | null> => {
            const token = unsign(request.cookies[PENDING_COOKIE], secret);
            if (!token) return null;
            const pending = await store.findPendingSignIn(hashToken(token));
            return pending ? { token, pending } : null;
        };

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

            let caller: Caller;
            try {
                const accessToken = await identity.exchange(query.code);
                const who = await identity.identity(accessToken);
                // THE FULL REPORT, loudly complete. Since #125 this is no longer automatically
                // the membership set: it is what the selection is validated against, what the
                // stored choice is pruned with, and what signIn materializes from — signIn
                // removes what this list does not name, so a truncated one is as corrosive as
                // ever (see github.ts's page cap).
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
                const reported = installations.map((install) => ({
                    id: install.id,
                    name: install.account ?? install.id,
                }));
                // The account's stored choice, intersected with what GitHub still reports — the
                // membership rows ARE the stored selection (#125), and the sweep has already kept
                // it honest. Anything GitHub stopped reporting drops out here.
                const stored = await store.storedSelection(who.githubUserId);
                const remembered = stored.filter((id) => reported.some((install) => install.id === id));

                // THE SELECTION STEP. A first sign-in — no stored choice — with two or more
                // installations parks the round trip and asks what to track; so does an explicit
                // `?reselect=1`, whatever the report's size — for a single-installation account
                // that link is the only lever on `tracked_repo`, since completion is the only
                // production writer of it. A first sign-in with one installation has nothing to
                // choose, whatever was asked.
                if ((remembered.length === 0 && reported.length >= 2) || decoded.reselect) {
                    const token = await store.createPendingSignIn({
                        identity: who,
                        installations: reported,
                        returnTo,
                        orgPreference: decoded.org,
                        // The row and the pending cookie describe the same instant, for the same
                        // reason the session cookie's Max-Age and its row's expires_at do.
                        expiresAt: new Date(Date.now() + OAUTH_TTL_SECONDS * 1000),
                    });
                    reply.setCookie(PENDING_COOKIE, sign(token, secret), pendingCookieOptions(auth.cookieSecure));
                    return reply.redirect('/onboarding', 302);
                }

                // Straight in: the remembered selection in report order, or the one installation
                // when nothing is stored. First reported installation, unless the sign-in was FOR
                // another one this account can actually see — a stale deep link is a preference,
                // never an error page.
                const selection =
                    remembered.length > 0 ? reported.filter((ref) => remembered.includes(ref.id)) : reported;
                const selected =
                    decoded.org && selection.some((install) => install.id === decoded.org)
                        ? decoded.org
                        : selection[0]!.id;
                caller = await store.signIn(who, selected, selection);
            } catch (e) {
                request.log.error({ err: e }, 'github sign-in failed');
                return reply.redirect(failure(returnTo, 'github'), 302);
            }

            await startSession(request, reply, caller);
            return reply.redirect(returnTo, 302);
        });

        /*
         * The selection screen's read (#125).
         *
         * Answers the parked sign-in the onboarding page is to render: who is signing in, what
         * their account can see, and what arrives pre-checked. `selected` is the stored choice —
         * already intersected with the report — when there is one (a reselect), and every
         * reported installation otherwise (a first sign-in, where the default matches today's
         * behavior and confirming is a no-op narrowing).
         */
        app.get('/api/auth/github/pending', async (request, reply) => {
            const resolved = await pendingFrom(request);
            if (!resolved) {
                return reply.code(401).send({ error: 'No pending sign-in — start again', code: 'NO_PENDING' });
            }
            const { pending } = resolved;
            const stored = await store.storedSelection(pending.identity.githubUserId);
            const remembered = stored.filter((id) => pending.installations.some((install) => install.id === id));
            return reply.code(200).send({
                identity: {
                    login: pending.identity.login,
                    displayName: pending.identity.displayName,
                    avatarUrl: pending.identity.avatarUrl,
                },
                // `tracked` is the org's stored repo allowlist, or null when it tracks everything.
                // The screen seeds its checkboxes from it: a reselect must SHOW the narrowing it
                // is asking about, and confirming must be able to express widening back — an
                // all-checked org that had a narrowing posts an empty list, which clears it.
                // Intersected with what the installation CURRENTLY reports: a repo removed (or
                // renamed) on GitHub's side since the narrowing was stored is not seedable, and
                // posting it would 400 UNKNOWN_REPO with no checkbox anywhere to uncheck. The
                // listing is asked ONLY for an org that has a narrowing to check against — a
                // first sign-in's screen (narrowings nowhere) costs no App call, no rate-limit
                // point, on the enterprise path this flow exists for.
                installations: await Promise.all(
                    pending.installations.map(async (install): Promise<PendingInstallation> => {
                        const narrowed = await store.trackedRepos(install.id);
                        if (narrowed.length === 0) {
                            return { id: install.id, account: install.name, tracked: null };
                        }
                        const listed = listInstallationRepos
                            ? await listInstallationRepos(install.id)
                                  .then((repos) =>
                                      repos === null ? null : repos.map((repo) => `${repo.owner}/${repo.name}`)
                                  )
                                  .catch(() => null)
                            : null;
                        // Nothing to intersect with: show the stored names as they are, so the
                        // screen still says what the org narrowed to even while offline.
                        const seeded = listed === null ? narrowed : narrowed.filter((name) => listed.includes(name));
                        // A narrowing whose every entry GitHub stopped reporting is KEPT, not
                        // retired: this store reads an empty allowlist as track-everything, so a
                        // read-time repair to [] would silently widen the org to every repo its
                        // installation can see — the exact widening the allowlist exists to
                        // prevent. The stale rows fail closed instead (the repo source filters
                        // against names that no longer match anything), and the screen is told
                        // the stored names as they are, so the stale selection is visible and can
                        // be explicitly revised — re-posting it 400s UNKNOWN_REPO, never a guess.
                        return {
                            id: install.id,
                            account: install.name,
                            tracked: seeded.length > 0 ? seeded : narrowed,
                        };
                    })
                ),
                selected: remembered.length > 0 ? remembered : pending.installations.map((install) => install.id),
                reselect: remembered.length > 0,
                org: pending.orgPreference,
                returnTo: pending.returnTo,
            });
        });

        /*
         * One installation's repos, for the screen's per-org checkboxes (#125).
         *
         * A direct per-installation read through the App client — the org registry cannot answer
         * here, because the org rows this choice is deciding on do not exist yet. `source:
         * 'none'` means there was no client to ask (offline, or GitHub failed): a fact the screen
         * renders as "unavailable" rather than an empty list pretending the installation has no
         * repos — narrowing one is then refused at completion, never silently guessed.
         */
        app.get('/api/auth/github/pending/installations/:installationId/repos', async (request, reply) => {
            const resolved = await pendingFrom(request);
            if (!resolved) {
                return reply.code(401).send({ error: 'No pending sign-in — start again', code: 'NO_PENDING' });
            }
            const { installationId } = request.params as { installationId: string };
            const reported = resolved.pending.installations.some((install) => install.id === installationId);
            if (!INSTALLATION_ID.test(installationId) || !reported) {
                return reply.code(400).send({ error: 'Unknown installation', code: 'UNKNOWN_INSTALLATION' });
            }
            if (!listInstallationRepos) return reply.code(200).send({ repos: [], source: 'none' });
            const repos = await listInstallationRepos(installationId).catch((e: Error) => {
                request.log.error({ err: e }, 'installation repo listing failed');
                return null;
            });
            if (!repos) return reply.code(200).send({ repos: [], source: 'none' });
            return reply.code(200).send({
                repos: repos.map((repo) => `${repo.owner}/${repo.name}`),
                source: 'app',
            });
        });

        /*
         * The selection screen's write (#125).
         *
         * Materializes the posted choice and finishes the sign-in the callback parked. JSON
         * errors, not `?auth_error=` redirects — this route is reached by the SPA's fetch, not by
         * a top-level navigation, so a redirect would be swallowed by it. Everything else about
         * the failure rule stays: an expired or missing pending sign-in is one answer ("start
         * again"), every refusal up to the claim leaves the pending row alive so the person can
         * re-post — and a failure past the claim rolls the materialization back, so "start
         * again" is what actually happens rather than a half-committed sign-in.
         */
        app.post('/api/auth/github/complete', { bodyLimit: 1048576 }, async (request, reply) => {
            const resolved = await pendingFrom(request);
            if (!resolved) {
                return reply.code(401).send({ error: 'No pending sign-in — start again', code: 'NO_PENDING' });
            }
            const { pending } = resolved;

            const body = request.body as { orgs?: unknown; repos?: unknown } | undefined;
            // The orgs: non-empty, deduplicated, decimal ids, every one of the reported set. The
            // selection may only narrow what GitHub reported — never widen it.
            const orgIds: string[] = [];
            const rawOrgs = Array.isArray(body?.orgs) ? body.orgs : [];
            for (const entry of rawOrgs) {
                if (typeof entry !== 'string' || !INSTALLATION_ID.test(entry) || orgIds.includes(entry)) {
                    return reply.code(400).send({ error: 'Bad org selection', code: 'BAD_SELECTION' });
                }
                orgIds.push(entry);
            }
            if (orgIds.length === 0 || !orgIds.every((id) => pending.installations.some((i) => i.id === id))) {
                return reply.code(400).send({ error: 'Bad org selection', code: 'BAD_SELECTION' });
            }

            // The repos, per chosen org — optional, because the screen posts a key only for an
            // org whose checkbox set was narrowed. Keys must be selected orgs; values must be
            // names that org's installation can actually see.
            const reposByOrg = new Map<string, string[]>();
            if (body?.repos !== undefined) {
                if (typeof body.repos !== 'object' || body.repos === null || Array.isArray(body.repos)) {
                    return reply.code(400).send({ error: 'Bad repo selection', code: 'BAD_SELECTION' });
                }
                for (const [orgId, names] of Object.entries(body.repos as Record<string, unknown>)) {
                    if (!orgIds.includes(orgId) || !Array.isArray(names)) {
                        return reply.code(400).send({ error: 'Bad repo selection', code: 'BAD_SELECTION' });
                    }
                    const listed = names.filter((name): name is string => typeof name === 'string');
                    if (listed.length !== names.length) {
                        return reply.code(400).send({ error: 'Bad repo selection', code: 'BAD_SELECTION' });
                    }
                    reposByOrg.set(orgId, listed);
                }
            }
            const listings = new Map<string, InstallationRepo[]>();
            for (const [orgId, names] of reposByOrg) {
                if (names.length === 0) continue; // nothing narrowed — nothing to validate
                const known = listings.get(orgId);
                if (known === undefined) {
                    const fetched = listInstallationRepos
                        ? await listInstallationRepos(orgId).catch((e: Error) => {
                              request.log.error({ err: e }, 'installation repo listing failed');
                              return null;
                          })
                        : null;
                    if (!fetched) {
                        return reply.code(400).send({
                            error: 'Repos cannot be listed for this installation',
                            code: 'REPOS_UNAVAILABLE',
                        });
                    }
                    listings.set(orgId, fetched);
                }
                const visible = new Set(listings.get(orgId)!.map((repo) => `${repo.owner}/${repo.name}`));
                if (!names.every((name) => visible.has(name))) {
                    return reply.code(400).send({ error: 'Unknown repository', code: 'UNKNOWN_REPO' });
                }
            }

            let caller: Caller | undefined;
            // What this completion has rewritten so far — the rollback's map of what to undo.
            const rewroteAllowlist: string[] = [];
            // The prior state the rollback restores — read before anything is written, because
            // the rollback must put back what STOOD here, not a default. A first sign-in has
            // neither memberships nor narrowings (both reads come back empty), so restoring
            // degenerates to plain undo; a RESELECT has both, and restoring them is what keeps a
            // failed reselect from silently widening a narrowed org to track-everything or
            // dropping standing memberships.
            const priorAllowlists = new Map<string, string[]>();
            let priorSelection: string[] = [];
            try {
                for (const orgId of reposByOrg.keys()) {
                    priorAllowlists.set(orgId, await store.trackedRepos(orgId));
                }
                priorSelection = await store.storedSelection(pending.identity.githubUserId);

                // THE CLAIM. Atomically spends the pending row before anything is materialized,
                // so only one of two completions racing the same cookie can get past it — the
                // docs' single-use is a property, not a description of the happy path. Every
                // validation refusal above left the row alive; from here the row is spent, and a
                // failure rolls the materialization back (below) so the only path is, in truth,
                // starting the flow again.
                const claimed = await store.deletePendingSignIn(hashToken(resolved.token));
                if (!claimed) {
                    return reply.code(401).send({ error: 'No pending sign-in — start again', code: 'NO_PENDING' });
                }
                // The choice, in report order, and the session lands in the deep-linked org when
                // it was chosen — or the first of the selection, as the callback would.
                const selection = pending.installations.filter((install) => orgIds.includes(install.id));
                const selected =
                    pending.orgPreference && orgIds.includes(pending.orgPreference)
                        ? pending.orgPreference
                        : selection[0]!.id;
                caller = await store.signIn(pending.identity, selected, selection);
                for (const [orgId, names] of reposByOrg) {
                    await store.replaceTrackedRepos(orgId, names);
                    rewroteAllowlist.push(orgId);
                }
                await startSession(request, reply, caller);
                // The org runtimes cache their repo list with the allowlist intersection folded
                // in — without this poke, a reselect would keep serving the pre-choice truth
                // until the ten-minute TTL ran out. Expire, don't drop: the stale list serves
                // until the next read re-produces, so no poll sees an empty dashboard.
                for (const orgId of orgIds) {
                    const runtime = await orgs?.for(orgId);
                    if (!runtime) continue;
                    runtime.repos.invalidate();
                    // A refresh already in flight read the PRE-write allowlist; when it lands it
                    // stores that stale list with a fresh timestamp, and the expire above cannot
                    // touch a result that did not exist yet. The read is single-flight, so this
                    // joins whatever produce is running rather than racing it — and never
                    // rejects; a failed produce serves the last good entry. The expire AFTER it
                    // lands is what retires the stale capture: the old list still serves until
                    // the next read re-produces, so the exposure is one produce, not a full TTL.
                    await runtime.repos.list();
                    runtime.repos.invalidate();
                }
            } catch (e) {
                request.log.error({ err: e }, 'onboarding completion failed');
                // THE ROLLBACK. These writes are separate transactions, so a failure partway
                // would otherwise leave the memberships committed — and the next OAuth attempt,
                // seeing a stored selection, would bypass onboarding and silently lose the repo
                // choice. Undo what landed, best-effort, back to the PRIOR state rather than to
                // a default: the allowlist rows get their stored narrowing back (writing []
                // instead would read as track-everything and widen the org), and the memberships
                // go back to the stored choice — signIn re-materializes it, which re-adds what
                // this completion's sweep removed and sweeps what it added. A first sign-in has
                // no prior choice, so there the memberships are removed, which is the same
                // thing: the account back to "no stored choice", the next sign-in parked on the
                // screen again. The pending row stays spent either way — one completion, one
                // materialization, whatever the outcome.
                for (const orgId of rewroteAllowlist) {
                    await store
                        .replaceTrackedRepos(orgId, priorAllowlists.get(orgId) ?? [])
                        .catch((err: Error) => request.log.error({ err }, 'onboarding rollback failed'));
                }
                if (caller) {
                    const restored = pending.installations.filter((install) => priorSelection.includes(install.id));
                    if (restored.length > 0) {
                        await store
                            .signIn(pending.identity, restored[0]!.id, restored)
                            .catch((err: Error) => request.log.error({ err }, 'onboarding rollback failed'));
                    } else {
                        for (const install of pending.installations) {
                            if (!orgIds.includes(install.id)) continue;
                            await store
                                .removeMember(install.id, pending.identity.githubUserId)
                                .catch((err: Error) => request.log.error({ err }, 'onboarding rollback failed'));
                        }
                    }
                }
                return reply.code(500).send({ error: 'Could not complete the sign-in', code: 'COMPLETE_FAILED' });
            }

            reply.clearCookie(PENDING_COOKIE, pendingCookieOptions(auth.cookieSecure));
            return reply.code(200).send({ organization: caller.org, returnTo: pending.returnTo });
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
