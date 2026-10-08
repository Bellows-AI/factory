import type { FastifyPluginAsync } from 'fastify';
import { boardScan } from './job-context.js';
import {
    handleArtifact,
    handleClaimJob,
    handleCreateJob,
    handleGates,
    handleGatesReread,
    handleHeartbeat,
    handleLeases,
    handleOutput,
    handlePublishToken,
    handleSession,
    handleSuspend,
} from './job-handlers-worker.js';
import {
    handleArtifactRead,
    handleCompleteJob,
    handleDone,
    handleEditJob,
    handleFollowUp,
    handleGetJob,
    handleJobActivity,
    handleListJobs,
    handleReclaimsAck,
    handleReclaimsClaim,
    handleRemove,
    handleReopen,
    handleRetry,
    handleStop,
    handleThread,
    handleWaitCancel,
    handleWaitPoke,
} from './job-handlers-actions.js';
import { handleAnswer, handleQuestion, handleQuestionExpire } from './job-handlers-questions.js';
import { handleReviewRead, handleReviewRequest } from './job-handlers-reviews.js';
import { ARTIFACT_BODY_LIMIT, BODY_LIMIT, CONTROL_BODY_LIMIT, QUESTION_BODY_LIMIT } from './job-limits.js';
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
        // The orphan reaper's batched lease lookup (issue #301). Static segment, registered
        // beside /claim — it wins over /api/jobs/:id the same way the claim route already does.
        app.post('/api/jobs/leases', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleLeases(orgs, request, reply)
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
        app.post('/api/jobs/:id/retry', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleRetry(orgs, request, reply)
        );
        // The edit of a queued task's command (issue #329): person-gated like the follow-up it
        // sits beside, no lease token — a queued task is nobody's. The command can be 16 KiB,
        // so the create body limit.
        app.patch('/api/jobs/:id', { bodyLimit: BODY_LIMIT }, (request, reply) => handleEditJob(orgs, request, reply));
        app.post('/api/jobs/:id/done', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleDone(orgs, request, reply)
        );
        app.post('/api/jobs/:id/stop', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleStop(orgs, request, reply)
        );
        app.post('/api/jobs/:id/remove', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleRemove(orgs, request, reply)
        );
        // Done's inverse (issue #327): the mistake undone, while the worktree it would resume in
        // still exists. Person-gated like done, beside which it is registered.
        app.post('/api/jobs/:id/reopen', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleReopen(orgs, request, reply)
        );
        // Both control a thread parked on a durable PR wait (issue #328) — person's actions on a
        // wait no worker holds a lease on, so no token and the actor off the session, exactly as
        // stop/done/remove take them. The store author-scopes both and answers the no-open-wait
        // conflict the issue mandates.
        app.post('/api/jobs/:id/wait/cancel', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleWaitCancel(orgs, request, reply)
        );
        app.post('/api/jobs/:id/wait/poke', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleWaitPoke(orgs, request, reply)
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
        // The run-artifact upload (issue #325): the driver's close-time POST of the full-run log
        // and the agent transcript, one kind per call. The body limit sits above the artifact cap
        // plus JSON overhead, so an honest upload never dies on its envelope; the handler slices
        // to the cap regardless.
        app.post('/api/jobs/:id/artifact', { bodyLimit: ARTIFACT_BODY_LIMIT }, (request, reply) =>
            handleArtifact(orgs, request, reply)
        );
        // The agent's questions (050, issue #531): the driver's report and expiry are worker
        // routes; the answer is a person's, and no organization token reaches it.
        app.post('/api/jobs/:id/question', { bodyLimit: QUESTION_BODY_LIMIT }, (request, reply) =>
            handleQuestion(orgs, request, reply)
        );
        app.post('/api/jobs/:id/question-expire', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleQuestionExpire(orgs, request, reply)
        );
        app.post('/api/jobs/:id/questions/:questionId/answer', { bodyLimit: QUESTION_BODY_LIMIT }, (request, reply) =>
            handleAnswer(orgs, request, reply)
        );
        // A named reviewer's separate run (056, issue #549): the driver's request and its read of
        // the verdict, both worker routes — the agent reaches them only through the control endpoint.
        app.post('/api/jobs/:id/review', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleReviewRequest(orgs, request, reply)
        );
        app.post('/api/jobs/:id/review-read', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleReviewRead(orgs, request, reply)
        );
        app.get('/api/jobs/:id', (request, reply) => handleGetJob(orgs, request, reply));
        app.get('/api/jobs/:id/thread', (request, reply) => handleThread(orgs, request, reply));
        app.get('/api/jobs/:id/activity', (request, reply) => handleJobActivity(orgs, request, reply));
        // The artifacts' person reads (issue #325), beside the job read they extend.
        app.get('/api/jobs/:id/log', (request, reply) => handleArtifactRead(orgs, request, reply, 'log'));
        app.get('/api/jobs/:id/transcript', (request, reply) => handleArtifactRead(orgs, request, reply, 'transcript'));
        app.get('/api/jobs', (request, reply) => handleListJobs(orgs, request, reply));
    };
