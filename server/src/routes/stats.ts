import { isRangePreset, resolveRange } from '@factory-ai/core';
import type { DateRange, Organization } from '@factory-ai/core';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import type { StatsService } from '../stats-service.js';

interface StatsQuery {
    range?: string;
    from?: string;
    to?: string;
    org?: string;
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
 * The precedent for an early interface here — `TokenProvider` — ships with two implementations
 * already in tree, and has a signature that was load-bearing on day
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

            const range = parseRange(query, new Date(now()));
            if ('error' in range) {
                return reply.code(400).send({ error: range.error, code: 'BAD_RANGE' });
            }

            // `org` goes no further on purpose. The service already knows the only organization
            // there is, and a parameter it ignores is worse than no parameter.
            service.ensureFresh();
            const payload = service.current(range);

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
