import { ERROR_CODES, isRangePreset, resolveRange } from '@factory-ai/core';
import type { DateRange, Organization, OrganizationMeta } from '@factory-ai/core';
import type { FastifyPluginAsync } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { AuthStore, Caller, OrgTokenIdentity } from '../auth/store.js';
import { LOCAL_ORG_ID, type AppConfig } from '../config.js';
import type { OrgRegistry } from '../orgs.js';
import type { StatsScope, StatsService } from '../stats-service.js';

interface StatsQuery {
    range?: string;
    from?: string;
    to?: string;
    org?: string;
    scope?: string;
}

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_UNAVAILABLE = 503;

/**
 * A bare `YYYY-MM-DD` is what `<input type="date">` submits. `to` is an exclusive bound, so a
 * day is widened to the start of the next one — otherwise "custom range: today to today" is an
 * empty interval and the dashboard reads as no activity.
 */
function parseBound(raw: string, edge: 'from' | 'to'): string | null {
    if (DAY_ONLY.test(raw)) {
        const day = new Date(`${raw}T00:00:00.000Z`);
        if (Number.isNaN(day.getTime())) return null;
        if (edge === 'to') day.setUTCDate(day.getUTCDate() + 1);
        return day.toISOString();
    }
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function parseRange(query: StatsQuery, now: Date): DateRange | { error: string } {
    const preset = query.range ?? 'all';
    if (!isRangePreset(preset)) return { error: `Unknown range '${preset}'` };
    if (preset !== 'custom') return resolveRange(preset, now);

    if (!query.from && !query.to) return { error: 'A custom range needs from, to, or both' };
    const from = query.from ? parseBound(query.from, 'from') : null;
    const to = query.to ? parseBound(query.to, 'to') : null;
    if (query.from && from === null) return { error: `Unparseable from '${query.from}'` };
    if (query.to && to === null) return { error: `Unparseable to '${query.to}'` };
    if (from !== null && to !== null && from >= to) return { error: 'from must precede to' };

    return { preset: 'custom', from, to };
}

/**
 * The org resolution still lives in ONE function, as docs/organizations.md promised it would —
 * the body changed with #99, the shape did not.
 *
 * It no longer answers "is this the configured org" but "may this caller read that org": the
 * caller's own org (session row, personal-token row, org-token row) is served without a check;
 * a requested org must EXIST (400 UNKNOWN_ORG — the error a typo gets) and be one the caller is a
 * member of (403 FORBIDDEN — the error a stranger gets). Membership is the materialized fact the
 * last sign-in reported, so the check is a read, never a GitHub call.
 *
 * `store` is absent only in the route tests that predate accounts: no auth hook, nobody to be a
 * member of anything, and any requested org other than the local one is unknown by definition.
 */
/**
 * The org this principal is bound to. A user principal carries its org (with its name) from the
 * row it authenticated through; an org token carries only the id.
 */
async function boundOrgOf(
    store: AuthStore | undefined,
    caller: Caller | null,
    orgToken: OrgTokenIdentity | null
): Promise<Organization> {
    if (caller) return caller.org;
    if (orgToken) return (await store?.findOrg(orgToken.orgId)) ?? { id: orgToken.orgId, name: orgToken.orgId };
    return { id: LOCAL_ORG_ID, name: LOCAL_ORG_ID };
}

async function resolveOrg(
    config: AppConfig,
    store: AuthStore | undefined,
    request: Parameters<typeof callerOf>[0],
    requested: string | undefined
): Promise<
    | { meta: OrganizationMeta; serviceOrg: Organization }
    | { error: string; code: typeof ERROR_CODES.UNKNOWN_ORG | typeof ERROR_CODES.FORBIDDEN }
> {
    const caller = callerOf(request);
    const orgToken = request.auth?.kind === 'org' ? request.auth.token : null;
    const bound = await boundOrgOf(store, caller, orgToken);

    // '' is not a request, consistent with how every other empty value is treated.
    if (!requested || requested === bound.id) {
        return {
            serviceOrg: bound,
            meta: {
                mode: config.auth.mode === 'none' ? 'config' : 'directory',
                current: bound,
                available: caller ? await store!.membershipsOf(caller.user.id) : [bound],
            },
        };
    }

    const org = (await store?.findOrg(requested)) ?? null;
    if (!org) {
        return { error: `Unknown organization '${requested}'`, code: ERROR_CODES.UNKNOWN_ORG };
    }
    // Known, but not this caller's: the org decides WHICH data set, and the membership join —
    // not the parameter — decides whose. "Trust the parameter" is how a cross-tenant read is
    // born. Read ONCE: this route is the dashboard's two-second poll, and ?org= is on it.
    const memberships = caller ? await store!.membershipsOf(caller.user.id) : [];
    if (!caller || !memberships.some((m) => m.id === requested)) {
        return { error: `Not a member of '${requested}'`, code: ERROR_CODES.FORBIDDEN };
    }
    return {
        serviceOrg: org,
        meta: {
            mode: 'directory',
            current: org,
            available: memberships,
        },
    };
}

/**
 * The scope the figures are computed under, resolved from the caller.
 *
 * `mine` without a person behind the request is a client error, never a silent fallback to org
 * figures under a personal heading — the same reasoning `resolveOrg` applies to unknown orgs.
 * AUTH_MODE=none is the always-case: the deployment holds no members at all, and the `__local__`
 * stand-in the auth hook resolves there is the deployment itself, not somebody whose usage
 * "mine" could mean. An organization token names no person either, so it is refused here the
 * same way — it authenticated, but there is nobody to be.
 */
function resolveScope(
    config: AppConfig,
    request: { auth: unknown },
    requested: string | undefined
): { value: StatsScope } | { error: string; code: string } {
    const raw = requested ?? 'org';
    if (raw === 'org') return { value: 'org' };
    if (raw !== 'mine') {
        return { error: `Unknown scope '${raw}'`, code: ERROR_CODES.BAD_SCOPE };
    }
    if (config.auth.mode !== 'none') {
        const caller = callerOf(request as Parameters<typeof callerOf>[0]);
        if (caller) return { value: { id: caller.user.id, login: caller.user.login } };
    }
    return {
        error: 'Caller scope needs a signed-in member; this deployment has none behind this request',
        code: ERROR_CODES.SCOPE_REQUIRES_USER,
    };
}

/**
 * What to answer when the cache has nothing yet. Telemetry-off is a configuration state, not a
 * cold start; a failed read reports itself; otherwise this is the ordinary first read and the
 * client is told to poll.
 */
function noPayloadResponse(
    config: AppConfig,
    service: Pick<StatsService, 'fetchState'>
): { status: number; body: Record<string, unknown> } {
    // Telemetry is the whole payload now, so a deployment that turned it off has nothing to serve;
    // that is a configuration state, not a cold start.
    if (config.telemetrySource === 'off') {
        return {
            status: HTTP_UNAVAILABLE,
            body: {
                error: 'Telemetry is disabled on this deployment (TELEMETRY_SOURCE=off)',
                code: ERROR_CODES.TELEMETRY_DISABLED,
                fetch: service.fetchState(),
            },
        };
    }

    const fetch = service.fetchState();
    if (fetch.state === 'error') {
        return {
            status: HTTP_UNAVAILABLE,
            body: {
                error: fetch.error?.message ?? 'Telemetry read failed',
                code: fetch.error?.code ?? 'UNKNOWN',
                fetch,
            },
        };
    }
    // Cold start: the first read is one database query, but it may be waiting on migrations, so
    // answer 202 and let the client poll.
    return { status: HTTP_ACCEPTED, body: { fetch } };
}

/**
 * The organization and the runtime a stats read serves under, or the response to send in its
 * place — grouped so the route handler decides on one thing at a time.
 */
interface StatsRoutesCtx {
    config: AppConfig;
    orgs: OrgRegistry;
    store: AuthStore | undefined;
}

async function resolveOrgContext(
    ctx: StatsRoutesCtx,
    request: Parameters<typeof callerOf>[0],
    requestedOrg: string | undefined
): Promise<
    | { ok: true; org: { meta: OrganizationMeta; serviceOrg: Organization }; service: StatsService }
    | { ok: false; status: number; body: Record<string, unknown> }
> {
    const { config, orgs, store } = ctx;
    // Ahead of parseRange: the organization selects WHICH data set is being ranged, so it is the
    // more fundamental of the two errors. Ahead of ensureFresh() too — a bad request is a bad
    // request whatever the cache is doing, which is why this can never be answered with a 202.
    //
    // Rejected rather than ignored: an ignored ?org= would echo `meta.organization.current` as the
    // caller's own org, rendering one organization's figures under a heading the caller did not
    // ask for. Unknown is 400; known-but-not-yours is 403 — the caller authenticated, the answer
    // just belongs to somebody else.
    const org = await resolveOrg(config, store, request, requestedOrg);
    if ('error' in org) {
        const status = org.code === ERROR_CODES.FORBIDDEN ? HTTP_FORBIDDEN : HTTP_BAD_REQUEST;
        return { ok: false, status, body: { error: org.error, code: org.code } };
    }

    // The runtime for the resolved org: its repo source, telemetry and stats cache are all the
    // org's own. Null here is not "unknown" — resolveOrg just proved the row — but the runtime
    // failed to build, which is a 503 like every other unavailable backing service, never a
    // client error.
    const rt = await orgs.for(org.serviceOrg.id);
    if (!rt) {
        return {
            ok: false,
            status: HTTP_UNAVAILABLE,
            body: {
                error: `The runtime for '${org.serviceOrg.id}' could not be built; retry`,
                code: ERROR_CODES.ORG_UNAVAILABLE,
            },
        };
    }
    return { ok: true, org, service: rt.service };
}

export const statsRoutes =
    (
        config: AppConfig,
        orgs: OrgRegistry,
        store: AuthStore | undefined,
        now: () => number = Date.now
    ): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/stats', async (request, reply) => {
            const query = request.query as StatsQuery;

            const context = await resolveOrgContext({ config, orgs, store }, request, query.org);
            if (!context.ok) return reply.code(context.status).send(context.body);
            const { org, service } = context;

            // Beside the organization: the org decides WHICH data set, the scope decides WHOSE
            // figures within it, and both must be settled before any range is parsed or the
            // cache is touched.
            const callerScope = resolveScope(config, request, query.scope);
            if ('error' in callerScope) {
                return reply.code(HTTP_BAD_REQUEST).send({ error: callerScope.error, code: callerScope.code });
            }
            const range = parseRange(query, new Date(now()));
            if ('error' in range) {
                return reply.code(HTTP_BAD_REQUEST).send({ error: range.error, code: ERROR_CODES.BAD_RANGE });
            }

            service.ensureFresh();
            // The organization meta rides into `current()` so the payload names the org the
            // figures were computed for — and what else this caller could have asked for.
            const payload = service.current(range, callerScope.value, org.meta);

            // A stale cache is still served with 200. A failed read must keep the last
            // good render on screen and explain itself, not blank the dashboard.
            if (payload) return reply.code(HTTP_OK).send(payload);

            const fallback = noPayloadResponse(config, service);
            return reply.code(fallback.status).send(fallback.body);
        });
    };
