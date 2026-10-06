import type { PublishStep, RunPublishStep } from './publish.js';

/** What git says when `--force-with-lease` finds the remote ref differs from the tracking ref. */
const STALE_INFO = /stale info/;

/**
 * Pushes with a lease, recovering from a stale one (issue #500). Something outside the runner can
 * push the task branch between turns, leaving the checkout's tracking ref behind: the bare lease
 * then refuses a push that is fine. On that refusal alone, refresh the tracking ref and look —
 * a remote head HEAD already contains retries as a fast-forward, a remote head HEAD lacks fails
 * naming its SHA, because forcing would discard the outside push.
 */
export async function pushWithLease(
    step: RunPublishStep,
    branch: string,
    credentialHelper: string,
    push: PublishStep
): Promise<void> {
    try {
        await step(push);
        return;
    } catch (e) {
        if (!STALE_INFO.test((e as Error).message)) throw e;
    }
    const tracking = `refs/remotes/origin/${branch}`;
    await step({
        label: 'git fetch',
        entrypoint: 'git',
        args: ['-c', `credential.helper=${credentialHelper}`, 'fetch', 'origin', `+refs/heads/${branch}:${tracking}`],
        env: true,
        inRepo: true,
    });
    const read = async (label: string, args: string[]): Promise<string> =>
        (await step({ label, entrypoint: 'git', args, env: false, inRepo: true })).stdout.trim();
    const remoteHead = await read('git rev-parse', ['rev-parse', tracking]);
    if ((await read('git rev-list', ['rev-list', '--count', `HEAD..${tracking}`])) !== '0') {
        throw new Error(
            `git push: origin/${branch} moved to ${remoteHead} outside the runner and HEAD does not contain it — ` +
                'merge it into the branch before publishing'
        );
    }
    await step(push);
}
