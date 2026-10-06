import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ADMIN_ROLE, ERROR_CODES, ORG_SCOPE, USER_SCOPE, type ExecutorScope } from '@factory-ai/core';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { Caller } from '../auth/store.js';
import type { OrgRegistry } from '../orgs.js';
import type { UserExecutorStore } from '../db/user-executor-store.js';
import { bad, badSegment, body as jsonBody, guard } from './helpers.js';
import {
    executorFieldRefusal,
    MAX_EXECUTORS_PER_ORG,
    MAX_EXECUTORS_PER_USER,
    parseExecutorFields,
} from './executor-fields.js';

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;

const BYTES_PER_KIB = 1024;
const BODY_LIMIT_KIB = 64;
const BODY_LIMIT = BODY_LIMIT_KIB * BYTES_PER_KIB;
/** No payload past an id or a scope pair needs more than a control route's headroom. */
const CONTROL_BODY_LIMIT = 4096;

/** No store behind the caller's org — every route here refuses the same way. */
function noStore(reply: FastifyReply) {
    return bad(reply, ERROR_CODES.WORKSPACE_UNAVAILABLE, 'No executor store for this organization', HTTP_UNAVAILABLE);
}

/** The organization's executor profiles are the caller's org's — the same resolution every route makes. */
async function storeOf(orgs: OrgRegistry, request: FastifyRequest): Promise<UserExecutorStore | null> {
    const rt = await orgs.for(orgOf(request));
    return rt?.userExecutors ?? null;
}

/** Organization profiles are an administrator's surface; a member's mutations refuse here. */
function requireAdmin(caller: Caller): boolean {
    return caller.role === ADMIN_ROLE;
}

/** Whether the error is the unique violation a per-scope name index raises — anything else rethrows. */
function isNameTaken(error: unknown): boolean {
    if ((error as { code?: string }).code === '23505') return true;
    throw error;
}

/**
 * The route-level name rules for an org profile, restating the row check the way the personal PUT
 * does: a name arrives in a JSON body now, so the route guards the request and
 * `user_executor_name_ck` guards the row (the constraint kept 012's name through 047's table rename).
 */
function badProfileName(name: string): string | null {
    return badSegment('name', name);
}

/** Selection metadata every member may see. */
function selectionMetadata(row: {
    id: string;
    name: string;
    type: string;
    createdAt: string;
    suspended: boolean;
}): Record<string, unknown> {
    return { id: row.id, name: row.name, type: row.type, createdAt: row.createdAt, suspended: row.suspended };
}

/** The admin list's row: the metadata plus the configuration and the audit fields. */
function adminRow(row: {
    id: string;
    name: string;
    type: string;
    createdAt: string;
    updatedAt: string;
    gateFixRounds: number;
    createdBy: string | null;
    suspended: boolean;
    config: Record<string, unknown>;
}): Record<string, unknown> {
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        suspended: row.suspended,
        gateFixRounds: row.gateFixRounds,
        createdBy: row.createdBy,
        config: row.config,
    };
}

async function handleListOrgExecutors(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeOf(orgs, request);
    if (!store) return noStore(reply);
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);

    // The config may hold provider credentials: it travels to the admins who manage it, never to
    // the members who only select it — the same visibility split the workspace poll makes.
    if (requireAdmin(caller)) {
        const loaded = await guard(
            reply,
            (e) => request.log.error({ err: e }),
            () => store.listOrgWithConfigs()
        );
        if (!loaded.ok) return reply;
        return reply.code(HTTP_OK).send({ executors: loaded.value.map(adminRow) });
    }
    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.listOrg()
    );
    if (!loaded.ok) return reply;
    return reply.code(HTTP_OK).send({ executors: loaded.value.map(selectionMetadata) });
}

async function handleCreateOrgExecutor(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeOf(orgs, request);
    if (!store) return noStore(reply);
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    if (!requireAdmin(caller)) {
        return bad(
            reply,
            ERROR_CODES.FORBIDDEN,
            'Only an organization admin can manage organization executors',
            HTTP_FORBIDDEN
        );
    }

    const fields = parseExecutorFields(jsonBody(request.body));
    if (typeof fields === 'string') return bad(reply, executorFieldRefusal(fields), fields);
    const reason = badProfileName(fields.name);
    if (reason) return bad(reply, ERROR_CODES.BAD_EXECUTOR_NAME, `"${fields.name}": ${reason}`);

    const counted = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.orgCount()
    );
    if (!counted.ok) return reply;
    if (counted.value >= MAX_EXECUTORS_PER_ORG) {
        return bad(
            reply,
            ERROR_CODES.TOO_MANY_EXECUTORS,
            `at most ${MAX_EXECUTORS_PER_ORG} organization executors can be configured at once`
        );
    }

    const saved = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => {
            try {
                return { ok: await store.createOrg({ ...fields, createdBy: caller.user.id }) };
            } catch (error) {
                if (isNameTaken(error)) return { taken: true };
                throw error;
            }
        }
    );
    if (!saved.ok) return reply;
    if ('taken' in saved.value) {
        return bad(
            reply,
            ERROR_CODES.NAME_TAKEN,
            `an organization executor named "${fields.name}" already exists`,
            HTTP_CONFLICT
        );
    }
    return reply.code(HTTP_CREATED).send(saved.value.ok);
}

async function handleUpdateOrgExecutor(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeOf(orgs, request);
    if (!store) return noStore(reply);
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    if (!requireAdmin(caller)) {
        return bad(
            reply,
            ERROR_CODES.FORBIDDEN,
            'Only an organization admin can manage organization executors',
            HTTP_FORBIDDEN
        );
    }
    const { id } = request.params as { id?: string };
    if (typeof id !== 'string' || !id) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a string');

    const raw = jsonBody(request.body);
    // Scope is not a field: it moves only through the scope route, loudly — quietly accepting it
    // here would let a caller believe they moved a profile between scopes when nothing changed.
    if ('scope' in raw) return bad(reply, ERROR_CODES.BAD_SCOPE, 'scope changes only through the scope route');

    const fields = parseExecutorFields(raw);
    if (typeof fields === 'string') return bad(reply, executorFieldRefusal(fields), fields);
    const reason = badProfileName(fields.name);
    if (reason) return bad(reply, ERROR_CODES.BAD_EXECUTOR_NAME, `"${fields.name}": ${reason}`);

    const saved = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => {
            try {
                return { ok: await store.updateOrg(id, fields) };
            } catch (error) {
                if (isNameTaken(error)) return { taken: true };
                throw error;
            }
        }
    );
    if (!saved.ok) return reply;
    if ('taken' in saved.value) {
        return bad(
            reply,
            ERROR_CODES.NAME_TAKEN,
            `an organization executor named "${fields.name}" already exists`,
            HTTP_CONFLICT
        );
    }
    if (!saved.value.ok) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such organization executor' });
    return reply.code(HTTP_OK).send(saved.value.ok);
}

async function handleDeleteOrgExecutor(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeOf(orgs, request);
    if (!store) return noStore(reply);
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    if (!requireAdmin(caller)) {
        return bad(
            reply,
            ERROR_CODES.FORBIDDEN,
            'Only an organization admin can manage organization executors',
            HTTP_FORBIDDEN
        );
    }
    const { id } = request.params as { id?: string };
    if (typeof id !== 'string' || !id) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a string');

    const removed = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.deleteOrg(id)
    );
    if (!removed.ok) return reply;
    if (!removed.value) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such organization executor' });
    return reply.code(HTTP_OK).send({ id, removed: removed.value });
}

/** Suspends or resumes an org profile for every member (issue 440): admin-gated, id-keyed. */
async function handleSuspendOrgExecutor(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeOf(orgs, request);
    if (!store) return noStore(reply);
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    if (!requireAdmin(caller)) {
        return bad(
            reply,
            ERROR_CODES.FORBIDDEN,
            'Only an organization admin can manage organization executors',
            HTTP_FORBIDDEN
        );
    }
    const { id } = request.params as { id?: string };
    if (typeof id !== 'string' || !id) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a string');
    const { suspended } = jsonBody(request.body);
    if (typeof suspended !== 'boolean') return bad(reply, ERROR_CODES.BAD_BODY, 'suspended must be a boolean');

    const updated = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.setOrgSuspended(id, suspended)
    );
    if (!updated.ok) return reply;
    if (!updated.value) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such organization executor' });
    return reply.code(HTTP_OK).send(selectionMetadata(updated.value));
}

/**
 * The one route a profile's scope moves through: an administrator promotes their OWN personal row
 * to org scope, or demotes an org row into their own personal list. The store's WHERE clause holds
 * the ownership, and this route holds the role check — both halves of the same enforcement.
 */
async function handleChangeOrgExecutorScope(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const store = await storeOf(orgs, request);
    if (!store) return noStore(reply);
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    if (!requireAdmin(caller)) {
        return bad(
            reply,
            ERROR_CODES.FORBIDDEN,
            'Only an organization admin can manage organization executors',
            HTTP_FORBIDDEN
        );
    }
    const { id } = request.params as { id?: string };
    if (typeof id !== 'string' || !id) return bad(reply, ERROR_CODES.BAD_ID, 'id must be a string');

    const raw = jsonBody(request.body);
    const scope = raw.scope as ExecutorScope | undefined;
    if (scope !== USER_SCOPE && scope !== ORG_SCOPE) {
        return bad(reply, ERROR_CODES.BAD_SCOPE, `scope must be "${USER_SCOPE}" or "${ORG_SCOPE}"`);
    }
    // Each direction lands the row in a list with a cap, enforced before the move: a promotion
    // adds to the organization's list exactly as the create route does, a demotion to the calling
    // admin's personal list.
    const caps = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => ({
            org: scope === ORG_SCOPE ? await store.orgCount() : 0,
            personal: scope === USER_SCOPE ? (await store.list(caller.user.id)).length : 0,
        })
    );
    if (!caps.ok) return reply;
    if (scope === ORG_SCOPE && caps.value.org >= MAX_EXECUTORS_PER_ORG) {
        return bad(
            reply,
            ERROR_CODES.TOO_MANY_EXECUTORS,
            `at most ${MAX_EXECUTORS_PER_ORG} organization executors can be configured at once`
        );
    }
    if (scope === USER_SCOPE && caps.value.personal >= MAX_EXECUTORS_PER_USER) {
        return bad(
            reply,
            ERROR_CODES.TOO_MANY_EXECUTORS,
            `at most ${MAX_EXECUTORS_PER_USER} executors can be configured at once`
        );
    }

    const moved = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        async () => {
            try {
                return { ok: await store.changeScope(id, scope, caller.user.id) };
            } catch (error) {
                if (isNameTaken(error)) return { taken: true };
                throw error;
            }
        }
    );
    if (!moved.ok) return reply;
    if ('taken' in moved.value) {
        return bad(
            reply,
            ERROR_CODES.NAME_TAKEN,
            'an executor with that name already exists in the target scope',
            HTTP_CONFLICT
        );
    }
    if (!moved.value.ok) return reply.code(HTTP_NOT_FOUND).send({ error: 'No such executor to move' });
    return reply.code(HTTP_OK).send(moved.value.ok);
}

/**
 * Organization-scoped executor profiles (issue 391): the administrators' CRUD over the profiles
 * every member of the organization may select. A person's surface, like the workflow routes it
 * mirrors — the board secret never gets past the auth wall here, because executor management is a
 * human's decision.
 *
 * - `GET /api/org/executors` — every member reads selection metadata (id, name, type, createdAt);
 *   the full configuration answers to admins only.
 * - `POST /api/org/executors` — create, admin-gated.
 * - `PUT /api/org/executors/:id` — edit, admin-gated; `scope` in the body is a BAD_SCOPE refusal.
 * - `DELETE /api/org/executors/:id` — delete, admin-gated.
 * - `POST /api/org/executors/:id/suspension` — suspend/resume `{suspended}`, admin-gated.
 * - `POST /api/org/executors/:id/scope` — promote/demote, admin-gated; the store only ever moves
 *   the calling admin's own personal row up.
 */
export const orgExecutorRoutes =
    ({ orgs }: { orgs: OrgRegistry }): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/org/executors', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleListOrgExecutors(orgs, request, reply)
        );
        app.post('/api/org/executors', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleCreateOrgExecutor(orgs, request, reply)
        );
        app.put('/api/org/executors/:id', { bodyLimit: BODY_LIMIT }, (request, reply) =>
            handleUpdateOrgExecutor(orgs, request, reply)
        );
        app.delete('/api/org/executors/:id', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleDeleteOrgExecutor(orgs, request, reply)
        );
        app.post('/api/org/executors/:id/suspension', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleSuspendOrgExecutor(orgs, request, reply)
        );
        app.post('/api/org/executors/:id/scope', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleChangeOrgExecutorScope(orgs, request, reply)
        );
    };
