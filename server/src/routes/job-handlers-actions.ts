import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import { type BoardScanner, boardsFor, storeFor } from './job-context.js';
import {
    followUpRefusal,
    validateClaimBody,
    validateCommandField,
    validateCompleteFields,
    validateListQuery,
    validatePublication,
    validateWorkerField,
} from './job-field-validation.js';
import { bad, body, guard } from './helpers.js';
import { UUID } from '../config.js';
import {
    HTTP_ACCEPTED,
    HTTP_CONFLICT,
    HTTP_CREATED,
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
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

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

// The user's verdict that the task is done — the one no run can make. Idempotent in the store, so
// a retried click answers the same instant rather than rewriting it.
export async function handleDone(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

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

// The user's stop. Two fates in one answer: a queued (never started), an already parked, or a
// running row whose lease has already expired (#152) is settled `stopped` directly — the turn is
// over — while a running row under a live lease is left running and stamped, and the WORKER
// settles it when its next heartbeat reports the stamp (suspend lands `stopped` under the flag).
// Either way the turn ends and the session stays, so the follow-up composer is what the member
// sees next. 202 for the moving case, because the request RIDES to the worker and the settle
// lands moments later.
export async function handleStop(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

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
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

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
    const boards = await boardsFor(orgs, request);
    if (!boards.length) return noBoard(reply);
    const parsed = validateClaimBody(body(request.body));
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);
    const { worker, lease } = parsed.value;

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
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

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
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

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
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

    const job = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job read failed'),
        () => store.get(id)
    );
    if (!job.ok) return reply;
    if (job.value === null) return notFoundJob(reply);
    return reply.code(HTTP_OK).send(job.value);
}

// The whole follow-up chain containing this task, oldest first. ANY member resolves to the same
// conversation — the UI keeps one task per thread, so the URL may name the root or any adjustment
// and the page must not change identity underneath the reader.
export async function handleThread(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

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
