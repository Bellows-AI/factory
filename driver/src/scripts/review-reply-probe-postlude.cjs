'use strict';

/*
 * The github-review-reconcile block's reply adapter (issue #133) — POSTLUDE half. Restores real
 * stdout, reshapes review-reply.cjs's own verdict (captured by review-reply-probe-middle.cjs) into
 * the versioned envelope the generic helper transport expects, and always answers as a PRE-helper
 * `conclude` (issue #230) on a well-formed run — the `reply` node never launches an agent turn; it
 * is purely mechanical, matching the block's contract that only `repair` may edit code or judge
 * feedback.
 *
 * A malformed REPLY_PLAN (review-reply.cjs's own terminal refusal) or any per-target `refused`
 * result (auth/permission/rate — a transient, retriable failure, never silently marked replied) is
 * a helper FAILURE: the block's own reply->reply retry edge re-attempts the whole round from a
 * fresh collection next time, since the plan is rebuilt from disk each attempt.
 *
 * `__reviewReplyProbeSkip` (review-reply-probe-middle.cjs): set when the fresh re-fetch itself
 * already failed and emitted the final ok:false envelope directly — this file does nothing more.
 */

process.stdout.write = __reviewProbeOriginalWrite;

(function __reviewReplyProbeFinish() {
    if (__reviewReplyProbeSkip) return;
    const SCHEMA = 'review-reply-probe/v1';
    const VERSION = 1;
    const ERROR_MAX = 300;

    function emit(line) {
        console.log(JSON.stringify(line));
    }
    function fail(reason, error) {
        emit({ schema: SCHEMA, version: VERSION, ok: false, reason, error: String(error).slice(0, ERROR_MAX) });
    }

    const capturedLine = __reviewProbeStdoutChunks.join('').trim().split('\n').filter(Boolean).pop() || '';
    let verdict;
    try {
        verdict = JSON.parse(capturedLine);
    } catch {
        verdict = null;
    }
    if (!verdict || verdict.ok === false) {
        fail('runner_error', (verdict && verdict.error) || 'unreadable reply verdict');
        return;
    }
    const results = Array.isArray(verdict.results) ? verdict.results : [];
    const refused = results.find((r) => r && r.status === 'refused');
    if (refused) {
        fail('runner_error', 'reply target ' + refused.kind + ':' + refused.id + ' refused: ' + String(refused.reason));
        return;
    }
    emit({ schema: SCHEMA, version: VERSION, ok: true, output: 'REVIEW-REPLIED', control: 'conclude' });
})();
