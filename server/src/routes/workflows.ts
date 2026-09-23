import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import type { WorkflowStore, WorkflowSummary } from '../db/workflow-store.js';
import type { Caller } from '../auth/store.js';
import { blockCatalog } from '../db/workflow-blocks/index.js';
import { bad, body, repoReason } from './helpers.js';
import { UUID } from '../config.js';
import { ADMIN_ROLE } from '@factory-ai/core';

export interface WorkflowRouteDeps {
    /**
     * The per-org runtimes; the store a request touches is the CALLER's org's. Workflows are
     * org-scoped rows, so the resolution is the same one every org-scoped route makes.
     */
    orgs: OrgRegistry;
}

const BYTES_PER_KIB = 1024;
const BODY_LIMIT_KIB = 64;
const BODY_LIMIT = BODY_LIMIT_KIB * BYTES_PER_KIB;
/** No payload past an id or a query string needs more than a control route's headroom. */
const CONTROL_BODY_LIMIT = 4096;

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;

/** No store behind the caller's org — every route here refuses the same way. */
function noStore(reply: FastifyReply) {
    return bad(reply, 'WORKFLOWS_UNAVAILABLE', 'No workflow store for this organization', HTTP_UNAVAILABLE);
}

/**
 * Workflow definitions: the process a task walks, stored per scope and validated strictly by the
 * store (docs/workflows.md). A person's surface, like every task route: the board secret never gets
 * past the auth wall here, because workflow selection is a human's decision, never a driver's.
 *
 * - `GET /api/workflows?repo=owner/name` — the caller-visible list (the org's, their own, the
 *   named repository's), the composer's dropdown feed.
 * - `POST /api/workflows` — create; org-level is an admin's move, user- and repo-level are any
 *   member's. A `kind: "block"` node is compiled (registry lookup, availability, config, expansion)
 *   before storage — an unknown/unavailable/misconfigured block refuses the same way a schema
 *   error does (issue #204, docs/workflows.md "Built-in blocks").
 * - `GET /api/workflow-blocks` — the board-owned catalog every `uses` may reference: id,
 *   description, config schema, availability. Never a prompt or script body — those stay inside
 *   the registry, unserialized. Static, org-independent metadata; gated the same as the other
 *   routes here because block selection is the same human authoring surface.
 * - `DELETE /api/workflows/:id` — an admin, the owning member, or any member within repo scope.
 *
 * Refusals carry named codes: a pasted foreign pipeline fails loudly (UNKNOWN_KEY, UNKNOWN_NODE,
 * BAD_RULE, … are the validator's own), and NAME_TAKEN answers 409 — the request was
 * well-formed, the name was gone.
 */
/**
 * The workflow definitions a request touches are its caller's org's (#99) — the same resolution
 * the job board makes. Absent in the route-test mode with no stores behind the registry.
 */
async function storeOf(orgs: OrgRegistry, request: FastifyRequest): Promise<WorkflowStore | null> {
    const rt = await orgs.for(orgOf(request));
    return rt?.workflows ?? null;
}

/** The `repo` query field: absent, or a valid `owner/name`. */
function validateRepoQuery(repoField: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
    if (repoField === undefined) return { ok: true, value: null };
    if (typeof repoField !== 'string') return { ok: false, message: 'repo must be a string' };
    const reason = repoReason(repoField);
    if (reason) return { ok: false, message: reason };
    return { ok: true, value: repoField };
}

/**
 * Board-owned, org-independent metadata — no `storeOf` gate. Auth-gated anyway: block selection
 * is part of the same human workflow-authoring surface as the routes below.
 */
function handleWorkflowBlocks(request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
    return reply.code(HTTP_OK).send({ blocks: blockCatalog() });
}

async function handleListWorkflows(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeOf(orgs, request);
    if (!store) return noStore(reply);
    const caller = callerOf(request);
    if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);

    const parsed = validateRepoQuery(body(request.query as unknown).repo);
    if (!parsed.ok) return bad(reply, 'BAD_REPO', parsed.message);

    const workflows = await store.listVisible({ userId: caller.user.id, repo: parsed.value });
    return reply.code(HTTP_OK).send({ workflows });
}

type ResolvedScope = { kind: 'org' } | { kind: 'user'; userId: string } | { kind: 'repo'; owner: string; name: string };

/**
 * The exactly-one-scope a create body names, resolved to what `store.create` expects. Org-level is
 * admin-gated here — a member's private process must not quietly become everyone's default. Repo-
 * and user-level are any member's: a member's own process, for their own tasks or a repository
 * they already queue against.
 */
function resolveScope(
    fields: Record<string, unknown>,
    caller: Caller
): { ok: true; value: ResolvedScope } | { ok: false; code: string; message: string; status?: number } {
    const scopeName = fields.scope;
    if (scopeName !== 'org' && scopeName !== 'user' && scopeName !== 'repo') {
        return { ok: false, code: 'BAD_SCOPE', message: 'scope must be "org", "user" or "repo"' };
    }
    if (scopeName === 'org') {
        if (caller.role !== ADMIN_ROLE) {
            return {
                ok: false,
                code: 'FORBIDDEN',
                message: 'Only an admin can publish an org-level workflow',
                status: HTTP_FORBIDDEN,
            };
        }
        return { ok: true, value: { kind: 'org' } };
    }
    if (scopeName === 'user') return { ok: true, value: { kind: 'user', userId: caller.user.id } };
    if (typeof fields.repo !== 'string') {
        return { ok: false, code: 'BAD_SCOPE', message: 'repo scope must name a repository' };
    }
    const reason = repoReason(fields.repo);
    if (reason) return { ok: false, code: 'BAD_SCOPE', message: reason };
    const [owner, name] = fields.repo.split('/') as [string, string];
    return { ok: true, value: { kind: 'repo', owner, name } };
}

async function handleCreateWorkflow(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeOf(orgs, request);
    if (!store) return noStore(reply);
    const caller = callerOf(request);
    if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);

    const fields = body(request.body);
    const { name, definition } = fields;
    if (typeof name !== 'string') return bad(reply, 'BAD_NAME', 'name must be a string');

    const scope = resolveScope(fields, caller);
    if (!scope.ok) return bad(reply, scope.code, scope.message, scope.status);

    const created = await store.create({ name, scope: scope.value, definition, createdBy: caller.user.id });
    if ('refused' in created) {
        const taken = created.code === 'NAME_TAKEN';
        return bad(reply, created.code, created.message, taken ? HTTP_CONFLICT : HTTP_BAD_REQUEST);
    }
    const record = await store.get(created.id);
    return reply.code(HTTP_CREATED).send(record);
}

function canDelete(caller: Caller, record: WorkflowSummary): boolean {
    if (caller.role === ADMIN_ROLE) return true;
    if (record.scope === 'org') return false;
    if (record.scope === 'user' && record.userId !== caller.user.id) return false;
    return true;
}

async function handleDeleteWorkflow(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeOf(orgs, request);
    if (!store) return noStore(reply);
    const caller = callerOf(request);
    if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

    const record = await store.get(id);
    if (!record) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such workflow' });
    if (!canDelete(caller, record)) {
        return bad(reply, 'FORBIDDEN', 'You cannot delete this workflow', HTTP_FORBIDDEN);
    }
    const removed = await store.remove(id);
    return reply.code(HTTP_OK).send({ id, removed });
}

export const workflowRoutes =
    ({ orgs }: WorkflowRouteDeps): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/workflows', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleListWorkflows(orgs, request, reply)
        );
        // Board-owned, org-independent metadata — no `storeOf` gate. Auth-gated anyway: block
        // selection is part of the same human workflow-authoring surface as the routes below.
        app.get('/api/workflow-blocks', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleWorkflowBlocks(request, reply)
        );
        app.post('/api/workflows', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleCreateWorkflow(orgs, request, reply)
        );
        app.delete('/api/workflows/:id', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleDeleteWorkflow(orgs, request, reply)
        );
    };
