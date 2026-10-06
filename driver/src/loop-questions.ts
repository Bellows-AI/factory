import type { AskedQuestion, BoardJob } from './board.js';
import { withBoardRetry } from './board-retry.js';
import { applyHeartbeatVerdict, down, QUESTION_TIMEOUT_MS } from './loop-attempt.js';
import type { JobState } from './loop-attempt.js';
import type { LoopRuntime } from './loop-types.js';
import type { QuestionRelay } from './question-control.js';

/**
 * The driver's relay of the agent's questions (issue #226): what the control endpoint recorded is
 * reported to the board, the run deadline is pushed out for the wait, and an expiry timer gives up
 * on the answer after `QUESTION_TIMEOUT_MS`. The answers come back on the heartbeat
 * (`deliverAnswers`, `loop-attempt.ts`). Question text and answers are never logged here.
 */

/** The one attempt a relay serves: its runtime, job, state, and the control token its questions live under. */
interface Attempt {
    rt: LoopRuntime;
    job: BoardJob;
    state: JobState;
    token: string;
}

/** Asks the board's verdict on the expiry when the timer fires, and settles the question as it says. */
async function expire({ rt, job, state, token }: Attempt, questionId: string): Promise<void> {
    state.questionTimers.delete(questionId);
    if (state.finished || down(state)) return;
    const verdict = await withBoardRetry(rt, `job ${job.id}: the question expiry was not accepted`, () =>
        rt.board.expireQuestion(job, questionId)
    ).catch((e: Error) => {
        rt.log(`job ${job.id}: could not expire a question, leaving it pending: ${e.message}`);
        return null;
    });
    if (verdict === null) return;
    if (verdict === 'lost' || verdict === 'removed') return applyHeartbeatVerdict(rt, job, state, verdict);
    // The board decides the race with an answer: an answer that got there first is delivered.
    rt.gates?.server.resolveQuestion(
        token,
        questionId,
        verdict.state === 'answered' ? { state: 'answered', answers: verdict.answers } : { state: 'expired' }
    );
}

/** Extends the attempt's run deadline by one question's wait; a runner that cannot costs the extension, never the question. */
async function extendDeadline({ rt, job, state }: Attempt): Promise<void> {
    try {
        await rt.runner.extendDeadline?.(job, QUESTION_TIMEOUT_MS);
        // Only an extension the runner made is one the timeout note may report.
        state.deadlineExtensionMs += QUESTION_TIMEOUT_MS;
    } catch (e) {
        rt.log(`job ${job.id}: could not extend the run deadline for a question: ${(e as Error).message}`);
    }
}

/** The relay one attempt's control token reports its questions through. */
export function createQuestionRelay(rt: LoopRuntime, job: BoardJob, state: JobState, token: string): QuestionRelay {
    const at: Attempt = { rt, job, state, token };
    return {
        async ask(questionId: string, questions: AskedQuestion[]) {
            const verdict = await withBoardRetry(rt, `job ${job.id}: the question was not accepted`, () =>
                rt.board.question(job, questionId, questions)
            );
            if (verdict === 'refused') return 'refused';
            if (verdict === 'lost' || verdict === 'removed') {
                await applyHeartbeatVerdict(rt, job, state, verdict);
                return 'gone';
            }
            // A Stop or the end of the run landed during the board call and already cleaned up:
            // nothing is waiting, so no timer and no extension.
            if (state.finished || state.draining || down(state)) return 'accepted';
            // Armed once per question: the control endpoint forwards a known id only once.
            const timer = setTimeout(() => {
                void expire(at, questionId);
            }, rt.questionTimeoutMs ?? QUESTION_TIMEOUT_MS);
            timer.unref?.();
            state.questionTimers.set(questionId, timer);
            await extendDeadline(at);
            return 'accepted';
        },
    };
}
