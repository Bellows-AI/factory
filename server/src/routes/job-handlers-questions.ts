import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import { UUID } from '../config.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, body, guard } from './helpers.js';
import { validateAnswerBody, validateQuestionBody } from './job-field-validation-questions.js';
import {
    HTTP_CONFLICT,
    HTTP_CREATED,
    HTTP_OK,
    HTTP_TOO_MANY_REQUESTS,
    QUESTION_ID,
    leaseLost,
    notFoundJob,
} from './job-limits.js';
import { resolveJobRoute } from './route-guards.js';

/**
 * The agent's questions (050, issue #531). The question text and the answers are member content:
 * nothing here logs them — the failure logs below carry the error alone.
 */

// The driver reports a question the agent asked: lease-fenced like every worker write, and a 409
// from it is not a kill order (the artifact rule) — the question is retention for the member.
export async function handleQuestion(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const fields = body(request.body);
    const { leaseToken } = fields;
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    const parsed = validateQuestionBody(fields);
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job question report failed'),
        () => store.askQuestion(id, leaseToken, parsed.value)
    );
    if (!result.ok) return reply;
    const outcome = result.value;
    if (outcome.result === 'missing') return notFoundJob(reply);
    if (outcome.result === 'lost') return leaseLost(reply);
    if (!('question' in outcome)) {
        return reply
            .code(HTTP_TOO_MANY_REQUESTS)
            .send({ error: 'This attempt has asked its question limit', code: ERROR_CODES.QUESTION_LIMIT });
    }
    return reply.code(outcome.result === 'created' ? HTTP_CREATED : HTTP_OK).send(outcome.question);
}

// The driver gives up waiting on a question. The board decides the race with an answer: an
// answered question comes back answered, and the driver delivers the answer instead of expiring.
export async function handleQuestionExpire(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { leaseToken, questionId } = body(request.body);
    if (typeof leaseToken !== 'string' || !UUID.test(leaseToken)) {
        return bad(reply, ERROR_CODES.BAD_TOKEN, 'leaseToken must be a uuid');
    }
    if (typeof questionId !== 'string' || !QUESTION_ID.test(questionId)) {
        return bad(
            reply,
            ERROR_CODES.INVALID_QUESTION,
            'questionId must be 1..128 characters of letters, digits, _ and -'
        );
    }

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job question expiry failed'),
        () => store.expireQuestion(id, leaseToken, questionId)
    );
    if (!result.ok) return reply;
    if (result.value.result === 'missing' || result.value.result === 'unknown') return notFoundJob(reply);
    if (result.value.result === 'lost') return leaseLost(reply);
    if (result.value.result === 'answered') {
        return reply.code(HTTP_OK).send({ state: 'answered', answers: result.value.answers });
    }
    return reply.code(HTTP_OK).send({ state: 'expired' });
}

// A member's answer. Any authenticated member of the task's org may answer — the same rule as
// Stop, the actor off the session, never the body. The store's one conditional update is what
// makes a retried or concurrent answer land once; the loser is told what the winner left.
export async function handleAnswer(orgs: OrgRegistry, request: FastifyRequest, reply: FastifyReply) {
    const route = await resolveJobRoute(orgs, request, reply);
    if (!route) return reply;
    const { store, id } = route;

    const { questionId } = request.params as { questionId: string };
    if (!QUESTION_ID.test(questionId)) return notFoundJob(reply);
    const parsed = validateAnswerBody(body(request.body));
    if (!parsed.ok) return bad(reply, parsed.code, parsed.message);

    const result = await guard(
        reply,
        (e) => request.log.error({ err: e }, 'job question answer failed'),
        () => store.answerQuestion(id, questionId, parsed.value, callerOf(request)?.user.id ?? null)
    );
    if (!result.ok) return reply;
    const outcome = result.value;
    if (outcome.result === 'unknown') return notFoundJob(reply);
    if (outcome.result === 'invalid') return bad(reply, ERROR_CODES.INVALID_ANSWER, outcome.message);
    if (outcome.result === 'ok') return reply.code(HTTP_OK).send(outcome.question);
    if (outcome.reason === 'answered') {
        return reply.code(HTTP_CONFLICT).send({
            error: 'Question already answered',
            code: ERROR_CODES.QUESTION_ANSWERED,
            answers: outcome.question.answers,
            answeredBy: outcome.question.answeredBy,
        });
    }
    if (outcome.reason === 'expired') {
        return reply.code(HTTP_CONFLICT).send({ error: 'Question expired', code: ERROR_CODES.QUESTION_EXPIRED });
    }
    return reply
        .code(HTTP_CONFLICT)
        .send({ error: 'The run that asked is no longer waiting', code: ERROR_CODES.QUESTION_CLOSED });
}
