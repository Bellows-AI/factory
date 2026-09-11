import { timingSafeEqual } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { SESSION_COOKIE, hashToken, unsign } from './session.js';
import type { AuthStore, Caller, WorkerIdentity } from './store.js';

/**
 * Who is making a request.
 *
 * A union, because the job board has two callers with nothing in common and the credentials that
 * identify them are deliberately disjoint: a session cookie accepted on `/claim` would let any
 * member steal another worker's lease, and a worker token accepted on `POST /api/jobs` would produce
 * a job with no author on the one route docs/security.md describes as remote code execution. No
 * route accepts both: an earlier exception for the thread read let a worker token read the audit
 * and session data of jobs it never held a lease on, so it is gone — the driver's one need from
 * that read rides the lease-guarded complete response instead.
 */
export type Principal =
    | { kind: 'user'; caller: Caller }
    | { kind: 'worker'; worker: WorkerIdentity };

declare module 'fastify' {
    interface FastifyRequest {
        auth: Principal | null;
    }
}

/** Routes the driver reaches, and no browser ever does. */
const WORKER_ROUTES: readonly RegExp[] = [
    /^\/api\/jobs\/claim$/,
    // `resume` is deliberately absent: nobody holds a parked job, which is exactly what makes it
    // resumable by a person rather than only by the worker that parked it.
    /^\/api\/jobs\/[^/]+\/(heartbeat|session|suspend|complete|output|gates|gates-reread)$/,
];

/** Machine-to-machine telemetry, from the collector and from developer laptops. */
const INGEST_ROUTES: readonly RegExp[] = [/^\/api\/otlp\//, /^\/api\/sessions\/branch$/];

/**
 * Routes that answer without a credential, and why each one has to.
 *
 * - `/api/health` must answer while the migrations are still retrying, and the compose healthcheck
 *   carries no credential. Authenticating it would restart the container that was about to succeed.
 * - `/api/auth/*` is how a caller obtains a credential in the first place. `/api/auth/me` 401s on
 *   its own — being the thing that *tells* the SPA it is unauthenticated is its whole purpose.
 *
 * Everything outside `/api/` — the SPA's HTML, its bundle, the not-found handler that serves
 * index.html — is open too, and that is not an omission. **If index.html 401s there is nothing left
 * to render a sign-in button in.** The wall is on the API, never on the document.
 */
const OPEN_ROUTES: readonly RegExp[] = [/^\/api\/health$/, /^\/api\/auth\//];

type Requirement = 'open' | 'user' | 'worker' | 'ingest';

/** Exported so the enforcement test can drive the table rather than re-deriving it. */
export function requirementFor(path: string): Requirement {
    if (!path.startsWith('/api/')) return 'open';
    if (OPEN_ROUTES.some((route) => route.test(path))) return 'open';
    if (WORKER_ROUTES.some((route) => route.test(path))) return 'worker';
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

const bearer = (request: FastifyRequest): string | null => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice(7).trim() || null;
};

export interface AuthPluginDeps {
    config: AppConfig;
    store: AuthStore;
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
            local ??= store.localCaller(config.orgId);
            return local;
        }
        const signed = request.cookies[SESSION_COOKIE];
        // Verified before the database is touched, so a flood of forged cookies costs a hash rather
        // than a query each.
        const token = unsign(signed, auth.sessionSecret);
        return token ? store.findSession(hashToken(token), config.orgId) : null;
    };
}

/**
 * Registers cookie support and the one `onRequest` hook that decides whether a request continues.
 *
 * Under `AUTH_MODE=none` this still runs, and still resolves a caller — the stand-in account seeded
 * at boot. That is deliberate: a mode that *skips* the auth path is a mode whose auth path nothing
 * exercises, and `job.created_by` would be null in exactly the environment where the feature is
 * developed. One code path downstream, in both modes.
 */
export async function registerAuth(app: FastifyInstance, { config, store }: AuthPluginDeps): Promise<void> {
    const { auth } = config;
    await app.register(fastifyCookie);

    const resolveUser = createUserResolver({ config, store });

    app.decorateRequest('auth', null);

    app.addHook('onRequest', async (request, reply) => {
        const requirement = requirementFor(pathOf(request.url));
        if (requirement === 'open') return;

        if (requirement === 'ingest') {
            // Optional, because the two callers are a collector on the compose network and a plugin
            // installed on developer laptops — requiring it would break both with no migration path.
            // Unset means these routes behave exactly as they did before accounts existed.
            //
            // A header, never a query parameter: a query parameter lands in every access log.
            if (!auth.ingestToken) return;
            const provided = request.headers['x-factory-ingest-token'];
            if (typeof provided === 'string' && secretsMatch(provided, auth.ingestToken)) return;
            return reply.code(401).send({ error: 'Invalid ingest token', code: 'UNAUTHENTICATED' });
        }

        if (requirement === 'worker') {
            // Open in `none` mode, like every other route in it. Requiring a worker token here
            // would buy nothing — anyone who can reach this port can already queue a command that
            // an agent runs — while breaking `npm run driver` against a local board, which is the
            // ordinary way this is developed. The two credentials are disjoint when there ARE
            // credentials; `none` means there are none.
            if (auth.mode === 'none') return;

            const token = bearer(request);
            const worker = token ? await store.findWorkerToken(hashToken(token)) : null;
            // Bound to the organization the token was minted for. In a deployment that serves one
            // organization this can only ever be config.orgId, but the check is here rather than
            // assumed so that a token from another database cannot drive this board.
            if (!worker || worker.orgId !== config.orgId) {
                return reply.code(401).send({ error: 'Invalid worker token', code: 'UNAUTHENTICATED' });
            }
            request.auth = { kind: 'worker', worker };
            return;
        }

        const caller = await resolveUser(request);
        if (!caller) {
            // Under AUTH_MODE=none this means the stand-in row migrate() seeds is not there yet,
            // which is a database that has not finished starting rather than a bad request — but it
            // is reported the same way, because a route that answers 503 only in one auth mode is a
            // difference between modes that nothing else in the system has.
            return reply.code(401).send({ error: 'Sign in required', code: 'UNAUTHENTICATED' });
        }
        request.auth = { kind: 'user', caller };
    });
}

/** The signed-in user behind a request, or null when a worker token got it here. */
export const callerOf = (request: FastifyRequest): Caller | null =>
    request.auth?.kind === 'user' ? request.auth.caller : null;
