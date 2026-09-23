'use strict';

/*
 * The github-review-reconcile block's collect adapter (issue #133) — POSTLUDE half. Restores real
 * stdout, reshapes the embedded review-collect.cjs's own verdict (captured by
 * review-collect-probe-prelude.cjs) into the versioned envelope the generic helper transport
 * expects, and decides the block's own outcome deterministically — no model judgment involved.
 * Shared by the block's `collect` and `wait` internal nodes (server/src/db/workflow-blocks/
 * github-review-reconcile.ts): both run this exact helper, so re-entering the wait always
 * re-fetches full state before deciding again.
 *
 * Outcomes, each answered as a PRE-helper `conclude` (issue #230) except REVIEW-ACTIONABLE, which
 * lets the node's own agent turn (the block's `repair` node, reached via a marker edge) launch
 * with a digest state file already written to the worktree — the generic transport surfaces only
 * ok/fail to the loop, never a helper's own output, to the agent that follows (the same reason
 * merge-conflict-probe.cjs writes its own state file):
 *   REVIEW-CLEAN       nothing requires attention — approved, or no feedback and no reviewer.
 *   REVIEW-WAIT        a reviewer is requested, or changes were requested, but nothing actionable
 *                      exists yet to fix.
 *   REVIEW-ACTIONABLE  unresolved feedback exists; .factory/review-reconcile/digest.json is
 *                      written for the repair agent to read, and any stale intents.json from an
 *                      earlier round is removed so it can never be replayed against a new digest.
 *
 * A collection error (review-collect.cjs's own ok:false, or a truncated-past-bound collection) is
 * a helper FAILURE, never a marker — the block's own collect->collect retry edge is what
 * re-attempts it, never a silent "nothing to do".
 */

process.stdout.write = __reviewProbeOriginalWrite;

const __rcpSchema = 'review-collect-probe/v1';
const __rcpVersion = 1;
const __rcpStateDir = '.factory/review-reconcile';
const __rcpDigestPath = __rcpStateDir + '/digest.json';
const __rcpIntentsPath = __rcpStateDir + '/intents.json';
const __rcpErrorMax = 300;
const __rcpDigestItemsMax = 16;
const __rcpDigestBodyMax = 1200;
const __rcpAddressedPrefix = '<!-- factory-review-reconcile addressed ';
const __rcpAddressedSuffix = ' -->';

function __rcpEmit(line) {
    console.log(JSON.stringify(line));
}
function __rcpFail(reason, error) {
    __rcpEmit({
        schema: __rcpSchema,
        version: __rcpVersion,
        ok: false,
        reason,
        error: String(error).slice(0, __rcpErrorMax),
    });
}
function __rcpConclude(marker) {
    __rcpEmit({ schema: __rcpSchema, version: __rcpVersion, ok: true, output: marker, control: 'conclude' });
}

function __rcpAddressedMarker(key) {
    return __rcpAddressedPrefix + key + __rcpAddressedSuffix;
}
function __rcpBodyHasMarker(body, key) {
    return typeof body === 'string' && body.includes(__rcpAddressedMarker(key));
}
function __rcpIsBot(author) {
    return typeof author === 'string' && author.endsWith('[bot]');
}

/**
 * Whether ANY comment in `comments` already carries this item's addressed marker — never just the
 * ORIGINAL item's own body. A reply lands as a brand-new, separate comment (review-reply.cjs posts
 * a general/inline reply, never edits the target it answers), so checking only the original
 * comment's own body would never see its own reply and would re-surface the same item as
 * actionable forever.
 */
function __rcpIsAddressedIn(comments, key) {
    return comments.some((c) => __rcpBodyHasMarker(c.body, key));
}

/** Every databaseId any GraphQL review thread already groups a comment under. */
function __rcpThreadedDatabaseIds(collection) {
    const ids = new Set();
    for (const t of collection.threads || []) {
        for (const c of t.comments) if (c.databaseId !== null) ids.add(c.databaseId);
    }
    return ids;
}

function __rcpGeneralItems(collection) {
    const general = collection.general || [];
    const items = [];
    for (const c of general) {
        const key = 'general:' + c.id;
        if (__rcpIsBot(c.author) || __rcpIsAddressedIn(general, key)) continue;
        items.push({ key, kind: 'general', body: c.body, path: null });
    }
    return items;
}

/**
 * Every inline (diff) comment GitHub's REST API lists also belongs to some GraphQL review
 * thread — `inline` and `threads` are two views of the SAME comments, never disjoint sets.
 * Threads are the richer, resolvable representation, so an inline comment already covered by a
 * thread is skipped here; only a stray inline comment a thread never grouped (a defensive
 * fallback, not the common case) is ever surfaced under its own `inline:` key.
 */
function __rcpInlineItems(collection, threadedDatabaseIds) {
    const inline = collection.inline || [];
    const items = [];
    for (const c of inline) {
        const key = 'inline:' + c.id;
        if (threadedDatabaseIds.has(c.id) || __rcpIsBot(c.author) || __rcpIsAddressedIn(inline, key)) continue;
        items.push({ key, kind: 'inline', body: c.body, path: c.path });
    }
    return items;
}

/**
 * GitHub has no reply-to-a-review mutation, so a review's own feedback is answered as a new
 * GENERAL conversation comment (review-reply-probe-middle.cjs's `generalTarget`) — the marker
 * this item was addressed is therefore looked up in `general`, never in the review's own body.
 */
function __rcpReviewItems(collection) {
    const general = collection.general || [];
    const items = [];
    for (const r of collection.reviews || []) {
        if (r.state !== 'CHANGES_REQUESTED' && r.state !== 'COMMENTED') continue;
        const key = 'review:' + r.id;
        if (!r.body || !r.body.trim() || __rcpIsBot(r.author) || __rcpIsAddressedIn(general, key)) continue;
        items.push({ key, kind: 'review', body: r.body, path: null });
    }
    return items;
}

function __rcpThreadItems(collection) {
    const items = [];
    for (const t of collection.threads || []) {
        if (t.isResolved) continue;
        if (__rcpIsAddressedIn(t.comments, 'thread:' + t.id)) continue;
        const last = t.comments[t.comments.length - 1];
        if (!last || __rcpIsBot(last.author)) continue;
        items.push({ key: 'thread:' + t.id, kind: 'thread', body: last.body, path: t.path });
    }
    return items;
}

function __rcpActionableItems(collection) {
    const threadedDatabaseIds = __rcpThreadedDatabaseIds(collection);
    const items = [
        ...__rcpGeneralItems(collection),
        ...__rcpInlineItems(collection, threadedDatabaseIds),
        ...__rcpReviewItems(collection),
        ...__rcpThreadItems(collection),
    ];
    items.sort((a, b) => a.key.localeCompare(b.key));
    return items;
}

/** Best-effort: git-ignoring the state dir keeps `git add -A` (the publisher's own commit step)
 *  from ever picking it up. A failure here never blocks the digest itself. */
function __rcpExcludeStateDir() {
    const fs = require('node:fs');
    const path = require('node:path');
    try {
        const excludePath = path.join('.git', 'info', 'exclude');
        const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
        const excludeLine = '/' + __rcpStateDir + '/';
        if (!existing.split('\n').includes(excludeLine)) {
            fs.appendFileSync(
                excludePath,
                (existing === '' || existing.endsWith('\n') ? '' : '\n') + excludeLine + '\n'
            );
        }
    } catch {
        // See the function comment above — never fatal to the digest write itself.
    }
}

/** Writes the digest state file and clears any stale intents; returns false on a write failure
 *  (already reported via __rcpFail). */
function __rcpWriteDigest(items) {
    const fs = require('node:fs');
    const digestItems = items.slice(0, __rcpDigestItemsMax).map((it) => ({
        key: it.key,
        kind: it.kind,
        path: it.path,
        body: it.body.length > __rcpDigestBodyMax ? it.body.slice(0, __rcpDigestBodyMax) + ' […truncated]' : it.body,
    }));
    try {
        fs.mkdirSync(__rcpStateDir, { recursive: true });
        fs.writeFileSync(
            __rcpDigestPath,
            JSON.stringify({ schema: 'review-reconcile-digest/v1', version: 1, items: digestItems }) + '\n'
        );
        fs.rmSync(__rcpIntentsPath, { force: true });
    } catch (e) {
        __rcpFail('runner_error', 'could not write the review digest: ' + String((e && e.message) || e));
        return false;
    }
    __rcpExcludeStateDir();
    return true;
}

function __rcpDecideWait(collection) {
    const reviewers = collection.requestedReviewers || { users: [], teams: [] };
    const reviewerRequested = (reviewers.users || []).length > 0 || (reviewers.teams || []).length > 0;
    return collection.decision === 'CHANGES_REQUESTED' || reviewerRequested;
}

(function __reviewProbeDecide() {
    const capturedLine = __reviewProbeStdoutChunks.join('').trim().split('\n').filter(Boolean).pop() || '';
    let collection;
    try {
        collection = JSON.parse(capturedLine);
    } catch {
        collection = null;
    }
    if (!collection || collection.ok === false) {
        __rcpFail('runner_error', (collection && collection.error) || 'unreadable collection verdict');
        return;
    }
    if (collection.truncated && collection.truncated.total) {
        __rcpFail(
            'runner_error',
            'the collection was truncated past its total output bound — refusing to decide blind'
        );
        return;
    }

    const items = __rcpActionableItems(collection);
    if (items.length > 0) {
        if (__rcpWriteDigest(items))
            __rcpEmit({ schema: __rcpSchema, version: __rcpVersion, ok: true, output: 'REVIEW-ACTIONABLE' });
        return;
    }

    __rcpConclude(__rcpDecideWait(collection) ? 'REVIEW-WAIT' : 'REVIEW-CLEAN');
})();
