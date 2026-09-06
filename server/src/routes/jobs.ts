import type { FastifyPluginAsync } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { JobOutcome, JobStatus, JobStore } from '../db/job-store.js';
import { UUID, bad, badSegment, body, guard } from './helpers.js';

/**
 * A command is a shell line, not a payload. 16 KiB is far past anything a human writes, and past
 * anything a generated one should be; the body limit is a little above it so an oversized command
 * is refused with a reason rather than a bare connection error.
 */
const COMMAND_LIMIT = 16_384;
const BODY_LIMIT = 128 * 1024;

/**
 * The repo and executor labels a task may carry. Both are display metadata for the tasks chat —
 * the chat groups by repository and names the executor — and nothing consumes them at claim time:
 * the claim payload is unchanged, and wiring an executor into the driver remains future work. They
 * are validated by shape only, under the same path-segment rules a checkout's directory name obeys,
 * never against the member's configured rows: `job` is an audit record, and the rows it would be
 * validated against come and go with a PUT. A length cap would dead-end an executor name the
 * selection route accepted, so neither field has one here either — the body limit bounds them the
 * way it bounds the command. See docs/jobs.md.
 */
const REPO_SEGMENT_LIMIT = 100;

function repoReason(value: string): string | null {
    const parts = value.split('/');
    if (parts.length !== 2) return 'repo must be owner/name';
    for (const [label, part] of [
        ['owner', parts[0]!],
        ['name', parts[1]!],
    ] as const) {
        if (part.length > REPO_SEGMENT_LIMIT) return `${label} exceeds ${REPO_SEGMENT_LIMIT} characters`;
        const reason = badSegment(label, part);
        if (reason) return reason;
    }
    return null;
}

function executorReason(value: string): string | null {
    return badSegment('executor', value);
}

/**
 * Output is truncated here, not trusted from the worker. The body limit lets 128 KiB through and a
 * job's tail is for debugging, not archival — the OTLP pipeline is where logs belong.
 */
const OUTPUT_LIMIT = 64 * 1024;

const LEASE_SECONDS_DEFAULT = 300;
const LEASE_SECONDS_MAX = 3600;

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

/** Far past the `cse_` tokens seen in practice, and short enough that it cannot be an essay. */
const REMOTE_SESSION_LIMIT = 256;

const STATUSES: readonly JobStatus[] = ['queued', 'running', 'standby', 'succeeded', 'failed', 'dead'];

function leaseSeconds(raw: unknown): number | null {
    if (raw === undefined || raw === null) return LEASE_SECONDS_DEFAULT;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > LEASE_SECONDS_MAX) return null;
    return raw;
}

export const jobRoutes =
    (store: JobStore): FastifyPluginAsync =>
    async (app) => {
        app.post('/api/jobs', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const fields = body(request.body);
            const command = fields.command;
            if (typeof command !== 'string' || !command.trim()) {
                return bad(reply, 'BAD_COMMAND', 'command must be a non-empty string');
            }
            if (command.length > COMMAND_LIMIT) {
                return bad(reply, 'BAD_COMMAND', `command exceeds ${COMMAND_LIMIT} characters`);
            }

            // Absent and explicit null both mean "not given" — what every job queued before the
            // chat carries.
            const repo = fields.repo === undefined || fields.repo === null ? null : fields.repo;
            const executor = fields.executor === undefined || fields.executor === null ? null : fields.executor;
            if (repo !== null) {
                const reason = typeof repo !== 'string' ? 'repo must be a string' : repoReason(repo);
                if (reason) return bad(reply, 'BAD_REPO', reason);
            }
            if (executor !== null) {
                const reason = typeof executor !== 'string' ? 'executor must be a string' : executorReason(executor);
                if (reason) return bad(reply, 'BAD_EXECUTOR', reason);
            }

            // Read off the authenticated request, never off the body: a client-supplied author is
            // impersonation. Null only when the app was built with no auth store at all, which is
            // the route tests' configuration rather than a deployment's.
            const createdBy = callerOf(request)?.user.id ?? null;

            const created = await guard(reply, (e) => request.log.error({ err: e }, 'job create failed'), () =>
                store.create(command, createdBy, {
                    repo: typeof repo === 'string' ? repo : null,
                    executor: typeof executor === 'string' ? executor : null,
                }),
            );
            if (!created.ok) return reply;
            return reply.code(201).send({ id: created.value.id, status: 'queued' });
        });

        // POST, not GET: claiming mutates. The worker id is required — it is the only thing that
        // says which container is holding a job when one has to be found and killed.
        app.post('/api/jobs/claim', { bodyLimit: 4096 }, async (request, reply) => {
            const { worker, leaseSeconds: requested } = body(request.body);
            if (typeof worker !== 'string' || !worker.trim() || worker.length > 128) {
                return bad(reply, 'BAD_WORKER', 'worker must be a non-empty string');
            }
            const lease = leaseSeconds(requested);
            if (lease === null) {
                return bad(reply, 'BAD_LEASE', `leaseSeconds must be an integer 1..${LEASE_SECONDS_MAX}`);
            }

            const claim = await guard(reply, (e) => request.log.error({ err: e }, 'job claim failed'), () =>
                store.claim(worker, lease),
            );
            if (!claim.ok) return reply;
            // 204, not 200 with a null: an idle poll is the common case and it should not have to
            // be parsed to be recognised.
            if (claim.value === null) return reply.code(204).send();
            return reply.code(200).send(claim.value);
        });

        app.post('/api/jobs/:id/heartbeat', { bodyLimit: 4096 }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken, leaseSeconds: requested } = body(request.body);
            if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
                return bad(reply, 'BAD_TOKEN', 'leaseToken must be a uuid');
            }
            const lease = leaseSeconds(requested);
            if (lease === null) {
                return bad(reply, 'BAD_LEASE', `leaseSeconds must be an integer 1..${LEASE_SECONDS_MAX}`);
            }

            const beat = await guard(reply, (e) => request.log.error({ err: e }, 'job heartbeat failed'), () =>
                store.heartbeat(id, leaseToken, lease),
            );
            if (!beat.ok) return reply;
            if (beat.value.result === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            // The board cannot stop a worker, only refuse it. A 409 here means this container is
            // running a job that belongs to someone else now, and it must terminate itself.
            if (beat.value.result === 'lost') {
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ leaseExpiresAt: beat.value.leaseExpiresAt });
        });

        // Reported separately from the completion, and not folded into the claim: the driver mints
        // the session id at spawn time, and a run that is still going is exactly when a reader wants
        // to open it.
        app.post('/api/jobs/:id/session', { bodyLimit: 4096 }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken, sessionId, remoteSessionId } = body(request.body);
            if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
                return bad(reply, 'BAD_TOKEN', 'leaseToken must be a uuid');
            }
            if (typeof sessionId !== 'string' || !UUID.test(sessionId)) {
                return bad(reply, 'BAD_SESSION_ID', 'sessionId must be a uuid');
            }
            // Not a uuid, and not checked against a shape: it is an opaque token minted elsewhere
            // (`cse_…` today), and pinning its format here would break on the day it changes.
            if (
                remoteSessionId !== undefined &&
                remoteSessionId !== null &&
                (typeof remoteSessionId !== 'string' ||
                    !remoteSessionId.trim() ||
                    remoteSessionId.length > REMOTE_SESSION_LIMIT)
            ) {
                return bad(
                    reply,
                    'BAD_REMOTE_SESSION_ID',
                    `remoteSessionId must be a non-empty string of at most ${REMOTE_SESSION_LIMIT} characters`,
                );
            }

            const result = await guard(reply, (e) => request.log.error({ err: e }, 'job session failed'), () =>
                store.session(id, leaseToken, sessionId, (remoteSessionId as string | undefined) ?? null),
            );
            if (!result.ok) return reply;
            if (result.value === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            if (result.value === 'lost') {
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ id, sessionId, remoteSessionId: remoteSessionId ?? null });
        });

        // Parking a job, not finishing it. Separate from complete because there is no outcome yet:
        // an exit code here would have to be invented, and inventing one makes a parked job
        // indistinguishable from a run that ended.
        app.post('/api/jobs/:id/suspend', { bodyLimit: 4096 }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken } = body(request.body);
            if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
                return bad(reply, 'BAD_TOKEN', 'leaseToken must be a uuid');
            }

            const result = await guard(reply, (e) => request.log.error({ err: e }, 'job suspend failed'), () =>
                store.suspend(id, leaseToken),
            );
            if (!result.ok) return reply;
            if (result.value === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            if (result.value === 'lost') {
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ id, status: 'standby' });
        });

        // No lease token, because nobody holds a parked job. That is what makes this callable by a
        // person rather than only by the worker that parked it.
        app.post('/api/jobs/:id/resume', { bodyLimit: 4096 }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const result = await guard(reply, (e) => request.log.error({ err: e }, 'job resume failed'), () =>
                store.resume(id),
            );
            if (!result.ok) return reply;
            if (result.value === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            if (result.value === 'conflict') {
                return reply.code(409).send({ error: 'Job is not on standby', code: 'NOT_STANDBY' });
            }
            return reply.code(200).send({ id, status: 'queued' });
        });

        app.post('/api/jobs/:id/complete', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken, status, exitCode, output } = body(request.body);
            if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
                return bad(reply, 'BAD_TOKEN', 'leaseToken must be a uuid');
            }
            if (status !== 'succeeded' && status !== 'failed') {
                return bad(reply, 'BAD_STATUS', "status must be 'succeeded' or 'failed'");
            }
            if (exitCode !== undefined && exitCode !== null && !Number.isInteger(exitCode)) {
                return bad(reply, 'BAD_EXIT_CODE', 'exitCode must be an integer or null');
            }
            if (output !== undefined && output !== null && typeof output !== 'string') {
                return bad(reply, 'BAD_OUTPUT', 'output must be a string or null');
            }

            const result = await guard(reply, (e) => request.log.error({ err: e }, 'job complete failed'), () =>
                store.complete(id, leaseToken, {
                    status: status as JobOutcome,
                    exitCode: (exitCode as number | undefined) ?? null,
                    output: typeof output === 'string' ? output.slice(0, OUTPUT_LIMIT) : null,
                }),
            );
            if (!result.ok) return reply;
            if (result.value === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            if (result.value === 'lost') {
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ id, status });
        });

        app.get('/api/jobs/:id', async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const job = await guard(reply, (e) => request.log.error({ err: e }, 'job read failed'), () =>
                store.get(id),
            );
            if (!job.ok) return reply;
            if (job.value === null) return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            return reply.code(200).send(job.value);
        });

        app.get('/api/jobs', async (request, reply) => {
            const query = request.query as { status?: string; limit?: string; repo?: string };
            if (query.status !== undefined && !STATUSES.includes(query.status as JobStatus)) {
                return bad(reply, 'BAD_STATUS', `status must be one of ${STATUSES.join(', ')}`);
            }
            const limit = query.limit === undefined ? LIST_LIMIT_DEFAULT : Number(query.limit);
            if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
                return bad(reply, 'BAD_LIMIT', `limit must be an integer 1..${LIST_LIMIT_MAX}`);
            }
            const repo = query.repo;
            // Fastify's query parser hands repeated keys over as an array, so the shape is checked
            // before use — a malformed filter is a 400, never a TypeError.
            if (repo !== undefined && (typeof repo !== 'string' || repoReason(repo) !== null)) {
                const reason = typeof repo === 'string' ? repoReason(repo) : 'repo must be a string';
                return bad(reply, 'BAD_REPO', reason ?? 'repo must be owner/name');
            }

            const jobs = await guard(reply, (e) => request.log.error({ err: e }, 'job list failed'), () =>
                store.list({ status: query.status as JobStatus | undefined, repo, limit }),
            );
            if (!jobs.ok) return reply;
            return reply.code(200).send({ jobs: jobs.value });
        });
    };
