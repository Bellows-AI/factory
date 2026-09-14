import type { FastifyPluginAsync } from 'fastify';
import { mintAccessToken } from '../auth/access-token.js';
import { callerOf } from '../auth/plugin.js';
import { hashToken } from '../auth/session.js';
import type { AuthStore } from '../auth/store.js';
import { UUID, bad, body as jsonBody, guard } from './helpers.js';

/**
 * Access-token management for the settings page (#70): a member's personal tokens (`fat_`), and
 * the organization's tokens (`oat_`), the latter admin-gated like every other org-wide write.
 *
 * The credential for all six routes is the browser's session — minting is a settings-UI act, and
 * an org token is refused here by the hook before this plugin ever runs, since these paths are not
 * on its allowlist. The plaintext token exists exactly twice: in the mint response, and nowhere —
 * only its hash is stored, so the create reply is the one chance to copy it.
 */

/** A ceiling, not a policy: a label is a line in a list, far past any real one. */
const LABEL_LIMIT = 128;

/** The trimmed label, or null when it is absent, blank, or over the ceiling. */
function parseLabel(raw: unknown): string | null {
    const label = jsonBody(raw).label;
    if (typeof label !== 'string') return null;
    const trimmed = label.trim();
    if (!trimmed || trimmed.length > LABEL_LIMIT) return null;
    return trimmed;
}

export interface TokenRoutesDeps {
    readonly store: AuthStore;
    readonly orgId: string;
}

export const tokenRoutes =
    ({ store, orgId }: TokenRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        app.post('/api/tokens', { bodyLimit: 4096 }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            const label = parseLabel(request.body);
            if (label === null) return bad(reply, 'BAD_LABEL', `label must be 1 to ${LABEL_LIMIT} characters`);

            const created = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                async () => {
                    const token = mintAccessToken('personal');
                    const row = await store.createAccessToken({
                        kind: 'personal',
                        orgId,
                        userId: caller.user.id,
                        createdBy: caller.user.id,
                        label,
                        tokenHash: hashToken(token),
                    });
                    return { id: row.id, token };
                }
            );
            if (!created.ok) return reply;
            return reply.code(201).send(created.value);
        });

        app.get('/api/tokens', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            const listed = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.listPersonalTokens(orgId, caller.user.id)
            );
            if (!listed.ok) return reply;
            return reply.code(200).send({ tokens: listed.value });
        });

        app.post('/api/tokens/:id/revoke', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            const { id } = request.params as { id: string };
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const revoked = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.revokePersonalToken(orgId, caller.user.id, id)
            );
            if (!revoked.ok) return reply;
            // Not-found covers unknown, someone else's, and already revoked alike: a revoke that
            // changed nothing has no row to name.
            if (revoked.value === 'missing') return bad(reply, 'NOT_FOUND', 'No such token', 404);
            return reply.code(200).send({ id, revoked: true });
        });

        app.post('/api/tokens/org', { bodyLimit: 4096 }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            if (caller.role !== 'admin') {
                return bad(reply, 'FORBIDDEN', 'Only an admin can manage organization tokens', 403);
            }
            const label = parseLabel(request.body);
            if (label === null) return bad(reply, 'BAD_LABEL', `label must be 1 to ${LABEL_LIMIT} characters`);

            const created = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                async () => {
                    const token = mintAccessToken('org');
                    const row = await store.createAccessToken({
                        kind: 'org',
                        orgId,
                        userId: null,
                        createdBy: caller.user.id,
                        label,
                        tokenHash: hashToken(token),
                    });
                    return { id: row.id, token };
                }
            );
            if (!created.ok) return reply;
            return reply.code(201).send(created.value);
        });

        app.get('/api/tokens/org', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            if (caller.role !== 'admin') {
                return bad(reply, 'FORBIDDEN', 'Only an admin can manage organization tokens', 403);
            }
            const listed = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.listOrgTokens(orgId)
            );
            if (!listed.ok) return reply;
            return reply.code(200).send({ tokens: listed.value });
        });

        app.post('/api/tokens/org/:id/revoke', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            if (caller.role !== 'admin') {
                return bad(reply, 'FORBIDDEN', 'Only an admin can manage organization tokens', 403);
            }
            const { id } = request.params as { id: string };
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const revoked = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.revokeOrgToken(orgId, id)
            );
            if (!revoked.ok) return reply;
            if (revoked.value === 'missing') return bad(reply, 'NOT_FOUND', 'No such token', 404);
            return reply.code(200).send({ id, revoked: true });
        });
    };
