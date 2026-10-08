import { CONTENT_TYPE_HEADER, ERROR_CODES, JSON_CONTENT_TYPE, JSON_HEADERS } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { JOB_ID_HEADER, LEASE_TOKEN_HEADER } from '../auth/plugin.js';
import type { ConnectionOfLease, ConnectionRefusal, LiveConnection } from '../db/connection-store.js';
import { bad } from './helpers.js';

/**
 * The Jira connector proxy (issue #546): the runner calls the board, the board calls Atlassian.
 * The connection's credential is added here and never leaves — so there is nothing to renew,
 * nothing in a runner's env or logs to leak, and every call re-checks the live attempt, the
 * selected connection and its access level. A reclaim or retry rotates the lease token, a cancel
 * or settle clears the lease, and deleting the connection (or its owner leaving the org) ends
 * access on the next call. The check is `createConnectionOfLease`'s; this file forwards.
 */

const HTTP_FORBIDDEN = 403;
const HTTP_BAD_GATEWAY = 502;
const HTTP_BAD_REQUEST = 400;

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_LIMIT = 1_048_576;
const RESPONSE_LIMIT = 5_242_880;
const GATEWAY = 'https://api.atlassian.com/ex/jira';
const API_PREFIX = 'rest/api/3/';

/** The methods a `read` connection forwards. */
const READ_METHODS: readonly string[] = ['GET', 'HEAD'];
const PROXIED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'] as const;

const REFUSALS: Record<ConnectionRefusal, string> = {
    lease: 'This attempt is no longer running, so its Jira connection is closed. Do not retry.',
    unselected:
        'No Jira connection is selected for this task, or it was deleted. Start the task with an authorized Jira connection (jiraConnection) and stop here.',
    revoked:
        "The task's Jira connection is no longer authorized (its owner left the organization). Ask an admin for an authorized connection and stop here.",
};

const READ_ONLY_MESSAGE =
    'The selected Jira connection is read-only; this call was refused. Ask for a write connection and stop here.';

export interface ConnectorJiraDeps {
    connectionOfLease: ConnectionOfLease;
    fetchFn?: typeof fetch;
}

const LAST_CONTROL_CHAR = 0x1f;
const DEL = '\u007f';

/** A path under the REST base whose segments never climb out of it — decoded, so `%2e%2e` counts. */
function safeRest(rest: string): boolean {
    let decoded: string;
    try {
        decoded = decodeURIComponent(rest);
    } catch {
        return false;
    }
    // Control characters are refused outright: a URL parser strips tabs and newlines, which would
    // turn `.<tab>.` into `..` after this check.
    if ([...decoded].some((char) => char.charCodeAt(0) <= LAST_CONTROL_CHAR || char === DEL || char === '\\')) {
        return false;
    }
    return !decoded.split('/').some((segment) => segment === '..' || segment === '.');
}

/** The path as sent upstream: every segment re-encoded, so nothing the check saw can change shape. */
const encodedRest = (rest: string): string => rest.split('/').map(encodeURIComponent).join('/');

type Live = Extract<LiveConnection, { ok: true }>;

/** The upstream request: the connection's credential added here, nothing of the runner's carried. */
function upstreamInit(request: FastifyRequest, live: Live): RequestInit {
    const hasBody = request.body !== undefined && request.body !== null;
    return {
        method: request.method,
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: {
            authorization: `Basic ${Buffer.from(`${live.email}:${live.apiToken}`).toString('base64')}`,
            accept: JSON_CONTENT_TYPE,
            ...(hasBody ? JSON_HEADERS : {}),
        },
        ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
    };
}

/** Why this call must not be forwarded to a live connection, or null when it may. */
function refusalFor(request: FastifyRequest, live: Live): { code: string; message: string; status: number } | null {
    if (live.access === 'read' && !READ_METHODS.includes(request.method)) {
        return { code: ERROR_CODES.CONNECTION_NOT_AUTHORIZED, message: READ_ONLY_MESSAGE, status: HTTP_FORBIDDEN };
    }
    const rest = (request.params as { '*': string })['*'];
    if (!rest.startsWith(API_PREFIX) || !safeRest(rest)) {
        return {
            code: ERROR_CODES.BAD_CONNECTION,
            message: `Only ${API_PREFIX}* is reachable`,
            status: HTTP_BAD_REQUEST,
        };
    }
    return null;
}

export function connectorJiraRoutes({ connectionOfLease, fetchFn = fetch }: ConnectorJiraDeps): FastifyPluginAsync {
    const forward = async (request: FastifyRequest, reply: FastifyReply, live: Live) => {
        const rest = (request.params as { '*': string })['*'];
        const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
        try {
            const upstream = await fetchFn(
                `${GATEWAY}/${live.cloudId}/${encodedRest(rest)}${query}`,
                upstreamInit(request, live)
            );
            const payload = Buffer.from(await upstream.arrayBuffer());
            if (payload.length > RESPONSE_LIMIT) {
                return bad(reply, ERROR_CODES.UNAVAILABLE, 'Jira response too large', HTTP_BAD_GATEWAY);
            }
            const type = upstream.headers.get(CONTENT_TYPE_HEADER);
            if (type) reply.header(CONTENT_TYPE_HEADER, type);
            return reply.code(upstream.status).send(payload);
        } catch {
            // The error text is not logged or returned: it can carry the request's headers.
            return bad(reply, ERROR_CODES.UNAVAILABLE, 'Jira did not answer', HTTP_BAD_GATEWAY);
        }
    };

    const handle = async (request: FastifyRequest, reply: FastifyReply) => {
        const jobId = (request.params as { id: string }).id;
        const leaseToken = request.headers[LEASE_TOKEN_HEADER];
        if (request.headers[JOB_ID_HEADER] !== jobId || typeof leaseToken !== 'string') {
            return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Job id and lease token required', HTTP_FORBIDDEN);
        }
        const live = await connectionOfLease(jobId, leaseToken);
        if (!live.ok) return bad(reply, ERROR_CODES.CONNECTION_NOT_AUTHORIZED, REFUSALS[live.reason], HTTP_FORBIDDEN);
        const refusal = refusalFor(request, live);
        if (refusal) return bad(reply, refusal.code, refusal.message, refusal.status);
        return forward(request, reply, live);
    };

    return async (app) => {
        app.route({
            method: [...PROXIED_METHODS],
            url: '/api/jobs/:id/connectors/jira/*',
            bodyLimit: BODY_LIMIT,
            handler: handle,
        });
    };
}
