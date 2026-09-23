import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import { type BoardScanner, boardsFor, storeFor, workflowsFor } from './job-context.js';
import {
    type ResolvedWorkflow,
    buildWorkflowSelection,
    validateClaimBody,
    validateCommandField,
    validateExecutorField,
    validateGates,
    validateRepoField,
} from './job-field-validation.js';
import { bad, body, guard } from './helpers.js';
import { UUID } from '../config.js';
import {
    HTTP_CREATED,
    HTTP_NOT_FOUND,
    HTTP_NO_CONTENT,
    HTTP_OK,
    LEASE_SECONDS_MAX,
    OUTPUT_LIMIT,
    SESSION_ID,
    leaseSeconds,
    leaseLost,
    noBoard,
    notFoundJob,
    runtimeVitals,
} from './job-limits.js';

type NamedWorkflowStore = NonNullable<Awaited<ReturnType<typeof workflowsFor>>>;

/**
 * Resolves the `workflow` field the create body named, within the caller's visible scopes — repo
 * over user over org when the name exists in several. `handled: true` means a refusal already
 * landed on `reply` and the caller must stop; otherwise the selection and the (possibly
 * interpolated) command are ready to create with.
 */
async function resolveNamedWorkflow(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: {
        workflowsStore: NamedWorkflowStore;
        fields: Record<string, unknown>;
        repo: string | null;
        createdBy: string | null;
        command: string;
    }
): Promise<{ handled: true } | { handled: false; workflow: ResolvedWorkflow; command: string }> {
    const { workflowsStore, fields, repo, createdBy, command } = opts;
    if (typeof fields.workflow !== 'string' || !fields.workflow.trim()) {
        bad(reply, ERROR_CODES.BAD_WORKFLOW, 'workflow must be a non-empty string');
        return { handled: true };
    }
    const found = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'workflow resolution failed'),
        () => workflowsStore.findByName(fields.workflow as string, { userId: createdBy, repo })
    );
    if (!found.ok) return { handled: true };
    if (found.value === null) {
        bad(reply, ERROR_CODES.UNKNOWN_WORKFLOW, `"${fields.workflow}" is not a workflow you can use`, HTTP_NOT_FOUND);
        return { handled: true };
    }
    const selection = buildWorkflowSelection(found.value, fields.workflowParams, command);
    if (!selection.ok) {
        bad(reply, selection.code, selection.message);
        return { handled: true };
    }
    return { handled: false, workflow: selection.value, command: selection.command };
}

export async function handleCreateJob(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const fields = body(request.body);
    const commandResult = validateCommandField(fields.command);
    if (!commandResult.ok) return bad(reply, ERROR_CODES.BAD_COMMAND, commandResult.message);
    // The command the task runs: the member's line verbatim — or, when a workflow resolves, the
    // interpolated ENTRY prompt built below.
    let command = commandResult.value;

    const repoResult = validateRepoField(fields.repo);
    if (!repoResult.ok) return bad(reply, ERROR_CODES.BAD_REPO, repoResult.message);
    const executorResult = validateExecutorField(fields.executor);
    if (!executorResult.ok) return bad(reply, ERROR_CODES.BAD_EXECUTOR, executorResult.message);
    const repo = repoResult.value;
    const executor = executorResult.value;

    // Read off the authenticated request, never off the body: a client-supplied author is
    // impersonation. Null only when the app was built with no auth store at all, which is the
    // route tests' configuration rather than a deployment's.
    const createdBy = callerOf(request)?.user.id ?? null;

    /*
     * The workflow the task walks: exactly the name the body carries, within the caller's visible
     * scopes. An unnamed task resolves NO workflow: the member's words are the whole command, the
     * row and claim byte-identical to pre-027. Naming one is what freezes the snapshot: the
     * store's create stamps the resolved definition onto the root row, and a later edit of the
     * workflow never moves a running thread.
     */
    const workflowsStore = await workflowsFor(orgs, request);
    let workflow: ResolvedWorkflow | null = null;
    if (workflowsStore && fields.workflow !== undefined && fields.workflow !== null) {
        const resolved = await resolveNamedWorkflow(request, reply, {
            workflowsStore,
            fields,
            repo,
            createdBy,
            command,
        });
        if (resolved.handled) return reply;
        workflow = resolved.workflow;
        command = resolved.command;
    }
    // Parameters are workflow-bound: sent beside a task that resolves no workflow, they are a
    // client bug — refused, never silently dropped.
    if (fields.workflowParams !== undefined && fields.workflowParams !== null && workflow === null) {
        return bad(reply, ERROR_CODES.BAD_WORKFLOW_PARAMS, 'workflowParams requires a resolved workflow');
    }

    const created = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job create failed'),
        () => store.create(command, createdBy, { repo, executor, ...(workflow ? { workflow } : {}) })
    );
    if (!created.ok) return reply;
    return reply.code(HTTP_CREATED).send({ id: created.value.id, status: 'queued' });
}

export async function handleClaimJob(
    orgs: OrgRegistry,
    firstJobClaim: BoardScanner,
    request: FastifyRequest,
    reply: FastifyReply
) {
    const boards = await boardsFor(orgs, request);
    if (!boards.length) return noBoard(reply);
    const parsed = validateClaimBody(body(request.body));
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);
    const { worker, lease } = parsed.value;

    const claimFailed = (e: Error) => request.log.error({ err: e }, 'job claim failed');
    const claim = await guard(reply, claimFailed, () =>
        firstJobClaim(boards, claimFailed, (board) => board.claim(worker, lease))
    );
    if (!claim.ok) return reply;
    // 204, not 200 with a null: an idle poll is the common case and it should not have to be
    // parsed to be recognised.
    if (claim.value === null) return reply.code(HTTP_NO_CONTENT).send();
    return reply.code(HTTP_OK).send(claim.value);
}

export async function handleHeartbeat(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

    const { leaseToken, leaseSeconds: requested } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const lease = leaseSeconds(requested);
    if (lease === null) {
        return bad(reply, ERROR_CODES.BAD_LEASE, `leaseSeconds must be an integer 1..${LEASE_SECONDS_MAX}`);
    }

    const beat = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job heartbeat failed'),
        () => store.heartbeat(id, leaseToken, lease)
    );
    if (!beat.ok) return reply;
    if (beat.value.result === 'missing') return notFoundJob(reply);
    // The board cannot stop a worker, only refuse it. A 409 here means this container is running
    // a job that belongs to someone else now, and it must terminate itself.
    if (beat.value.result === 'lost') return leaseLost(reply);
    // `cancelRequested` is the stop channel: the user's /stop stamped the row, and this is the
    // worker reading that it must park. False on every ordinary beat.
    return reply
        .code(HTTP_OK)
        .send({ leaseExpiresAt: beat.value.leaseExpiresAt, cancelRequested: beat.value.cancelRequested });
}

// Reported separately from the completion, and not folded into the claim: the driver mints the
// session id at spawn time, and a run that is still going is exactly when a reader wants to open
// it.
export async function handleSession(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

    const { leaseToken, sessionId } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
        return bad(reply, ERROR_CODES.BAD_SESSION_ID, 'sessionId must be a short opaque token');
    }

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job session failed'),
        () => store.session(id, leaseToken, sessionId)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'lost') return leaseLost(reply);
    return reply.code(HTTP_OK).send({ id, sessionId });
}

// A rolling tail of the running attempt's output, so the dashboard shows the work while it
// happens. Separate from complete because the run has not ended — there is no verdict here, and
// the final complete report overwrites whatever this last stored. The driver owns the window:
// this stores the tail it is sent, replacing the previous one, truncated by the same rule
// complete applies. An optional `runtime` object rides beside the tail — the driver's latest
// sample of the runner container's CPU/memory plus the agent's current activity line, the
// dashboard's "is it stuck or working" answer. Absent (or null) means no fresh sample: the last
// stored one stays. Replaced, never appended, like the tail.
export async function handleOutput(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

    const { leaseToken, output, runtime } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    if (typeof output !== 'string') {
        return bad(reply, ERROR_CODES.BAD_OUTPUT, 'output must be a string');
    }
    const vitals = runtimeVitals(runtime);
    if (typeof vitals === 'string') return bad(reply, ERROR_CODES.BAD_RUNTIME, vitals);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job output failed'),
        () => store.progress(id, leaseToken, output.slice(0, OUTPUT_LIMIT), vitals)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'lost') return leaseLost(reply);
    return reply.code(HTTP_OK).send({ id });
}

// The verification gates a job's checkout declares, executed by the driver in the declared
// environment image. Separate from /output because the run has not ended and there is no verdict
// here; the report REPLACES the stored list, which is what makes the UI's "current/last ran only"
// honest rather than a truncation somebody has to remember.
export async function handleGates(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

    const { leaseToken, gates } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const parsed = validateGates(gates);
    if (!parsed.ok) return bad(reply, ERROR_CODES.BAD_GATES, parsed.message);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job gates failed'),
        () => store.gates(id, leaseToken, parsed.value)
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'lost') return leaseLost(reply);
    return reply.code(HTTP_OK).send({ id });
}

// Re-reads what the job's checkout declares in .bellows.yaml. The claim read the file before the
// driver's startup sync brought the checkout up to the remote default, so the claim's answer can
// be stale by the time the run starts — the driver calls this right after the sync, and gates the
// run on what the tree holds NOW. Lease-guarded like every worker route: the fresh answer goes
// only to the worker that holds the run.
export async function handleGatesReread(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

    const { leaseToken } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }

    const reread = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job gates re-read failed'),
        () => store.rereadGates(id, leaseToken)
    );
    if (!reread.ok) return reply;
    if (reread.value.result !== 'ok') {
        if (reread.value.result === 'missing') return notFoundJob(reply);
        return leaseLost(reply);
    }
    return reply.code(HTTP_OK).send({ gates: reread.value.gates, gateError: reread.value.gateError });
}

// A publish credential for the run's final push. The claim mints a full-hour installation token,
// and a run can outlive it — the driver asks HERE, right before the push, and gets the claim's
// environment resolved now: an operator-configured GITHUB_TOKEN wins exactly as at claim time,
// and the mint (when there is one) is fresh, not the claim's hour-old token (observed 2026-09-13,
// job 43379d3a: a 1h33m run's push died on its expired claim credential with the work done and
// the gates green). Lease-guarded like every worker route: the credential goes only to the
// worker that holds the run. `GITHUB_TOKEN: null` — nothing fresher than the claim env — is an
// answer, not an error.
export async function handlePublishToken(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

    const { leaseToken } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }

    const minted = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'publish token mint failed'),
        () => store.publishToken(id, leaseToken)
    );
    if (!minted.ok) return reply;
    if (minted.value.result !== 'ok') {
        if (minted.value.result === 'missing') return notFoundJob(reply);
        return leaseLost(reply);
    }
    return reply.code(HTTP_OK).send({ GITHUB_TOKEN: minted.value.token });
}

// Ending a running job's attempt. Separate from complete because there is no worker outcome
// here: an exit code would have to be invented, and inventing one makes a user's stop
// indistinguishable from a run that ended on its own. The row lands `stopped` — the park is the
// user's stop landing — and the answer carries the status.
export async function handleSuspend(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeFor(orgs, request);
    if (!store) return noBoard(reply);
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');

    const { leaseToken } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job suspend failed'),
        () => store.suspend(id, leaseToken)
    );
    if (!result.ok) return reply;
    if (result.value.result === 'missing') return notFoundJob(reply);
    if (result.value.result === 'lost') return leaseLost(reply);
    return reply.code(HTTP_OK).send({ id, status: result.value.status });
}
