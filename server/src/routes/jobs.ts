import type { FastifyPluginAsync } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { GateReport, JobOutcome, JobStatus, JobStore, RuntimeVitals } from '../db/job-store.js';
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

/**
 * The runtime vitals a worker may report beside the tail. Numbers are bounded past anything a
 * real container reaches (a busy multi-core container exceeds 100% CPU; ten petabytes of RAM does
 * not exist), the activity line is capped because it is one CLI line and not a log, and the
 * timestamp must parse — the UI reads its staleness off it.
 *
 * Returns the validated value, null for "no sample this round", or the reason the object is bad.
 */
const CPU_PERCENT_MAX = 10_000;
const MEM_MB_MAX = 10_000_000;
const RUNTIME_ACTIVITY_LIMIT = 512;

/** The context stats a verdict may carry: a token count no real window reaches, a cost no run hits. */
const CONTEXT_TOKENS_MAX = 100_000_000;
const CONTEXT_COST_MAX = 1_000_000;

function runtimeVitals(raw: unknown): RuntimeVitals | null | string {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) return 'runtime must be an object';
    const fields = raw as Record<string, unknown>;
    const { cpuPercent, memUsedMb, memPercent, activity, sampledAt } = fields;
    if (typeof cpuPercent !== 'number' || !Number.isFinite(cpuPercent) || cpuPercent < 0 || cpuPercent > CPU_PERCENT_MAX) {
        return `runtime.cpuPercent must be a number 0..${CPU_PERCENT_MAX}`;
    }
    if (typeof memUsedMb !== 'number' || !Number.isFinite(memUsedMb) || memUsedMb < 0 || memUsedMb > MEM_MB_MAX) {
        return `runtime.memUsedMb must be a number 0..${MEM_MB_MAX}`;
    }
    if (
        memPercent !== undefined &&
        memPercent !== null &&
        (typeof memPercent !== 'number' || !Number.isFinite(memPercent) || memPercent < 0 || memPercent > 100)
    ) {
        return 'runtime.memPercent must be a number 0..100 or null';
    }
    if (activity !== undefined && activity !== null && (typeof activity !== 'string' || !activity.trim())) {
        return 'runtime.activity must be a non-empty string or null';
    }
    if (typeof sampledAt !== 'string' || !sampledAt.trim() || Number.isNaN(Date.parse(sampledAt))) {
        return 'runtime.sampledAt must be a parseable timestamp';
    }
    return {
        cpuPercent,
        memUsedMb,
        memPercent: (memPercent as number | null | undefined) ?? null,
        activity: typeof activity === 'string' ? activity.trim().slice(0, RUNTIME_ACTIVITY_LIMIT) : null,
        sampledAt: sampledAt.slice(0, 64),
    };
}

const LEASE_SECONDS_DEFAULT = 300;
const LEASE_SECONDS_MAX = 3600;

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

/** Far past the `cse_` tokens seen in practice, and short enough that it cannot be an essay. */
const REMOTE_SESSION_LIMIT = 256;

/**
 * What an agent session id may look like. Not pinned to a uuid: claude-code's are, but opencode
 * mints its own (`ses_…`), and the board's job is to RECORD the session the run used, not to
 * second-guess a foreign CLI's id format. Still an opaque-token check, not free-form: the value
 * rides back to the driver on a follow-up claim and becomes runner argv there.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

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
            if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
                return bad(reply, 'BAD_SESSION_ID', 'sessionId must be a short opaque token');
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

        // A rolling tail of the running attempt's output, so the dashboard shows the work while it
        // happens. Separate from complete because the run has not ended — there is no verdict
        // here, and the final complete report overwrites whatever this last stored. The driver
        // owns the window: this stores the tail it is sent, replacing the previous one, truncated
        // by the same rule complete applies. An optional `runtime` object rides beside the tail —
        // the driver's latest sample of the runner container's CPU/memory plus the agent's current
        // activity line, the dashboard's "is it stuck or working" answer. Absent (or null) means
        // no fresh sample: the last stored one stays. Replaced, never appended, like the tail.
        app.post('/api/jobs/:id/output', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken, output, runtime } = body(request.body);
            if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
                return bad(reply, 'BAD_TOKEN', 'leaseToken must be a uuid');
            }
            if (typeof output !== 'string') {
                return bad(reply, 'BAD_OUTPUT', 'output must be a string');
            }
            const vitals = runtimeVitals(runtime);
            if (typeof vitals === 'string') return bad(reply, 'BAD_RUNTIME', vitals);

            const result = await guard(reply, (e) => request.log.error({ err: e }, 'job output failed'), () =>
                store.progress(id, leaseToken, output.slice(0, OUTPUT_LIMIT), vitals),
            );
            if (!result.ok) return reply;
            if (result.value === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            if (result.value === 'lost') {
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ id });
        });

        // The verification gates a job's checkout declares, executed by the driver in the
        // declared environment image. Separate from /output because the run has not ended and
        // there is no verdict here; the report REPLACES the stored list, which is what makes the
        // UI's "current/last ran only" honest rather than a truncation somebody has to remember.
        app.post('/api/jobs/:id/gates', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken, gates } = body(request.body);
            if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
                return bad(reply, 'BAD_TOKEN', 'leaseToken must be a uuid');
            }
            if (!Array.isArray(gates)) {
                return bad(reply, 'BAD_GATES', 'gates must be an array');
            }
            const results: GateReport[] = [];
            for (const raw of gates) {
                const entry = body(raw);
                const name = entry.name;
                const status = entry.status;
                const exitCode = entry.exitCode;
                const output = entry.output;
                if (typeof name !== 'string' || !name.trim() || name.length > 64) {
                    return bad(reply, 'BAD_GATES', 'every gate needs a name of at most 64 characters');
                }
                if (status !== 'running' && status !== 'passed' && status !== 'failed') {
                    return bad(reply, 'BAD_GATES', "gate status must be 'running', 'passed' or 'failed'");
                }
                if (exitCode !== undefined && exitCode !== null && !Number.isInteger(exitCode)) {
                    return bad(reply, 'BAD_GATES', 'gate exitCode must be an integer or null');
                }
                if (output !== undefined && output !== null && typeof output !== 'string') {
                    return bad(reply, 'BAD_GATES', 'gate output must be a string or null');
                }
                results.push({
                    name,
                    status,
                    exitCode: (exitCode as number | undefined) ?? null,
                    output: typeof output === 'string' ? output.slice(0, OUTPUT_LIMIT) : null,
                });
            }

            const result = await guard(reply, (e) => request.log.error({ err: e }, 'job gates failed'), () =>
                store.gates(id, leaseToken, results),
            );
            if (!result.ok) return reply;
            if (result.value === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            if (result.value === 'lost') {
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ id });
        });

        // Re-reads what the job's checkout declares in .bellows.yaml. The claim read the file
        // before the driver's startup sync brought the checkout up to the remote default, so the
        // claim's answer can be stale by the time the run starts — the driver calls this right
        // after the sync, and gates the run on what the tree holds NOW. Lease-guarded like every
        // worker route: the fresh answer goes only to the worker that holds the run.
        app.post('/api/jobs/:id/gates-reread', { bodyLimit: 4096 }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken } = body(request.body);
            if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
                return bad(reply, 'BAD_TOKEN', 'leaseToken must be a uuid');
            }

            const reread = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job gates re-read failed'),
                () => store.rereadGates(id, leaseToken),
            );
            if (!reread.ok) return reply;
            if (reread.value.result !== 'ok') {
                if (reread.value.result === 'missing') {
                    return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
                }
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ gates: reread.value.gates, gateError: reread.value.gateError });
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

        // A person's action on a finished task: queue an adjustment as a continuation of the run
        // it just did. The store decides every refusal atomically with the insert, so a follow-up
        // can never land on a parent that turns out to be running or done. No lease token — the
        // task is finished, nobody holds it, and this is a person's action for exactly that reason.
        // The executor is NOT taken from the body: the adjustment is bound to the executor that
        // ran the task, copied from the parent at insert like the repo and the session.
        app.post('/api/jobs/:id/follow-up', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const fields = body(request.body);
            const command = fields.command;
            if (typeof command !== 'string' || !command.trim()) {
                return bad(reply, 'BAD_COMMAND', 'command must be a non-empty string');
            }
            if (command.length > COMMAND_LIMIT) {
                return bad(reply, 'BAD_COMMAND', `command exceeds ${COMMAND_LIMIT} characters`);
            }

            // Read off the authenticated request, never off the body — the create route's rule
            // about impersonation applies word for word here.
            const createdBy = callerOf(request)?.user.id ?? null;

            const created = await guard(reply, (e) => request.log.error({ err: e }, 'job follow-up failed'), () =>
                store.createFollowUp(id, command, createdBy),
            );
            if (!created.ok) return reply;
            if (typeof created.value === 'string') {
                switch (created.value) {
                    case 'missing':
                        return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
                    case 'not_finished':
                        return reply.code(409).send({ error: 'Task is not finished', code: 'NOT_FINISHED' });
                    case 'task_done':
                        return reply.code(409).send({ error: 'Task is done', code: 'TASK_DONE' });
                    case 'no_session':
                        return reply
                            .code(409)
                            .send({ error: 'The finished run has no agent session to continue', code: 'NO_SESSION' });
                    case 'forbidden':
                        return bad(reply, 'FORBIDDEN', 'Only the account that queued the task can follow it up', 403);
                }
            }
            return reply.code(201).send({ id: created.value.id, status: 'queued' });
        });

        // The user's verdict that the task is done — the one no run can make. Idempotent in the
        // store, so a retried click answers the same instant rather than rewriting it.
        app.post('/api/jobs/:id/done', { bodyLimit: 4096 }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const result = await guard(reply, (e) => request.log.error({ err: e }, 'job done failed'), () =>
                store.markDone(id),
            );
            if (!result.ok) return reply;
            if (result.value === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            if (result.value === 'conflict') {
                return reply.code(409).send({ error: 'Task is not finished', code: 'NOT_FINISHED' });
            }
            return reply.code(200).send({ id, status: result.value.status, doneAt: result.value.doneAt });
        });

        // The worker's verdict that the run is over. The 200 body carries `threadTerminal` — the
        // store's answer, computed in the same transaction as the verdict, to whether the job's
        // whole thread is finished: it is the driver's only worktree-reclaim signal, and it rides
        // the lease-guarded complete rather than a thread read, so a worker credential can never
        // pull the audit data of jobs it does not hold (see docs/auth.md).
        app.post('/api/jobs/:id/complete', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken, status, exitCode, output, contextTokens, contextCostUsd } = body(request.body);
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
            if (
                contextTokens !== undefined &&
                contextTokens !== null &&
                (!Number.isInteger(contextTokens) || (contextTokens as number) < 0 || (contextTokens as number) > CONTEXT_TOKENS_MAX)
            ) {
                return bad(reply, 'BAD_CONTEXT', `contextTokens must be an integer 0..${CONTEXT_TOKENS_MAX}`);
            }
            if (
                contextCostUsd !== undefined &&
                contextCostUsd !== null &&
                (typeof contextCostUsd !== 'number' ||
                    !Number.isFinite(contextCostUsd) ||
                    (contextCostUsd as number) < 0 ||
                    (contextCostUsd as number) > CONTEXT_COST_MAX)
            ) {
                return bad(reply, 'BAD_CONTEXT', `contextCostUsd must be a number 0..${CONTEXT_COST_MAX}`);
            }

            const result = await guard(reply, (e) => request.log.error({ err: e }, 'job complete failed'), () =>
                store.complete(id, leaseToken, {
                    status: status as JobOutcome,
                    exitCode: (exitCode as number | undefined) ?? null,
                    output: typeof output === 'string' ? output.slice(0, OUTPUT_LIMIT) : null,
                    contextTokens: (contextTokens as number | undefined) ?? null,
                    contextCostUsd: (contextCostUsd as number | undefined) ?? null,
                }),
            );
            if (!result.ok) return reply;
            if (result.value.result !== 'ok') {
                if (result.value.result === 'missing') {
                    return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
                }
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ id, status, threadTerminal: result.value.threadTerminal });
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

        // The whole follow-up chain containing this task, oldest first. ANY member resolves to the
        // same conversation — the UI keeps one task per thread, so the URL may name the root or
        // any adjustment and the page must not change identity underneath the reader.
        app.get('/api/jobs/:id/thread', async (request, reply) => {
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const jobs = await guard(reply, (e) => request.log.error({ err: e }, 'job thread read failed'), () =>
                store.thread(id),
            );
            if (!jobs.ok) return reply;
            if (jobs.value === null) return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            return reply.code(200).send({ jobs: jobs.value });
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
