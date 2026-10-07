import { ERROR_CODES } from '@factory-ai/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postAnswer } from '../src/api/answer-question.js';
import type { AskedQuestion, JobQuestion } from '../src/api/useJobs.js';
import { answerOrFail, TaskQuestionView } from '../src/panels/TaskQuestion.js';
import {
    answerValue,
    choose,
    composeAnswers,
    emptyDraft,
    type QuestionDraft,
    type QuestionPhase,
    questionView,
    settle,
} from '../src/task-question.js';
import { FORBIDDEN, question } from './tasks-fixtures.js';

const NOW = new Date('2026-09-01T12:10:00.000Z');

const colours: AskedQuestion = {
    question: 'Which colours?',
    header: 'Colours',
    multiSelect: true,
    options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
};

const draft = (over: Partial<QuestionDraft> = {}): QuestionDraft => ({ ...emptyDraft(), ...over });

function render(
    q: JobQuestion,
    {
        phase = 'idle',
        drafts,
        error = null,
    }: { phase?: QuestionPhase; drafts?: QuestionDraft[]; error?: string | null } = {}
): string {
    const html = renderToStaticMarkup(
        <TaskQuestionView
            question={q}
            phase={phase}
            drafts={drafts ?? q.questions.map(() => emptyDraft())}
            error={error}
            onChoose={() => {}}
            onOtherText={() => {}}
            onSubmit={() => {}}
            now={NOW}
        />
    );
    for (const bad of FORBIDDEN) expect(html).not.toContain(bad);
    return html;
}

const liveRegion = (html: string): string => {
    const start = html.indexOf('aria-live="polite"');
    return html.slice(start, html.indexOf('</p>', start));
};

describe('TaskQuestion: the form', () => {
    it('renders one fieldset per question, a legend holding the header chip and the text, native radios and Other', () => {
        const html = render(question({ questions: [question().questions[0]!, colours] }));
        expect(html.match(/<fieldset/g)?.length).toBe(2);
        expect(html).toMatch(
            /<legend[^>]*><span class="pill question-chip">Database<\/span>Which database\?<\/legend>/
        );
        // Two options and Other as radios; three options and Other as checkboxes.
        expect(html.match(/type="radio"/g)?.length).toBe(3);
        expect(html.match(/type="checkbox"/g)?.length).toBe(4);
        expect(html.match(/>Other</g)?.length).toBe(2);
        expect(liveRegion(html)).toContain('Claude is waiting for your answer');
        expect(html).not.toContain('autofocus');
        expect(html).not.toContain('autoFocus');
    });

    it('shows an option description as hint text linked to its input', () => {
        const html = render(question());
        const hint = html.match(/<span class="question-hint" id="([^"]+)">The board already runs it<\/span>/);
        expect(hint).not.toBeNull();
        expect(html).toContain(`aria-describedby="${hint![1]}"`);
    });

    it('reveals the Other text input, capped at 2000 characters, only once Other is chosen', () => {
        expect(render(question())).not.toContain('class="question-other"');
        const html = render(question(), { drafts: [draft({ other: true, otherText: 'MySQL' })] });
        expect(html).toMatch(/<input[^>]*class="question-other"[^>]*maxLength="2000"[^>]*value="MySQL"/);
    });

    it('keeps Submit disabled until every question has an answer', () => {
        const q = question({ questions: [question().questions[0]!, colours] });
        const submit = (html: string) => html.match(/<button type="submit"[^>]*>/)![0];
        expect(submit(render(q))).toContain('disabled');
        expect(submit(render(q, { drafts: [draft({ selected: ['SQLite'] }), emptyDraft()] }))).toContain('disabled');
        const ready = render(q, { drafts: [draft({ selected: ['SQLite'] }), draft({ selected: ['Red'] })] });
        expect(submit(ready)).not.toContain('disabled');
    });

    it('disables the form and marks Submit busy while the answer is in flight', () => {
        const html = render(question(), { phase: 'submitting', drafts: [draft({ selected: ['SQLite'] })] });
        expect(html).toMatch(/<fieldset[^>]*disabled/);
        expect(html).toMatch(/<button type="submit"[^>]*disabled[^>]*aria-busy="true"/);
        expect(html).toContain('Sending…');
    });

    it('keeps the entered values on a failure and links an inline, retryable error to the form', () => {
        const html = render(question(), {
            phase: 'failed',
            drafts: [draft({ selected: ['SQLite'] })],
            error: 'Could not send your answer (500)',
        });
        expect(html).toMatch(/<input[^>]*checked=""[^>]*value="SQLite"/);
        const error = html.match(/<p class="question-error" id="([^"]+)"[^>]*>([^<]*)/);
        expect(error?.[2]).toContain('Could not send your answer (500)');
        expect(error?.[2]).toContain('try again');
        expect(html).toMatch(new RegExp(`<form[^>]*aria-describedby="${error![1]}"`));
        expect(html).toMatch(new RegExp(`<button type="submit"[^>]*aria-describedby="${error![1]}"`));
        expect(html).toMatch(/<button type="submit"[^>]*>Try again<\/button>/);
        expect(html).not.toMatch(/<button type="submit"[^>]*disabled/);
    });
});

describe('TaskQuestion: the read-only states', () => {
    it('answered: each question with its answer, then who answered and when', () => {
        const html = render(
            question({
                status: 'answered',
                answerable: false,
                answers: { 'Which database?': 'SQLite' },
                answeredBy: { id: 'u1', login: 'octo', name: 'Octo Cat', avatarUrl: null },
                answeredAt: '2026-09-01T12:05:00.000Z',
            })
        );
        expect(html).not.toContain('<input');
        expect(html).not.toContain('<button');
        expect(html).toMatch(/<dt>[\s\S]*Which database\?<\/dt><dd>SQLite<\/dd>/);
        expect(liveRegion(html)).toMatch(/Answered by Octo Cat · <time[^>]*>5m ago<\/time>/);
    });

    it('answered by a person with no display name falls back to the login, and to no time when unknown', () => {
        const html = render(
            question({
                status: 'answered',
                answerable: false,
                answers: { 'Which database?': 'SQLite' },
                answeredBy: { id: 'u1', login: 'octo', name: null, avatarUrl: null },
                answeredAt: null,
            })
        );
        expect(liveRegion(html)).toContain('Answered by octo');
        expect(liveRegion(html)).not.toContain('·');
    });

    it('expired reads "Expired unanswered after 1 hour" with the questions read-only', () => {
        const html = render(question({ status: 'expired', answerable: false }));
        expect(html).not.toContain('<input');
        expect(html).toContain('Which database?');
        expect(liveRegion(html)).toContain('Expired unanswered after 1 hour');
    });

    it('closed — or pending on a run that no longer waits — reads "Run ended before an answer"', () => {
        for (const q of [question({ status: 'closed', answerable: false }), question({ answerable: false })]) {
            const html = render(q);
            expect(html).not.toContain('<input');
            expect(liveRegion(html)).toContain('Run ended before an answer');
        }
    });
});

describe('TaskQuestion: the answer value', () => {
    const single = question().questions[0]!;

    it('single select is the chosen label; choosing Other replaces it', () => {
        const picked = choose(emptyDraft(), single, 'SQLite', true);
        expect(answerValue(single, picked)).toBe('SQLite');
        const other = choose(picked, single, null, true);
        expect(answerValue(single, { ...other, otherText: '  MySQL  ' })).toBe('MySQL');
        expect(answerValue(single, choose(other, single, 'Postgres', true))).toBe('Postgres');
    });

    it('multiSelect joins the chosen labels with ", " in option order, whatever the click order', () => {
        let d = choose(emptyDraft(), colours, 'Blue', true);
        d = choose(d, colours, 'Red', true);
        expect(answerValue(colours, d)).toBe('Red, Blue');
        expect(answerValue(colours, choose(d, colours, 'Blue', false))).toBe('Red');
    });

    it('multiSelect appends the trimmed Other text after the labels', () => {
        const d = choose(choose(emptyDraft(), colours, 'Green', true), colours, null, true);
        expect(answerValue(colours, { ...d, otherText: ' teal ' })).toBe('Green, teal');
    });

    it('nothing chosen, or Other chosen with blank text, is no answer', () => {
        expect(answerValue(single, emptyDraft())).toBeNull();
        expect(answerValue(single, draft({ other: true, otherText: '   ' }))).toBeNull();
        expect(answerValue(colours, draft({ selected: ['Red'], other: true }))).toBeNull();
    });

    it('composes the answers keyed by question text, or null until every question is answered', () => {
        const q = question({ questions: [single, colours] });
        expect(composeAnswers(q.questions, [draft({ selected: ['SQLite'] }), emptyDraft()])).toBeNull();
        expect(composeAnswers(q.questions, [draft({ selected: ['SQLite'] }), draft({ selected: ['Red'] })])).toEqual({
            'Which database?': 'SQLite',
            'Which colours?': 'Red',
        });
    });
});

describe('TaskQuestion: what an answer POST settles to', () => {
    afterEach(() => vi.unstubAllGlobals());

    const respond = (status: number, body: unknown) =>
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json(body, { status }))
        );

    const viewAfter = async (): Promise<string> => {
        const outcome = await postAnswer('job-1', 'toolu_01', { 'Which database?': 'SQLite' });
        return questionView(settle(question(), outcome), outcome.state === 'failed' ? 'failed' : 'idle');
    };

    it('maps each 409 code to its state', async () => {
        respond(409, {
            code: ERROR_CODES.QUESTION_ANSWERED,
            error: 'Question already answered',
            answers: { 'Which database?': 'Postgres' },
            answeredBy: { id: 'u2', login: 'other', name: 'Other Member', avatarUrl: null },
        });
        expect(await viewAfter()).toBe('answered');
        respond(409, { code: ERROR_CODES.QUESTION_EXPIRED, error: 'Question expired' });
        expect(await viewAfter()).toBe('expired');
        respond(409, { code: ERROR_CODES.QUESTION_CLOSED, error: 'The run that asked is no longer waiting' });
        expect(await viewAfter()).toBe('closed');
    });

    it('shows the winner’s answer after a 409 question_answered', async () => {
        respond(409, {
            code: ERROR_CODES.QUESTION_ANSWERED,
            answers: { 'Which database?': 'Postgres' },
            answeredBy: { id: 'u2', login: 'other', name: 'Other Member', avatarUrl: null },
        });
        const outcome = await postAnswer('job-1', 'toolu_01', { 'Which database?': 'SQLite' });
        const html = render(settle(question(), outcome));
        expect(html).toContain('<dd>Postgres</dd>');
        expect(liveRegion(html)).toContain('Answered by Other Member');
    });

    it('a 400, a 5xx and a network error are failures that keep the form', async () => {
        respond(400, { code: ERROR_CODES.INVALID_ANSWER, error: 'answers must name every question' });
        expect(await postAnswer('job-1', 'toolu_01', {})).toEqual({
            state: 'failed',
            error: 'answers must name every question',
        });
        respond(503, {});
        expect(await viewAfter()).toBe('failed');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('Failed to fetch');
            })
        );
        expect(await postAnswer('job-1', 'toolu_01', {})).toEqual({ state: 'failed', error: 'Failed to fetch' });
    });
});

describe('TaskQuestion: an answer callback that rejects', () => {
    it('settles to a failed outcome, so the form leaves Sending… and offers a retry', async () => {
        const outcome = await answerOrFail(
            async () => {
                throw new Error('refresh exploded');
            },
            'toolu_01',
            { 'Which database?': 'SQLite' }
        );
        expect(outcome).toEqual({ state: 'failed', error: 'refresh exploded' });
        expect(questionView(settle(question(), outcome), 'failed')).toBe('failed');
    });
});
