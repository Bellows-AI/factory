import { useId, useRef, useState } from 'react';
import type { AnswerOutcome } from '../api/answer-question.js';
import type { AskedQuestion, JobQuestion } from '../api/useJobs.js';
import { RelativeTime } from '../components/RelativeTime.js';
import {
    ANSWER_MAX_LENGTH,
    choose,
    composeAnswers,
    emptyDraft,
    type QuestionDraft,
    type QuestionPhase,
    type QuestionView,
    questionView,
    settle,
} from '../task-question.js';

/** How a run's question is answered: the POST, already bound to the run's job id. */
export type AnswerQuestion = (questionId: string, answers: Record<string, string>) => Promise<AnswerOutcome>;

const SUBMIT_LABEL: Partial<Record<QuestionView, string>> = {
    submitting: 'Sending…',
    failed: 'Try again',
};

function Legend({ asked }: { asked: AskedQuestion }) {
    return (
        <>
            <span className="pill question-chip">{asked.header}</span>
            {asked.question}
        </>
    );
}

/**
 * One asked question as native inputs, so arrow keys walk the radios and Tab walks the fieldsets.
 * Other is the last choice of the same group and reveals its text box once chosen.
 */
function AskedFieldset({
    asked,
    draft,
    disabled,
    onChoose,
    onOtherText,
}: {
    asked: AskedQuestion;
    draft: QuestionDraft;
    disabled: boolean;
    onChoose: (label: string | null, checked: boolean) => void;
    onOtherText: (text: string) => void;
}) {
    const id = useId();
    const type = asked.multiSelect ? 'checkbox' : 'radio';
    return (
        <fieldset className="question-set" disabled={disabled}>
            <legend>
                <Legend asked={asked} />
            </legend>
            {asked.options.map((option, index) => {
                const hintId = option.description ? `${id}-hint-${index}` : undefined;
                return (
                    <label key={option.label} className="question-option">
                        <input
                            type={type}
                            name={id}
                            value={option.label}
                            checked={draft.selected.includes(option.label)}
                            aria-describedby={hintId}
                            onChange={(e) => onChoose(option.label, e.currentTarget.checked)}
                        />
                        <span>{option.label}</span>
                        {hintId ? (
                            <span className="question-hint" id={hintId}>
                                {option.description}
                            </span>
                        ) : null}
                    </label>
                );
            })}
            <label className="question-option">
                <input
                    type={type}
                    name={id}
                    value=""
                    checked={draft.other}
                    onChange={(e) => onChoose(null, e.currentTarget.checked)}
                />
                <span>Other</span>
            </label>
            {draft.other ? (
                <input
                    type="text"
                    className="question-other"
                    maxLength={ANSWER_MAX_LENGTH}
                    value={draft.otherText}
                    aria-label={`Other answer to: ${asked.question}`}
                    onChange={(e) => onOtherText(e.currentTarget.value)}
                />
            ) : null}
        </fieldset>
    );
}

/** The read-only question list of a settled question: each text, with its answer when it has one. */
function AnsweredList({ question }: { question: JobQuestion }) {
    return (
        <dl className="question-answers">
            {question.questions.map((asked) => (
                <div key={asked.question}>
                    <dt>
                        <Legend asked={asked} />
                    </dt>
                    {question.answers ? <dd>{question.answers[asked.question] ?? '—'}</dd> : null}
                </div>
            ))}
        </dl>
    );
}

function StatusLine({ question, view, now }: { question: JobQuestion; view: QuestionView; now?: Date | undefined }) {
    if (view === 'answered') {
        const by = question.answeredBy?.name ?? question.answeredBy?.login ?? null;
        return (
            <>
                {by !== null ? `Answered by ${by}` : 'Answered'}
                {question.answeredAt !== null ? (
                    <>
                        {' · '}
                        <RelativeTime at={question.answeredAt} now={now} />
                    </>
                ) : null}
            </>
        );
    }
    if (view === 'expired') return <>Expired unanswered after 1 hour</>;
    if (view === 'closed') return <>Run ended before an answer</>;
    if (view === 'submitting') return <>Sending your answer…</>;
    return <>Claude is waiting for your answer</>;
}

/**
 * One AskUserQuestion call inside its run's exchange, in whichever of its six states it is.
 * Props in, markup out — `TaskQuestion` below owns the drafts and the request. The live region is
 * the same node in every state, so the switch from the form to its outcome is announced.
 */
export function TaskQuestionView({
    question,
    phase,
    drafts,
    error,
    onChoose,
    onOtherText,
    onSubmit,
    now,
}: {
    question: JobQuestion;
    phase: QuestionPhase;
    drafts: QuestionDraft[];
    error: string | null;
    onChoose: (index: number, label: string | null, checked: boolean) => void;
    onOtherText: (index: number, text: string) => void;
    onSubmit: () => void;
    now?: Date | undefined;
}) {
    const errorId = useId();
    const view = questionView(question, phase);
    const open = view === 'waiting' || view === 'submitting' || view === 'failed';
    const submitting = view === 'submitting';
    const ready = composeAnswers(question.questions, drafts) !== null;
    return (
        <div className="question">
            {open ? (
                <form
                    aria-describedby={error !== null ? errorId : undefined}
                    onSubmit={(e) => {
                        e.preventDefault();
                        onSubmit();
                    }}
                >
                    {question.questions.map((asked, index) => (
                        <AskedFieldset
                            key={asked.question}
                            asked={asked}
                            draft={drafts[index] ?? emptyDraft()}
                            disabled={submitting}
                            onChoose={(label, checked) => onChoose(index, label, checked)}
                            onOtherText={(text) => onOtherText(index, text)}
                        />
                    ))}
                    <button
                        type="submit"
                        className="primary"
                        disabled={!ready || submitting}
                        aria-busy={submitting || undefined}
                        aria-describedby={error !== null ? errorId : undefined}
                    >
                        {SUBMIT_LABEL[view] ?? 'Submit'}
                    </button>
                    {error !== null ? (
                        <p className="question-error" id={errorId}>
                            Your answer was not sent: {error}. Your choices are kept — try again.
                        </p>
                    ) : null}
                </form>
            ) : (
                <AnsweredList question={question} />
            )}
            <p className="question-status" aria-live="polite">
                <StatusLine question={question} view={view} now={now} />
            </p>
        </div>
    );
}

/**
 * The stateful half: the member's picks, the one in-flight request (a second Submit while it is
 * out does nothing), and what it settled to — laid over the polled row until the thread refresh
 * the page runs after a settled answer catches up.
 */
export function TaskQuestion({ question, onAnswer }: { question: JobQuestion; onAnswer: AnswerQuestion }) {
    const [drafts, setDrafts] = useState<QuestionDraft[]>(() => question.questions.map(emptyDraft));
    const [phase, setPhase] = useState<QuestionPhase>('idle');
    const [error, setError] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<AnswerOutcome | null>(null);
    const inFlight = useRef(false);

    const update = (index: number, next: (draft: QuestionDraft) => QuestionDraft) =>
        setDrafts((current) => current.map((draft, at) => (at === index ? next(draft) : draft)));

    const submit = async () => {
        const answers = composeAnswers(question.questions, drafts);
        if (answers === null || inFlight.current) return;
        inFlight.current = true;
        setPhase('submitting');
        setError(null);
        const result = await onAnswer(question.id, answers);
        inFlight.current = false;
        setOutcome(result);
        setPhase(result.state === 'failed' ? 'failed' : 'idle');
        setError(result.state === 'failed' ? result.error : null);
    };

    return (
        <TaskQuestionView
            question={settle(question, outcome)}
            phase={phase}
            drafts={drafts}
            error={error}
            onChoose={(index, label, checked) =>
                update(index, (draft) => choose(draft, question.questions[index]!, label, checked))
            }
            onOtherText={(index, text) => update(index, (draft) => ({ ...draft, otherText: text }))}
            onSubmit={() => void submit()}
        />
    );
}
