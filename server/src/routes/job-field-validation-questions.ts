import { ERROR_CODES } from '@factory-ai/core';
import type { AskedQuestion } from '../db/job-store-types.js';
import {
    ANSWER_LIMIT,
    QUESTION_DESCRIPTION_LIMIT,
    QUESTION_HEADER_LIMIT,
    QUESTION_ID,
    QUESTION_LABEL_LIMIT,
    QUESTION_OPTIONS_MAX,
    QUESTION_OPTIONS_MIN,
    QUESTION_TEXT_LIMIT,
    QUESTIONS_PER_ASK_MAX,
} from './job-limits.js';

/**
 * The question report's and the answer's field validation (050, issue #531), split out of
 * `job-field-validation.ts` for that file's line budget. Unknown keys are dropped, never stored:
 * every value that survives is rebuilt from the fields named here.
 */

type Checked<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const invalidQuestion = (message: string): { ok: false; code: string; message: string } => ({
    ok: false,
    code: ERROR_CODES.INVALID_QUESTION,
    message,
});

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
    typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const boundedText = (raw: unknown, limit: number): raw is string =>
    typeof raw === 'string' && raw.trim().length > 0 && raw.length <= limit;

function validateOption(raw: unknown, at: string): Checked<AskedQuestion['options'][number]> {
    if (!isRecord(raw)) return invalidQuestion(`${at} must be an object`);
    const { label, description } = raw;
    if (!boundedText(label, QUESTION_LABEL_LIMIT)) {
        return invalidQuestion(`${at}.label must be a non-empty string of at most ${QUESTION_LABEL_LIMIT} characters`);
    }
    if (description === undefined) return { ok: true, value: { label } };
    if (typeof description !== 'string' || description.length > QUESTION_DESCRIPTION_LIMIT) {
        return invalidQuestion(
            `${at}.description must be a string of at most ${QUESTION_DESCRIPTION_LIMIT} characters`
        );
    }
    return { ok: true, value: { label, description } };
}

function validateOptions(raw: unknown, at: string): Checked<AskedQuestion['options']> {
    if (!Array.isArray(raw) || raw.length < QUESTION_OPTIONS_MIN || raw.length > QUESTION_OPTIONS_MAX) {
        return invalidQuestion(`${at}.options must be ${QUESTION_OPTIONS_MIN}..${QUESTION_OPTIONS_MAX} items`);
    }
    const options: AskedQuestion['options'] = [];
    for (const [i, item] of raw.entries()) {
        const one = validateOption(item, `${at}.options[${i}]`);
        if (!one.ok) return one;
        options.push(one.value);
    }
    return { ok: true, value: options };
}

function validateAsked(raw: unknown, at: string): Checked<AskedQuestion> {
    if (!isRecord(raw)) return invalidQuestion(`${at} must be an object`);
    const { question, header, multiSelect } = raw;
    if (!boundedText(question, QUESTION_TEXT_LIMIT)) {
        return invalidQuestion(
            `${at}.question must be a non-empty string of at most ${QUESTION_TEXT_LIMIT} characters`
        );
    }
    if (!boundedText(header, QUESTION_HEADER_LIMIT)) {
        return invalidQuestion(
            `${at}.header must be a non-empty string of at most ${QUESTION_HEADER_LIMIT} characters`
        );
    }
    if (typeof multiSelect !== 'boolean') return invalidQuestion(`${at}.multiSelect must be a boolean`);
    const options = validateOptions(raw.options, at);
    if (!options.ok) return options;
    return { ok: true, value: { question, header, multiSelect, options: options.value } };
}

/**
 * The question report's body, minus the lease token the handler checks (the artifact precedent).
 * Question texts must be distinct: they key the answer, so a repeat could never be answered twice.
 */
export function validateQuestionBody(
    fields: Record<string, unknown>
): Checked<{ questionId: string; questions: AskedQuestion[] }> {
    const { questionId, questions } = fields;
    if (typeof questionId !== 'string' || !QUESTION_ID.test(questionId)) {
        return invalidQuestion('questionId must be 1..128 characters of letters, digits, _ and -');
    }
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > QUESTIONS_PER_ASK_MAX) {
        return invalidQuestion(`questions must be 1..${QUESTIONS_PER_ASK_MAX} items`);
    }
    const asked: AskedQuestion[] = [];
    for (const [i, item] of questions.entries()) {
        const one = validateAsked(item, `questions[${i}]`);
        if (!one.ok) return one;
        asked.push(one.value);
    }
    if (new Set(asked.map((entry) => entry.question)).size !== asked.length) {
        return invalidQuestion('question texts must be distinct');
    }
    return { ok: true, value: { questionId, questions: asked } };
}

/** The answer's shape: an object of trimmed, non-empty strings. Which keys is the store's check. */
export function validateAnswerBody(fields: Record<string, unknown>): Checked<Record<string, string>> {
    const { answers } = fields;
    const invalid = (message: string) => ({ ok: false as const, code: ERROR_CODES.INVALID_ANSWER, message });
    if (!isRecord(answers)) return invalid('answers must be an object');
    const trimmed: Record<string, string> = {};
    for (const [key, value] of Object.entries(answers)) {
        if (typeof value !== 'string' || value.trim().length === 0) {
            return invalid('every answer must be a non-empty string');
        }
        if (value.trim().length > ANSWER_LIMIT)
            return invalid(`every answer must be at most ${ANSWER_LIMIT} characters`);
        trimmed[key] = value.trim();
    }
    return { ok: true, value: trimmed };
}
