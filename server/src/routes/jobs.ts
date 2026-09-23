import type { FastifyPluginAsync } from 'fastify';
import { boardScan } from './job-context.js';
import {
    handleClaimJob,
    handleCreateJob,
    handleGates,
    handleGatesReread,
    handleHeartbeat,
    handleOutput,
    handlePublishToken,
    handleSession,
    handleSuspend,
} from './job-handlers-worker.js';
import {
    handleCompleteJob,
    handleDone,
    handleFollowUp,
    handleGetJob,
    handleListJobs,
    handleReclaimsAck,
    handleReclaimsClaim,
    handleRemove,
    handleStop,
    handleThread,
} from './job-handlers-actions.js';
import { BODY_LIMIT, CONTROL_BODY_LIMIT } from './job-limits.js';
import type { OrgRegistry } from '../orgs.js';

export interface JobRouteDeps {
    /** The per-org runtimes; the store a request touches is the CALLER's org's. */
    orgs: OrgRegistry;
}

/**
 * The job board's HTTP surface. The validation and the per-route logic live beside it in
 * `job-limits.ts` (sizes, status codes, the shared refusals), `job-field-validation.ts` (body/query
 * shape checks), `job-context.ts` (the org/board lookups every route shares) and the two
 * `job-handlers-*.ts` files (one route handler per export) — split purely to keep each file under
 * the repo's line-count ceiling. See docs/jobs.md for the protocol these routes implement.
 */
export const jobRoutes =
    ({ orgs }: JobRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const firstJobClaim = boardScan();
        const firstReclaimClaim = boardScan();

        app.post('/api/jobs', { bodyLimit: BODY_LIMIT }, (request, reply) => handleCreateJob(orgs, request, reply));

        // POST, not GET: claiming mutates. The worker id is required — it is the only thing that
        // says which container is holding a job when one has to be found and killed.
        app.post('/api/jobs/claim', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleClaimJob(orgs, firstJobClaim, request, reply)
        );
        app.post('/api/jobs/:id/heartbeat', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleHeartbeat(orgs, request, reply)
        );
        app.post('/api/jobs/:id/session', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleSession(orgs, request, reply)
        );
        app.post('/api/jobs/:id/output', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleOutput(orgs, request, reply)
        );
        app.post('/api/jobs/:id/gates', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleGates(orgs, request, reply)
        );
        app.post('/api/jobs/:id/gates-reread', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleGatesReread(orgs, request, reply)
        );
        app.post('/api/jobs/:id/publish-token', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handlePublishToken(orgs, request, reply)
        );
        app.post('/api/jobs/:id/suspend', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleSuspend(orgs, request, reply)
        );
        app.post('/api/jobs/:id/follow-up', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleFollowUp(orgs, request, reply)
        );
        app.post('/api/jobs/:id/done', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleDone(orgs, request, reply)
        );
        app.post('/api/jobs/:id/stop', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleStop(orgs, request, reply)
        );
        app.post('/api/jobs/:id/remove', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleRemove(orgs, request, reply)
        );
        app.post('/api/reclaims/claim', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleReclaimsClaim(orgs, firstReclaimClaim, request, reply)
        );
        app.post('/api/reclaims/:id/ack', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleReclaimsAck(orgs, request, reply)
        );
        app.post('/api/jobs/:id/complete', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleCompleteJob(orgs, request, reply)
        );
        app.get('/api/jobs/:id', (request, reply) => handleGetJob(orgs, request, reply));
        app.get('/api/jobs/:id/thread', (request, reply) => handleThread(orgs, request, reply));
        app.get('/api/jobs', (request, reply) => handleListJobs(orgs, request, reply));
    };
