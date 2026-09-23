import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PENDING_COOKIE, hashToken, pendingCookieOptions, unsign } from '../auth/session.js';
import type { AuthStore, Caller, PendingSignIn } from '../auth/store.js';
import type { InstallationRepo } from '../github/app-client.js';
import type { OrgRegistry } from '../orgs.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_OK,
    HTTP_SERVER_ERROR,
    HTTP_UNAUTHORIZED,
    INSTALLATION_ID,
    type ListInstallationRepos,
    type SessionDeps,
    startSession,
} from './auth-shared.js';

/**
 * The onboarding selection screen (#125): reading the parked sign-in, listing an installation's
 * repos for its checkboxes, and materializing the posted choice. Split out of `auth.ts` purely to
 * keep each file under the repo's line-count ceiling.
 */

/**
 * The onboarding completion body lists org ids and repo names — bigger than a control route, well
 * under a command body: 1 MiB.
 */
const BYTES_PER_KIB = 1024;
const KIB_PER_MIB = 1024;
const COMPLETE_BODY_LIMIT = BYTES_PER_KIB * KIB_PER_MIB;

/** One installation as the onboarding screen receives it: its stored narrowing, if it has one. */
interface PendingInstallation {
    id: string;
    account: string;
    tracked: string[] | null;
}

/*
 * The pending sign-in behind the cookie, or null. The cookie holds a signed opaque token;
 * the row is keyed by its hash — the same at-rest rule as the session cookie — and the
 * signature is rejected before any database round trip.
 */
async function resolvePendingSignIn(
    store: AuthStore,
    secret: string,
    request: FastifyRequest
): Promise<{ token: string; pending: PendingSignIn } | null> {
    const token = unsign(request.cookies[PENDING_COOKIE], secret);
    if (!token) return null;
    const pending = await store.findPendingSignIn(hashToken(token));
    return pending ? { token, pending } : null;
}

/**
 * The orgs a completion body named: non-empty, deduplicated, decimal ids, every one of the
 * reported set. The selection may only narrow what GitHub reported — never widen it. Null is the
 * one refusal shape (`BAD_SELECTION`) every malformed input collapses to.
 */
function parseSelectedOrgIds(body: { orgs?: unknown } | undefined, pending: PendingSignIn): string[] | null {
    const orgIds: string[] = [];
    const rawOrgs = Array.isArray(body?.orgs) ? body.orgs : [];
    for (const entry of rawOrgs) {
        if (typeof entry !== 'string' || !INSTALLATION_ID.test(entry) || orgIds.includes(entry)) return null;
        orgIds.push(entry);
    }
    if (orgIds.length === 0 || !orgIds.every((id) => pending.installations.some((i) => i.id === id))) return null;
    return orgIds;
}

/**
 * The repos, per chosen org — optional, because the screen posts a key only for an org whose
 * checkbox set was narrowed. Keys must be selected orgs; values must be strings. Null is the one
 * refusal shape (`BAD_SELECTION`); an empty map means nothing was narrowed.
 */
function parseRequestedRepos(body: { repos?: unknown } | undefined, orgIds: string[]): Map<string, string[]> | null {
    const reposByOrg = new Map<string, string[]>();
    if (body?.repos === undefined) return reposByOrg;
    if (typeof body.repos !== 'object' || body.repos === null || Array.isArray(body.repos)) return null;
    for (const [orgId, names] of Object.entries(body.repos as Record<string, unknown>)) {
        if (!orgIds.includes(orgId) || !Array.isArray(names)) return null;
        const listed = names.filter((name): name is string => typeof name === 'string');
        if (listed.length !== names.length) return null;
        reposByOrg.set(orgId, listed);
    }
    return reposByOrg;
}

/** Every narrowed org's posted names must be repos that installation's live listing can see. */
async function validateRepoVisibility(
    request: FastifyRequest,
    reposByOrg: Map<string, string[]>,
    listInstallationRepos: ListInstallationRepos
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
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
                return {
                    ok: false,
                    code: ERROR_CODES.REPOS_UNAVAILABLE,
                    message: 'Repos cannot be listed for this installation',
                };
            }
            listings.set(orgId, fetched);
        }
        const visible = new Set(listings.get(orgId)!.map((repo) => `${repo.owner}/${repo.name}`));
        if (!names.every((name) => visible.has(name))) {
            return { ok: false, code: ERROR_CODES.UNKNOWN_REPO, message: 'Unknown repository' };
        }
    }
    return { ok: true };
}

/**
 * THE ROLLBACK. These writes are separate transactions, so a failure partway through
 * materialization would otherwise leave the memberships committed — and the next OAuth attempt,
 * seeing a stored selection, would bypass onboarding and silently lose the repo choice. Undo what
 * landed, best-effort, back to the PRIOR state rather than to a default: the allowlist rows get
 * their stored narrowing back (writing [] instead would read as track-everything and widen the
 * org), and the memberships go back to the stored choice — signIn re-materializes it, which
 * re-adds what this completion's sweep removed and sweeps what it added. A first sign-in has no
 * prior choice, so there the memberships are removed, which is the same thing: the account back to
 * "no stored choice", the next sign-in parked on the screen again. The pending row stays spent
 * either way — one completion, one materialization, whatever the outcome.
 */
interface RollbackState {
    pending: PendingSignIn;
    orgIds: string[];
    rewroteAllowlist: string[];
    priorAllowlists: Map<string, string[]>;
    priorSelection: string[];
    caller: Caller | undefined;
}

async function rollbackOnboarding(request: FastifyRequest, store: AuthStore, state: RollbackState): Promise<void> {
    const { pending, orgIds, rewroteAllowlist, priorAllowlists, priorSelection, caller } = state;
    for (const orgId of rewroteAllowlist) {
        await store
            .replaceTrackedRepos(orgId, priorAllowlists.get(orgId) ?? [])
            .catch((err: Error) => request.log.error({ err }, 'onboarding rollback failed'));
    }
    if (!caller) return;
    const restored = pending.installations.filter((install) => priorSelection.includes(install.id));
    if (restored.length > 0) {
        await store
            .signIn(pending.identity, restored[0]!.id, restored)
            .catch((err: Error) => request.log.error({ err }, 'onboarding rollback failed'));
        return;
    }
    for (const install of pending.installations) {
        if (!orgIds.includes(install.id)) continue;
        await store
            .removeMember(install.id, pending.identity.githubUserId)
            .catch((err: Error) => request.log.error({ err }, 'onboarding rollback failed'));
    }
}

/**
 * The org runtimes cache their repo list with the allowlist intersection folded in — without this
 * poke, a reselect would keep serving the pre-choice truth until the ten-minute TTL ran out.
 * Expire, don't drop: the stale list serves until the next read re-produces, so no poll sees an
 * empty dashboard. A refresh already in flight read the PRE-write allowlist; when it lands it
 * stores that stale list with a fresh timestamp, and the expire above cannot touch a result that
 * did not exist yet. The read is single-flight, so this joins whatever produce is running rather
 * than racing it — and never rejects; a failed produce serves the last good entry. The expire
 * AFTER it lands is what retires the stale capture: the old list still serves until the next read
 * re-produces, so the exposure is one produce, not a full TTL.
 */
async function refreshOrgRepoCaches(orgs: OrgRegistry | undefined, orgIds: string[]): Promise<void> {
    for (const orgId of orgIds) {
        const runtime = await orgs?.for(orgId);
        if (!runtime) continue;
        runtime.repos.invalidate();
        await runtime.repos.list();
        runtime.repos.invalidate();
    }
}

interface CompleteCtx {
    store: AuthStore;
    orgs: OrgRegistry | undefined;
    sessionDeps: SessionDeps;
}

interface MaterializeInput {
    resolved: { token: string; pending: PendingSignIn };
    orgIds: string[];
    reposByOrg: Map<string, string[]>;
}

/**
 * THE CLAIM and everything after it. Atomically spends the pending row before anything is
 * materialized, so only one of two completions racing the same cookie can get past it — the docs'
 * single-use is a property, not a description of the happy path. Every validation refusal before
 * this call left the row alive; from here the row is spent, and a failure rolls the materialization
 * back so the only path is, in truth, starting the flow again. Returns null once the reply has
 * already been sent (the claim lost the race, or materialization failed and was rolled back).
 */
async function materializeOnboarding(
    ctx: CompleteCtx,
    request: FastifyRequest,
    reply: FastifyReply,
    input: MaterializeInput
): Promise<Caller | null> {
    const { resolved, orgIds, reposByOrg } = input;
    const { pending } = resolved;
    let caller: Caller | undefined;
    // What this completion has rewritten so far — the rollback's map of what to undo.
    const rewroteAllowlist: string[] = [];
    // The prior state the rollback restores — read before anything is written, because the
    // rollback must put back what STOOD here, not a default.
    const priorAllowlists = new Map<string, string[]>();
    let priorSelection: string[] = [];
    try {
        for (const orgId of reposByOrg.keys()) {
            priorAllowlists.set(orgId, await ctx.store.trackedRepos(orgId));
        }
        priorSelection = await ctx.store.storedSelection(pending.identity.githubUserId);

        const claimed = await ctx.store.deletePendingSignIn(hashToken(resolved.token));
        if (!claimed) {
            reply
                .code(HTTP_UNAUTHORIZED)
                .send({ error: 'No pending sign-in — start again', code: ERROR_CODES.NO_PENDING });
            return null;
        }
        // The choice, in report order, and the session lands in the deep-linked org when it was
        // chosen — or the first of the selection, as the callback would.
        const selection = pending.installations.filter((install) => orgIds.includes(install.id));
        const selected =
            pending.orgPreference && orgIds.includes(pending.orgPreference) ? pending.orgPreference : selection[0]!.id;
        caller = await ctx.store.signIn(pending.identity, selected, selection);
        for (const [orgId, names] of reposByOrg) {
            await ctx.store.replaceTrackedRepos(orgId, names);
            rewroteAllowlist.push(orgId);
        }
        await startSession(ctx.sessionDeps, request, reply, caller);
        await refreshOrgRepoCaches(ctx.orgs, orgIds);
        return caller;
    } catch (e) {
        request.log.error({ err: e }, 'onboarding completion failed');
        await rollbackOnboarding(request, ctx.store, {
            pending,
            orgIds,
            rewroteAllowlist,
            priorAllowlists,
            priorSelection,
            caller,
        });
        reply
            .code(HTTP_SERVER_ERROR)
            .send({ error: 'Could not complete the sign-in', code: ERROR_CODES.COMPLETE_FAILED });
        return null;
    }
}

export interface OnboardingDeps {
    store: AuthStore;
    orgs: OrgRegistry | undefined;
    secret: string;
    cookieSecure: boolean;
    sessionDeps: SessionDeps;
    listInstallationRepos: ListInstallationRepos;
}

/** Registers the three onboarding routes on the app the caller already holds `AUTH_MODE=github` for. */
export function registerOnboardingRoutes(app: FastifyInstance, deps: OnboardingDeps): void {
    const { store, orgs, secret, cookieSecure, sessionDeps, listInstallationRepos } = deps;

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
        const resolved = await resolvePendingSignIn(store, secret, request);
        if (!resolved) {
            return reply
                .code(HTTP_UNAUTHORIZED)
                .send({ error: 'No pending sign-in — start again', code: ERROR_CODES.NO_PENDING });
        }
        const { pending } = resolved;
        const stored = await store.storedSelection(pending.identity.githubUserId);
        const remembered = stored.filter((id) => pending.installations.some((install) => install.id === id));
        return reply.code(HTTP_OK).send({
            identity: {
                login: pending.identity.login,
                displayName: pending.identity.displayName,
                avatarUrl: pending.identity.avatarUrl,
            },
            // `tracked` is the org's stored repo allowlist, or null when it tracks everything.
            // The screen seeds its checkboxes from it: a reselect must SHOW the narrowing it
            // is asking about, and confirming must be able to express widening back — an
            // all-checked org that had a narrowing posts an empty list, which clears it.
            // Reported RAW, never intersected here: the screen holds the live listing (it
            // fetches each org's repos to render the checkboxes anyway) and intersects where
            // it can act on it, so this read costs no App call at all — a first sign-in's
            // screen and a reselect alike.
            installations: await Promise.all(
                pending.installations.map(async (install): Promise<PendingInstallation> => {
                    const narrowed = await store.trackedRepos(install.id);
                    // A narrowing whose every entry GitHub stopped reporting is reported as
                    // stored — the honest stale selection, kept fail-closed: this store reads
                    // an empty allowlist as track-everything, so retiring the rows here would
                    // silently widen the org to every repo its installation can see. The
                    // screen intersects with the listing when seeding and before posting, so
                    // it can never submit a name the listing cannot render; an untouched
                    // fully-stale org posts nothing (the rows are retained) and touching the
                    // live checkboxes is the explicit revision.
                    return {
                        id: install.id,
                        account: install.name,
                        tracked: narrowed.length > 0 ? narrowed : null,
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
        const resolved = await resolvePendingSignIn(store, secret, request);
        if (!resolved) {
            return reply
                .code(HTTP_UNAUTHORIZED)
                .send({ error: 'No pending sign-in — start again', code: ERROR_CODES.NO_PENDING });
        }
        const { installationId } = request.params as { installationId: string };
        const reported = resolved.pending.installations.some((install) => install.id === installationId);
        if (!INSTALLATION_ID.test(installationId) || !reported) {
            return reply
                .code(HTTP_BAD_REQUEST)
                .send({ error: 'Unknown installation', code: ERROR_CODES.UNKNOWN_INSTALLATION });
        }
        if (!listInstallationRepos) return reply.code(HTTP_OK).send({ repos: [], source: 'none' });
        const repos = await listInstallationRepos(installationId).catch((e: Error) => {
            request.log.error({ err: e }, 'installation repo listing failed');
            return null;
        });
        if (!repos) return reply.code(HTTP_OK).send({ repos: [], source: 'none' });
        return reply.code(HTTP_OK).send({
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
    app.post('/api/auth/github/complete', { bodyLimit: COMPLETE_BODY_LIMIT }, async (request, reply) => {
        const resolved = await resolvePendingSignIn(store, secret, request);
        if (!resolved) {
            return reply
                .code(HTTP_UNAUTHORIZED)
                .send({ error: 'No pending sign-in — start again', code: ERROR_CODES.NO_PENDING });
        }
        const { pending } = resolved;

        const body = request.body as { orgs?: unknown; repos?: unknown } | undefined;
        const orgIds = parseSelectedOrgIds(body, pending);
        if (!orgIds)
            return reply.code(HTTP_BAD_REQUEST).send({ error: 'Bad org selection', code: ERROR_CODES.BAD_SELECTION });

        const reposByOrg = parseRequestedRepos(body, orgIds);
        if (!reposByOrg) {
            return reply.code(HTTP_BAD_REQUEST).send({ error: 'Bad repo selection', code: ERROR_CODES.BAD_SELECTION });
        }

        const visibility = await validateRepoVisibility(request, reposByOrg, listInstallationRepos);
        if (!visibility.ok) {
            return reply.code(HTTP_BAD_REQUEST).send({ error: visibility.message, code: visibility.code });
        }

        const caller = await materializeOnboarding({ store, orgs, sessionDeps }, request, reply, {
            resolved,
            orgIds,
            reposByOrg,
        });
        if (!caller) return reply;

        reply.clearCookie(PENDING_COOKIE, pendingCookieOptions(cookieSecure));
        return reply.code(HTTP_OK).send({ organization: caller.org, returnTo: pending.returnTo });
    });
}
