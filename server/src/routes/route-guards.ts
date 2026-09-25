import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { Caller } from '../auth/store.js';
import { UUID } from '../config.js';
import type { JobStore } from '../db/job-store-types.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, body } from './helpers.js';
import { boardsFor, storeFor } from './job-context.js';
import { validateClaimBody } from './job-field-validation.js';
import { noBoard } from './job-limits.js';

/**
 * The preambles the `:id` and CLAIM routes open with.
 *
 * These live beside `helpers.ts` rather than inside it because `job-limits` and
 * `job-field-validation` both import `helpers` for `bad`/`body`: putting the resolvers there makes
 * `helpers` import them back, and the pair becomes an import cycle (`noImportCycles`). `helpers`
 * stays the leaf every route module can reach for, and the composition that needs a board or a
 * claim body lands here, one edge further out.
 */

const HTTP_UNAUTHORIZED = 401;

/**
 * The preamble every `/api/jobs/:id` route opens with: the caller's board, and the id its URL
 * names. Null means the refusal is already sent — a 503 when the org has no board, a 400 BAD_ID
 * when the path segment is not a uuid — so the handler's first line is `if (!route) return reply`.
 *
 * Extracted at 15 copies: the BAD_ID sentence was 15 independent string literals, which is 15
 * chances for one of them to say something else.
 */
export async function resolveJobRoute(
    orgs: OrgRegistry,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<{ store: JobStore; id: string } | null> {
    const store = await storeFor(orgs, request);
    if (!store) {
        await noBoard(reply);
        return null;
    }
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) {
        await bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');
        return null;
    }
    return { store, id };
}

/**
 * The preamble the two CLAIM routes open with — the job queue's and the worktree-reclaim queue's.
 * Byte-identical in both: the boards this credential may poll, then the claim body they share
 * (`validateClaimBody` is already the one spelling of that). Null means the refusal is sent.
 */
export async function resolveClaimRoute(
    orgs: OrgRegistry,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<{ boards: JobStore[]; worker: string; lease: number } | null> {
    const boards = await boardsFor(orgs, request);
    if (!boards.length) {
        await noBoard(reply);
        return null;
    }
    const parsed = validateClaimBody(body(request.body));
    if (!parsed.ok) {
        await bad(reply, parsed.code, parsed.message);
        return null;
    }
    return { boards, ...parsed.value };
}

/**
 * The same preamble for the person-gated `:id` routes that read no board — workflows and tokens.
 * A missing caller is a 401 here rather than the jobs routes' 503: those refuse because the org
 * has no store, these because nobody is signed in.
 */
export function resolveCallerRoute(
    request: FastifyRequest,
    reply: FastifyReply
): { caller: Caller; id: string } | null {
    const caller = callerOf(request);
    if (!caller) {
        void bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
        return null;
    }
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) {
        void bad(reply, ERROR_CODES.BAD_ID, 'id must be a uuid');
        return null;
    }
    return { caller, id };
}
