import type { AskedQuestion } from './board.js';
import type { PublishRelay, PublishSlot } from './publish-control.js';
import { QUESTION_ID, validateQuestionReport } from './question-validation.js';

/**
 * The control endpoint's question state (`POST /question`, `GET /question/:id`), one per control
 * token — so one lease. It is the driver's half of the runner bridge: the bridge posts what the
 * agent asked and polls for the answer; the loop (`loop-questions.ts`) forwards the ask to the
 * board and feeds the board's answer back in here. Question text and answers pass through and are
 * never logged.
 */

/** One attempt asks at most this many questions — the board's own cap (`QUESTIONS_PER_ATTEMPT`). */
export const QUESTIONS_PER_ATTEMPT = 5;
/** `POST /question` carries up to four questions of four options each: far more than a gate call. */
export const QUESTION_BODY_LIMIT = 65_536;

const HTTP_ACCEPTED = 202;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;

/** Where one question stands, as `GET /question/:id` answers it. */
export type QuestionState =
    | { state: 'pending' }
    | { state: 'answered'; answers: Record<string, string> }
    | { state: 'expired' }
    | { state: 'cancelled' };

/** How a pending question is settled from outside: an answer, or the wait running out. */
export type QuestionResolution = Extract<QuestionState, { state: 'answered' | 'expired' }>;

/**
 * What the loop does with a newly recorded question: `accepted` (the board has it), `refused` (the
 * board's question limit, 429) or `gone` (the lease is lost — the attempt is over).
 */
export interface QuestionRelay {
    ask(questionId: string, questions: AskedQuestion[]): Promise<'accepted' | 'refused' | 'gone'>;
}

/** One control token's state: the stop flag, whether a runner ever read it, and its questions. */
export interface ControlEntry {
    stop: boolean;
    polled: boolean;
    questions: Map<string, QuestionState>;
    /** The forward of each question still being reported to the board, by id. */
    inflight: Map<string, Promise<QuestionAnswer>>;
    relay: QuestionRelay | null;
    /** The draft-publication route's relay and in-flight flag (`publish-control.ts`). */
    publisher: PublishRelay | null;
    publishing: PublishSlot;
}

export const newControl = (relay: QuestionRelay | null, publisher: PublishRelay | null = null): ControlEntry => ({
    stop: false,
    polled: false,
    questions: new Map(),
    inflight: new Map(),
    relay,
    publisher,
    publishing: { running: false },
});

export interface QuestionAnswer {
    status: number;
    body: unknown;
}

const refusedAnswer: QuestionAnswer = { status: HTTP_TOO_MANY_REQUESTS, body: { state: 'refused' } };

/** `POST /question`: validate, record, forward once. Rejects when the forward throws; the record is dropped. */
export async function recordQuestion(control: ControlEntry, raw: string): Promise<QuestionAnswer> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = null;
    }
    const report = validateQuestionReport(parsed);
    if (!report) return { status: HTTP_BAD_REQUEST, body: { error: 'invalid question' } };
    // A repeat that arrives while the first forward is in flight waits for it and gets the same
    // answer, so a forward that then fails or is refused fails the repeat too and the bridge retries.
    const inflight = control.inflight.get(report.questionId);
    if (inflight) return inflight;
    const known = control.questions.get(report.questionId);
    if (known) return { status: HTTP_ACCEPTED, body: { state: known.state } };
    if (control.questions.size >= QUESTIONS_PER_ATTEMPT) return refusedAnswer;
    // Asked after a Stop was raised: nobody is waiting, so nothing is forwarded to the board.
    if (control.stop) {
        control.questions.set(report.questionId, { state: 'cancelled' });
        return { status: HTTP_ACCEPTED, body: { state: 'cancelled' } };
    }
    const forwarding = forwardQuestion(control, report);
    control.inflight.set(report.questionId, forwarding);
    try {
        return await forwarding;
    } finally {
        control.inflight.delete(report.questionId);
    }
}

/** Records the question pending, forwards it, and drops the record again when the board did not take it. */
async function forwardQuestion(
    control: ControlEntry,
    report: { questionId: string; questions: AskedQuestion[] }
): Promise<QuestionAnswer> {
    control.questions.set(report.questionId, { state: 'pending' });
    let verdict: Awaited<ReturnType<QuestionRelay['ask']>> = 'accepted';
    try {
        verdict = (await control.relay?.ask(report.questionId, report.questions)) ?? 'accepted';
    } catch (e) {
        control.questions.delete(report.questionId);
        throw e;
    }
    if (verdict === 'accepted') return { status: HTTP_ACCEPTED, body: { state: 'pending' } };
    control.questions.delete(report.questionId);
    if (verdict === 'refused') return refusedAnswer;
    return { status: HTTP_UNAUTHORIZED, body: { error: 'unknown token' } };
}

/** `GET /question/:id`. */
export function readQuestion(control: ControlEntry, questionId: string): QuestionAnswer {
    const known = QUESTION_ID.test(questionId) ? control.questions.get(questionId) : undefined;
    if (!known) return { status: HTTP_NOT_FOUND, body: { error: 'unknown question' } };
    return { status: HTTP_OK, body: known };
}

/** Settles a PENDING question; anything already settled, and unknown ids, are left alone. */
export function resolveQuestion(control: ControlEntry, questionId: string, resolution: QuestionResolution): boolean {
    if (control.questions.get(questionId)?.state !== 'pending') return false;
    control.questions.set(questionId, resolution);
    return true;
}

/** A stop: every pending question is cancelled, so the bridge interrupts the CLI without polling `/control`. */
export function cancelPendingQuestions(control: ControlEntry): void {
    for (const [id, question] of control.questions) {
        if (question.state === 'pending') control.questions.set(id, { state: 'cancelled' });
    }
}

export const hasPendingQuestion = (control: ControlEntry): boolean =>
    [...control.questions.values()].some((question) => question.state === 'pending');
