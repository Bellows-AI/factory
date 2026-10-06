import { ERROR_CODES, executorSuspendedMessage, type ExecutorScope } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import {
    type BoardScanner,
    boardsFor,
    executorsFor,
    storeFor,
    userReposFor,
    workflowDefaultsFor,
    workflowsFor,
} from './job-context.js';
import { resolveLaunchWorkflow } from './job-workflow-resolution.js';
import { validateArtifactBody } from './job-field-validation-artifacts.js';
import {
    type ResolvedWorkflow,
    validateCommandField,
    validateExecutorField,
    validateExecutorScopeField,
    validateGates,
    validateRepoField,
} from './job-field-validation.js';
import { bad, body, guard } from './helpers.js';
import { resolveClaimRoute, resolveJobRoute } from './route-guards.js';
import { fullName, UUID } from '../config.js';
import {
    ARTIFACT_LIMIT,
    HTTP_CONFLICT,
    HTTP_CREATED,
    HTTP_NO_CONTENT,
    HTTP_OK,
    HTTP_UNAVAILABLE,
    LEASE_BATCH_MAX,
    LEASE_SECONDS_MAX,
    OUTPUT_LIMIT,
    SESSION_ID,
    leaseSeconds,
    leaseLost,
    noBoard,
    notFoundJob,
    runtimeVitals,
} from './job-limits.js';

/**
 * A suspended profile launches nothing (issue 440): refused with its own code, so a client is told
 * why instead of queueing a task the claim would fail. True when a refusal (or a failed read) has
 * already landed on `reply`.
 */
async function refusedAsSuspended(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: {
        executorsStore: Awaited<ReturnType<typeof executorsFor>>;
        executor: string | null;
        executorScope: ExecutorScope;
        createdBy: string | null;
    }
): Promise<boolean> {
    const { executorsStore, executor, executorScope, createdBy } = opts;
    if (!executorsStore || !createdBy || !executor) return false;
    const target = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'executor row read failed'),
        () => executorsStore.configFor(createdBy, executor, executorScope)
    );
    if (!target.ok) return true;
    if (!target.value?.suspended) return false;
    bad(reply, ERROR_CODES.EXECUTOR_SUSPENDED, executorSuspendedMessage(executorScope, executor), HTTP_CONFLICT);
    return true;
}

/**
 * A task runs against a checkout (issue 263): the repository must be in the caller's own selection
 * AND `ready`. Revalidated here, whatever the browser believed — a deselection or a failed clone
 * between page load and submit is refused, never queued. True when a refusal (or a failed read) has
 * already landed on `reply`. Skipped where no member or repo store exists: the route tests'
 * configuration, as for the suspension check above.
 */
async function refusedAsNotSynced(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { userRepos: Awaited<ReturnType<typeof userReposFor>>; repo: string | null; createdBy: string | null }
): Promise<boolean> {
    const { userRepos, repo, createdBy } = opts;
    if (!userRepos || !createdBy) return false;
    if (repo === null) {
        bad(reply, ERROR_CODES.REPO_REQUIRED, 'Select a synced repository to run this task against.');
        return true;
    }
    const selected = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'repo selection read failed'),
        () => userRepos.list(createdBy)
    );
    if (!selected.ok) return true;
    const row = selected.value.find((candidate) => fullName(candidate) === repo);
    if (row?.status === 'ready') return false;
    if (!row) {
        bad(reply, ERROR_CODES.REPO_REQUIRED, `${repo} is not in your selected repositories.`);
    } else {
        bad(
            reply,
            ERROR_CODES.REPO_NOT_READY,
            `${repo} is ${row.status}, not synced yet. Wait for it to finish syncing, then start the task.`,
            HTTP_CONFLICT
        );
    }
    return true;
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
    const scopeResult = validateExecutorScopeField(fields.executorScope);
    if (!scopeResult.ok) return bad(reply, ERROR_CODES.BAD_EXECUTOR_SCOPE, scopeResult.message);
    const repo = repoResult.value;
    const executor = executorResult.value;
    const executorScope = scopeResult.value;

    // Read off the authenticated request, never off the body: a client-supplied author is
    // impersonation. Null only when the app was built with no auth store at all, which is the
    // route tests' configuration rather than a deployment's.
    const createdBy = callerOf(request)?.user.id ?? null;

    /*
     * The workflow the task walks (issue #209's launch contract): an explicit `workflow` name
     * resolves the caller's visible scopes exactly as before; an unnamed task now resolves the
     * code-owned DEFAULT workflow instead of none at all — the mandatory `{{command}}` spine plus
     * whichever optional blocks the caller selected. Naming one, named or default, is what freezes
     * the snapshot: the store's create stamps the resolved definition onto the root row, and a
     * later edit (a custom workflow, or the caller's saved settings) never moves a running thread.
     */
    const workflowsStore = await workflowsFor(orgs, request);
    const defaultsStore = await workflowDefaultsFor(orgs, request);
    const executorsStore = await executorsFor(orgs, request);
    if (await refusedAsSuspended(request, reply, { executorsStore, executor, executorScope, createdBy })) {
        return reply;
    }
    const userRepos = await userReposFor(orgs, request);
    if (await refusedAsNotSynced(request, reply, { userRepos, repo, createdBy })) return reply;
    const resolved = await resolveLaunchWorkflow(request, reply, {
        workflowsStore,
        defaultsStore,
        executorsStore,
        executor,
        executorScope,
        fields,
        repo,
        createdBy,
        command,
    });
    if (resolved.handled) return reply;
    const workflow: ResolvedWorkflow | null = resolved.workflow;
    command = resolved.command;
    // Parameters are workflow-bound: sent beside a task that resolves no workflow at all (the
    // degenerate no-workflows-store branch `resolveLaunchWorkflow` preserves), they are a client
    // bug — refused, never silently dropped. Every OTHER path (named, or the default) already
    // validated `workflowParams` against its own definition's declarations before returning here.
    if (fields.workflowParams !== undefined && fields.workflowParams !== null && workflow === null) {
        return bad(reply, ERROR_CODES.BAD_WORKFLOW_PARAMS, 'workflowParams requires a resolved workflow');
    }

    const created = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job create failed'),
        () =>
            store.create(command, createdBy, {
                repo,
                executor,
                executorScope,
                ...(workflow ? { workflow } : {}),
            })
    );
    if (!created.ok) return reply;
    // The author's checkout row was `purging` when the insert transaction took its lock (issue
    // #92): a task cannot be queued into a checkout that is being deleted.
    if (created.value === 'purging') {
        return reply.code(HTTP_CONFLICT).send({
            error: 'The checkout for this task is being deleted from disk',
            code: ERROR_CODES.PURGE_IN_PROGRESS,
        });
    }
    return reply.code(HTTP_CREATED).send({ id: created.value.id, status: 'queued' });
}

export async function handleClaimJob(
    orgs: OrgRegistry,
    firstJobClaim: BoardScanner,
    request: FastifyRequest,
    reply: FastifyReply
) {
    const claimRoute = await resolveClaimRoute(orgs, request, reply);
    if (!claimRoute) return reply;
    const { boards, worker, lease } = claimRoute;

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
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

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
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken, sessionId } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    // An explicit null clears the session: a refused start's minted id never ran.
    if (sessionId !== null && (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))) {
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
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

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
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

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

// The run artifacts (issue #325): the driver uploads the full-run log and the agent transcript at
// close, while its lease is still live, and the read routes serve them to investigating readers.
// The content bound is enforced HERE, not trusted from the worker — the same rule the output tail
// follows — and a cut forces `truncated` beside it. A 409 from this route is not a kill order, the
// same rule /output states: the upload is retention, never a verdict.
export async function handleArtifact(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const parsed = validateArtifactBody(body(request.body));
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);

    // Sliced, not refused — the point is retention, not protocol discipline. The slice is in
    // characters (the OUTPUT_LIMIT precedent; the honest driver byte-caps before upload) and
    // keeps the TAIL — the driver's cut is tail-kept, and the read routes promise the head bytes
    // were dropped, not stored elsewhere. The flag is forced when the route cut what the driver
    // thought fit: the reader must be able to trust it.
    const raw = parsed.value.content;
    const content = raw.length > ARTIFACT_LIMIT ? raw.slice(raw.length - ARTIFACT_LIMIT) : raw;
    const truncated = parsed.value.truncated || content.length < parsed.value.content.length;

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job artifact upload failed'),
        () => store.artifact(id, leaseToken, { ...parsed.value, content, truncated })
    );
    if (!result.ok) return reply;
    if (result.value === 'missing') return notFoundJob(reply);
    if (result.value === 'lost') return leaseLost(reply);
    return reply.code(HTTP_OK).send({ id, kind: parsed.value.kind, attempt: parsed.value.attempt });
}

// Re-reads what the job's checkout declares in .bellows.yaml. The claim read the file before the
// driver's startup sync brought the checkout up to the remote default, so the claim's answer can
// be stale by the time the run starts — the driver calls this right after the sync, and gates the
// run on what the tree holds NOW. Lease-guarded like every worker route: the fresh answer goes
// only to the worker that holds the run.
export async function handleGatesReread(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

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
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

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
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

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

/*
 * The orphan reaper's one board route (issue #301): a batched "what does the board think of these
 * job ids" — each known id's status and CURRENT lease, absent for the ids it does not know. The
 * shared secret authenticates the driver, not an org, so like the claim this is offered every
 * org's board and the answers merge by id; uuids cannot collide across orgs. Unlike every other
 * worker route there is NO lease guard — the reaper holds no lease, and that is the whole point —
 * and it is read-only: it answers facts a terminal row's reader could already see.
 *
 * The strictness is the driver's safety: ANY board failing ⇒ 503, so a sweep is never decided by
 * a partial answer — "absent means unknown" is only true when every board that could know the id
 * actually answered.
 */
export async function handleLeases(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const boards = await boardsFor(orgs, request);
    if (!boards.length) return noBoard(reply);
    // Fail closed on the every-org worker path: boardsFor DROPS an org whose runtime failed to
    // build, and every id of a dropped board would read as "unknown to the board" — a reap
    // verdict. Answering from a partial registry is the one thing this route must never do, so a
    // registry that cannot fully answer is a 503, exactly like a board that throws. The org-less
    // shape is the worker-token path only; `none` mode falls through to the caller's own org —
    // one board IS the whole registry there, whatever foreign org rows a shared database holds.
    if (
        request.auth?.kind === 'worker' &&
        request.auth.orgId === null &&
        (await orgs.list()).length !== boards.length
    ) {
        return bad(reply, ERROR_CODES.UNAVAILABLE, 'Not every organization board answered', HTTP_UNAVAILABLE);
    }

    const { ids } = body(request.body);
    if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > LEASE_BATCH_MAX ||
        ids.some((id) => typeof id !== 'string' || !UUID.test(id))
    ) {
        return bad(reply, ERROR_CODES.BAD_ID, `ids must be 1..${LEASE_BATCH_MAX} uuids`);
    }

    const answered = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job lease lookup failed'),
        () => Promise.all(boards.map((board) => board.leases(ids as string[])))
    );
    if (!answered.ok) return reply;
    const jobs = [...new Map(answered.value.flat().map((row) => [row.id, row])).values()];
    return reply.code(HTTP_OK).send({ jobs });
}
