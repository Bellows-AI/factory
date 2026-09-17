import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AuthStore } from '../auth/store.js';

/**
 * A payload big enough for any member event and far above what a real delivery can reach.
 */
const BODY_LIMIT = 1_000_000;

/**
 * GitHub signs the RAW body with the shared secret and sends `sha256=<hex>` — compare the digests
 * in constant time, the `secretsMatch` shape the auth plugin already uses for its string secrets.
 */
function signatureMatches(secret: string, header: unknown, body: Buffer): boolean {
    if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'), 'utf8');
    const provided = Buffer.from(header.slice('sha256='.length), 'utf8');
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
}

/** The fields this route reads, everything else in the delivery is ignored. */
interface MemberRemovedPayload {
    action?: unknown;
    installation?: { id?: unknown } | null;
    membership?: { user?: { id?: unknown } | null } | null;
}

export const webhookRoutes =
    ({ store, secret }: { store: AuthStore; secret: string }): FastifyPluginAsync =>
    async (app) => {
        // The signature is computed over the raw bytes, so this scope's parser hands the route the
        // Buffer and verification runs before any parse. Scoped to this plugin: every other route
        // keeps Fastify's own JSON parser.
        app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

        app.post('/api/github/webhook', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            // The signature IS the credential here — the route is open to the auth hook
            // (OPEN_ROUTES) precisely so it can do its own authentication.
            const body = request.body as Buffer;
            if (!signatureMatches(secret, request.headers['x-hub-signature-256'], body)) {
                return reply.code(401).send({ error: 'Invalid signature', code: 'UNAUTHENTICATED' });
            }

            // A body GitHub signed that does not parse is not fixed by a redelivery, so it is
            // 200 and a log line — never a 4xx/5xx for GitHub to retry forever.
            let payload: MemberRemovedPayload;
            try {
                payload = JSON.parse(body.toString('utf8')) as MemberRemovedPayload;
            } catch (e) {
                request.log.warn({ err: e }, 'webhook body did not parse');
                return reply.code(200).send({ ok: true });
            }

            // Unknown events are ignored loudly enough to find in the log, answered 200: a
            // non-2xx makes GitHub retry a delivery this deployment will never handle.
            if (request.headers['x-github-event'] !== 'organization') {
                return reply.code(200).send({ ok: true });
            }
            if (payload.action !== 'member_removed') return reply.code(200).send({ ok: true });

            // installation.id IS the organization id — the orgs are the App's installations (#99) —
            // and membership.user.id is THE identity: github_login is a label (docs/auth.md).
            const installation = payload.installation?.id;
            const githubUserId = payload.membership?.user?.id;
            if (typeof installation !== 'number' || typeof githubUserId !== 'number') {
                return reply.code(200).send({ ok: true });
            }

            // The deletion is the whole act of revocation: findSession and findPersonalToken
            // inner-join through org_membership, so the removed account's every credential dies
            // on its next request — bounded by GitHub's report, not the next sign-in.
            await store.removeMember(String(installation), githubUserId);
            return reply.code(200).send({ ok: true });
        });
    };
