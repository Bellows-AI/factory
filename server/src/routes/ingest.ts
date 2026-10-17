import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { JOB_ID_HEADER, LEASE_TOKEN_HEADER, orgOf } from '../auth/plugin.js';
import { UUID } from '../config.js';
import type { OrgRegistry } from '../orgs.js';
import { flattenMetrics } from '../telemetry/otlp.js';
import type { SessionBranchReport, TelemetryStore } from '../telemetry/store.js';
import { storeFor } from './job-context.js';
import { SESSION_ID } from './job-limits.js';
import { CLAUDE_CODE, CONTENT_TYPE_HEADER, OPENCODE } from '@factory-ai/core';

/**
 * A misconfigured exporter can POST into the same process that serves the SPA, every few
 * seconds, forever. 1 MB is far above a real Claude Code export.
 */
const BODY_LIMIT = 1_000_000;
/** No payload past a branch report needs more than a control route's headroom. */
const CONTROL_BODY_LIMIT = 4096;

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_UNAVAILABLE = 503;

const isJson = (type: string | undefined) => typeof type === 'string' && /^application\/json\b/.test(type);

function branchReport(body: unknown): SessionBranchReport | null {
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object') return null;
    const { sessionId, repo, branch, headSha, at, agent } = b as Record<string, unknown>;
    if (typeof sessionId !== 'string' || !sessionId) return null;
    if (typeof repo !== 'string' || !repo) return null;
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
    // A detached HEAD legitimately has no branch, but the literal 'HEAD' is not a branch name
    // and would join to nothing while looking like one.
    if (branch !== null && (typeof branch !== 'string' || !branch || branch === 'HEAD')) return null;
    return {
        agent: typeof agent === 'string' && agent ? agent : CLAUDE_CODE,
        sessionId,
        repo,
        branch: branch as string | null,
        headSha: typeof headSha === 'string' && headSha ? headSha : null,
        at,
    };
}

/**
 * An opencode report's session, recorded on the attempt its pair names (issue #822): opencode mints
 * its own id and the driver learns it only at close, so a run lost mid-flight would leave its
 * takeover nothing to resume. The write is the driver's own lease-guarded session report — the
 * pair is the credential, and an attempt no longer live changes nothing.
 */
async function recordLiveSession(orgs: OrgRegistry, request: FastifyRequest, report: SessionBranchReport) {
    const jobId = request.headers[JOB_ID_HEADER];
    const leaseToken = request.headers[LEASE_TOKEN_HEADER];
    if (report.agent !== OPENCODE || !SESSION_ID.test(report.sessionId)) return;
    if (typeof jobId !== 'string' || !UUID.test(jobId) || typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return;
    }
    await (await storeFor(orgs, request))?.session(jobId, leaseToken, report.sessionId);
}

export const ingestRoutes =
    (store: TelemetryStore, orgs: OrgRegistry): FastifyPluginAsync =>
    async (app) => {
        app.post('/api/otlp/v1/metrics', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            if (!isJson(request.headers[CONTENT_TYPE_HEADER])) {
                return reply.code(HTTP_UNSUPPORTED_MEDIA_TYPE).send({ error: 'Expected application/json' });
            }

            const { rows, skipped } = flattenMetrics(request.body);
            try {
                await store.insertMetrics(rows);
            } catch (e) {
                // 5xx is the ONE signal that means "resend". Reserve it for a genuine
                // write failure, which is exactly the case a retry can fix.
                request.log.error({ err: e }, 'otlp insert failed');
                return reply.code(HTTP_UNAVAILABLE).send({ error: (e as Error).message });
            }

            // 200 with an empty partialSuccess is the OTLP success shape. A body we could
            // not fully parse is reported here, never as 5xx: exporters retry 5xx forever,
            // so a shape our parser rejects would become an infinite loop.
            app.log.debug({ accepted: rows.length, skipped }, 'otlp metrics');
            return reply.code(HTTP_OK).send({ partialSuccess: {} });
        });

        // Accepted and dropped. Log records carry prompt.id and message.uuid, which are only
        // worth storing once there is a per-prompt view to spend them on (M6). Returning 200
        // keeps a configured exporter from retrying forever in the meantime.
        app.post('/api/otlp/v1/logs', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            if (!isJson(request.headers[CONTENT_TYPE_HEADER])) {
                return reply.code(HTTP_UNSUPPORTED_MEDIA_TYPE).send({ error: 'Expected application/json' });
            }
            return reply.code(HTTP_OK).send({ partialSuccess: {} });
        });

        app.post('/api/sessions/branch', { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const report = branchReport(request.body);
            // 400, never 5xx: the hook is fire-and-forget and a 5xx would make a well-behaved
            // client retry a body it can never fix. (The credential check has already happened —
            // the hook answers 401 before this route ever runs.)
            if (!report) return reply.code(HTTP_BAD_REQUEST).send({ error: 'Malformed session branch report' });

            try {
                // The org is the credential's, never the report's: `repo` is caller-controlled
                // payload, and the owner match it used to drive would let a report name another
                // organization's repository and poison its telemetry (CWE-862).
                await store.recordBranch(report, orgOf(request));
                await recordLiveSession(orgs, request, report);
            } catch (e) {
                request.log.error({ err: e }, 'session branch upsert failed');
                return reply.code(HTTP_UNAVAILABLE).send({ error: (e as Error).message });
            }
            return reply.code(HTTP_ACCEPTED).send({ ok: true });
        });
    };
