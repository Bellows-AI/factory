import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UUID } from '../config.js';
import type { ReviewRequest } from '../db/job-store-types.js';
import type { OrgRegistry } from '../orgs.js';
import { REVIEWER_NAME } from '../workspace/bellows-reviewers.js';
import { bad, body, guard } from './helpers.js';
import {
    HTTP_CONFLICT,
    HTTP_CREATED,
    HTTP_NOT_FOUND,
    HTTP_OK,
    REVIEW_KEY,
    REVIEW_REVISION_LIMIT,
    leaseLost,
    notFoundJob,
} from './job-limits.js';
import { resolveJobRoute } from './route-guards.js';

/**
 * Independent reviewer invocation (issue #549): the driver's request for a named reviewer's
 * separate run, and its read of the verdict. Both are worker routes, lease-fenced like every
 * worker write. The revision and the ref are what the DRIVER measured and snapshotted — the agent
 * names a key and a profile, never a revision.
 */

const BAD_KEY_MESSAGE = 'key must be 1..64 characters of letters, digits, _ and -';

type Checked = { ok: true; value: ReviewRequest } | { ok: false; message: string };

function validateReviewBody(fields: Record<string, unknown>): Checked {
    const { key, profile, revision, ref } = fields;
    if (typeof key !== 'string' || !REVIEW_KEY.test(key)) return { ok: false, message: BAD_KEY_MESSAGE };
    if (typeof profile !== 'string' || !REVIEWER_NAME.test(profile)) {
        return { ok: false, message: 'profile must be a lowercase reviewer name' };
    }
    if (typeof revision !== 'string' || revision === '' || revision.length > REVIEW_REVISION_LIMIT) {
        return {
            ok: false,
            message: `revision must be a non-empty string of at most ${REVIEW_REVISION_LIMIT} characters`,
        };
    }
    if (typeof ref !== 'string' || ref === '' || ref.length > REVIEW_REVISION_LIMIT) {
        return { ok: false, message: 'ref must be a non-empty git ref' };
    }
    return { ok: true, value: { key, profile, revision, ref } };
}

export async function handleReviewRequest(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const { leaseToken } = fields;
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const parsed = validateReviewBody(fields);
    if (!parsed.ok) return bad(reply, ERROR_CODES.INVALID_REVIEW, parsed.message);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job review request failed'),
        () => store.requestReview(id, leaseToken, parsed.value)
    );
    if (!result.ok) return reply;
    const outcome = result.value;
    if ('review' in outcome)
        return reply.code(outcome.result === 'created' ? HTTP_CREATED : HTTP_OK).send(outcome.review);
    return refusedReview(reply, outcome.result, parsed.value.profile);
}

/** The answer of each way a request is refused. */
function refusedReview(
    reply: FastifyReply,
    refusal: 'lost' | 'missing' | 'unsupported' | 'unknown_profile' | 'invalid_ref',
    profile: string
) {
    if (refusal === 'missing') return notFoundJob(reply);
    if (refusal === 'lost') return leaseLost(reply);
    if (refusal === 'unsupported') {
        return bad(
            reply,
            ERROR_CODES.REVIEW_UNSUPPORTED,
            'A workflow task reviews through its own graph; a named reviewer is for tasks without one',
            HTTP_CONFLICT
        );
    }
    if (refusal === 'unknown_profile') {
        return bad(
            reply,
            ERROR_CODES.UNKNOWN_REVIEWER,
            `No reviewer named "${profile}" is declared in this repository's .bellows.yaml`,
            HTTP_CONFLICT
        );
    }
    return bad(reply, ERROR_CODES.INVALID_REVIEW, 'ref is not the snapshot ref of this task and key');
}

export async function handleReviewRead(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken, key } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    if (typeof key !== 'string' || !REVIEW_KEY.test(key)) {
        return bad(reply, ERROR_CODES.INVALID_REVIEW, BAD_KEY_MESSAGE);
    }
    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job review read failed'),
        () => store.readReview(id, leaseToken, key)
    );
    if (!result.ok) return reply;
    const outcome = result.value;
    if ('review' in outcome) return reply.code(HTTP_OK).send(outcome.review);
    if (outcome.result === 'missing') return notFoundJob(reply);
    if (outcome.result === 'lost') return leaseLost(reply);
    return bad(reply, ERROR_CODES.REVIEW_NOT_FOUND, 'No review was requested under that key', HTTP_NOT_FOUND);
}
