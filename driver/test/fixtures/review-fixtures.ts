import type { ReviewCollection, ReviewPlan, ReviewReplyRequest } from '../../src/review.js';

/**
 * Shared data builders for the review suites (`review.test.ts` and `review-scripts.test.ts`,
 * split for the line-count cap): a normalized collection state and the plan-builder request/
 * target shapes, so both the pure planner tests and the real-script end-to-end tests describe
 * the same PR against the same fixture data.
 */
export const ref = { owner: 'octo', repo: 'factory', number: 7 };

/** Identical to `ref`, kept as its own value: the two suites (pure planner vs real script) each
 * name the PR they describe independently, so a future divergence is a deliberate edit, not a
 * shared-constant surprise. */
export const collectRef = { owner: 'octo', repo: 'factory', number: 7 };

export const collection = (over: Partial<ReviewCollection> = {}): ReviewCollection => ({
    version: 1,
    schema: 'review-collect/v1',
    ref,
    general: [
        {
            id: 401,
            author: 'commenter',
            body: 'please add a test for the empty path',
            createdAt: '2026-09-02T10:00:00Z',
            path: null,
            line: null,
            diffHunk: null,
            inReplyToId: null,
            reviewId: null,
        },
        {
            id: 402,
            author: 'watcher',
            body: 'looks related to #200',
            createdAt: '2026-09-03T11:00:00Z',
            path: null,
            line: null,
            diffHunk: null,
            inReplyToId: null,
            reviewId: null,
        },
    ],
    reviews: [
        {
            id: 22,
            author: 'aye',
            state: 'APPROVED',
            body: 'lgtm',
            createdAt: '2026-09-02T12:00:00Z',
            commitId: 'abc',
        },
        {
            id: 23,
            author: 'naysayer',
            state: 'CHANGES_REQUESTED',
            body: 'must close the null path',
            createdAt: '2026-09-03T13:00:00Z',
            commitId: 'abc',
        },
    ],
    inline: [
        {
            id: 111,
            author: 'naysayer',
            body: 'null here blows up',
            createdAt: '2026-09-03T13:01:00Z',
            path: 'src/parse.ts',
            line: 5,
            diffHunk: '@@ -5,3 +5,3 @@',
            inReplyToId: null,
            reviewId: 23,
        },
        {
            id: 112,
            author: 'naysayer',
            body: 'and here the retry path',
            createdAt: '2026-09-03T13:02:00Z',
            path: 'src/parse.ts',
            line: 9,
            diffHunk: '@@ -9,3 +9,3 @@',
            inReplyToId: null,
            reviewId: 23,
        },
    ],
    threads: [
        {
            id: 'T_a',
            isResolved: false,
            isOutdated: false,
            path: 'src/parse.ts',
            line: 5,
            comments: [
                {
                    id: 'IC_a1',
                    databaseId: 111,
                    author: 'naysayer',
                    body: 'null here blows up',
                    createdAt: '2026-09-03T13:01:00Z',
                },
            ],
        },
        {
            id: 'T_b',
            isResolved: true,
            isOutdated: false,
            path: 'src/parse.ts',
            line: 9,
            comments: [
                {
                    id: 'IC_b1',
                    databaseId: 112,
                    author: 'naysayer',
                    body: 'and here the retry path',
                    createdAt: '2026-09-03T13:02:00Z',
                },
            ],
        },
    ],
    requestedReviewers: { users: ['reviewer-a'], teams: ['qa-team'] },
    decision: 'CHANGES_REQUESTED',
    truncated: { sections: [], bodies: 0, diffHunks: 0, threads: 0, total: false },
    error: null,
    ...over,
});

export const planned = (over: Partial<ReviewPlan['targets'][number]>): ReviewPlan['targets'][number] => ({
    id: '',
    kind: 'general',
    reply: null,
    resolve: false,
    firstCommentId: null,
    status: 'planned',
    reason: null,
    ...over,
});

export const request = (
    over: Partial<ReviewReplyRequest> & { id: string; kind: 'general' | 'inline' | 'thread' }
): ReviewReplyRequest => ({
    reply: null,
    resolve: false,
    ...over,
});
