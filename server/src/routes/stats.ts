import { isRangePreset, resolveRange } from '@factory-ai/core';
import type { DateRange, Organization } from '@factory-ai/core';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { callerOf } from '../auth/plugin.js';
import type { StatsScope, StatsService } from '../stats-service.js';

interface StatsQuery {
    range?: string;
    from?: string;
    to?: string;
    org?: string;
    scope?: string;
}

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

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
 * One function, not an `OrgProvider`.
 *
 * The precedent for an early interface here — `TokenProvider` — ships with one implementation
 * in tree, and has a signature that was load-bearing on day
 * one. A directory's org list is per *user*, so its real signature is `resolve(caller, orgId)` in a
 * codebase that has no caller, no session and no auth: the interface would have to change shape the
 * day its second implementation arrived, having bought nothing but a provider threaded through
 * `buildApp` and the service deps. Mode 2 replaces this body and its argument list, in one place.
 */
function resolveOrg(config: AppConfig, requested: string | undefined): Organization | { error: string } {
    const current = { id: config.orgId, name: config.orgName };
    // '' is not a request, consistent with how every other empty value is treated.
    if (!requested || requested === current.id) return current;
    return {
        error: `Unknown organization '${requested}'; this deployment serves '${current.id}' only`,
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
        return { error: `Unknown scope '${raw}'`, code: 'BAD_SCOPE' };
    }
    if (config.auth.mode !== 'none') {
        const caller = callerOf(request as Parameters<typeof callerOf>[0]);
        if (caller) return { value: { id: caller.user.id, login: caller.user.login } };
    }
    return {
        error: 'Caller scope needs a signed-in member; this deployment has none behind this request',
        code: 'SCOPE_REQUIRES_USER',
    };
}

export const statsRoutes =
    (config: AppConfig, service: StatsService, now: () => number = Date.now): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/stats', async (request, reply) => {
            const query = request.query as StatsQuery;

            // Ahead of parseRange: the organization selects WHICH data set is being ranged, so it
            // is the more fundamental of the two errors, and in mode 2 it decides which store the
            // range applies to at all. Ahead of ensureFresh() too — a bad request is a bad request
            // whatever the cache is doing, which is why this can never be answered with a 202.
            //
            // Rejected rather than ignored, and the BAD_RANGE precedent below understates the
            // reason. An ignored range at least echoes back in `meta.range` where a reader could
            // notice; an ignored ?org= would echo `meta.organization.current` as the configured
            // org, rendering one organization's figures under a heading the caller did not ask
            // for. Once the store is partitioned, "trust the parameter" must never become a habit:
            // the day auth lands, that habit is a cross-tenant read.
            const org = resolveOrg(config, query.org);
            if ('error' in org) {
                return reply.code(400).send({ error: org.error, code: 'UNKNOWN_ORG' });
            }

            // Beside the organization: the org decides WHICH data set, the scope decides WHOSE
            // figures within it, and both must be settled before any range is parsed or the
            // cache is touched — a bad scope is a bad request whatever the cache is doing.
            const scope = resolveScope(config, request, query.scope);
            if ('error' in scope) {
                return reply.code(400).send({ error: scope.error, code: scope.code });
            }
            const range = parseRange(query, new Date(now()));
            if ('error' in range) {
                return reply.code(400).send({ error: range.error, code: 'BAD_RANGE' });
            }

            // `org` goes no further on purpose. The service already knows the only organization
            // there is, and a parameter it ignores is worse than no parameter.
            service.ensureFresh();
            const payload = service.current(range, scope.value);

            // A stale cache is still served with 200. A failed read must keep the last
            // good render on screen and explain itself, not blank the dashboard.
            if (payload) return reply.code(200).send(payload);

            // Telemetry is the whole payload now, so a deployment that turned it off has
            // nothing to serve; that is a configuration state, not a cold start.
            if (config.telemetrySource === 'off') {
                return reply.code(503).send({
                    error: 'Telemetry is disabled on this deployment (TELEMETRY_SOURCE=off)',
                    code: 'TELEMETRY_DISABLED',
                    fetch: service.fetchState(),
                });
            }

            const fetch = service.fetchState();
            if (fetch.state === 'error') {
                return reply.code(503).send({
                    error: fetch.error?.message ?? 'Telemetry read failed',
                    code: fetch.error?.code ?? 'UNKNOWN',
                    fetch,
                });
            }
            // Cold start: the first read is one database query, but it may be waiting on
            // migrations, so answer 202 and let the client poll.
            return reply.code(202).send({ fetch });
        });

        app.post('/api/refresh', async (_request, reply) => {
            service.refresh();
            return reply.code(202).send({ fetch: service.fetchState() });
        });
    };
