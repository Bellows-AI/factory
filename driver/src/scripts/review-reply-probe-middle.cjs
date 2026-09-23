'use strict';

/*
 * The github-review-reconcile block's reply adapter (issue #133) — MIDDLE half, run between the
 * embedded review-collect.cjs and review-reply.cjs (driver/src/review-helpers.ts assembles the
 * five pieces — review-collect-probe-prelude.cjs, review-collect.cjs, this file,
 * review-reply.cjs, review-reply-probe-postlude.cjs — at driver load time). The `reply` node
 * always follows a SUCCEEDED, published `repair` row (the block's own edge grammar only routes
 * there on `succeeded`, and a publish failure fails the verdict — docs/jobs.md), so the push this
 * reply answers has already landed by construction; this step's own job is turning the repair
 * agent's declared intents into a bounded, host-VALIDATED mutation plan against the FRESH
 * collection (never trusting the agent's own claim that a comment id or thread still exists).
 *
 * Reads from the worktree (written earlier in this same session/thread):
 *   .factory/review-reconcile/digest.json   the items `collect`/`wait` presented this round
 *                                            ({schema:'review-reconcile-digest/v1', items:[...]})
 *   .factory/review-reconcile/intents.json  the repair agent's own reply plan
 *                                            ({schema:'review-reconcile-intents/v1',
 *                                              items:[{key, reply, resolve}]})
 * Both missing or unreadable is not fatal: an empty REPLY_PLAN just runs review-reply.cjs with
 * zero targets, which succeeds with zero results — never a crash mid-round.
 *
 * The fresh re-fetch failing OUTRIGHT (review-collect.cjs's own ok:false) is different: silently
 * proceeding with an empty plan would falsely conclude REVIEW-REPLIED without ever having
 * validated a single target against live state. `__reviewReplyProbeSkip`, declared at this
 * composed script's TOP LEVEL (visible to the `review-reply.cjs` block and the postlude
 * concatenated after this file — driver/src/review-helpers.ts), is what short-circuits both: this
 * file emits the final ok:false envelope itself and neither the embedded review-reply.cjs nor the
 * postlude do anything further.
 */

const __rrpPlanSchema = 'review-reply/plan/v1';
const __rrpReplyBodyMax = 1000;
const __rrpPlanTargetsMax = 32;
const __rrpAddressedPrefix = '<!-- factory-review-reconcile addressed ';
const __rrpAddressedSuffix = ' -->';
const __rrpProbeSchema = 'review-reply-probe/v1';
const __rrpProbeVersion = 1;
const __rrpProbeErrorMax = 300;
const __rrpStateDir = '.factory/review-reconcile';

let __reviewReplyProbeSkip = false;

process.stdout.write = __reviewProbeOriginalWrite;

function __rrpReadJson(p) {
    const fs = require('node:fs');
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

function __rrpAddressedMarker(key) {
    return __rrpAddressedPrefix + key + __rrpAddressedSuffix;
}

function __rrpBoundedReply(key, text) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const body = trimmed.length > __rrpReplyBodyMax ? trimmed.slice(0, __rrpReplyBodyMax) : trimmed;
    return (body ? body + '\n\n' : '') + __rrpAddressedMarker(key);
}

function __rrpThreadIsAlreadyMarked(thread, key) {
    return thread.comments.some((c) => typeof c.body === 'string' && c.body.includes(__rrpAddressedMarker(key)));
}

function __rrpGeneralTarget(intent) {
    return {
        id: intent.key,
        kind: 'general',
        reply: __rrpBoundedReply(intent.key, intent.reply),
        resolve: false,
        firstCommentId: null,
        status: 'planned',
        reason: null,
    };
}

/** The (up to two) plan targets one `thread:` intent produces: a reply, and/or a resolve. */
function __rrpThreadTargets(thread, id, intent) {
    const targets = [];
    if (__rrpThreadIsAlreadyMarked(thread, intent.key)) return targets;
    const wantsReply = typeof intent.reply === 'string' && intent.reply.trim();
    if (wantsReply) {
        const anchor = thread.comments[0] && thread.comments[0].databaseId;
        if (typeof anchor === 'number') {
            // `id` reports which digest item this target answers; the REST reply mutation itself
            // anchors on `firstCommentId`, never on `id` (review-reply.cjs).
            targets.push({
                id,
                kind: 'thread',
                reply: __rrpBoundedReply(intent.key, intent.reply),
                resolve: false,
                firstCommentId: anchor,
                status: 'planned',
                reason: null,
            });
        }
    }
    if (intent.resolve === true && !thread.isResolved) {
        // `id` here MUST be the real GraphQL thread node id: review-reply.cjs's resolve execution
        // passes `target.id` straight into `resolveReviewThread`'s `threadId`.
        targets.push({
            id,
            kind: 'resolve',
            reply: null,
            resolve: true,
            firstCommentId: null,
            status: 'planned',
            reason: null,
        });
    }
    return targets;
}

/** One digest-presented intent -> zero or more plan targets, validated against LIVE collection ids. */
function __rrpTargetsFor(intent, live) {
    const sep = intent.key.indexOf(':');
    const kind = intent.key.slice(0, sep);
    const id = intent.key.slice(sep + 1);
    if (kind === 'thread') {
        const thread = live.threadsById.get(id);
        return thread ? __rrpThreadTargets(thread, id, intent) : [];
    }
    if (kind === 'general' && live.generalIds.has(id)) return [__rrpGeneralTarget(intent)];
    if (kind === 'inline' && live.inlineIds.has(id)) {
        return [
            {
                id,
                kind: 'inline',
                reply: __rrpBoundedReply(intent.key, intent.reply),
                resolve: false,
                firstCommentId: null,
                status: 'planned',
                reason: null,
            },
        ];
    }
    // GitHub has no reply-to-a-review mutation; a review's feedback is answered as a new general
    // conversation comment, carrying the same addressed marker so it is never re-surfaced.
    if (kind === 'review' && live.reviewIds.has(id)) return [__rrpGeneralTarget(intent)];
    return [];
}

/** The digest-presented intents, deduped and capped — a malformed or over-eager agent output
 *  never grows the plan past what collect/wait actually offered this round. */
function __rrpBoundedIntents(rawIntents, digestKeys) {
    const seen = new Set();
    const intents = [];
    for (const raw of rawIntents) {
        if (!raw || typeof raw.key !== 'string' || seen.has(raw.key) || !digestKeys.has(raw.key)) continue;
        seen.add(raw.key);
        intents.push(raw);
        if (intents.length >= __rrpPlanTargetsMax) break;
    }
    return intents;
}

function __rrpLiveIndex(collection) {
    return {
        threadsById: new Map((collection.threads || []).map((t) => [t.id, t])),
        generalIds: new Set((collection.general || []).map((c) => String(c.id))),
        inlineIds: new Set((collection.inline || []).map((c) => String(c.id))),
        reviewIds: new Set((collection.reviews || []).map((r) => String(r.id))),
    };
}

function __rrpEmitSkipFailure(collection) {
    __reviewReplyProbeSkip = true;
    console.log(
        JSON.stringify({
            schema: __rrpProbeSchema,
            version: __rrpProbeVersion,
            ok: false,
            reason: 'runner_error',
            error: String((collection && collection.error) || 'unreadable collection verdict').slice(
                0,
                __rrpProbeErrorMax
            ),
        })
    );
}

(function __reviewReplyProbeBuildPlan() {
    const capturedLine = __reviewProbeStdoutChunks.join('').trim().split('\n').filter(Boolean).pop() || '';
    let collection;
    try {
        collection = JSON.parse(capturedLine);
    } catch {
        collection = null;
    }
    if (!collection || collection.ok === false) {
        __rrpEmitSkipFailure(collection);
        return;
    }

    const digest = __rrpReadJson(__rrpStateDir + '/digest.json');
    const intentsFile = __rrpReadJson(__rrpStateDir + '/intents.json');
    const digestKeys = new Set(
        digest && Array.isArray(digest.items)
            ? digest.items.map((it) => it.key).filter((k) => typeof k === 'string')
            : []
    );
    const rawIntents =
        intentsFile && intentsFile.schema === 'review-reconcile-intents/v1' && Array.isArray(intentsFile.items)
            ? intentsFile.items
            : [];
    const intents = __rrpBoundedIntents(rawIntents, digestKeys);
    const live = __rrpLiveIndex(collection);
    const targets = intents.flatMap((intent) => __rrpTargetsFor(intent, live));

    const plan = { version: 1, schema: __rrpPlanSchema, ref: collection.ref, targets };
    process.env.REPLY_PLAN = JSON.stringify(plan);

    // Re-arm the SAME capture function the prelude declared (never a second copy) for this node's
    // second capture window, ahead of the embedded review-reply.cjs run below.
    __reviewProbeStdoutChunks.length = 0;
    process.stdout.write = __reviewProbeCapture;
})();
