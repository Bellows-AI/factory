import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { GateReport, JobOutcome, JobStatus, JobStore, RuntimeVitals, ServiceStatus } from '../db/job-store.js';
import {
    type ParamValues,
    type WorkflowDefinition,
    checkWorkflowParams,
    interpolate,
    nodeOf,
} from '../db/workflow-schema.js';
import type { OrgRegistry } from '../orgs.js';
import { UUID, bad, badSegment, body, guard } from './helpers.js';

export interface JobRouteDeps {
    /** The per-org runtimes; the store a request touches is the CALLER's org's. */
    orgs: OrgRegistry;
}

/**
 * A command is a shell line, not a payload. 16 KiB is far past anything a human writes, and past
 * anything a generated one should be; the body limit is a little above it so an oversized command
 * is refused with a reason rather than a bare connection error.
 */
const COMMAND_LIMIT = 16_384;
const BODY_LIMIT = 128 * 1024;

/**
 * The repo and executor labels a task may carry. The repo label is display metadata for the tasks
 * chat — the chat groups by repository. The executor label is consumed at claim time: the claim
 * reads the AUTHOR's executor row of that name, and for an `opencode` row the pasted config rides
 * the claim env as `OPENCODE_CONFIG_CONTENT` (docs/env.md) — how the member's model and provider
 * choice reach the run. Both are validated by shape only, under the same path-segment rules a
 * checkout's directory name obeys, never against the member's configured rows: `job` is an audit
 * record, and the rows it would be validated against come and go with a PUT. A label that matches
 * no current row runs exactly as an unlabelled job. A length cap would dead-end an executor name
 * the selection route accepted, so neither field has one here either — the body limit bounds them
 * the way it bounds the command. See docs/jobs.md.
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
 * timestamp must parse — the UI reads its staleness off it. The numbers may be null: "not read
 * this round" is honest data beside a service fleet that was read (a cluster with no
 * metrics-server reports exactly that). The attempt's `.bellows.yaml` services ride the same
 * object under the same grammar the driver's own parser enforces — copied, not imported.
 *
 * Returns the validated value, null for "no sample this round", or the reason the object is bad.
 */
const CPU_PERCENT_MAX = 10_000;
const MEM_MB_MAX = 10_000_000;
const RUNTIME_ACTIVITY_LIMIT = 512;

/** The context stats a verdict may carry: a token count no real window reaches, a cost no run hits. */
const CONTEXT_TOKENS_MAX = 100_000_000;
const CONTEXT_COST_MAX = 1_000_000;
/** `job.agent_turns` is an int4 column: the route is the boundary that keeps the verdict writable. */
const AGENT_TURNS_MAX = 2_147_483_647;
/**
 * The close-time summary is one line of prose, not a log — the driver truncates to a line and
 * the route is the boundary past which a stream cannot enter the list payload.
 */
const SUMMARY_LIMIT = 512;

/** The workspace's ten-service cap, and the name/state shapes the driver's parser enforces. */
const SERVICES_MAX = 10;
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
const SERVICE_STATE = /^[a-z][a-z-]{0,31}$/;
/** Past any legal registry path — an image that long must not bounce every flush of a live run. */
const SERVICE_IMAGE_LIMIT = 2048;

function serviceStatus(raw: unknown, at: string): ServiceStatus | string {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${at} must be an object`;
    const { name, image, state } = raw as Record<string, unknown>;
    if (typeof name !== 'string' || !SERVICE_NAME.test(name)) {
        return `${at}.name must be a lowercase DNS label`;
    }
    if (typeof image !== 'string' || !image.trim() || image.length > SERVICE_IMAGE_LIMIT) {
        return `${at}.image must be a non-empty string of at most ${SERVICE_IMAGE_LIMIT} characters`;
    }
    if (typeof state !== 'string' || !SERVICE_STATE.test(state)) {
        return `${at}.state must be a lowercase word`;
    }
    return { name, image, state };
}

function runtimeVitals(raw: unknown): RuntimeVitals | null | string {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) return 'runtime must be an object';
    const fields = raw as Record<string, unknown>;
    const { cpuPercent, memUsedMb, memPercent, activity, sampledAt, services } = fields;
    if (
        cpuPercent !== null &&
        (typeof cpuPercent !== 'number' ||
            !Number.isFinite(cpuPercent) ||
            cpuPercent < 0 ||
            cpuPercent > CPU_PERCENT_MAX)
    ) {
        return `runtime.cpuPercent must be a number 0..${CPU_PERCENT_MAX} or null`;
    }
    if (
        memUsedMb !== null &&
        (typeof memUsedMb !== 'number' || !Number.isFinite(memUsedMb) || memUsedMb < 0 || memUsedMb > MEM_MB_MAX)
    ) {
        return `runtime.memUsedMb must be a number 0..${MEM_MB_MAX} or null`;
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
    let fleet: ServiceStatus[] | undefined;
    if (services !== undefined) {
        if (!Array.isArray(services) || services.length > SERVICES_MAX) {
            return `runtime.services must be an array of at most ${SERVICES_MAX} items`;
        }
        fleet = [];
        for (const [i, item] of services.entries()) {
            const one = serviceStatus(item, `runtime.services[${i}]`);
            if (typeof one === 'string') return one;
            fleet.push(one);
        }
        // An empty list is "no fleet", the shape the driver actually reports: no key at all.
        if (fleet.length === 0) fleet = undefined;
    }
    return {
        cpuPercent: cpuPercent as number | null,
        memUsedMb: memUsedMb as number | null,
        memPercent: (memPercent as number | null | undefined) ?? null,
        activity: typeof activity === 'string' ? activity.trim().slice(0, RUNTIME_ACTIVITY_LIMIT) : null,
        sampledAt: sampledAt.slice(0, 64),
        ...(fleet ? { services: fleet } : {}),
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

const STATUSES: readonly JobStatus[] = ['queued', 'running', 'standby', 'succeeded', 'failed', 'dead', 'stopped'];

function leaseSeconds(raw: unknown): number | null {
    if (raw === undefined || raw === null) return LEASE_SECONDS_DEFAULT;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > LEASE_SECONDS_MAX) return null;
    return raw;
}

export const jobRoutes =
    ({ orgs }: JobRouteDeps): FastifyPluginAsync =>
    async (app) => {
        /**
         * The job board a request lands on is its caller's org's (#99): the session, the personal
         * token or the worker secret's resolved org each names one, and the runtime resolved from
         * it carries that org's store. Absent in the route-test mode with no stores behind the
         * registry.
         */
        const storeOf = async (request: FastifyRequest): Promise<JobStore | null> => {
            const rt = await orgs.for(orgOf(request));
            return rt?.jobs ?? null;
        };
        /**
         * The boards a WORKER call may reach. The shared secret authenticates the driver, not an
         * org, so a claim names no row and no org: it is offered EVERY org's queue, first claim
         * wins and the empty orgs cost one idle poll each. Every other worker route arrives with
         * the org the auth hook read from the row its URL names, and is a one-element list.
         */
        const boardsOf = async (request: FastifyRequest): Promise<JobStore[]> => {
            if (request.auth?.kind === 'worker' && request.auth.orgId === null) {
                const boards: JobStore[] = [];
                for (const org of await orgs.list()) {
                    const rt = await orgs.for(org.id);
                    if (rt?.jobs) boards.push(rt.jobs);
                }
                return boards;
            }
            const store = await storeOf(request);
            return store ? [store] : [];
        };
        /** The workflow definitions the create may resolve against — the caller's org's (#99). */
        const workflowsOf = async (request: FastifyRequest) => {
            const rt = await orgs.for(orgOf(request));
            return rt?.workflows ?? null;
        };
        app.post('/api/jobs', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const fields = body(request.body);
            const rawCommand = fields.command;
            if (typeof rawCommand !== 'string' || !rawCommand.trim()) {
                return bad(reply, 'BAD_COMMAND', 'command must be a non-empty string');
            }
            if (rawCommand.length > COMMAND_LIMIT) {
                return bad(reply, 'BAD_COMMAND', `command exceeds ${COMMAND_LIMIT} characters`);
            }
            // The command the task runs: the member's line verbatim — or, when a workflow
            // resolves, the interpolated ENTRY prompt built below.
            let command: string = rawCommand;

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
            const caller = callerOf(request);
            const createdBy = caller?.user.id ?? null;

            /*
             * The workflow the task will walk, resolved by the board (docs/workflows.md): a named
             * workflow within the caller's visible scopes — repo over user over org when the name
             * exists in several — or, unnamed, the scope stack's default. The resolution is also
             * what freezes the snapshot: the store's create stamps the resolved definition onto
             * the root row, and a later edit of the workflow never moves a running thread. A
             * create that resolves NO workflow calls the store exactly as before 027 — no field,
             * no read, a byte-identical row and claim.
             */
            const workflowsStore = await workflowsOf(request);
            let workflow: { id: string; node: string; snapshot: WorkflowDefinition; params: ParamValues } | null = null;
            if (workflowsStore) {
                const resolve = async () => {
                    const target = {
                        userId: createdBy,
                        repo: typeof repo === 'string' ? repo : null,
                    };
                    if (fields.workflow !== undefined && fields.workflow !== null) {
                        if (typeof fields.workflow !== 'string' || !fields.workflow.trim()) {
                            return { bad: 'BAD_WORKFLOW' as const };
                        }
                        return {
                            found: await workflowsStore.findByName(fields.workflow, target),
                            wanted: fields.workflow,
                        };
                    }
                    return { found: await workflowsStore.resolveDefault(target), wanted: null };
                };
                const resolved = await guard(
                    reply,
                    (e) => request.log.error({ err: e }, 'workflow resolution failed'),
                    resolve
                );
                if (!resolved.ok) return reply;
                if ('bad' in resolved.value) {
                    return bad(reply, 'BAD_WORKFLOW', 'workflow must be a non-empty string');
                }
                if (resolved.value.found === null && resolved.value.wanted !== null) {
                    return bad(
                        reply,
                        'UNKNOWN_WORKFLOW',
                        `"${resolved.value.wanted}" is not a workflow you can use`,
                        404
                    );
                }
                if (resolved.value.found !== null) {
                    const definition = resolved.value.found.definition;
                    // The declared parameters are code-enforced, not prompt-discipline: a
                    // parametrized workflow must never launch on a guess, so a missing or
                    // malformed value refuses HERE — a 400 to the composer, not a runner
                    // improvising (issue #127).
                    const checked = checkWorkflowParams(definition, fields.workflowParams);
                    if (!checked.ok) {
                        return bad(reply, checked.refusal.code, checked.refusal.message);
                    }
                    // The root row runs the ENTRY node's prompt, interpolated now with the
                    // member's own words — the graph's first run IS the task. `{{command}}`
                    // carries the chat line; `{{param.*}}` the validated values; `{{node.*}}`
                    // is empty HERE by definition (no run of this thread exists yet — an entry
                    // re-entered later by an edge interpolates real outputs, in complete()).
                    // The same cap applies to the built command as to a raw one.
                    const entry = nodeOf(definition, definition.entry);
                    if (!entry) return bad(reply, 'BAD_WORKFLOW', 'workflow has no entry node');
                    command = interpolate(entry.prompt, {
                        nodeOutput: () => '',
                        gateName: '',
                        gateOutput: '',
                        param: (name) => checked.values[name] ?? '',
                        command,
                    });
                    if (command.length > COMMAND_LIMIT) {
                        return bad(reply, 'BAD_COMMAND', `command exceeds ${COMMAND_LIMIT} characters`);
                    }
                    workflow = {
                        id: resolved.value.found.id,
                        node: definition.entry,
                        snapshot: definition,
                        params: checked.values,
                    };
                }
            }
            // Parameters are workflow-bound: sent beside a task that resolves no workflow, they
            // are a client bug — refused, never silently dropped.
            if (fields.workflowParams !== undefined && fields.workflowParams !== null && workflow === null) {
                return bad(reply, 'BAD_WORKFLOW_PARAMS', 'workflowParams requires a resolved workflow');
            }

            const created = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job create failed'),
                () =>
                    store.create(command, createdBy, {
                        repo: typeof repo === 'string' ? repo : null,
                        executor: typeof executor === 'string' ? executor : null,
                        ...(workflow ? { workflow } : {}),
                    })
            );
            if (!created.ok) return reply;
            return reply.code(201).send({ id: created.value.id, status: 'queued' });
        });

        // POST, not GET: claiming mutates. The worker id is required — it is the only thing that
        // says which container is holding a job when one has to be found and killed.
        app.post('/api/jobs/claim', { bodyLimit: 4096 }, async (request, reply) => {
            const boards = await boardsOf(request);
            if (!boards.length) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const { worker, leaseSeconds: requested } = body(request.body);
            if (typeof worker !== 'string' || !worker.trim() || worker.length > 128) {
                return bad(reply, 'BAD_WORKER', 'worker must be a non-empty string');
            }
            const lease = leaseSeconds(requested);
            if (lease === null) {
                return bad(reply, 'BAD_LEASE', `leaseSeconds must be an integer 1..${LEASE_SECONDS_MAX}`);
            }

            // First board with work wins; the rest cost one idle poll each. With the common
            // single-org deployment this is the single claim query it always was.
            const claim = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job claim failed'),
                async () => {
                    for (const board of boards) {
                        const claimed = await board.claim(worker, lease);
                        if (claimed !== null) return claimed;
                    }
                    return null;
                }
            );
            if (!claim.ok) return reply;
            // 204, not 200 with a null: an idle poll is the common case and it should not have to
            // be parsed to be recognised.
            if (claim.value === null) return reply.code(204).send();
            return reply.code(200).send(claim.value);
        });

        app.post('/api/jobs/:id/heartbeat', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
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

            const beat = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job heartbeat failed'),
                () => store.heartbeat(id, leaseToken, lease)
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
            // `cancelRequested` is the stop channel: the user's /stop stamped the row, and this is
            // the worker reading that it must park. False on every ordinary beat.
            return reply
                .code(200)
                .send({ leaseExpiresAt: beat.value.leaseExpiresAt, cancelRequested: beat.value.cancelRequested });
        });

        // Reported separately from the completion, and not folded into the claim: the driver mints
        // the session id at spawn time, and a run that is still going is exactly when a reader wants
        // to open it.
        app.post('/api/jobs/:id/session', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
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
                    `remoteSessionId must be a non-empty string of at most ${REMOTE_SESSION_LIMIT} characters`
                );
            }

            const result = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job session failed'),
                () => store.session(id, leaseToken, sessionId, (remoteSessionId as string | undefined) ?? null)
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
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
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

            const result = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job output failed'),
                () => store.progress(id, leaseToken, output.slice(0, OUTPUT_LIMIT), vitals)
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
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
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

            const result = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job gates failed'),
                () => store.gates(id, leaseToken, results)
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
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken } = body(request.body);
            if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
                return bad(reply, 'BAD_TOKEN', 'leaseToken must be a uuid');
            }

            const reread = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job gates re-read failed'),
                () => store.rereadGates(id, leaseToken)
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

        // A publish credential for the run's final push. The claim mints a full-hour installation
        // token, and a run can outlive it — the driver asks HERE, right before the push, and gets
        // the claim's environment resolved now: an operator-configured GITHUB_TOKEN wins exactly
        // as at claim time, and the mint (when there is one) is fresh, not the claim's
        // hour-old token (observed 2026-09-13, job 43379d3a: a 1h33m run's push died on its
        // expired claim credential with the work done and the gates green). Lease-guarded like
        // every worker route: the credential goes only to the worker that holds the run.
        // `GITHUB_TOKEN: null` — nothing fresher than the claim env — is an answer, not an error.
        app.post('/api/jobs/:id/publish-token', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken } = body(request.body);
            if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
                return bad(reply, 'BAD_TOKEN', 'leaseToken must be a uuid');
            }

            const minted = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'publish token mint failed'),
                () => store.publishToken(id, leaseToken)
            );
            if (!minted.ok) return reply;
            if (minted.value.result !== 'ok') {
                if (minted.value.result === 'missing') {
                    return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
                }
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ GITHUB_TOKEN: minted.value.token });
        });

        // Ending a running job's attempt. Separate from complete because there is no worker
        // outcome here: an exit code would have to be invented, and inventing one makes a user's
        // stop indistinguishable from a run that ended on its own. Where the row lands is the
        // board's decision, read off the stop stamp the heartbeat delivered — `stopped` when the
        // park was the user's stop landing, `standby` for the Remote Control idle park — and the
        // answer carries it.
        app.post('/api/jobs/:id/suspend', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken } = body(request.body);
            if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
                return bad(reply, 'BAD_TOKEN', 'leaseToken must be a uuid');
            }

            const result = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job suspend failed'),
                () => store.suspend(id, leaseToken)
            );
            if (!result.ok) return reply;
            if (result.value.result === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            if (result.value.result === 'lost') {
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ id, status: result.value.status });
        });

        // A person's action on a finished task: queue an adjustment as a continuation of the run
        // it just did. The store decides every refusal atomically with the insert, so a follow-up
        // can never land on a parent that turns out to be running or done. No lease token — the
        // task is finished, nobody holds it, and this is a person's action for exactly that reason.
        // The executor is NOT taken from the body: the adjustment is bound to the executor that
        // ran the task, copied from the parent at insert like the repo and the session.
        app.post('/api/jobs/:id/follow-up', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
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

            const created = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job follow-up failed'),
                () => store.createFollowUp(id, command, createdBy)
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
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const result = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job done failed'),
                // The actor comes from the session, never a body — the same rule as create.
                () => store.markDone(id, callerOf(request)?.user.id ?? null)
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

        // The user's stop. Two fates in one answer: a queued (never started) or already parked row
        // is settled `stopped` directly — the turn is over — while a running row is left running
        // and stamped, and the WORKER settles it when its next heartbeat reports the stamp
        // (suspend lands `stopped` under the flag). Either way the turn ends and the session
        // stays, so the follow-up composer is what the member sees next. 202 for the moving case,
        // because the request RIDES to the worker and the settle lands moments later.
        app.post('/api/jobs/:id/stop', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const result = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job stop failed'),
                // The actor comes from the session, never a body — the same rule as create.
                () => store.stop(id, callerOf(request)?.user.id ?? null)
            );
            if (!result.ok) return reply;
            if (result.value === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            if (result.value.result === 'conflict') {
                return reply.code(409).send({
                    error: `Task is ${result.value.status} — nothing to stop`,
                    code: 'NOT_STOPPABLE',
                    status: result.value.status,
                });
            }
            if (result.value.result === 'requested') {
                return reply
                    .code(202)
                    .send({ id, status: 'running', cancelRequestedAt: result.value.cancelRequestedAt });
            }
            return reply.code(200).send({ id, status: 'stopped' });
        });

        // The user's remove: the thread is gone and a worktree reclaim is queued. Person-gated like
        // every job write here, not just because the driver has no use for it — the board secret
        // deleting the audit rows of jobs it never held would be exactly the thread-read hole again.
        app.post('/api/jobs/:id/remove', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const result = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job remove failed'),
                // The actor comes from the session, never a body — the same rule as create. It
                // rides the task_reclaim row: the thread rows are deleted in the same transaction.
                () => store.removeThread(id, callerOf(request)?.user.id ?? null)
            );
            if (!result.ok) return reply;
            if (result.value === 'missing') {
                return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            }
            if (result.value === 'conflict') {
                return reply
                    .code(409)
                    .send({ error: 'The task is still running — stop it first', code: 'TASK_RUNNING' });
            }
            return reply.code(200).send({ id, removed: true });
        });

        // The driver's poll of the worktree-reclaim queue: the rows POST /remove left behind for
        // worktrees no live driver holds a lease on. Claim and ack are the worker routes the job
        // claim/complete are, and the body matches: the worker name is required (it is queued for
        // exactly this claim), and an idle poll answers 204 rather than a parsed null.
        app.post('/api/reclaims/claim', { bodyLimit: 4096 }, async (request, reply) => {
            const boards = await boardsOf(request);
            if (!boards.length) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const { worker, leaseSeconds: requested } = body(request.body);
            if (typeof worker !== 'string' || !worker.trim() || worker.length > 128) {
                return bad(reply, 'BAD_WORKER', 'worker must be a non-empty string');
            }
            const lease = leaseSeconds(requested);
            if (lease === null) {
                return bad(reply, 'BAD_LEASE', `leaseSeconds must be an integer 1..${LEASE_SECONDS_MAX}`);
            }

            const claim = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'reclaim claim failed'),
                async () => {
                    for (const board of boards) {
                        const claimed = await board.claimReclaim(worker, lease);
                        if (claimed !== null) return claimed;
                    }
                    return null;
                }
            );
            if (!claim.ok) return reply;
            if (claim.value === null) return reply.code(204).send();
            return reply.code(200).send(claim.value);
        });

        // The driver's proof that a parked worktree is gone. Only the worker that holds the claim
        // may ack it, so a slow worker's row survives a foreign ack and finishes on its next try.
        app.post('/api/reclaims/:id/ack', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { worker } = body(request.body);
            if (typeof worker !== 'string' || !worker.trim() || worker.length > 128) {
                return bad(reply, 'BAD_WORKER', 'worker must be a non-empty string');
            }

            const result = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'reclaim ack failed'),
                () => store.ackReclaim(id, worker)
            );
            if (!result.ok) return reply;
            if (result.value === 'missing') {
                return reply.code(404).send({ error: 'No such reclaim', code: 'NOT_FOUND' });
            }
            if (result.value === 'lost') {
                return reply.code(409).send({ error: 'Reclaim is not yours', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ id });
        });

        // The worker's verdict that the run is over. The 200 body carries `threadDone` — the
        // store's answer, computed in the same transaction as the verdict, to whether the job's
        // whole thread is finished AND the user has closed it (a `done_at` on some member): it is
        // the driver's only worktree-reclaim signal, and it rides the lease-guarded complete
        // rather than a thread read, so a worker credential can never pull the audit data of jobs
        // it does not hold (see docs/auth.md). A thread that merely finished keeps its tree.
        app.post('/api/jobs/:id/complete', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const { leaseToken, status, exitCode, output, contextTokens, contextCostUsd, agentTurns, summary } = body(
                request.body
            );
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
                (!Number.isInteger(contextTokens) ||
                    (contextTokens as number) < 0 ||
                    (contextTokens as number) > CONTEXT_TOKENS_MAX)
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
            // The close-time agent-turn count: optional, and absent means unmeasured — the
            // never-zero contract puts the boundary at the route, so a malformed report cannot
            // write a plausible-looking zero over a run nobody counted. Capped at PostgreSQL's
            // int4 maximum, because `job.agent_turns` is an int and an out-of-range value would
            // fail the verdict's transaction, leaving a finished run unsettled.
            if (
                agentTurns !== undefined &&
                agentTurns !== null &&
                (!Number.isInteger(agentTurns) ||
                    (agentTurns as number) < 0 ||
                    (agentTurns as number) > AGENT_TURNS_MAX)
            ) {
                return bad(reply, 'BAD_AGENT_TURNS', `agentTurns must be an integer 0..${AGENT_TURNS_MAX}`);
            }
            if (summary !== undefined && summary !== null && typeof summary !== 'string') {
                return bad(reply, 'BAD_SUMMARY', 'summary must be a string or null');
            }

            const result = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job complete failed'),
                () =>
                    store.complete(id, leaseToken, {
                        status: status as JobOutcome,
                        exitCode: (exitCode as number | undefined) ?? null,
                        output: typeof output === 'string' ? output.slice(0, OUTPUT_LIMIT) : null,
                        contextTokens: (contextTokens as number | undefined) ?? null,
                        contextCostUsd: (contextCostUsd as number | undefined) ?? null,
                        agentTurns: (agentTurns as number | undefined) ?? null,
                        // Empty is none, the same contract the store and the docs state: null
                        // is unmeasured, never an empty string. Bounded by codepoint, so the
                        // cap never splits a surrogate pair.
                        summary:
                            typeof summary === 'string' && summary.trim()
                                ? [...summary.trim()].slice(0, SUMMARY_LIMIT).join('')
                                : null,
                    })
            );
            if (!result.ok) return reply;
            if (result.value.result !== 'ok') {
                if (result.value.result === 'missing') {
                    return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
                }
                return reply.code(409).send({ error: 'Lease lost', code: 'LEASE_LOST' });
            }
            return reply.code(200).send({ id, status, threadDone: result.value.threadDone });
        });

        app.get('/api/jobs/:id', async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const job = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job read failed'),
                () => store.get(id)
            );
            if (!job.ok) return reply;
            if (job.value === null) return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            return reply.code(200).send(job.value);
        });

        // The whole follow-up chain containing this task, oldest first. ANY member resolves to the
        // same conversation — the UI keeps one task per thread, so the URL may name the root or
        // any adjustment and the page must not change identity underneath the reader.
        app.get('/api/jobs/:id/thread', async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const id = (request.params as { id: string }).id;
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const jobs = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job thread read failed'),
                () => store.thread(id)
            );
            if (!jobs.ok) return reply;
            if (jobs.value === null) return reply.code(404).send({ error: 'No such job', code: 'NOT_FOUND' });
            return reply.code(200).send({ jobs: jobs.value });
        });

        app.get('/api/jobs', async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'JOBS_UNAVAILABLE', 'No job board for this organization', 503);
            const query = request.query as { status?: string; limit?: string; repo?: string };
            // 'terminal' is the one pseudo-status: every settled verdict at once, so a
            // completed-jobs view can bound its request instead of filtering a newest-N window
            // client-side and losing finished runs behind a busy queue.
            if (
                query.status !== undefined &&
                query.status !== 'terminal' &&
                !STATUSES.includes(query.status as JobStatus)
            ) {
                return bad(reply, 'BAD_STATUS', `status must be one of ${STATUSES.join(', ')} or 'terminal'`);
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

            const jobs = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'job list failed'),
                () => store.list({ status: query.status as JobStatus | 'terminal' | undefined, repo, limit })
            );
            if (!jobs.ok) return reply;
            return reply.code(200).send({ jobs: jobs.value });
        });
    };
