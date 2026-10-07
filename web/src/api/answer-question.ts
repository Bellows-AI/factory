import { ERROR_CODES, JSON_HEADERS } from '@factory-ai/core';
import type { AuthorRef } from './useJobs.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/**
 * What one answer POST settled to. `answered` covers our own 200 and a 409 another member won —
 * either way the question now carries an answer; a 409 does not say when, so `answeredAt` is null
 * until the thread refresh brings it in. `failed` keeps the form open for a retry.
 */
export type AnswerOutcome =
    | { state: 'answered'; answers: Record<string, string>; answeredBy: AuthorRef | null; answeredAt: string | null }
    | { state: 'expired' }
    | { state: 'closed' }
    | { state: 'failed'; error: string };

interface AnsweredBody {
    answers: Record<string, string>;
    answeredBy: AuthorRef | null;
    answeredAt?: string | null;
}

const answered = (body: AnsweredBody): AnswerOutcome => ({
    state: 'answered',
    answers: body.answers,
    answeredBy: body.answeredBy,
    answeredAt: body.answeredAt ?? null,
});

/** `POST /api/jobs/:id/questions/:questionId/answer`, mapped to the state the question now shows. */
export async function postAnswer(
    jobId: string,
    questionId: string,
    answers: Record<string, string>
): Promise<AnswerOutcome> {
    try {
        const response = await fetch(`/api/jobs/${jobId}/questions/${questionId}/answer`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ answers }),
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { state: 'failed', error: 'Your session expired' };
        }
        if (response.ok) return answered((await response.json()) as AnsweredBody);
        // Read once: the 409 arms need the body's code AND, for an answered one, the winner's answer.
        const body = (await response.json().catch(() => ({}))) as Partial<AnsweredBody> & {
            code?: string;
            error?: string;
        };
        if (body.code === ERROR_CODES.QUESTION_ANSWERED && body.answers) return answered(body as AnsweredBody);
        if (body.code === ERROR_CODES.QUESTION_EXPIRED) return { state: 'expired' };
        if (body.code === ERROR_CODES.QUESTION_CLOSED) return { state: 'closed' };
        return { state: 'failed', error: body.error ?? `Could not send your answer (${response.status})` };
    } catch (e) {
        return { state: 'failed', error: (e as Error).message };
    }
}
