import { ERROR_CODES } from '@factory-ai/core';
import { timingSafeEqual } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LOCAL_ORG_ID, UUID, type AppConfig, type AuthConfig } from '../config.js';
import { ORG_TOKEN_PREFIX, isAccessToken } from './access-token.js';
import { SESSION_COOKIE, hashToken, unsign } from './session.js';
import type { AuthStore, Caller, OrgTokenIdentity } from './store.js';

/**
 * Who is making a request.
 *
 * A union, because the job board has callers with nothing in common and the credentials that
 * identify them are deliberately disjoint: a session cookie accepted on `/claim` would let any
 * member steal another worker's lease, and a worker secret accepted on `POST /api/jobs` would
 * produce a job with no author on the one route docs/security.md describes as remote code
 * execution. No route accepts both: an earlier exception for the thread read let a worker read the
 * audit and session data of jobs it never held a lease on, so it is gone — the driver's one need
 * from that read rides the lease-guarded complete response instead.
 *
 * The third kind is an organization access token (`oat_`): it names the org but no person, so it
 * is not a Caller — `callerOf` keeps returning null for it and every person-gated route refuses it
 * without knowing access tokens exist.
 *
 * The fourth kind is an attempt: the job id and lease token pair a runner's branch reporter
 * presents. It names no person and holds no token row — the org is looked up from the live
 * attempt itself — which is what keeps a branch write scoped to the org whose job produced it,
 * never to whatever repo the report happens to carry.
 */
export type Principal =
    | { kind: 'user'; caller: Caller }
    | { kind: 'worker'; orgId: string | null }
    | { kind: 'org'; token: OrgTokenIdentity }
    | { kind: 'job'; orgId: string };

declare module 'fastify' {
    interface FastifyRequest {
        auth: Principal | null;
    }
}

/** Routes the driver reaches, and no browser ever does. */
const WORKER_ROUTES: readonly RegExp[] = [
    /^\/api\/jobs\/claim$/,
    /^\/api\/reclaims\/claim$/,
    /^\/api\/reclaims\/[^/]+\/ack$/,
    // `stop`, `follow-up`, `done` and `remove` are person actions: the driver is told to stop
    // through the heartbeat it already holds, and the board secret moving or deleting the audit
    // rows of jobs it never held would be the thread-read hole again.
    /^\/api\/jobs\/[^/]+\/(heartbeat|session|suspend|complete|output|gates|gates-reread|publish-token)$/,
];

/** Machine-to-machine telemetry, from the collector. The branch route is NOT here — see BRANCH. */
const INGEST_ROUTES: readonly RegExp[] = [/^\/api\/otlp\//];

/** The one route a runner's own credential writes: the branch reporter's attribution samples. */
const BRANCH_ROUTES: readonly RegExp[] = [/^\/api\/sessions\/branch$/];

/**
 * What an organization token may reach, and nothing else — an allowlist, because a refusal list
 * would silently admit every route added after it. Each entry names no person: board and repo
 * reads, and the cache poke. Everything a route needs a `callerOf` for — queueing a job above all,
 * whose `created_by` must stay a person — is outside it, and gets a 403 rather than a 401: the
 * token did authenticate, the route just needs a human behind it.
 */
const ORG_TOKEN_ROUTES: readonly (readonly [string, RegExp])[] = [
    ['GET', /^\/api\/stats$/],
    ['POST', /^\/api\/refresh$/],
    ['GET', /^\/api\/repos$/],
    ['GET', /^\/api\/jobs$/],
    ['GET', /^\/api\/jobs\/[^/]+$/],
    ['GET', /^\/api\/jobs\/[^/]+\/thread$/],
];

/**
 * Fastify auto-creates a HEAD route for every GET, so a `curl -I` probe must ride the GET entry —
 * refusing it would 403 a request the equivalent GET answers.
 */
const orgTokenAllowed = (method: string, path: string): boolean =>
    ORG_TOKEN_ROUTES.some(([routeMethod, route]) => {
        const matches = routeMethod === 'GET' && method === 'HEAD' ? true : method === routeMethod;
        return matches && route.test(path);
    });

/**
 * Routes that answer without a credential, and why each one has to.
 *
 * - `/api/health` must answer while the migrations are still retrying, and the compose healthcheck
 *   carries no credential. Authenticating it would restart the container that was about to succeed.
 * - `/api/auth/*` is how a caller obtains a credential in the first place. `/api/auth/me` answers
 *   `200 {authenticated: false}` for nobody — being the thing that *tells* the SPA it is
 *   unauthenticated is its whole purpose, and a 401 there would be logged as a console error by
 *   the browser of everybody who has not signed in yet.
 *
 * Everything outside `/api/` — the SPA's HTML, its bundle, the not-found handler that serves
 * index.html — is open too, and that is not an omission. **If index.html 401s there is nothing left
 * to render a sign-in button in.** The wall is on the API, never on the document.
 */
const OPEN_ROUTES: readonly RegExp[] = [
    /^\/api\/health$/,
    /^\/api\/auth\//,
    // The installation webhook answers to the HMAC signature over its body — a credential the
    // route verifies itself — so the session hook must not demand a cookie of it.
    /^\/api\/github\/webhook$/,
];

type Requirement = 'open' | 'user' | 'worker' | 'branch' | 'ingest';

/** Exported so the enforcement test can drive the table rather than re-deriving it. */
export function requirementFor(path: string): Requirement {
    if (!path.startsWith('/api/')) return 'open';
    if (OPEN_ROUTES.some((route) => route.test(path))) return 'open';
    if (WORKER_ROUTES.some((route) => route.test(path))) return 'worker';
    if (BRANCH_ROUTES.some((route) => route.test(path))) return 'branch';
    if (INGEST_ROUTES.some((route) => route.test(path))) return 'ingest';
    return 'user';
}

const pathOf = (url: string): string => {
    const cut = url.indexOf('?');
    return cut === -1 ? url : url.slice(0, cut);
};

/** Constant-time equality for two secrets that arrived as strings. */
function secretsMatch(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

const BEARER_PREFIX = 'Bearer ';

const bearer = (request: FastifyRequest): string | null => {
    const header = request.headers.authorization;
    if (!header?.startsWith(BEARER_PREFIX)) return null;
    return header.slice(BEARER_PREFIX.length).trim() || null;
};

export interface AuthPluginDeps {
    config: AppConfig;
    store: AuthStore;
    /**
     * The org-less lease resolver for the branch route's runner credential: the job id and lease
     * token pair a reporter presents resolves to the org whose attempt it is, or null. Built in
     * main.ts from the job store's SQL (`createOrgOfLease`), because no single org's store can
     * answer it — the pair's whole point is to say WHICH org is speaking. Absent in tests that
     * predate it, where no pair resolves and the route falls through to the bearer.
     */
    orgOfLease?: ((jobId: string, leaseToken: string) => Promise<string | null>) | undefined;
    /**
     * The org resolvers for the worker routes, built in main.ts from the same org-less SQL as
     * `orgOfLease`. The shared secret authenticates the DRIVER, not an org — so the org a
     * job-scoped worker call operates on comes from the row it names (`createOrgOfJob`,
     * `createOrgOfReclaim`), the same direction the branch route resolves in. Absent in the route
     * tests, where no id resolves and the principal carries null.
     */
    orgOfJob?: ((jobId: string) => Promise<string | null>) | undefined;
    orgOfReclaim?: ((reclaimId: string) => Promise<string | null>) | undefined;
}

/**
 * Turns a request into the user behind it, or null.
 *
 * Shared by the enforcement hook and by `GET /api/auth/me`, which cannot use the hook's answer: that
 * route is exempt from enforcement precisely so it can be the thing that reports "nobody", so it
 * arrives with `request.auth` still null and has to resolve the caller itself.
 */
export function createUserResolver({ config, store }: AuthPluginDeps) {
    const { auth } = config;

    // Resolved once per process rather than per request: it is a fixed row, and re-reading it on
    // every request would be a query to learn something that cannot change.
    let local: Promise<Caller | null> | null = null;

    return async (request: FastifyRequest): Promise<Caller | null> => {
        if (auth.mode === 'none') {
            local ??= store.localCaller(LOCAL_ORG_ID);
            return local;
        }
        const signed = request.cookies[SESSION_COOKIE];
        // Verified before the database is touched, so a flood of forged cookies costs a hash rather
        // than a query each.
        const token = unsign(signed, auth.sessionSecret);
        // The org comes back FROM the session row (#99) — a property of the caller, re-checked
        // through the membership join inside.
        return token ? store.findSession(hashToken(token)) : null;
    };
}

/**
 * The access token in the Authorization header — the credential for callers that cannot hold a
 * cookie, and the laptop plugin's credential on the branch route. Shared by the person routes'
 * fall-through and the branch arm, because both mean the same two things: a personal token acts as
 * its member, and an `oat_` is a read-only allowlist credential that a write route refuses with
 * 403 (it did authenticate — the route just needs a human or a lease behind it).
 *
 * Answers true when the request is settled — `request.auth` set, or a refusal already sent — and
 * false when there was no bearer to look at, so the caller can fall through. A PRESENT bearer that
 * resolves is the credential for the request: a failed or foreign one is a 401, never a fall-through
 * to whatever stands behind it.
 */
async function resolveBearer(request: FastifyRequest, reply: FastifyReply, store: AuthStore): Promise<boolean> {
    const accessToken = bearer(request);
    if (!accessToken) return false;
    if (!isAccessToken(accessToken)) {
        await reply.code(HTTP_UNAUTHORIZED).send({ error: 'Invalid access token', code: ERROR_CODES.UNAUTHENTICATED });
        return true;
    }
    const tokenHash = hashToken(accessToken);
    if (accessToken.startsWith(ORG_TOKEN_PREFIX)) {
        // The org comes from the token row: an oat_ is minted INTO an organization and
        // reads only that one, whatever else this database serves.
        const orgToken = await store.findOrgToken(tokenHash);
        if (!orgToken) {
            await reply
                .code(HTTP_UNAUTHORIZED)
                .send({ error: 'Invalid access token', code: ERROR_CODES.UNAUTHENTICATED });
            return true;
        }
        const path = pathOf(request.url);
        if (!orgTokenAllowed(request.method, path)) {
            await reply
                .code(HTTP_FORBIDDEN)
                .send({ error: 'Organization tokens can only read', code: ERROR_CODES.FORBIDDEN });
            return true;
        }
        request.auth = { kind: 'org', token: orgToken };
        return true;
    }
    const tokenCaller = await store.findPersonalToken(tokenHash);
    if (!tokenCaller) {
        await reply.code(HTTP_UNAUTHORIZED).send({ error: 'Invalid access token', code: ERROR_CODES.UNAUTHENTICATED });
        return true;
    }
    request.auth = { kind: 'user', caller: tokenCaller };
    return true;
}

async function enforceIngest(auth: AuthConfig, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Optional, because the two callers are a collector on the compose network and a plugin
    // installed on developer laptops — requiring it would break both with no migration path.
    // Unset means these routes behave exactly as they did before accounts existed.
    //
    // A header, never a query parameter: a query parameter lands in every access log.
    if (!auth.ingestToken) return;
    const provided = request.headers['x-factory-ingest-token'];
    if (typeof provided === 'string' && secretsMatch(provided, auth.ingestToken)) return;
    await reply.code(HTTP_UNAUTHORIZED).send({ error: 'Invalid ingest token', code: ERROR_CODES.UNAUTHENTICATED });
}

interface BranchAuthDeps {
    auth: AuthConfig;
    store: AuthStore;
    leaseOrgOf: (jobId: string, leaseToken: string) => Promise<string | null>;
}

async function enforceBranch(deps: BranchAuthDeps, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { auth, store, leaseOrgOf } = deps;
    // Open in `none` mode, exactly the worker routes' stance: the stand-in local org is the only
    // one there is, and request.auth stays null for it.
    if (auth.mode === 'none') return;

    // The runner's credential: the attempt it runs for. The deployment-wide ingest token
    // deliberately does NOT authorize this write — a shared secret cannot bind a report to an
    // organization, which is the whole finding. A pair that is PRESENT but does not resolve is a
    // 401 with no fall-through, the same rule a failed bearer gets: a credential that failed must
    // not ride a weaker one behind it.
    const jobId = request.headers['x-factory-job-id'];
    const leaseToken = request.headers['x-factory-job-lease-token'];
    if (typeof jobId === 'string' && jobId && typeof leaseToken === 'string' && leaseToken) {
        const orgId = await leaseOrgOf(jobId, leaseToken);
        if (!orgId) {
            await reply
                .code(HTTP_UNAUTHORIZED)
                .send({ error: 'Unknown job or lease', code: ERROR_CODES.UNAUTHENTICATED });
            return;
        }
        request.auth = { kind: 'job', orgId };
        return;
    }

    // The laptop plugin's credential: the user's personal access token, through the same
    // resolution the person routes use. No pair and no bearer → 401.
    if (await resolveBearer(request, reply, store)) return;
    await reply
        .code(HTTP_UNAUTHORIZED)
        .send({ error: 'Branch ingest needs a credential', code: ERROR_CODES.UNAUTHENTICATED });
}

interface WorkerAuthDeps {
    auth: AuthConfig;
    jobOrgOf: (jobId: string) => Promise<string | null>;
    reclaimOrgOf: (reclaimId: string) => Promise<string | null>;
}

async function enforceWorker(deps: WorkerAuthDeps, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { auth, jobOrgOf, reclaimOrgOf } = deps;
    // Open in `none` mode, like every other route in it. Requiring a secret here would buy
    // nothing — anyone who can reach this port can already queue a command that an agent runs —
    // while breaking `npm run driver` against a local board, which is the ordinary way this is
    // developed. The two credentials are disjoint when there ARE credentials; `none` means there
    // are none.
    if (auth.mode === 'none') return;

    // One shared secret, the same value in the board's and the driver's environment
    // (JOB_BOARD_TOKEN on both sides). Constant-time, and checked before any database round trip —
    // a wrong guess costs a compare, not a query. There is no token row and no org binding: the
    // secret is the deployment's driver credential, so the org a call operates on comes from the
    // row it names.
    const token = bearer(request);
    if (!token || !secretsMatch(token, auth.jobBoardToken)) {
        await reply.code(HTTP_UNAUTHORIZED).send({ error: 'Invalid worker token', code: ERROR_CODES.UNAUTHENTICATED });
        return;
    }

    // The two claim routes name no row — they ASK for work — so their principal carries null and
    // the route offers every org's queue. Every other worker route carries the job (or reclaim) id
    // in its URL, and the org comes from that row; an id that resolves to nothing is the route's
    // own 404, answered here to keep the store lookup from inventing a runtime for a row that does
    // not exist. The segment is captured before any shape check, so a MALFORMED id is refused on
    // the same terms instead of slipping through with a null org — which the route's storeOf()
    // would turn into a 503 before its own id validation ran — and so a resolver is never handed a
    // string postgres would refuse to cast.
    const path = pathOf(request.url);
    const rowId = path.match(/^\/api\/jobs\/([^/]+)\//)?.[1] ?? path.match(/^\/api\/reclaims\/([^/]+)\//)?.[1];
    let orgId: string | null = null;
    if (rowId && UUID.test(rowId)) {
        orgId = path.startsWith('/api/reclaims/') ? await reclaimOrgOf(rowId) : await jobOrgOf(rowId);
    }
    if (rowId && !orgId) {
        await reply.code(HTTP_NOT_FOUND).send({ error: 'No such job', code: ERROR_CODES.NOT_FOUND });
        return;
    }
    request.auth = { kind: 'worker', orgId };
}

interface UserAuthDeps {
    auth: AuthConfig;
    store: AuthStore;
    resolveUser: (request: FastifyRequest) => Promise<Caller | null>;
}

async function enforceUser(deps: UserAuthDeps, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { auth, store, resolveUser } = deps;
    // The bearer is THE credential when present: a CLI never sends a cookie and a browser never
    // sends a bearer, so both at once means something between them is rewriting, and the cookie
    // behind a failed or foreign bearer must not be consulted — that would let a rewritten header
    // ride somebody's session in.
    if (auth.mode !== 'none') {
        if (await resolveBearer(request, reply, store)) return;
    }

    const caller = await resolveUser(request);
    if (!caller) {
        // Under AUTH_MODE=none this means the stand-in row migrate() seeds is not there yet, which
        // is a database that has not finished starting rather than a bad request — but it is
        // reported the same way, because a route that answers 503 only in one auth mode is a
        // difference between modes that nothing else in the system has.
        await reply.code(HTTP_UNAUTHORIZED).send({ error: 'Sign in required', code: ERROR_CODES.UNAUTHENTICATED });
        return;
    }
    request.auth = { kind: 'user', caller };
}

/**
 * Registers cookie support and the one `onRequest` hook that decides whether a request continues.
 *
 * Under `AUTH_MODE=none` this still runs, and still resolves a caller — the stand-in account seeded
 * at boot. That is deliberate: a mode that *skips* the auth path is a mode whose auth path nothing
 * exercises, and `job.created_by` would be null in exactly the environment where the feature is
 * developed. One code path downstream, in both modes.
 */
export async function registerAuth(
    app: FastifyInstance,
    { config, store, orgOfLease, orgOfJob, orgOfReclaim }: AuthPluginDeps
): Promise<void> {
    const { auth } = config;
    await app.register(fastifyCookie);

    const resolveUser = createUserResolver({ config, store });
    const leaseOrgOf = orgOfLease ?? (async () => null);
    const jobOrgOf = orgOfJob ?? (async () => null);
    const reclaimOrgOf = orgOfReclaim ?? (async () => null);

    app.decorateRequest('auth', null);

    app.addHook('onRequest', async (request, reply) => {
        const requirement = requirementFor(pathOf(request.url));
        if (requirement === 'open') return;
        if (requirement === 'ingest') return enforceIngest(auth, request, reply);
        if (requirement === 'branch') return enforceBranch({ auth, store, leaseOrgOf }, request, reply);
        if (requirement === 'worker') return enforceWorker({ auth, jobOrgOf, reclaimOrgOf }, request, reply);
        return enforceUser({ auth, store, resolveUser }, request, reply);
    });
}

/** The signed-in user behind a request, or null when the board secret got it here. */
export const callerOf = (request: FastifyRequest): Caller | null =>
    request.auth?.kind === 'user' ? request.auth.caller : null;

/**
 * The organization a request is scoped to — the org each kind of principal carries (#99).
 *
 * `LOCAL_ORG_ID` answers for `request.auth === null`, which is only reachable when no auth hook is
 * registered at all: the route-test mode, where the app is built without a store and every route
 * would otherwise have nowhere to point. It is the AUTH_MODE=none semantic — one local org —
 * expressed for the tests that predate accounts.
 */
export const orgOf = (request: FastifyRequest): string => {
    const auth = request.auth;
    if (!auth) return LOCAL_ORG_ID;
    if (auth.kind === 'user') return auth.caller.org.id;
    if (auth.kind === 'worker') {
        // Null only on the two claim routes, which never consult orgOf: they offer every org's
        // queue in the route layer instead. Every other worker route arrives with the org the
        // auth hook resolved from the row its URL names.
        return auth.orgId!;
    }
    if (auth.kind === 'job') return auth.orgId;
    return auth.token.orgId;
};
