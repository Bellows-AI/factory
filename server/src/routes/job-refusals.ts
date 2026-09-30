import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyReply } from 'fastify';
import { bad } from './helpers.js';
import { HTTP_CONFLICT, HTTP_FORBIDDEN, notFoundJob } from './job-limits.js';

/**
 * The shared refusal renderers of the job routes' person writes — "what the store's refusal
 * reason answers, status code and envelope included" — split out of `job-field-validation.ts`
 * for that file's line budget. They render; they validate nothing.
 */

export type FollowUpRefusal = 'missing' | 'not_finished' | 'task_done' | 'no_session' | 'forbidden' | 'purging';

export function followUpRefusal(reply: FastifyReply, reason: FollowUpRefusal) {
    switch (reason) {
        case 'missing':
            return notFoundJob(reply);
        case 'not_finished':
            return reply.code(HTTP_CONFLICT).send({ error: 'Task is not finished', code: ERROR_CODES.NOT_FINISHED });
        case 'task_done':
            return reply.code(HTTP_CONFLICT).send({ error: 'Task is done', code: ERROR_CODES.TASK_DONE });
        case 'no_session':
            return reply
                .code(HTTP_CONFLICT)
                .send({ error: 'The finished run has no agent session to continue', code: ERROR_CODES.NO_SESSION });
        case 'forbidden':
            return bad(
                reply,
                ERROR_CODES.FORBIDDEN,
                'Only the account that queued the task can follow it up',
                HTTP_FORBIDDEN
            );
        case 'purging':
            return reply.code(HTTP_CONFLICT).send({
                error: "The task's checkout is being deleted from disk",
                code: ERROR_CODES.PURGE_IN_PROGRESS,
            });
    }
}

export type RetryRefusal = 'missing' | 'not_finished' | 'task_done' | 'forbidden' | 'purging';

export function retryRefusal(reply: FastifyReply, reason: RetryRefusal) {
    switch (reason) {
        case 'missing':
            return notFoundJob(reply);
        case 'not_finished':
            return reply.code(HTTP_CONFLICT).send({ error: 'Task is not finished', code: ERROR_CODES.NOT_FINISHED });
        case 'task_done':
            return reply.code(HTTP_CONFLICT).send({ error: 'Task is done', code: ERROR_CODES.TASK_DONE });
        case 'forbidden':
            return bad(
                reply,
                ERROR_CODES.FORBIDDEN,
                'Only the account that queued the task can retry it',
                HTTP_FORBIDDEN
            );
        case 'purging':
            return reply.code(HTTP_CONFLICT).send({
                error: "The task's checkout is being deleted from disk",
                code: ERROR_CODES.PURGE_IN_PROGRESS,
            });
    }
}

/** The refusal answers both wait-control verbs (issue #328) share; the ok paths differ per route. */
export type WaitControlRefusal = 'missing' | 'forbidden' | 'no_wait';

export function waitControlRefusal(reply: FastifyReply, reason: WaitControlRefusal) {
    switch (reason) {
        case 'missing':
            return notFoundJob(reply);
        case 'forbidden':
            return reply.code(HTTP_FORBIDDEN).send({
                error: 'Only the account that queued the task can control its wait',
                code: ERROR_CODES.FORBIDDEN,
            });
        case 'no_wait':
            return reply
                .code(HTTP_CONFLICT)
                .send({ error: 'The task has no open wait', code: ERROR_CODES.NO_OPEN_WAIT });
    }
}
