import type { FastifyPluginAsync } from 'fastify';
import { mintAccessToken } from '../auth/access-token.js';
import { callerOf } from '../auth/plugin.js';
import { hashToken } from '../auth/session.js';
import type { AuthStore } from '../auth/store.js';
import { bad, body as jsonBody, guard } from './helpers.js';
import { UUID } from '../config.js';

/**
 * Access-token management for the settings page (#70): a member's personal tokens (`fat_`), and
 * the organization's tokens (`oat_`). Both mint into the org the caller is signed into (#99) —
 * installation access is membership, so every member is the same trust level and the org-token
 * routes carry no admin gate.
 *
 * The credential for all six routes is the browser's session — minting is a settings-UI act. The
 * plaintext token exists exactly twice: in the mint response, and nowhere — only its hash is
 * stored, so the create reply is the one chance to copy it.
 */

/** A ceiling, not a policy: a label is a line in a list, far past any real one. */
const LABEL_LIMIT = 128;

/** No payload past a label or an id needs more than a control route's headroom. */
const CONTROL_BODY_LIMIT = 4096;

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

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
}

export const tokenRoutes =
    ({ store }: TokenRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        /**
         * Every route scopes to the CALLER's org (#99): a personal token is minted into the org
         * the caller is signed into, and an org token into the org of the admin... of the member
         * who mints it — installation access is membership and there are no roles above member,
         * so the org-token routes lost their admin gate with the roster that fed it.
         */
        const orgIdOf = (request: Parameters<typeof callerOf>[0]): string => {
            const caller = callerOf(request);
            if (!caller) throw new Error('token routes require a caller');
            return caller.org.id;
        };

        app.post('/api/tokens', { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
            const label = parseLabel(request.body);
            if (label === null) return bad(reply, 'BAD_LABEL', `label must be 1 to ${LABEL_LIMIT} characters`);

            const created = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                async () => {
                    const token = mintAccessToken('personal');
                    const row = await store.createAccessToken({
                        kind: 'personal',
                        orgId: orgIdOf(request),
                        userId: caller.user.id,
                        createdBy: caller.user.id,
                        label,
                        tokenHash: hashToken(token),
                    });
                    return { id: row.id, token };
                }
            );
            if (!created.ok) return reply;
            return reply.code(HTTP_CREATED).send(created.value);
        });

        app.get('/api/tokens', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
            const listed = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.listPersonalTokens(orgIdOf(request), caller.user.id)
            );
            if (!listed.ok) return reply;
            return reply.code(HTTP_OK).send({ tokens: listed.value });
        });

        app.post('/api/tokens/:id/revoke', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
            const { id } = request.params as { id: string };
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const revoked = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.revokePersonalToken(orgIdOf(request), caller.user.id, id)
            );
            if (!revoked.ok) return reply;
            // Not-found covers unknown, someone else's, and already revoked alike: a revoke that
            // changed nothing has no row to name.
            if (revoked.value === 'missing') return bad(reply, 'NOT_FOUND', 'No such token', HTTP_NOT_FOUND);
            return reply.code(HTTP_OK).send({ id, revoked: true });
        });

        app.post('/api/tokens/org', { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
            const label = parseLabel(request.body);
            if (label === null) return bad(reply, 'BAD_LABEL', `label must be 1 to ${LABEL_LIMIT} characters`);

            const created = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                async () => {
                    const token = mintAccessToken('org');
                    const row = await store.createAccessToken({
                        kind: 'org',
                        orgId: orgIdOf(request),
                        userId: null,
                        createdBy: caller.user.id,
                        label,
                        tokenHash: hashToken(token),
                    });
                    return { id: row.id, token };
                }
            );
            if (!created.ok) return reply;
            return reply.code(HTTP_CREATED).send(created.value);
        });

        app.get('/api/tokens/org', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
            const listed = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.listOrgTokens(orgIdOf(request))
            );
            if (!listed.ok) return reply;
            return reply.code(HTTP_OK).send({ tokens: listed.value });
        });

        app.post('/api/tokens/org/:id/revoke', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', HTTP_UNAUTHORIZED);
            const { id } = request.params as { id: string };
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const revoked = await guard(
                reply,
                (e) => request.log.error({ err: e }),
                () => store.revokeOrgToken(orgIdOf(request), id)
            );
            if (!revoked.ok) return reply;
            if (revoked.value === 'missing') return bad(reply, 'NOT_FOUND', 'No such token', HTTP_NOT_FOUND);
            return reply.code(HTTP_OK).send({ id, revoked: true });
        });
    };
