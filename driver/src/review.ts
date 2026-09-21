import { readFileSync } from 'node:fs';

/**
 * The deterministic GitHub review helpers: the collection and reply script VALUES plus the pure
 * host-side parser/planner that turns a collected state and a set of intents into a bounded
 * mutation plan.
 *
 * The scripts (scripts/review-collect.cjs, scripts/review-reply.cjs) are content-passed into
 * containers — a `node -e` value, never a path, never a template string — so each carries its
 * normalization, dedupe, ordering and capping logic inline; they cannot require this module
 * at runtime. This module is the seam the host keeps: the script values (byte-pinned by
 * scripts.test.ts), the cap and marker constants the orchestration must agree with the scripts
 * on, and the planners that read a collection, refuse targets the collection does not contain,
 * and hand the reply script a bounded plan. This issue ships the helpers only — nothing wires
 * to this module yet.
 */

const script = (name: string): string => readFileSync(new URL(`./scripts/${name}`, import.meta.url), 'utf8');

export const reviewCollectScript = script('review-collect.cjs');
export const reviewReplyScript = script('review-reply.cjs');

export const TRUNCATED_MARKER = ' […truncated by the board] ';
export const BODY_MAX = 2000;
export const DIFF_HUNK_MAX = 500;
export const REPLY_BODY_MAX = 4000;
export const ERROR_MAX = 300;
export const GENERAL_LIMIT = 50;
export const INLINE_LIMIT = 50;
export const REVIEWS_LIMIT = 20;
export const THREADS_LIMIT = 100;
export const THREAD_COMMENTS_LIMIT = 10;
export const TOTAL_OUTPUT_BYTES = 256 * 1024;
export const PLAN_TARGETS_MAX = 32;
export const PLAN_BYTES_MAX = 128 * 1024;

export interface ReviewRef {
    owner: string;
    repo: string;
    number: number;
}

export interface ReviewCommentItem {
    id: number;
    author: string | null;
    body: string;
    createdAt: string | null;
    path: string | null;
    line: number | null;
    diffHunk: string | null;
    inReplyToId: number | null;
    reviewId: number | null;
}

export interface SubmittedReview {
    id: number;
    author: string | null;
    state: string | null;
    body: string;
    createdAt: string | null;
    commitId: string | null;
}

export interface ReviewThreadComment {
    id: string;
    databaseId: number | null;
    author: string | null;
    body: string;
    createdAt: string | null;
}

export interface ReviewThread {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    path: string | null;
    line: number | null;
    comments: ReviewThreadComment[];
}

export interface ReviewTruncated {
    sections: string[];
    bodies: number;
    diffHunks: number;
    threads: number;
    total: boolean;
}

export interface ReviewCollection {
    version: 1;
    schema: 'review-collect/v1';
    ref: ReviewRef;
    general: ReviewCommentItem[];
    reviews: SubmittedReview[];
    inline: ReviewCommentItem[];
    threads: ReviewThread[];
    requestedReviewers: { users: string[]; teams: string[] };
    decision: string | null;
    truncated: ReviewTruncated;
    error: string | null;
}

export type ReplyKind = 'general' | 'inline' | 'thread' | 'resolve';

export interface ReviewReplyRequest {
    /** Numeric id for general/inline intents; the review-thread node id for thread intents. */
    id: string;
    kind: 'general' | 'inline' | 'thread';
    /** The bounded "what changed" body; null when the intent only resolves. */
    reply: string | null;
    /** Resolve the thread, for thread intents only. */
    resolve: boolean;
}

export type ReviewPlanAllowedKind = Exclude<ReplyKind, 'resolve'>;
export type ReviewPlanStatus = 'planned' | 'refused';
export type ReviewPlanReason = 'unknown_target' | 'already_resolved' | 'no_action' | 'no_reply_target';

export interface ReviewPlanTarget {
    id: string;
    kind: ReplyKind;
    /** Reply body for general/inline/thread targets; null for resolve targets. */
    reply: string | null;
    resolve: boolean;
    /** The thread's first comment, the only deterministic reply anchor; thread replies only. */
    firstCommentId: number | null;
    status: ReviewPlanStatus;
    reason: ReviewPlanReason | null;
}

export interface ReviewPlan {
    version: 1;
    schema: 'review-reply/plan/v1';
    ref: ReviewRef;
    targets: ReviewPlanTarget[];
}

export type ReviewResultStatus = 'done' | 'noop' | 'refused';

export interface ReviewResultItem {
    id: string;
    kind: ReplyKind;
    status: ReviewResultStatus;
    reason: string | null;
}

export interface ReviewReplyResults {
    version: 1;
    schema: 'review-reply/v1';
    ref: ReviewRef;
    results: ReviewResultItem[];
    error: string | null;
}

/** The owner/name/repo shape, validated. Null when the values cannot form a pull-reference. */
export function validateReviewRef(repo: string, pr: string): ReviewRef | null {
    const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
    if (!m || !/^\d{1,9}$/.test(pr)) return null;
    return { owner: m[1]!, repo: m[2]!, number: Number(pr) };
}

/** Code-point truncation (never a lone surrogate) with the visible board marker. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
    const chars = [...text];
    if (chars.length <= max) return { text, truncated: false };
    return { text: `${chars.slice(0, max).join('')}${TRUNCATED_MARKER}`, truncated: true };
}

const emptyRef = (): ReviewRef => ({ owner: '', repo: '', number: 0 });

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => typeof v === 'boolean' && v;

const refOf = (o: Record<string, unknown>): ReviewRef => {
    const r = (typeof o.ref === 'object' && o.ref !== null ? o.ref : {}) as Record<string, unknown>;
    return {
        owner: str(r.owner) ?? '',
        repo: str(r.repo) ?? '',
        number: num(r.number) ?? 0,
    };
};

const emptyTruncated = (): ReviewTruncated => ({
    sections: [],
    bodies: 0,
    diffHunks: 0,
    threads: 0,
    total: false,
});

function asComment(v: unknown): ReviewCommentItem {
    const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return {
        id: num(o.id) ?? 0,
        author: str(o.author),
        body: str(o.body) ?? '',
        createdAt: str(o.createdAt),
        path: str(o.path),
        line: num(o.line),
        diffHunk: str(o.diffHunk),
        inReplyToId: num(o.inReplyToId),
        reviewId: num(o.reviewId),
    };
}

function asReview(v: unknown): SubmittedReview {
    const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return {
        id: num(o.id) ?? 0,
        author: str(o.author),
        state: str(o.state),
        body: str(o.body) ?? '',
        createdAt: str(o.createdAt),
        commitId: str(o.commitId),
    };
}

function asThread(v: unknown): ReviewThread {
    const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return {
        id: str(o.id) ?? '',
        isResolved: bool(o.isResolved),
        isOutdated: bool(o.isOutdated),
        path: str(o.path),
        line: num(o.line),
        comments: arr(o.comments)
            .map(asThreadComment)
            .sort((a, b) => (a.databaseId ?? 0) - (b.databaseId ?? 0)),
    };
}

function asThreadComment(v: unknown): ReviewThreadComment {
    const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return {
        id: str(o.id) ?? '',
        databaseId: num(o.databaseId),
        author: str(o.author),
        body: str(o.body) ?? '',
        createdAt: str(o.createdAt),
    };
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const truncatedOf = (v: unknown): ReviewTruncated => {
    const t = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return {
        sections: arr(t.sections)
            .map((s) => str(s))
            .filter((s): s is string => s !== null),
        bodies: num(t.bodies) ?? 0,
        diffHunks: num(t.diffHunks) ?? 0,
        threads: num(t.threads) ?? 0,
        total: bool(t.total),
    };
};

const errorCollection = (o: Record<string, unknown>, fallback: string): ReviewCollection => ({
    version: 1,
    schema: 'review-collect/v1',
    ref: refOf(o),
    general: [],
    reviews: [],
    inline: [],
    threads: [],
    requestedReviewers: { users: [], teams: [] },
    decision: null,
    truncated: emptyTruncated(),
    error: str(o.error) ?? fallback,
});

/** Tolerant parse of the collection script's single stdout verdict; defaults on any bad shape. */
export function parseReviewCollection(stdout: string): ReviewCollection {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let p: unknown;
    try {
        p = JSON.parse(line);
    } catch {
        return errorCollection({ error: 'unreadable collection verdict' }, 'unreadable collection verdict');
    }
    const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
    if (o.schema !== 'review-collect/v1' || o.version !== 1) {
        return errorCollection({ ...o, error: 'unsupported collection schema' }, 'unsupported collection schema');
    }
    if (o.ok === false) return errorCollection(o, 'collection failed');
    const reviewers = (
        typeof o.requestedReviewers === 'object' && o.requestedReviewers !== null ? o.requestedReviewers : {}
    ) as Record<string, unknown>;
    return {
        version: 1,
        schema: 'review-collect/v1',
        ref: refOf(o),
        general: arr(o.general).map(asComment),
        reviews: arr(o.reviews).map(asReview),
        inline: arr(o.inline).map(asComment),
        threads: arr(o.threads).map(asThread),
        requestedReviewers: {
            users: arr(reviewers.users)
                .map((u) => str(u))
                .filter((u): u is string => u !== null),
            teams: arr(reviewers.teams)
                .map((t) => str(t))
                .filter((t): t is string => t !== null),
        },
        decision: str(o.decision),
        truncated: truncatedOf(o.truncated),
        error: str(o.error),
    };
}

/** Tolerant parse of the reply script's single stdout verdict; a refusal surfaces as error. */
export function parseReviewReplyResults(stdout: string): ReviewReplyResults {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let p: unknown;
    try {
        p = JSON.parse(line);
    } catch {
        return {
            version: 1,
            schema: 'review-reply/v1',
            ref: emptyRef(),
            results: [],
            error: 'unreadable reply verdict',
        };
    }
    const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
    if (o.schema !== 'review-reply/v1' || o.version !== 1) {
        return { version: 1, schema: 'review-reply/v1', ref: refOf(o), results: [], error: 'unsupported reply schema' };
    }
    const asResult = (v: unknown): ReviewResultItem => {
        const r = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
        return {
            id: str(r.id) ?? '',
            kind: ['general', 'inline', 'thread', 'resolve'].includes(str(r.kind) ?? '')
                ? (str(r.kind) as ReplyKind)
                : 'general',
            status: ['done', 'noop', 'refused'].includes(str(r.status) ?? '')
                ? (str(r.status) as ReviewResultStatus)
                : 'refused',
            reason: str(r.reason),
        };
    };
    if (o.ok === false) {
        return {
            version: 1,
            schema: 'review-reply/v1',
            ref: refOf(o),
            results: [],
            error: str(o.error) ?? 'reply failed',
        };
    }
    return {
        version: 1,
        schema: 'review-reply/v1',
        ref: refOf(o),
        results: arr(o.results).map(asResult),
        error: str(o.error),
    };
}

function planReplyTarget(
    state: ReviewCollection,
    kind: 'general' | 'inline',
    id: string,
    body: string | null
): ReviewPlanTarget {
    const base = { id, kind, resolve: false, firstCommentId: null };
    const item = (kind === 'general' ? state.general : state.inline).some((c) => String(c.id) === id);
    if (!item) return { ...base, reply: null, status: 'refused', reason: 'unknown_target' };
    if (!body || !body.trim()) return { ...base, reply: null, status: 'refused', reason: 'no_reply_target' };
    return { ...base, reply: truncateText(body, REPLY_BODY_MAX).text, status: 'planned', reason: null };
}

/** Build a bounded mutation plan: dedupe intents, refuse anything the collection does not hold. */
export function buildReviewReply(state: ReviewCollection, requested: ReviewReplyRequest[]): ReviewPlan {
    const targets: ReviewPlanTarget[] = [];
    const seen = new Set<string>();
    for (const r of requested) {
        const key = `${r.kind}:${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (r.kind === 'general' || r.kind === 'inline') {
            targets.push(planReplyTarget(state, r.kind, r.id, r.reply));
            continue;
        }
        const thread = state.threads.find((t) => t.id === r.id);
        if (!thread) {
            targets.push({
                id: r.id,
                kind: 'thread',
                reply: null,
                resolve: false,
                firstCommentId: null,
                status: 'refused',
                reason: 'unknown_target',
            });
            continue;
        }
        const wantsReply = Boolean(r.reply && r.reply.trim());
        if (!wantsReply && !r.resolve) {
            targets.push({
                id: r.id,
                kind: 'thread',
                reply: null,
                resolve: false,
                firstCommentId: null,
                status: 'refused',
                reason: 'no_action',
            });
            continue;
        }
        if (wantsReply) {
            const firstCommentId = thread.comments.at(0)?.databaseId ?? null;
            if (firstCommentId === null) {
                targets.push({
                    id: r.id,
                    kind: 'thread',
                    reply: null,
                    resolve: r.resolve,
                    firstCommentId: null,
                    status: 'refused',
                    reason: 'no_reply_target',
                });
            } else {
                targets.push({
                    id: r.id,
                    kind: 'thread',
                    reply: truncateText(r.reply!, REPLY_BODY_MAX).text,
                    resolve: false,
                    firstCommentId,
                    status: 'planned',
                    reason: null,
                });
            }
        }
        if (r.resolve) {
            targets.push({
                id: r.id,
                kind: 'resolve',
                reply: null,
                resolve: true,
                firstCommentId: null,
                status: thread.isResolved ? 'refused' : 'planned',
                reason: thread.isResolved ? 'already_resolved' : null,
            });
        }
    }
    return { version: 1, schema: 'review-reply/plan/v1', ref: state.ref, targets };
}
