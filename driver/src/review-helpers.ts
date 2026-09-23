import { containerScript } from './container-scripts.js';
import { reviewCollectScript, reviewReplyScript } from './review.js';
import type { HelperDescriptor } from './helpers.js';

/**
 * The `builtin/github-review-reconcile` block's two driver-side helpers (issue #133), additive to
 * issue #207's transport exactly the way issue #122 registered `merge-conflict-probe` — neither
 * transport (`docker-runner.ts`, `k8s-helper-runner.ts`) changes for this file.
 *
 * Issue #201 shipped `review-collect.cjs`/`review-reply.cjs` unmodified — they read REPO/PR (and,
 * for the reply script, REPLY_PLAN) from the environment and answer one bare JSON verdict on
 * stdout, with no `ok`/`output` envelope and no awareness of the block-helper transport's bounded
 * `HELPER_INPUT`. This module never edits either file; it ADAPTS around them, assembling each
 * composed script body from real files at driver LOAD time (never in the container, never a
 * mounted path — the same "content, not a path" rule every container script in this driver
 * follows): a small prelude maps `HELPER_INPUT` onto the environment the embedded script expects
 * and captures its one stdout line instead of letting it reach the container's real stdout, and a
 * postlude restores stdout and reshapes that captured line into the envelope
 * driver/src/helpers.ts's `parseHelperOutput` expects. The embedded script's own content runs
 * inside a bare `{ }` block so its top-level `const`/function names can never collide with the
 * adapter's own — see the prelude/postlude files themselves for the full contract.
 *
 * `review-collect-probe` backs both the block's `collect` and `wait` internal nodes (a full
 * re-fetch on every entry and every wake) and decides REVIEW-CLEAN / REVIEW-WAIT /
 * REVIEW-ACTIONABLE, writing a digest state file for the `repair` agent on the actionable case.
 * `review-reply-probe` backs the `reply` node: it re-fetches (to validate the repair agent's own
 * declared intents against LIVE ids, never trusting stale claims), builds a bounded mutation plan,
 * runs it through the unmodified reply script, and always concludes REVIEW-REPLIED on success.
 * Neither helper ever lets an agent turn launch on its own node — see each script's own header.
 */

const collectPrelude = containerScript('review-collect-probe-prelude.cjs');
const collectPostlude = containerScript('review-collect-probe-postlude.cjs');
const replyMiddle = containerScript('review-reply-probe-middle.cjs');
const replyPostlude = containerScript('review-reply-probe-postlude.cjs');

const REVIEW_COLLECT_PROBE_BODY = [collectPrelude, '{', reviewCollectScript, '}', collectPostlude].join('\n');

const REVIEW_REPLY_PROBE_BODY = [
    collectPrelude,
    '{',
    reviewCollectScript,
    '}',
    replyMiddle,
    // `__reviewReplyProbeSkip` (set by replyMiddle) short-circuits the embedded review-reply.cjs
    // entirely when the fresh re-fetch above failed outright — never running a mutation plan the
    // middle segment could not actually validate against live state.
    'if (!__reviewReplyProbeSkip) {',
    reviewReplyScript,
    '}',
    replyPostlude,
].join('\n');

const BYTES_PER_KB = 1024;
/** Generous past a full collection (256 KiB, review.ts's own TOTAL_OUTPUT_BYTES) plus the digest. */
const REVIEW_COLLECT_PROBE_OUTPUT_CAP_KB = 320;
/** A conclude marker plus a short failure message — far under any concern for the wire value. */
const REVIEW_REPLY_PROBE_OUTPUT_CAP_KB = 8;

export const REVIEW_COLLECT_PROBE_ID = 'review-collect-probe';
export const REVIEW_REPLY_PROBE_ID = 'review-reply-probe';

export const REVIEW_HELPER_DESCRIPTORS: readonly HelperDescriptor[] = [
    {
        id: REVIEW_COLLECT_PROBE_ID,
        scriptBody: REVIEW_COLLECT_PROBE_BODY,
        schema: 'review-collect-probe/v1',
        version: 1,
        outputCapBytes: REVIEW_COLLECT_PROBE_OUTPUT_CAP_KB * BYTES_PER_KB,
    },
    {
        id: REVIEW_REPLY_PROBE_ID,
        scriptBody: REVIEW_REPLY_PROBE_BODY,
        schema: 'review-reply-probe/v1',
        version: 1,
        outputCapBytes: REVIEW_REPLY_PROBE_OUTPUT_CAP_KB * BYTES_PER_KB,
    },
];
