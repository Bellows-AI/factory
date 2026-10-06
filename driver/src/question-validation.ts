import type { AskedQuestion } from './board.js';

/**
 * The question report's validation, the driver's copy of the board's
 * (`server/src/routes/job-field-validation-questions.ts`, limits in `job-limits.ts`): the control
 * endpoint refuses what the board would, so a malformed ask never reaches the wire. Copied, not
 * imported — this package depends on nothing. Unknown keys are dropped.
 */

export const QUESTION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const QUESTIONS_PER_ASK_MAX = 4;
const QUESTION_OPTIONS_MIN = 2;
const QUESTION_OPTIONS_MAX = 4;
const QUESTION_TEXT_LIMIT = 1000;
const QUESTION_HEADER_LIMIT = 100;
const QUESTION_LABEL_LIMIT = 200;
const QUESTION_DESCRIPTION_LIMIT = 1000;

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
    typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const boundedText = (raw: unknown, limit: number): raw is string =>
    typeof raw === 'string' && raw.trim().length > 0 && raw.length <= limit;

function validOption(raw: unknown): AskedQuestion['options'][number] | null {
    if (!isRecord(raw) || !boundedText(raw.label, QUESTION_LABEL_LIMIT)) return null;
    const { label, description } = raw;
    if (description === undefined) return { label };
    if (typeof description !== 'string' || description.length > QUESTION_DESCRIPTION_LIMIT) return null;
    return { label, description };
}

function validAsked(raw: unknown): AskedQuestion | null {
    if (!isRecord(raw)) return null;
    const { question, header, multiSelect, options } = raw;
    if (!boundedText(question, QUESTION_TEXT_LIMIT) || !boundedText(header, QUESTION_HEADER_LIMIT)) return null;
    if (typeof multiSelect !== 'boolean') return null;
    if (!Array.isArray(options) || options.length < QUESTION_OPTIONS_MIN || options.length > QUESTION_OPTIONS_MAX) {
        return null;
    }
    const kept: AskedQuestion['options'] = [];
    for (const item of options) {
        const one = validOption(item);
        if (!one) return null;
        kept.push(one);
    }
    return { question, header, multiSelect, options: kept };
}

/** The question report body, or null when the board would refuse it. Question texts must be distinct. */
export function validateQuestionReport(raw: unknown): { questionId: string; questions: AskedQuestion[] } | null {
    if (!isRecord(raw)) return null;
    const { questionId, questions } = raw;
    if (typeof questionId !== 'string' || !QUESTION_ID.test(questionId)) return null;
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > QUESTIONS_PER_ASK_MAX) return null;
    const asked: AskedQuestion[] = [];
    for (const item of questions) {
        const one = validAsked(item);
        if (!one) return null;
        asked.push(one);
    }
    if (new Set(asked.map((entry) => entry.question)).size !== asked.length) return null;
    return { questionId, questions: asked };
}
