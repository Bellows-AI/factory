import type { BoardJob } from './board.js';
import { evidenceDecision } from './evidence-policy.js';
import { down, type JobState } from './loop-attempt.js';
import type { LoopRuntime } from './loop-types.js';
import { publishFailed } from './publish.js';
import type { PublishRelay, PublishVerdict } from './publish-control.js';

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
            // A configured requirement is enforced here whatever the agent ran. Ad-hoc gate runs
            // are not evidence (they carry no assessed revision), so a draft under `gates:
            // required` is refused and the end-of-run publish, which runs the declared gates, is
            // the path; a review-only policy binds the push to the reviewed revision.
            const decision = evidenceDecision(job.policy, null, job.review);
            if (!decision.ok) return { refused: decision.reason };
            return pushDraft(rt, job, state, { revision: decision.revision, gone });
        },
    };
}

/** The credential ask, the fence after it, and the draft push — bound to `revision` when the policy named one. */
async function pushDraft(
    rt: LoopRuntime,
    job: BoardJob,
    state: JobState,
    { revision, gone }: { revision: string | null; gone: () => boolean }
): Promise<PublishVerdict> {
    const token = await rt.board.publishToken(job);
    if (!token) rt.log(`job ${job.id}: draft publish-token ask answered nothing fresh — using the claim env`);
    if (gone()) return 'gone';
    const result = await rt.runner
        .publishGit?.(job, token ?? undefined, { draft: true, ...(revision === null ? {} : { revision }) })
        .catch((e: Error) => publishFailed(`the publish threw: ${e.message}`));
    if (result?.ok && result.published) state.draftPublication = result;
    return result ?? 'unsupported';
}
