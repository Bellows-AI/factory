import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
    BODY_MAX,
    DIFF_HUNK_MAX,
    ERROR_MAX,
    GENERAL_LIMIT,
    THREAD_COMMENTS_LIMIT,
    TRUNCATED_MARKER,
    type ReviewCollection,
} from '../src/review.js';
import { collectRef } from './fixtures/review-fixtures.js';
import { cleanupTempDirs, fixture, runScript, TEST_TOKEN, writeFixture } from './fixtures/review-script-support.js';

afterEach(cleanupTempDirs);

const GH_RESPONSES = JSON.parse(readFileSync(fixture('gh-responses.json'), 'utf8')) as {
    general: Array<Record<string, unknown>>;
    inline: Array<Record<string, unknown>>;
    reply: Record<string, unknown>;
};

// The full normalized verdict `review-collect.cjs` produces against gh-responses.json — a plain
// constant, not a function, so its bulk (one literal per feedback surface) never counts against
// any function's own line cap.
const body114 = String(GH_RESPONSES.inline[2]?.body ?? '');
const hunk114 = String(GH_RESPONSES.inline[2]?.diff_hunk ?? '');
const truncatedBody114 = `${body114.slice(0, BODY_MAX)}${TRUNCATED_MARKER}`;
const truncatedHunk114 = `${hunk114.slice(0, DIFF_HUNK_MAX)}${TRUNCATED_MARKER}`;
const EXPECTED_COLLECTION_VERDICT: ReviewCollection = {
    version: 1,
    schema: 'review-collect/v1',
    ref: collectRef,
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
            commitId: 'abc123',
        },
        {
            id: 23,
            author: 'naysayer',
            state: 'CHANGES_REQUESTED',
            body: 'must close the null path',
            createdAt: '2026-09-03T13:00:00Z',
            commitId: 'abc123',
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
            diffHunk: '@@ -5,3 +5,3 @@ function parse(input) {',
            inReplyToId: null,
            reviewId: 23,
        },
        {
            id: 112,
            author: 'doeser',
            body: 'fixed it',
            createdAt: '2026-09-03T13:05:00Z',
            path: 'src/parse.ts',
            line: 5,
            diffHunk: '@@ -5,3 +5,3 @@ function parse(input) {',
            inReplyToId: 111,
            reviewId: 23,
        },
        {
            id: 114,
            author: 'naysayer',
            body: truncatedBody114,
            createdAt: '2026-09-03T13:06:00Z',
            path: 'src/parse.ts',
            line: 9,
            diffHunk: truncatedHunk114,
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
                {
                    id: 'IC_a2',
                    databaseId: 112,
                    author: 'doeser',
                    body: 'fixed it',
                    createdAt: '2026-09-03T13:05:00Z',
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
                    databaseId: 114,
                    author: 'naysayer',
                    body: truncatedBody114,
                    createdAt: '2026-09-03T13:06:00Z',
                },
            ],
        },
    ],
    requestedReviewers: { users: ['reviewer-a', 'reviewer-b'], teams: ['qa-team'] },
    decision: 'CHANGES_REQUESTED',
    truncated: { sections: [], bodies: 2, diffHunks: 1, threads: 0, total: false },
    error: null,
};

const EXPECTED_ARGS_COUNT = 5;
const HTTP_UNAUTHORIZED = '401';

describe('the review collection script', () => {
    it('collects every feedback surface into one bounded normalized verdict', async () => {
        const { stdout, stderr, args } = await runScript('review-collect.cjs', { REPO: 'octo/factory', PR: '7' });
        expect(JSON.parse(stdout.trim())).toEqual(EXPECTED_COLLECTION_VERDICT);
        expect(JSON.parse(stdout.trim())).toHaveProperty('error', null);
        expect(stderr).toBe('');
        expect(args).toHaveLength(EXPECTED_ARGS_COUNT);
        expect(args[0]).toEqual(['api', 'repos/octo/factory/issues/7/comments', '--paginate']);
        expect(args[1]).toEqual(['api', 'repos/octo/factory/pulls/7/reviews', '--paginate']);
        expect(args[2]).toEqual(['api', 'repos/octo/factory/pulls/7/comments', '--paginate']);
        expect(args[3]).toEqual(['api', 'repos/octo/factory/pulls/7/requested_reviewers']);
        expect(args[4]!.slice(0, 2)).toEqual(['api', 'graphql']);
        expect(args[4]![2]).toBe('-f');
        expect(args[4]![3]!.startsWith('query=query($owner: String!')).toBe(true);
        const GRAPHQL_QUERY_ARG_COUNT = 4;
        expect(args[4]!.slice(GRAPHQL_QUERY_ARG_COUNT)).toEqual([
            '-f',
            'owner=octo',
            '-f',
            'repo=factory',
            '-F',
            'number=7',
        ]);
        expect(args[4]!.join(' ')).toContain('reviewDecision');
        expect(args[4]!.join(' ')).toContain('isResolved');
    });

    it('is byte-stable for the same upstream state', async () => {
        const first = (await runScript('review-collect.cjs', { REPO: 'octo/factory', PR: '7' })).stdout;
        const second = (await runScript('review-collect.cjs', { REPO: 'octo/factory', PR: '7' })).stdout;
        expect(second).toBe(first);
    });

    it('refuses as one bounded verdict when gh fails, never a partial collection', async () => {
        const { stdout, args } = await runScript('review-collect.cjs', {
            REPO: 'octo/factory',
            PR: '7',
            GH_HTTP_STATUS: HTTP_UNAUTHORIZED,
        });
        const verdict = JSON.parse(stdout.trim()) as { ok: boolean; error: string };
        expect(verdict.ok).toBe(false);
        expect(verdict.error).toContain(`HTTP ${HTTP_UNAUTHORIZED}`);
        expect(verdict.error.length).toBeLessThanOrEqual(ERROR_MAX + TRUNCATED_MARKER.length);
        expect(stdout.trim().split('\n')).toHaveLength(1);
        expect(args.length).toBeLessThan(EXPECTED_ARGS_COUNT);
    });
});

describe('the review collection script: input validation', () => {
    it('refuses an invalid REPO/PR before spawning gh', async () => {
        const { stdout, args } = await runScript('review-collect.cjs', { REPO: 'octo', PR: '7' });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            ok: false,
            error: expect.stringContaining('invalid REPO/PR'),
        });
        expect(args).toEqual([]);
    });

    it('refuses a missing credential before spawning gh', async () => {
        const { stdout, args } = await runScript(
            'review-collect.cjs',
            { REPO: 'octo/factory', PR: '7' },
            { token: false }
        );
        expect(JSON.parse(stdout.trim())).toMatchObject({
            ok: false,
            error: expect.stringContaining('missing credential'),
        });
        expect(args).toEqual([]);
    });

    it('never lets the token reach argv, stdout or stderr', async () => {
        const { stdout, stderr, args } = await runScript('review-collect.cjs', { REPO: 'octo/factory', PR: '7' });
        const everything = [stdout, stderr, ...args.flat()].join('\n');
        expect(everything).not.toContain(TEST_TOKEN);
    });
});

describe('the review collection script: section and thread caps', () => {
    it('caps a section at its limit and reports the truncation', async () => {
        const BULK_GENERAL_COUNT = 60;
        const BULK_GENERAL_FIRST_ID = 500;
        const general = Array.from({ length: BULK_GENERAL_COUNT }, (_, i) => ({
            id: BULK_GENERAL_FIRST_ID + i,
            user: { login: 'bulk' },
            body: 'short',
            created_at: '2026-09-03T10:00:00Z',
        }));
        const file = writeFixture({
            general,
            reviews: [],
            inline: [],
            requested: { users: [], teams: [] },
            threads: { data: { repository: { pullRequest: null } } },
        });
        const { stdout } = await runScript('review-collect.cjs', { REPO: 'octo/factory', PR: '7', GH_FIXTURES: file });
        const verdict = JSON.parse(stdout.trim()) as ReviewCollection;
        expect(verdict.general).toHaveLength(GENERAL_LIMIT);
        expect(verdict.general.map((c) => c.id)).toEqual(
            Array.from({ length: GENERAL_LIMIT }, (_, i) => BULK_GENERAL_FIRST_ID + i)
        );
        expect(verdict.truncated.sections).toContain('general');
        expect(verdict.truncated.total).toBe(false);
    });

    it('caps a thread at its comment limit and reports the truncation', async () => {
        const BULK_COMMENT_COUNT = 12;
        const BULK_COMMENT_FIRST_ID = 600;
        const comments = Array.from({ length: BULK_COMMENT_COUNT }, (_, i) => ({
            id: `C${i}`,
            databaseId: BULK_COMMENT_FIRST_ID + i,
            author: { login: 'bulk' },
            body: 'short',
            createdAt: '2026-09-03T10:00:00Z',
        }));
        const file = writeFixture({
            general: [],
            reviews: [],
            inline: [],
            requested: { users: [], teams: [] },
            threads: {
                data: {
                    repository: {
                        pullRequest: {
                            reviewDecision: 'REVIEW_REQUIRED',
                            reviewThreads: {
                                nodes: [
                                    {
                                        id: 'T_big',
                                        isResolved: false,
                                        isOutdated: false,
                                        path: 'src/a.ts',
                                        line: 1,
                                        comments: { nodes: comments },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const { stdout } = await runScript('review-collect.cjs', { REPO: 'octo/factory', PR: '7', GH_FIXTURES: file });
        const verdict = JSON.parse(stdout.trim()) as ReviewCollection;
        expect(verdict.threads).toHaveLength(1);
        expect(verdict.threads[0]!.comments).toHaveLength(THREAD_COMMENTS_LIMIT);
        expect(verdict.threads[0]!.comments[0]!.databaseId).toBe(BULK_COMMENT_FIRST_ID);
        expect(verdict.truncated.sections).toContain('thread-comments');
        expect(verdict.truncated.threads).toBe(1);
    });
});

describe('the review collection script: byte bound and server-reported truncation', () => {
    it('reports thread truncation from the server totalCount, not just the client-side cap', async () => {
        const SKINNY_THREAD_TOTAL_COMMENTS = 12;
        const file = writeFixture({
            general: [],
            reviews: [],
            inline: [],
            requested: { users: [], teams: [] },
            threads: {
                data: {
                    repository: {
                        pullRequest: {
                            reviewDecision: 'REVIEW_REQUIRED',
                            reviewThreads: {
                                totalCount: 150,
                                nodes: [
                                    {
                                        id: 'T_skinny',
                                        isResolved: false,
                                        isOutdated: false,
                                        path: 'src/a.ts',
                                        line: 1,
                                        comments: { totalCount: SKINNY_THREAD_TOTAL_COMMENTS, nodes: [] },
                                    },
                                    {
                                        id: 'T_even',
                                        isResolved: false,
                                        isOutdated: false,
                                        path: 'src/b.ts',
                                        line: 2,
                                        comments: { totalCount: 1, nodes: [{ id: 'IC_e1' }] },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const { stdout } = await runScript('review-collect.cjs', { REPO: 'octo/factory', PR: '7', GH_FIXTURES: file });
        const verdict = JSON.parse(stdout.trim()) as ReviewCollection;
        expect(verdict.threads).toHaveLength(2);
        expect(verdict.truncated.threads).toBe(1);
        expect(verdict.truncated.sections).toContain('thread-comments');
        expect(verdict.truncated.sections).toContain('threads');
    });

    it('collapses the whole verdict to the bounded shell when the payload outgrows the byte cap', async () => {
        // Multi-byte bodies pin the BYTE metric: 600 kept thread comments x 240 CJK chars each is
        // ~222 KiB of UTF-16 length but ~503 KiB of bytes — under TOTAL_OUTPUT_BYTES by length,
        // over it by bytes, so only the Buffer.byteLength check (vs the old string .length one)
        // collapses the verdict. A general key present would mean the bound did not trigger.
        const BULK_THREAD_COUNT = 60;
        const BULK_COMMENTS_PER_THREAD = 20;
        const CJK_BODY_REPEAT = 240;
        const BULK_COMMENT_FIRST_DATABASE_ID = 700;
        const threads = Array.from({ length: BULK_THREAD_COUNT }, (_, i) => ({
            id: `T_bulk${i}`,
            isResolved: false,
            isOutdated: false,
            path: 'src/a.ts',
            line: 1,
            comments: {
                nodes: Array.from({ length: BULK_COMMENTS_PER_THREAD }, (_, j) => ({
                    id: `C${i}_${j}`,
                    databaseId: BULK_COMMENT_FIRST_DATABASE_ID + i * BULK_COMMENTS_PER_THREAD + j,
                    author: { login: 'bulk' },
                    body: '\u6c49'.repeat(CJK_BODY_REPEAT),
                    createdAt: '2026-09-03T10:00:00Z',
                })),
            },
        }));
        const file = writeFixture({
            general: [],
            reviews: [],
            inline: [],
            requested: { users: [], teams: [] },
            threads: {
                data: {
                    repository: {
                        pullRequest: { reviewDecision: 'REVIEW_REQUIRED', reviewThreads: { nodes: threads } },
                    },
                },
            },
        });
        const { stdout, args } = await runScript('review-collect.cjs', {
            REPO: 'octo/factory',
            PR: '7',
            GH_FIXTURES: file,
        });
        const verdict = JSON.parse(stdout.trim()) as ReviewCollection;
        expect('general' in verdict).toBe(false);
        expect(verdict.truncated.total).toBe(true);
        expect(verdict.error).toBeNull();
        expect(verdict.ref).toEqual(collectRef);
        expect(args).toHaveLength(EXPECTED_ARGS_COUNT);
    });
});
