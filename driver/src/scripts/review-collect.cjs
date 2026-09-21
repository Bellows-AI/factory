'use strict';

/*
 * The deterministic review COLLECTION: every supported feedback surface of a pull request in one
 * bounded, versioned JSON verdict — the state future review reconciliation reads, and the reply
 * planner validates against. One execFileSync per gh call, direct argv only: no shell, no
 * interpolation, no value can become a command. The credential rides gh's own env (GH_TOKEN or
 * GITHUB_TOKEN) and never appears in argv, in an error, or on stdout (issue #201).
 *
 * Environment:
 *   REPO  owner/name of the repository;
 *   PR    the pull request number;
 *   GH_TOKEN or GITHUB_TOKEN — required before any spawn (a tokenless gh would sit on an auth
 *         prompt instead of failing).
 *
 * The verdict is ONE JSON line: {version, schema, ref, general, reviews, inline, threads,
 * requestedReviewers, decision, truncated, error}. Every section is deduped by GitHub id, capped,
 * and stable-sorted, so the same upstream state always produces the same bytes. REST carries the
 * bulk (numeric ids, full bodies, diff hunks, --paginate); GraphQL carries the three things REST
 * does not expose: review-thread node ids, their resolved state, and the PR's review decision.
 * Any gh failure is a TERMINAL refusal ({ok:false, ...}) — a partial collection is never the
 * answer, because the reply planner must trust that "absent from state" means "not on the PR".
 */

const { execFileSync } = require('node:child_process');

const VERSION = 1;
const SCHEMA = 'review-collect/v1';
const TRUNCATED_MARKER = ' […truncated by the board] ';
const BODY_MAX = 2000;
const DIFF_HUNK_MAX = 500;
const ERROR_MAX = 300;
const GENERAL_LIMIT = 50;
const INLINE_LIMIT = 50;
const REVIEWS_LIMIT = 20;
const THREADS_LIMIT = 100;
const THREAD_COMMENTS_LIMIT = 10;
const TOTAL_OUTPUT_BYTES = 256 * 1024;

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewDecision
      reviewThreads(first: ${THREADS_LIMIT}) {
        totalCount
        nodes {
          id isResolved isOutdated path line
          comments(first: ${THREAD_COMMENTS_LIMIT}) {
            totalCount
            nodes { id databaseId author { login } body createdAt }
          }
        }
      }
    }
  }
}`;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : null);
const login = (o) => (o && typeof o.user === 'object' && o.user !== null ? str(o.user.login) : null);
const present = (o) => o && typeof o === 'object' && o !== null;

function validateRef(repo, pr) {
    const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
    if (!m || !/^\d{1,9}$/.test(pr)) return null;
    return { owner: m[1], repo: m[2], number: Number(pr) };
}

function truncated(text, max, counts, key) {
    const chars = [...text];
    if (chars.length <= max) return text;
    counts[key] += 1;
    return `${chars.slice(0, max).join('')}${TRUNCATED_MARKER}`;
}

/** Cap + dedupe by GitHub id; a capped section records its name so the answer says so. */
function section(rows, map, limit, ts, name) {
    const seen = new Set();
    const out = [];
    for (const row of rows) {
        const item = map(row);
        if (!item || item.id === null || item.id === undefined) continue;
        const key = String(item.id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (out.length >= limit) {
            if (!ts.sections.includes(name)) ts.sections.push(name);
            break;
        }
        out.push(item);
    }
    return out;
}

const byId = (a, b) => a.id - b.id || String(a.id).localeCompare(String(b.id));

const sortThread = (a, b) => {
    const da = a.comments[0] && a.comments[0].databaseId !== null ? a.comments[0].databaseId : null;
    const db = b.comments[0] && b.comments[0].databaseId !== null ? b.comments[0].databaseId : null;
    if (da === null && db === null) return a.id.localeCompare(b.id);
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db || a.id.localeCompare(b.id);
};

const sortComment = (a, b) => {
    if (a.databaseId === null && b.databaseId === null) return a.id.localeCompare(b.id);
    if (a.databaseId === null) return 1;
    if (b.databaseId === null) return -1;
    return a.databaseId - b.databaseId || a.id.localeCompare(b.id);
};

function collect() {
    const ref = validateRef(process.env.REPO, process.env.PR);
    if (!ref) return refusal('invalid REPO/PR: expected owner/name and a pull request number', null);
    if (!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()) {
        return refusal('missing credential: GH_TOKEN or GITHUB_TOKEN must be set', ref);
    }

    const ts = { sections: [], bodies: 0, diffHunks: 0, threads: 0, total: false };
    const counts = { bodies: 0, diffHunks: 0, threads: 0 };
    const pulls = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const issues = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;

    const asComment = (row) => ({
        id: num(row && row.id),
        author: login(row),
        body: truncated(str(row && row.body) ?? '', BODY_MAX, counts, 'bodies'),
        createdAt: str(row && row.created_at),
        path: null,
        line: null,
        diffHunk: null,
        inReplyToId: null,
        reviewId: null,
    });

    const asLine = (row) => ({
        id: num(row && row.id),
        author: login(row),
        body: truncated(str(row && row.body) ?? '', BODY_MAX, counts, 'bodies'),
        createdAt: str(row && row.created_at),
        path: str(row && row.path),
        line: num(row && row.line),
        diffHunk: truncated(str(row && row.diff_hunk) ?? '', DIFF_HUNK_MAX, counts, 'diffHunks'),
        inReplyToId: num(row && row.in_reply_to_id),
        reviewId: num(row && row.pull_request_review_id),
    });

    const asReview = (row) => ({
        id: num(row && row.id),
        author: login(row),
        state: str(row && row.state),
        body: truncated(str(row && row.body) ?? '', BODY_MAX, counts, 'bodies'),
        createdAt: str(row && row.submitted_at),
        commitId: str(row && row.commit_id),
    });

    const general = section(
        JSON.parse(gh(['api', `${issues}/comments`, '--paginate'])),
        asComment,
        GENERAL_LIMIT,
        ts,
        'general'
    );
    const reviews = section(
        JSON.parse(gh(['api', `${pulls}/reviews`, '--paginate'])),
        asReview,
        REVIEWS_LIMIT,
        ts,
        'reviews'
    );
    const inline = section(
        JSON.parse(gh(['api', `${pulls}/comments`, '--paginate'])),
        asLine,
        INLINE_LIMIT,
        ts,
        'inline'
    );

    const requested = JSON.parse(gh(['api', `${pulls}/requested_reviewers`]));
    const users = (present(requested) && Array.isArray(requested.users) ? requested.users : [])
        .map((u) => str(u && u.login))
        .filter((u) => u !== null);
    const teams = (present(requested) && Array.isArray(requested.teams) ? requested.teams : [])
        .map((t) => str(t && t.name))
        .filter((t) => t !== null);

    const gql = JSON.parse(
        gh([
            'api',
            'graphql',
            '-f',
            `query=${THREADS_QUERY}`,
            '-f',
            `owner=${ref.owner}`,
            '-f',
            `repo=${ref.repo}`,
            '-F',
            `number=${ref.number}`,
        ])
    );
    const pr = gql && gql.data && gql.data.repository && gql.data.repository.pullRequest;

    const threads = [];
    for (const node of pr && pr.reviewThreads && Array.isArray(pr.reviewThreads.nodes) ? pr.reviewThreads.nodes : []) {
        if (!node || typeof node.id !== 'string') continue;
        const comments = (node.comments && Array.isArray(node.comments.nodes) ? node.comments.nodes : [])
            .filter((c) => c && typeof c.id === 'string')
            .map((c) => ({
                id: c.id,
                databaseId: num(c.databaseId),
                author: c.author && c.author !== null ? str(c.author.login) : null,
                body: truncated(str(c.body) ?? '', BODY_MAX, counts, 'bodies'),
                createdAt: str(c.createdAt),
            }))
            .sort(sortComment);
        const totalComments = num(node.comments && node.comments.totalCount);
        if (comments.length > THREAD_COMMENTS_LIMIT || (totalComments !== null && totalComments > comments.length)) {
            if (comments.length > THREAD_COMMENTS_LIMIT) comments.length = THREAD_COMMENTS_LIMIT;
            counts.threads += 1;
        }
        threads.push({
            id: node.id,
            isResolved: node.isResolved === true,
            isOutdated: node.isOutdated === true,
            path: str(node.path),
            line: num(node.line),
            comments,
        });
    }
    const totalThreads = pr && pr.reviewThreads ? num(pr.reviewThreads.totalCount) : null;
    if (threads.length > THREADS_LIMIT || (totalThreads !== null && totalThreads > threads.length)) {
        if (threads.length > THREADS_LIMIT) threads.length = THREADS_LIMIT;
        ts.sections.push('threads');
    }
    if (counts.threads > 0) ts.sections.push('thread-comments');
    ts.bodies = counts.bodies;
    ts.diffHunks = counts.diffHunks;
    ts.threads = counts.threads;

    general.sort(byId);
    reviews.sort(byId);
    inline.sort(byId);
    threads.sort(sortThread);
    users.sort();
    teams.sort();

    const out = {
        version: VERSION,
        schema: SCHEMA,
        ref,
        general,
        reviews,
        inline,
        threads,
        requestedReviewers: { users, teams },
        decision: pr ? str(pr.reviewDecision) : null,
        truncated: ts,
        error: null,
    };

    let serialized = JSON.stringify(out);
    if (Buffer.byteLength(serialized, 'utf8') > TOTAL_OUTPUT_BYTES) {
        serialized = JSON.stringify({
            version: VERSION,
            schema: SCHEMA,
            ref,
            truncated: { sections: [], bodies: 0, diffHunks: 0, threads: 0, total: true },
            error: null,
        });
    }
    return serialized;
}

function gh(args) {
    return execFileSync('gh', args, {
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function refusal(error, ref) {
    const text = String(error);
    const bounded = text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX)}${TRUNCATED_MARKER}` : text;
    return JSON.stringify({ ok: false, version: VERSION, schema: SCHEMA, ref, error: bounded });
}

try {
    const out = collect();
    if (typeof out === 'string') process.stdout.write(`${out}\n`);
} catch (e) {
    const ref = validateRef(process.env.REPO, process.env.PR);
    const message = (e && e.stderr && String(e.stderr)) || (e && e.message && String(e.message)) || String(e);
    process.stdout.write(`${refusal(message, ref)}\n`);
}
