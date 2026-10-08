import type { BoardJobStatus, ReviewReport } from './board.js';

/**
 * The control endpoint's reviewer routes (issue #549), one set per control token — so one lease:
 * `POST /review {key, profile}` asks for a named reviewer's separate run over the task's tree as it
 * stands now, and `GET /review/<key>` reads its progress and verdict. The agent names a key and a
 * profile and nothing else: the revision is what the DRIVER measures, the snapshot is what the
 * driver freezes, and the board decides what the reviewer may reach. `loop-review.ts` is the relay.
 */

/** A request names a key and a profile, so one past this is an attack. */
export const REVIEW_BODY_LIMIT = 1024;

/** The caller's idempotency key and a profile name, in the board's own spelling (`REVIEW_KEY`, `REVIEW_PROFILE`). */
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const PROFILE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_NOT_IMPLEMENTED = 501;

/**
 * What the loop answers a route with: the review (`created` when this request started it), or why
 * not — `forbidden` (this run is itself a reviewer, or the board gave it no way to ask),
 * `unsupported` (a runner that cannot snapshot), `gone` (the lease is lost, a Stop landed or the
 * run ended) or the board's own `refused` reason (an undeclared profile, a workflow task, a tree
 * that could not be measured).
 */
export type ReviewVerdict =
    | { review: ReviewReport; created: boolean }
    | 'forbidden'
    | 'unsupported'
    | 'gone'
    | { refused: string };

export interface ReviewRelay {
    request(key: string, profile: string): Promise<ReviewVerdict>;
    read(key: string): Promise<ReviewVerdict>;
}

export interface ReviewAnswer {
    status: number;
    body: unknown;
}

/** The statuses after which a review will never change. */
const SETTLED: readonly BoardJobStatus[] = ['succeeded', 'failed', 'dead', 'stopped'];

/** The wire answer of a review verdict: what the agent reads, or the reason it got none. */
export function reviewAnswer(verdict: ReviewVerdict): ReviewAnswer {
    if (verdict === 'forbidden') {
        return { status: HTTP_FORBIDDEN, body: { error: 'this run cannot invoke a reviewer' } };
    }
    if (verdict === 'unsupported') {
        return { status: HTTP_NOT_IMPLEMENTED, body: { error: 'this executor cannot offer a reviewer' } };
    }
    if (verdict === 'gone') return { status: HTTP_UNAUTHORIZED, body: { error: 'unknown token' } };
    if ('refused' in verdict) return { status: HTTP_CONFLICT, body: { error: verdict.refused } };
    const { review } = verdict;
    return {
        status: verdict.created ? HTTP_CREATED : HTTP_OK,
        body: {
            key: review.key,
            profile: review.profile,
            status: review.status,
            // `done` is "will not change": poll until it is, then read the verdict. `verdict` is
            // `none` for anything but a succeeded run that ended on a marker — a failed, stopped or
            // marker-less review has no verdict, and a policy never counts it as an approval.
            done: SETTLED.includes(review.status),
            verdict: review.verdict,
            findings: review.findings,
            revision: review.revision,
            failureKind: review.failureKind,
            // Whether the thread's review evidence, as the repository's policy reads it, approves.
            approved: review.evidence.state === 'approved',
        },
    };
}

/** The per-token state: whether a request is in flight (a second caller is told, never queued). */
export interface ReviewSlot {
    running: boolean;
}

const BUSY: ReviewAnswer = { status: HTTP_CONFLICT, body: { error: 'a review request is already running' } };
const badRequest = (error: string): ReviewAnswer => ({ status: HTTP_BAD_REQUEST, body: { error } });

/** `POST /review` once the token is known: parse, then one request at a time per token. */
export async function serveReviewRequest(
    slot: ReviewSlot,
    relay: ReviewRelay | null,
    raw: string
): Promise<ReviewAnswer> {
    if (!relay) return reviewAnswer('forbidden');
    let fields: { key?: unknown; profile?: unknown } = {};
    try {
        fields = JSON.parse(raw) as typeof fields;
    } catch {
        return badRequest('the body must be JSON: {"key": …, "profile": …}');
    }
    const { key, profile } = fields;
    if (typeof key !== 'string' || !KEY.test(key)) {
        return badRequest('key must be 1..64 characters of letters, digits, _ and -');
    }
    if (typeof profile !== 'string' || !PROFILE.test(profile)) {
        return badRequest('profile must be a reviewer name declared in .bellows.yaml');
    }
    if (slot.running) return BUSY;
    slot.running = true;
    try {
        return reviewAnswer(await relay.request(key, profile));
    } finally {
        slot.running = false;
    }
}

/** `GET /review/<key>` once the token is known. */
export async function serveReviewRead(relay: ReviewRelay | null, key: string): Promise<ReviewAnswer> {
    if (!relay) return reviewAnswer('forbidden');
    if (!KEY.test(key)) return badRequest('key must be 1..64 characters of letters, digits, _ and -');
    return reviewAnswer(await relay.read(key));
}
