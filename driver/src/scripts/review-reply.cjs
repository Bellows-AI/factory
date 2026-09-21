'use strict';

/*
 * The deterministic review REPLY: execute a bounded mutation plan against a pull request and
 * report one per-target result per target, so orchestration can retry the refusals without
 * duplicating the work that already landed. One execFileSync per gh call, direct argv only; the
 * credential rides gh's own env and never appears in argv, in an error, or on stdout (issue #201).
 *
 * Environment:
 *   REPO        owner/name of the repository;
 *   PR          the pull request number;
 *   REPLY_PLAN  the JSON plan (review-reply/plan/v1: ref + targets), passed as a whole value,
 *               never interpolated — same doctrine as every other script parameter;
 *   GH_TOKEN or GITHUB_TOKEN — required before any spawn.
 *
 * Execution is per-target, in plan order. Reply targets post a bounded "what changed" body: a
 * general reply is a new conversation comment (`issues/N/comments`), an inline reply and a thread
 * reply both anchor to a comment via the REST replies endpoint (`…/comments/<id>/replies`) — a
 * thread has no reply mutation, its oldest comment is the deterministic anchor the planner put in
 * firstCommentId. Resolve targets first read live thread state (GraphQL — REST exposes no
 * resolution state) and mutate only the still-unresolved threads.
 *
 * Outcomes: exit-0 is `done`; a comment/thread GitHub can no longer find (HTTP 404/410) and a
 * resolve whose thread is already resolved or gone are idempotent NO-OPS — they are never
 * re-posted and never treated as failures. Auth (401), permission (403) and rate (429) failures
 * stay actionable REFUSALS. Anything else is a refused with the error text bounded and marked.
 * A malformed plan — wrong schema, ref mismatch, oversized input — is ONE terminal refusal, never
 * a partial run: the per-target shape only exists when the whole plan was legible.
 */

const { execFileSync } = require('node:child_process');

const VERSION = 1;
const SCHEMA = 'review-reply/v1';
const PLAN_SCHEMA = 'review-reply/plan/v1';
const TRUNCATED_MARKER = ' […truncated by the board] ';
const ERROR_MAX = 300;
const PLAN_TARGETS_MAX = 32;
const PLAN_BYTES_MAX = 128 * 1024;

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { id isResolved }
      }
    }
  }
}`;
const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`;

const KINDS = ['general', 'inline', 'thread', 'resolve'];
const STATUSES = ['planned', 'refused'];

const str = (v) => (typeof v === 'string' ? v : null);

function validateRef(repo, pr) {
    const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
    if (!m || !/^\d{1,9}$/.test(pr)) return null;
    return { owner: m[1], repo: m[2], number: Number(pr) };
}

function gh(args) {
    return execFileSync('gh', args, {
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function bound(error) {
    const text = String(error);
    return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX)}${TRUNCATED_MARKER}` : text;
}

function classify(id, kind, error) {
    const text = String((error && error.stderr) || (error && error.message) || error);
    const code = /HTTP (\d{3})/.exec(text)?.[1] ?? null;
    if (code === '404' || code === '410') return { id, kind, status: 'noop', reason: 'not_found' };
    if (code === '401') return { id, kind, status: 'refused', reason: 'auth' };
    if (code === '403') return { id, kind, status: 'refused', reason: 'permission' };
    if (code === '429') return { id, kind, status: 'refused', reason: 'rate' };
    return { id, kind, status: 'refused', reason: bound(text) };
}

function refusal(error, ref) {
    return JSON.stringify({ ok: false, version: VERSION, schema: SCHEMA, ref, error: bound(error) });
}

function reply() {
    const ref = validateRef(process.env.REPO, process.env.PR);
    if (!ref) return refusal('invalid REPO/PR: expected owner/name and a pull request number', null);
    if (!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()) {
        return refusal('missing credential: GH_TOKEN or GITHUB_TOKEN must be set', ref);
    }

    let plan;
    try {
        plan = JSON.parse(process.env.REPLY_PLAN ?? '');
    } catch {
        return refusal('malformed REPLY_PLAN: not JSON', ref);
    }
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.version !== 1) {
        return refusal('malformed REPLY_PLAN: expected review-reply/plan/v1', ref);
    }
    if (!plan.ref || plan.ref.owner !== ref.owner || plan.ref.repo !== ref.repo || plan.ref.number !== ref.number) {
        return refusal('REPLY_PLAN ref does not match REPO/PR', ref);
    }
    if (!Array.isArray(plan.targets)) return refusal('malformed REPLY_PLAN: no targets', ref);
    if (plan.targets.length > PLAN_TARGETS_MAX)
        return refusal(`REPLY_PLAN oversized: > ${PLAN_TARGETS_MAX} targets`, ref);
    if (Buffer.byteLength(process.env.REPLY_PLAN ?? '', 'utf8') > PLAN_BYTES_MAX) {
        return refusal(`REPLY_PLAN oversized: > ${PLAN_BYTES_MAX} bytes`, ref);
    }

    const pulls = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const issues = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    const results = [];

    const threadState = {};
    const resolveTargets = plan.targets.filter((t) => t.kind === 'resolve' && t.status === 'planned');
    if (resolveTargets.length) {
        const gql = JSON.parse(
            gh([
                'api',
                'graphql',
                '-f',
                `query=${THREADS_QUERY}`,
                '-F',
                `owner=${ref.owner}`,
                '-F',
                `repo=${ref.repo}`,
                '-F',
                `number=${ref.number}`,
            ])
        );
        const pr = gql && gql.data && gql.data.repository && gql.data.repository.pullRequest;
        const nodes = pr && pr.reviewThreads && Array.isArray(pr.reviewThreads.nodes) ? pr.reviewThreads.nodes : [];
        for (const node of nodes) {
            if (node && typeof node.id === 'string')
                threadState[node.id] = { found: true, isResolved: node.isResolved === true };
        }
        for (const t of resolveTargets) {
            if (!(t.id in threadState)) threadState[t.id] = { found: false, isResolved: false };
        }
    }

    for (const target of plan.targets) {
        if (
            typeof target.id !== 'string' ||
            !target.id ||
            !KINDS.includes(target.kind) ||
            !STATUSES.includes(target.status)
        ) {
            return refusal(`malformed REPLY_PLAN target: ${JSON.stringify(target).slice(0, ERROR_MAX)}`, ref);
        }
        const base = { id: target.id, kind: target.kind };
        if (target.status === 'refused') {
            results.push({ ...base, status: 'refused', reason: str(target.reason) ?? 'refused by plan' });
            continue;
        }
        if (target.kind === 'resolve') {
            const st = threadState[target.id];
            if (!st || !st.found) {
                results.push({ ...base, status: 'noop', reason: 'not_found' });
            } else if (st.isResolved) {
                results.push({ ...base, status: 'noop', reason: 'already_resolved' });
            } else {
                try {
                    gh(['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-F', `threadId=${target.id}`]);
                    results.push({ ...base, status: 'done', reason: null });
                } catch (e) {
                    results.push(classify(target.id, 'resolve', e));
                }
            }
            continue;
        }
        if (typeof target.reply !== 'string' || !target.reply.trim()) {
            return refusal(`malformed REPLY_PLAN target: no reply body for ${target.kind} ${target.id}`, ref);
        }
        const replyBody = target.reply;
        let args;
        if (target.kind === 'general') {
            args = ['api', `${issues}/comments`, '-f', `body=${replyBody}`];
        } else if (target.kind === 'inline') {
            const anchorId = /^\d{1,10}$/.test(target.id) ? Number(target.id) : null;
            if (anchorId === null) {
                return refusal(`malformed REPLY_PLAN target: no anchor comment for inline ${target.id}`, ref);
            }
            args = ['api', `${pulls}/comments/${anchorId}/replies`, '-f', `body=${replyBody}`];
        } else {
            const anchorId = target.firstCommentId;
            if (typeof anchorId !== 'number') {
                return refusal(`malformed REPLY_PLAN target: no anchor comment for thread ${target.id}`, ref);
            }
            args = ['api', `${pulls}/comments/${anchorId}/replies`, '-f', `body=${replyBody}`];
        }
        try {
            gh(args);
            results.push({ ...base, status: 'done', reason: null });
        } catch (e) {
            results.push(classify(target.id, target.kind, e));
        }
    }

    return JSON.stringify({ version: VERSION, schema: SCHEMA, ref, results, error: null });
}

try {
    const out = reply();
    if (typeof out === 'string') process.stdout.write(`${out}\n`);
} catch (e) {
    const ref = validateRef(process.env.REPO, process.env.PR);
    const message = (e && e.stderr && String(e.stderr)) || (e && e.message && String(e.message)) || String(e);
    process.stdout.write(`${refusal(message, ref)}\n`);
}
