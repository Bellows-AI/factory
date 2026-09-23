'use strict';

/*
 * The github-review-reconcile block's collect adapter (issue #133) — PRELUDE half. Maps the
 * generic block-helper transport's bounded HELPER_INPUT (issue #207) onto the REPO/PR environment
 * issue #201's review-collect.cjs reads, and captures its one stdout verdict instead of letting it
 * reach the real stdout — review-collect-probe-postlude.cjs (concatenated after it, with the
 * unmodified review-collect.cjs content sandwiched between the two inside a bare block) restores
 * stdout and reshapes that verdict into the envelope driver/src/helpers.ts's parseHelperOutput
 * expects. driver/src/review-helpers.ts assembles the three pieces at DRIVER LOAD TIME — never in
 * the container, and never by mounting a path — so review-collect.cjs itself ships byte-identical
 * to issue #201's own file; only this prelude and its postlude are new.
 *
 * Environment:
 *   HELPER_INPUT  {"publication": {repo, prNumber, ...} | null} — issue #207's bounded plan input,
 *                 the thread's structured PR identity (issue #202), injected generically by the
 *                 board's resolveClaimHelperPlans. Absent or malformed leaves REPO/PR unset, so
 *                 the embedded review-collect.cjs answers its own "invalid REPO/PR" refusal.
 */

const __reviewProbeStdoutChunks = [];
const __reviewProbeOriginalWrite = process.stdout.write.bind(process.stdout);
// One capture function, reused for BOTH capture windows a reply-node run needs (this file's own
// prelude window, and review-reply-probe-middle.cjs's re-armed second window before
// review-reply.cjs runs) — never redeclared, only reassigned to `process.stdout.write` again
// after `__reviewProbeStdoutChunks.length = 0` clears the first window's captured line.
function __reviewProbeCapture(chunk, encoding, callback) {
    __reviewProbeStdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString(encoding));
    const cb = typeof encoding === 'function' ? encoding : callback;
    if (typeof cb === 'function') cb();
    return true;
}
process.stdout.write = __reviewProbeCapture;

(function __reviewProbeSetRepoPr() {
    let input;
    try {
        input = JSON.parse(process.env.HELPER_INPUT || 'null');
    } catch {
        input = null;
    }
    const publication = input && typeof input === 'object' ? input.publication : null;
    if (publication && typeof publication.repo === 'string' && typeof publication.prNumber === 'number') {
        process.env.REPO = publication.repo;
        process.env.PR = String(publication.prNumber);
    }
})();
