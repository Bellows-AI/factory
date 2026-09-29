import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import { type BoardScanner, storeFor, telemetryFor } from './job-context.js';
import { pickBucketMs } from '../telemetry/run-activity.js';
import {
    followUpRefusal,
    validateCommandField,
    validateCompleteFields,
    validateListQuery,
    validatePublication,
    validateWaitQuery,
    validateWorkerField,
    waitControlRefusal,
} from './job-field-validation.js';
import { bad, body, guard } from './helpers.js';
import { resolveClaimRoute, resolveJobRoute } from './route-guards.js';
import { UUID } from '../config.js';
import {
    HTTP_ACCEPTED,
    HTTP_CONFLICT,
    HTTP_CREATED,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_NO_CONTENT,
    HTTP_OK,
    leaseLost,
    noBoard,
    notFoundJob,
} from './job-limits.js';

// A person's action on a finished task: queue an adjustment as a continuation of the run it just
// did. The store decides every refusal atomically with the insert, so a follow-up can never land
// on a parent that turns out to be running or done. No lease token — the task is finished, nobody
// holds it, and this is a person's action for exactly that reason. The executor is NOT taken from
// the body: the adjustment is bound to the executor that ran the task, copied from the parent at
// insert like the repo and the session.
export async function handleFollowUp(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const commandResult = validateCommandField(fields.command);
    if (!commandResult.ok) return bad(reply, ERROR_CODES.BAD_COMMAND, commandResult.message);

    // Read off the authenticated request, never off the body — the create route's rule about
    // impersonation applies word for word here.
    const createdBy = callerOf(request)?.user.id ?? null;

    const created = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job follow-up failed'),
        () => store.createFollowUp(id, commandResult.value, createdBy)
    );
    if (!created.ok) return reply;
    if (typeof created.value === 'string') return followUpRefusal(reply, created.value);
    return reply.code(HTTP_CREATED).send({ id: created.value.id, status: 'queued' });
}

// The edit of a queued task's command (issue #329): same id, same thread, where a stop plus a
// re-create would have burned both. The store decides every refusal atomically with the write —
// queued rows only, author only, workflow rows refused (their command is interpolated prompt
// text and the raw chat line was never stored) — so a row claimed as the request arrives
// answers 409 NOT_QUEUED instead of editing a run's input underneath its worker.
export async function handleEditJob(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const commandResult = validateCommandField(fields.command);
    if (!commandResult.ok) return bad(reply, ERROR_CODES.BAD_COMMAND, commandResult.message);

    // Read off the authenticated request, never off the body — the create route's rule about
    // impersonation applies word for word here.
    const caller = callerOf(request)?.user.id ?? null;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job edit failed'),
        () => store.editCommand(id, commandResult.value, caller)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'workflow') {
        return reply.code(HTTP_CONFLICT).send({
            error: "The task's command is built by its workflow's prompt",
            code: ERROR_CODES.WORKFLOW_COMMAND_FROZEN,
        });
    }
    if (result.value === 'forbidden') {
        return reply.code(HTTP_FORBIDDEN).send({
            error: 'Only the account that queued the task can edit its command',
            code: ERROR_CODES.FORBIDDEN,
        });
    }
    if (result.value.result === 'not_queued') {
        return reply.code(HTTP_CONFLICT).send({
            error: `Task is ${result.value.status} — only a queued task's command can be edited`,
            code: ERROR_CODES.NOT_QUEUED,
            status: result.value.status,
        });
    }
    return reply.code(HTTP_OK).send({ id, status: 'queued', command: result.value.command });
}

// The user's verdict that the task is done — the one no run can make. Idempotent in the store, so
// a retried click answers the same instant rather than rewriting it.
export async function handleDone(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job done failed'),
        // The actor comes from the session, never a body — the same rule as create.
        () => store.markDone(id, callerOf(request)?.user.id ?? null)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'conflict') {
        return reply.code(HTTP_CONFLICT).send({ error: 'Task is not finished', code: ERROR_CODES.NOT_FINISHED });
    }
    return reply.code(HTTP_OK).send({ id, status: result.value.status, doneAt: result.value.doneAt });
}

// The user's stop. Two fates in one answer: a queued (never started) or a
// running row whose lease has already expired (#152) is settled `stopped` directly — the turn is
// over — while a running row under a live lease is left running and stamped, and the WORKER
// settles it when its next heartbeat reports the stamp (suspend lands `stopped` under the flag).
// Either way the turn ends and the session stays, so the follow-up composer is what the member
// sees next. 202 for the moving case, because the request RIDES to the worker and the settle
// lands moments later.
export async function handleStop(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job stop failed'),
        // The actor comes from the session, never a body — the same rule as create.
        () => store.stop(id, callerOf(request)?.user.id ?? null)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value.result === 'conflict') {
        return reply.code(HTTP_CONFLICT).send({
            error: `Task is ${result.value.status} — nothing to stop`,
            code: ERROR_CODES.NOT_STOPPABLE,
            status: result.value.status,
        });
    }
    if (result.value.result === 'requested') {
        return reply
            .code(HTTP_ACCEPTED)
            .send({ id, status: 'running', cancelRequestedAt: result.value.cancelRequestedAt });
    }
    return reply.code(HTTP_OK).send({ id, status: 'stopped' });
}

// The user's remove: the thread is gone and a worktree reclaim is queued. Person-gated like every
// job write here, not just because the driver has no use for it — the board secret deleting the
// audit rows of jobs it never held would be exactly the thread-read hole again.
export async function handleRemove(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job remove failed'),
        // The actor comes from the session, never a body — the same rule as create. It rides the
        // task_reclaim row: the thread rows are deleted in the same transaction.
        () => store.removeThread(id, callerOf(request)?.user.id ?? null)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'conflict') {
        return reply
            .code(HTTP_CONFLICT)
            .send({ error: 'The task is still running — stop it first', code: ERROR_CODES.TASK_RUNNING });
    }
    return reply.code(HTTP_OK).send({ id, removed: true });
}

// The user's wait-cancel (issue #328): ends the durable PR wait a thread is parked on, so a
// missed webhook or a changed mind does not strand the thread forever. A person's action on a
// wait no worker holds a lease on — no lease token, actor off the session like stop/done/remove.
// Author-scoped in the store: the woken continuation would run in the author's worktree.
export async function handleWaitCancel(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job wait-cancel failed'),
        () => store.cancelWait(id, callerOf(request)?.user.id ?? null)
    );
    if (!result.ok) return reply;
    // The string members are exactly the shared refusals; the object members differ per verb.
    if (typeof result.value === 'string') return waitControlRefusal(reply, result.value);
    return reply.code(HTTP_OK).send({ id, cancelled: true });
}

// The user's wait-poke (issue #328): re-evaluate the parked PR now — the wake transaction the
// sweep runs, minus the pending gate, because webhooks are the board's only GitHub input and the
// motivating case is one that never arrived. `woken: false` is an honest answer (nothing parked,
// already woken, an active member), never an error.
export async function handleWaitPoke(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job wait-poke failed'),
        () => store.pokeWait(id, callerOf(request)?.user.id ?? null)
    );
    if (!result.ok) return reply;
    if (typeof result.value === 'string') return waitControlRefusal(reply, result.value);
    return reply.code(HTTP_OK).send({ id, woken: result.value.woken });
}

// The user's reopening of a done task (issue #327): done's inverse. Person-gated like done/remove
// — a person's verdict on a task no worker holds — and it takes no lease token for the same
// reason. The store refuses atomically: a task that was never done, one whose worktree a reclaim
// already removed (a follow-up would have nothing to resume in), and one whose worktree is being
// removed right now (retry once the reclaim settles) are all conflicts.
export async function handleReopen(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job reopen failed'),
        () => store.reopen(id)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'not_done') {
        return reply.code(HTTP_CONFLICT).send({ error: 'Task is not done', code: ERROR_CODES.TASK_NOT_DONE });
    }
    if (result.value === 'reclaimed') {
        return reply.code(HTTP_CONFLICT).send({
            error: "The task's worktree was already reclaimed",
            code: ERROR_CODES.WORKTREE_RECLAIMED,
        });
    }
    if (result.value === 'reclaiming') {
        return reply.code(HTTP_CONFLICT).send({
            error: "A driver is removing the task's worktree — retry once the reclaim settles",
            code: ERROR_CODES.RECLAIM_IN_PROGRESS,
        });
    }
    return reply.code(HTTP_OK).send({ id, reopened: true });
}

// The driver's poll of the worktree-reclaim queue: the rows POST /remove left behind for
// worktrees no live driver holds a lease on. Claim and ack are the worker routes the job
// claim/complete are, and the body matches: the worker name is required (it is queued for
// exactly this claim), and an idle poll answers 204 rather than a parsed null.
export async function handleReclaimsClaim(
    orgs: OrgRegistry,
    firstReclaimClaim: BoardScanner,
    request: FastifyRequest,
    reply: FastifyReply
) {
    const claimRoute = await resolveClaimRoute(orgs, request, reply);
    if (!claimRoute) return reply;
    const { boards, worker, lease } = claimRoute;

    const reclaimFailed = (e: Error) => request.log.error({ err: e }, 'reclaim claim failed');
    const claim = await guard(reply, reclaimFailed, () =>
        firstReclaimClaim(boards, reclaimFailed, (board) => board.claimReclaim(worker, lease))
    );
    if (!claim.ok) return reply;
    if (claim.value === null) return reply.code(HTTP_NO_CONTENT).send();
    return reply.code(HTTP_OK).send(claim.value);
}

// The driver's proof that a parked worktree is gone. Only the worker that holds the claim may ack
// it, so a slow worker's row survives a foreign ack and finishes on its next try.
export async function handleReclaimsAck(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const workerResult = validateWorkerField(body(request.body).worker);
    if (!workerResult.ok) return bad(reply, ERROR_CODES.BAD_WORKER, workerResult.message);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'reclaim ack failed'),
        () => store.ackReclaim(id, workerResult.value)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') {
        return reply.code(HTTP_NOT_FOUND).send({ error: 'No such reclaim', code: ERROR_CODES.NOT_FOUND });
    }
    if (result.value === 'lost') {
        return reply.code(HTTP_CONFLICT).send({ error: 'Reclaim is not yours', code: ERROR_CODES.LEASE_LOST });
    }
    return reply.code(HTTP_OK).send({ id });
}

// The worker's verdict that the run is over. The 200 body carries `threadDone` — the store's
// answer, computed in the same transaction as the verdict, to whether the job's whole thread is
// finished AND the user has closed it (a `done_at` on some member): it is the driver's only
// worktree-reclaim signal, and it rides the lease-guarded complete rather than a thread read, so a
// worker credential can never pull the audit data of jobs it does not hold (see docs/auth.md). A
// thread that merely finished keeps its tree.
export async function handleCompleteJob(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const { leaseToken } = fields;
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const parsed = validateCompleteFields(fields);
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);
    const publicationResult = validatePublication(fields.publication ?? null);
    if (!publicationResult.ok) return bad(reply, ERROR_CODES.BAD_PUBLICATION, publicationResult.message);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job complete failed'),
        () => store.complete(id, leaseToken, { ...parsed.value, publication: publicationResult.value })
    );
    if (!result.ok) return reply;
    if (result.value.result !== 'ok') {
        if (result.value.result === 'missing') return notFoundJob(reply);
        return leaseLost(reply);
    }
    return reply.code(HTTP_OK).send({ id, status: parsed.value.status, threadDone: result.value.threadDone });
}

export async function handleGetJob(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    // The settle long-poll (issue #323): `?waitFor=terminal&timeout=<s>` holds the request —
    // store-side, one indexed re-read every 250ms — until the thread's chain head reaches a
    // terminal status or an open PR wait stands on it, or the (capped) timeout elapses, then
    // answers the usual job shape either way; the client re-issues on a timeout. An unknown id
    // is a 404 without any hold.
    const wait = validateWaitQuery(request.query as { waitFor?: unknown; timeout?: unknown });
    if (!wait.ok) return bad(reply, wait.code, wait.message);
    const timeoutMs = wait.value?.timeoutMs;
    if (timeoutMs !== undefined) {
        const settled = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'job wait failed'),
            () => store.waitForSettle(id, timeoutMs)
        );
        if (!settled.ok) return reply;
        if (settled.value === null) return notFoundJob(reply);
    }

    const job = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job read failed'),
        () => store.get(id)
    );
    if (!job.ok) return reply;
    if (job.value === null) return notFoundJob(reply);
    return reply.code(HTTP_OK).send(job.value);
}

// The run-activity read (issue #339): the run's own progress-over-time chart, bucketed from the
// session telemetry the executor already reported. A person route, like the job read it extends —
// the session arrived through this org's own job row, which is the whole org boundary.
export async function handleJobActivity(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { id } = route;

    const telemetry = await telemetryFor(orgs, request);
    if (!telemetry) return noBoard(reply);

    const job = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job read failed'),
        () => route.store.get(id)
    );
    if (!job.ok) return reply;
    if (job.value === null) return notFoundJob(reply);
    const run = job.value;
    // A run that never started, or whose session was never reported, has nothing to chart —
    // an empty answer, never a fabricated one.
    if (!run.startedAt || !run.sessionId) {
        return reply.code(HTTP_OK).send({
            jobId: id,
            sessionId: null,
            from: null,
            to: null,
            bucketMs: null,
            buckets: [],
        });
    }
    const to = run.finishedAt ?? new Date().toISOString();
    const bucketMs = pickBucketMs(Date.parse(to) - Date.parse(run.startedAt));
    const buckets = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job activity read failed'),
        () => telemetry.runActivity({ sessionId: run.sessionId!, from: run.startedAt!, to, bucketMs })
    );
    if (!buckets.ok) return reply;
    return reply.code(HTTP_OK).send({
        jobId: id,
        sessionId: run.sessionId,
        from: run.startedAt,
        to,
        bucketMs,
        buckets: buckets.value,
    });
}

// The whole follow-up chain containing this task, oldest first. ANY member resolves to the same
// conversation — the UI keeps one task per thread, so the URL may name the root or any adjustment
// and the page must not change identity underneath the reader.
export async function handleThread(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const jobs = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job thread read failed'),
        () => store.thread(id)
    );
    if (!jobs.ok) return reply;
    if (jobs.value === null) return notFoundJob(reply);
    return reply.code(HTTP_OK).send({ jobs: jobs.value });
}

export async function handleListJobs(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const parsed = validateListQuery(request.query as { status?: string; limit?: string; repo?: string });
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);

    const jobs = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job list failed'),
        () => store.list(parsed.value)
    );
    if (!jobs.ok) return reply;
    return reply.code(HTTP_OK).send({ jobs: jobs.value });
}
