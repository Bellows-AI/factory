import type { AnswerOutcome } from './api/answer-question.js';
import type { AskedQuestion, JobQuestion } from './api/useJobs.js';

/** The board refuses a longer answer (`validateAnswerBody`); the Other input stops there. */
export const ANSWER_MAX_LENGTH = 2000;

/** What a member has picked for one asked question so far: option labels, and the Other choice. */
export interface QuestionDraft {
    selected: string[];
    other: boolean;
    otherText: string;
}

export const emptyDraft = (): QuestionDraft => ({ selected: [], other: false, otherText: '' });

/**
 * One input's change applied to a draft. `label` null is Other. A radio only ever turns on, and
 * turning one on clears the rest — Other included; a checkbox toggles itself alone.
 */
export function choose(
    draft: QuestionDraft,
    asked: AskedQuestion,
    label: string | null,
    checked: boolean
): QuestionDraft {
    if (!asked.multiSelect) {
        return label === null ? { ...draft, selected: [], other: true } : { ...draft, selected: [label], other: false };
    }
    if (label === null) return { ...draft, other: checked };
    const rest = draft.selected.filter((picked) => picked !== label);
    return { ...draft, selected: checked ? [...rest, label] : rest };
}

/**
 * The answer string the board stores for one question: the chosen labels in option order, then
 * the trimmed Other text, joined with ", ". Null is "not answered" — nothing picked, or Other
 * picked with nothing typed.
 */
export function answerValue(asked: AskedQuestion, draft: QuestionDraft): string | null {
    const other = draft.otherText.trim();
    if (draft.other && other === '') return null;
    const labels = asked.options.map((option) => option.label).filter((label) => draft.selected.includes(label));
    const parts = draft.other ? [...labels, other] : labels;
    return parts.length > 0 ? parts.join(', ') : null;
}

/** The POST body's `answers`, keyed by question text — null until every question has one. */
export function composeAnswers(questions: AskedQuestion[], drafts: QuestionDraft[]): Record<string, string> | null {
    const answers: Record<string, string> = {};
    for (const [index, asked] of questions.entries()) {
        const value = answerValue(asked, drafts[index] ?? emptyDraft());
        if (value === null) return null;
        answers[asked.question] = value;
    }
    return answers;
}

/** The member's own request, as the form tracks it. */
export type QuestionPhase = 'idle' | 'submitting' | 'failed';

export type QuestionView = 'waiting' | 'submitting' | 'failed' | 'answered' | 'expired' | 'closed';

/**
 * Lays this tab's settled POST over the polled row until the thread refresh carries the same
 * news: a 409 says what the board already holds, so it settles the question exactly like our 200.
 */
export function settle(question: JobQuestion, outcome: AnswerOutcome | null): JobQuestion {
    if (question.status !== 'pending' || outcome === null || outcome.state === 'failed') return question;
    if (outcome.state === 'answered') {
        const { answers, answeredBy, answeredAt } = outcome;
        return { ...question, status: 'answered', answerable: false, answers, answeredBy, answeredAt };
    }
    return { ...question, status: outcome.state, answerable: false };
}

/** Which of the six states a question shows. A pending row nobody can answer has lost its run. */
export function questionView(question: JobQuestion, phase: QuestionPhase): QuestionView {
    if (question.status !== 'pending') return question.status;
    if (!question.answerable) return 'closed';
    return phase === 'idle' ? 'waiting' : phase;
}
