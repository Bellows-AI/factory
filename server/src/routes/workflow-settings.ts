import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import { parseDefaultWorkflowSelection } from '../db/default-workflow.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, guard } from './helpers.js';

export interface WorkflowSettingsRouteDeps {
    /** The per-org runtimes; the store a request touches is the CALLER's org's, like workflowRoutes. */
    orgs: OrgRegistry;
}

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;

/**
 * A member's saved defaults for the two optional default-workflow steps (#203, parent #36). Own
 * route module and store so this lands without touching generic workflow CRUD — this issue changes
 * no job behavior. A person's surface, like every other member-settings route: identity comes from
 * the authenticated caller, never the body.
 */
export const workflowSettingsRoutes =
    ({ orgs }: WorkflowSettingsRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const storeOf = async (request: FastifyRequest) => {
            const rt = await orgs.for(orgOf(request));
            return rt?.workflowDefaults ?? null;
        };

        app.get('/api/workflows/default-settings', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) {
                return bad(
                    reply,
                    ERROR_CODES.WORKFLOW_SETTINGS_UNAVAILABLE,
                    'No workflow settings store for this organization',
                    HTTP_UNAVAILABLE
                );
            }
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);

            const loaded = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.get(caller.user.id)
            );
            if (!loaded.ok) return reply;

            return reply.code(HTTP_OK).send(loaded.value);
        });

        app.put('/api/workflows/default-settings', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) {
                return bad(
                    reply,
                    ERROR_CODES.WORKFLOW_SETTINGS_UNAVAILABLE,
                    'No workflow settings store for this organization',
                    HTTP_UNAVAILABLE
                );
            }
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);

            const pair = parseDefaultWorkflowSelection(request.body);
            if (!pair.ok) return bad(reply, ERROR_CODES.BAD_DEFAULT_WORKFLOW, pair.message);

            const saved = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.put(caller.user.id, pair.value)
            );
            if (!saved.ok) return reply;

            return reply.code(HTTP_OK).send(saved.value);
        });
    };
