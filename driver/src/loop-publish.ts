import type { BoardJob } from './board.js';
import { down, type JobState } from './loop-attempt.js';
import type { LoopRuntime } from './loop-types.js';
import { publishFailed } from './publish.js';
import type { PublishRelay } from './publish-control.js';

/**
 * The agent's draft publication (`POST /publish` on the control endpoint): the same
 * `runner.publishGit` the end-of-run publish calls — one implementation per executor, so docker and
 * kubernetes cannot drift — asked for a DRAFT pull request. `publishCheckout` reuses the branch's
 * PR, so a retried call, a reclaimed attempt and the end-of-run publish all land on the one PR.
 *
 * The fences are the end-of-run publish's, taken at the same two places: a stood-down or finished
 * attempt publishes nothing, checked before the fresh credential is asked for and again after it.
 * A Stop that is only draining refuses too — the agent was told to finish, not to ship. The push
 * itself is not abortable (a push cannot be recalled), so the control token a lost lease closes is
 * what stops the NEXT call. A workflow task's board reserves publication for its publish node
 * (`job.publish === false`) and the route says so.
 */
export function createPublishRelay(rt: LoopRuntime, job: BoardJob, state: JobState): PublishRelay {
    const gone = (): boolean => state.finished || state.draining || down(state);
    return {
        async publish() {
            if (job.publish === false) return 'forbidden';
            if (!rt.runner.publishGit) return 'unsupported';
            if (gone()) return 'gone';
            const token = await rt.board.publishToken(job);
            if (!token) rt.log(`job ${job.id}: draft publish-token ask answered nothing fresh — using the claim env`);
            if (gone()) return 'gone';
            const result = await rt.runner
                .publishGit(job, token ?? undefined, { draft: true })
                .catch((e: Error) => publishFailed(`the publish threw: ${e.message}`));
            if (result.ok && result.published) state.draftPublication = result;
            return result;
        },
    };
}
