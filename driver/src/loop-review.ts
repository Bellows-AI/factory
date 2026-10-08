import type { BoardJob, ReviewAnswer } from './board.js';
import { withBoardRetry } from './board-retry.js';
import { applyHeartbeatVerdict, down, type JobState } from './loop-attempt.js';
import type { LoopRuntime } from './loop-types.js';
import type { QuestionRelay } from './question-control.js';
import type { ReviewRelay, ReviewVerdict } from './review-control.js';

/**
 * The agent's named-reviewer invocation (issue #549): `POST /review` and `GET /review/<key>` on the
 * control endpoint, relayed to the board. The agent names a key and a profile. Everything that
 * makes the result trustworthy is the DRIVER's, never the agent's:
 *
 * - the revision is the tree fingerprint `runner.probeTree` measures right now, over the same
 *   transport the publish binding uses — the agent cannot name one;
 * - the snapshot is frozen by `runner.snapshotTree` BEFORE the board is asked, so a reviewer that
 *   is claimed the instant its row exists already finds its ref, and a repeated request finds the
 *   first snapshot (a stored review keeps the revision it was bound to);
 * - the board validates the profile against the ones the repository declared when this attempt was
 *   claimed, runs the review as a thread of its own with only that profile's grants, and answers
 *   the thread's review evidence — which this relay adopts as `job.review`, so the end-of-run
 *   publish and the draft publish judge the review that actually ran, not the claim-time state.
 *
 * Fenced like the publish relay: a stood-down or finished attempt asks for nothing. A Stop that is
 * only draining refuses too — a review is new work, and the agent was told to finish.
 */
export function createReviewRelay(rt: LoopRuntime, job: BoardJob, state: JobState): ReviewRelay {
    const gone = (): boolean => state.finished || state.draining || down(state);
    return {
        async request(key, profile) {
            if (!rt.runner.snapshotTree || !rt.runner.probeTree) return 'unsupported';
            if (gone()) return 'gone';
            const revision = await rt.runner.probeTree(job, state.signal).catch(() => null);
            if (revision === null)
                return { refused: 'the task tree could not be measured, so there is nothing to review' };
            const snapshot = await rt.runner.snapshotTree(job, key, state.signal);
            if (!snapshot.ok) return { refused: snapshot.reason };
            if (gone()) return 'gone';
            return verdictOf(rt, job, state, () =>
                rt.board.requestReview(job, { key, profile, revision, ref: snapshot.ref })
            );
        },
        async read(key) {
            if (gone()) return 'gone';
            return verdictOf(rt, job, state, () => rt.board.readReview(job, key));
        },
    };
}

/**
 * What a reviewer's own control channel does with a question: refuses it. A reviewer has a caller
 * to answer to and no member to ask — and a question nobody relays would wait out the whole budget.
 */
export const reviewerQuestionRelay: QuestionRelay = { ask: async () => 'refused' };

/** One board round trip, read as a verdict; the lease verdicts stand the attempt down like a heartbeat's. */
async function verdictOf(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState,
    ask: () => Promise<ReviewAnswer>
): Promise<ReviewVerdict> {
    const answer = await withBoardRetry(rt, `job ${job.id}: the review call was not accepted`, ask).catch(
        (e: Error) => {
            rt.log(`job ${job.id}: the review call failed: ${e.message}`);
            return null;
        }
    );
    if (answer === null) return { refused: 'the board could not be reached; ask again' };
    if (answer.result === 'refused') return { refused: answer.reason };
    if (answer.result !== 'ok') {
        await applyHeartbeatVerdict(rt, job, state, answer.result);
        return 'gone';
    }
    // The thread's review evidence as the policy reads it now: what the publish decisions judge.
    job.review = answer.review.evidence;
    return { review: answer.review, created: answer.created };
}
