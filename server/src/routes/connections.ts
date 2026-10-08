import { ADMIN_ROLE, ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import { UUID } from '../config.js';
import type { ConnectionAccess } from '../db/connection-store.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, body as jsonBody, guard } from './helpers.js';

/**
 * Managed connector connections (issue #546): which Jira sites an org's tasks may reach, and as
 * whom. This file is who may create or delete one and what shape is accepted; what a task may do
 * with it is the proxy's (`connector-jira.ts`), and the token is never in a response.
 */

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const HTTP_BAD_GATEWAY = 502;

const CONTROL_BODY_LIMIT = 8192;
const LOOKUP_TIMEOUT_MS = 10_000;
const SITE_LIMIT = 253;

/** A Jira Cloud site, and nothing the board could be steered at: the cloud-id lookup is a fetch. */
const SITE_HOST = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/i;

export const CONNECTION_ACCESS: readonly ConnectionAccess[] = ['read', 'write'];
const ORG_SCOPE_VALUE = 'org';
const USER_SCOPE_VALUE = 'user';

/** Resolves a Jira site's cloud id from its public tenant_info, or null when it cannot. */
export type CloudIdLookup = (host: string) => Promise<string | null>;

export const lookupCloudId: CloudIdLookup = async (host) => {
    const response = await fetch(`https://${host}/_edge/tenant_info`, {
        redirect: 'error',
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const cloudId = ((await response.json()) as { cloudId?: unknown }).cloudId;
    return typeof cloudId === 'string' && cloudId ? cloudId : null;
};

/** The host of a `site` field given as a bare host or an https URL, or null when it is neither. */
export function siteHost(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > SITE_LIMIT) return null;
    const host = raw
        .trim()
        .replace(/^https:\/\//i, '')
        .replace(/\/+$/, '');
    return SITE_HOST.test(host) ? host.toLowerCase() : null;
}

interface ParsedConnection {
    host: string;
    email: string;
    apiToken: string;
    access: ConnectionAccess;
    scope: typeof ORG_SCOPE_VALUE | typeof USER_SCOPE_VALUE;
}

/** The create body's shape, or the reason it is refused — the credential's own characters included. */
function parseConnection(fields: Record<string, unknown>): ParsedConnection | string {
    const host = siteHost(fields.site);
    if (!host) return 'site must be a Jira Cloud site such as example.atlassian.net';
    const { email, apiToken } = fields;
    if (typeof email !== 'string' || !email || typeof apiToken !== 'string' || !apiToken) {
        return 'email and apiToken are required';
    }
    if (/[\r\n"]/.test(email) || /[\r\n"]/.test(apiToken)) {
        return 'email and apiToken must not contain quotes or newlines';
    }
    const access = fields.access ?? 'read';
    if (!CONNECTION_ACCESS.includes(access as ConnectionAccess)) {
        return `access must be one of ${CONNECTION_ACCESS.join(', ')}`;
    }
    const scope = fields.scope ?? USER_SCOPE_VALUE;
    if (scope !== ORG_SCOPE_VALUE && scope !== USER_SCOPE_VALUE) {
        return `scope must be ${USER_SCOPE_VALUE} or ${ORG_SCOPE_VALUE}`;
    }
    return { host, email, apiToken, access: access as ConnectionAccess, scope };
}

const signInRequired = (reply: FastifyReply) =>
    reply.code(HTTP_UNAUTHORIZED).send({ error: 'Sign in required', code: ERROR_CODES.UNAUTHENTICATED });

/**
 * The task-create check (issue #546): the connection a task selects must be one its author may
 * use now — org-owned in this org, or the author's own. Selection is this field and nothing else;
 * a skill never names a connection. `handled` means a refusal already landed on `reply`.
 */
export async function resolveJiraConnection(
    orgs: OrgRegistry,
    ctx: { request: FastifyRequest; reply: FastifyReply; createdBy: string | null },
    raw: unknown
): Promise<{ handled: true } | { handled: false; id: string | null }> {
    const { request, reply, createdBy } = ctx;
    if (raw === undefined || raw === null) return { handled: false, id: null };
    if (typeof raw !== 'string' || !UUID.test(raw)) {
        bad(reply, ERROR_CODES.BAD_CONNECTION, 'jiraConnection must be a connection id');
        return { handled: true };
    }
    const store = (await orgs.for(orgOf(request)))?.connections;
    if (!store || createdBy === null || !(await store.authorizedFor(createdBy, raw))) {
        bad(
            reply,
            ERROR_CODES.CONNECTION_NOT_AUTHORIZED,
            'That Jira connection does not exist or is not available to you. Pick one from GET /api/connections.',
            HTTP_FORBIDDEN
        );
        return { handled: true };
    }
    return { handled: false, id: raw };
}

export interface ConnectionRoutesDeps {
    orgs: OrgRegistry;
    lookupCloudId?: CloudIdLookup;
}

export function connectionRoutes({
    orgs,
    lookupCloudId: lookup = lookupCloudId,
}: ConnectionRoutesDeps): FastifyPluginAsync {
    /** The caller and their org's store, or the refusal already sent. */
    const resolve = async (request: FastifyRequest, reply: FastifyReply) => {
        const caller = callerOf(request);
        if (!caller) {
            await signInRequired(reply);
            return null;
        }
        const store = (await orgs.for(orgOf(request)))?.connections;
        if (!store) {
            bad(
                reply,
                ERROR_CODES.CONNECTIONS_UNAVAILABLE,
                'No connection store for this organization',
                HTTP_UNAVAILABLE
            );
            return null;
        }
        return { caller, store };
    };

    /** The cloud id of `host`, or null (logged) when Atlassian cannot say. */
    const cloudIdOf = async (request: FastifyRequest, host: string): Promise<string | null> => {
        try {
            return await lookup(host);
        } catch (e) {
            request.log.warn({ err: e }, 'jira cloud id lookup failed');
            return null;
        }
    };

    const create = async (request: FastifyRequest, reply: FastifyReply) => {
        const ctx = await resolve(request, reply);
        if (!ctx) return reply;
        const { caller, store } = ctx;
        const parsed = parseConnection(jsonBody(request.body));
        if (typeof parsed === 'string') return bad(reply, ERROR_CODES.BAD_CONNECTION, parsed);
        if (parsed.scope === ORG_SCOPE_VALUE && caller.role !== ADMIN_ROLE) {
            return bad(
                reply,
                ERROR_CODES.FORBIDDEN,
                'Only an organization admin can create an org-wide connection',
                HTTP_FORBIDDEN
            );
        }
        const cloudId = await cloudIdOf(request, parsed.host);
        if (!cloudId) {
            return bad(
                reply,
                ERROR_CODES.BAD_CONNECTION,
                `Could not resolve the Jira cloud id of ${parsed.host}`,
                HTTP_BAD_GATEWAY
            );
        }
        const created = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'connection create failed'),
            () =>
                store.create({
                    ownerUserId: parsed.scope === ORG_SCOPE_VALUE ? null : caller.user.id,
                    site: parsed.host,
                    cloudId,
                    email: parsed.email,
                    apiToken: parsed.apiToken,
                    access: parsed.access,
                })
        );
        if (!created.ok) return reply;
        return reply.code(HTTP_CREATED).send(created.value);
    };

    const remove = async (request: FastifyRequest, reply: FastifyReply) => {
        const ctx = await resolve(request, reply);
        if (!ctx) return reply;
        const id = (request.params as { id: string }).id;
        if (!UUID.test(id)) return bad(reply, ERROR_CODES.BAD_ID, 'connection id must be a uuid');
        const removed = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'connection delete failed'),
            () => ctx.store.remove(id, { userId: ctx.caller.user.id, admin: ctx.caller.role === ADMIN_ROLE })
        );
        if (!removed.ok) return reply;
        if (!removed.value) {
            return reply
                .code(HTTP_NOT_FOUND)
                .send({ error: 'No such connection you may delete', code: ERROR_CODES.NOT_FOUND });
        }
        return reply.code(HTTP_NO_CONTENT).send();
    };

    return async (app) => {
        app.get('/api/connections', async (request, reply) => {
            const ctx = await resolve(request, reply);
            if (!ctx) return reply;
            const listed = await guard(
                reply,
                (e) => request.log.error({ err: e }, 'connection list failed'),
                () => ctx.store.list(ctx.caller.user.id)
            );
            if (!listed.ok) return reply;
            return reply.code(HTTP_OK).send({ connections: listed.value });
        });
        app.post('/api/connections', { bodyLimit: CONTROL_BODY_LIMIT }, create);
        app.delete('/api/connections/:id', remove);
    };
}
