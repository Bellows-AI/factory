import { execFile as execFileCb } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
    BODY_MAX,
    DIFF_HUNK_MAX,
    ERROR_MAX,
    GENERAL_LIMIT,
    INLINE_LIMIT,
    PLAN_BYTES_MAX,
    PLAN_TARGETS_MAX,
    REPLY_BODY_MAX,
    REVIEWS_LIMIT,
    THREADS_LIMIT,
    THREAD_COMMENTS_LIMIT,
    TOTAL_OUTPUT_BYTES,
    TRUNCATED_MARKER,
    buildReviewReply,
    parseReviewCollection,
    parseReviewReplyResults,
    truncateText,
    validateReviewRef,
    type ReviewCollection,
    type ReviewPlan,
    type ReviewReplyRequest,
    type ReviewReplyResults,
} from '../src/review.js';

const execFile = promisify(execFileCb);

const SCRIPTS_DIR = join(fileURLToPath(import.meta.url), '..', '..', 'src', 'scripts');
const pathOf = (name: string): string => join(SCRIPTS_DIR, name);

const TEST_TOKEN = 'token-opencode-review-secret-42';

const ref = { owner: 'octo', repo: 'factory', number: 7 };

const collection = (over: Partial<ReviewCollection> = {}): ReviewCollection => ({
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

const planned = (over: Partial<ReviewPlan['targets'][number]>): ReviewPlan['targets'][number] => ({
    id: '',
    kind: 'general',
    reply: null,
    resolve: false,
    firstCommentId: null,
    status: 'planned',
    reason: null,
    ...over,
});

const request = (
    over: Partial<ReviewReplyRequest> & { id: string; kind: 'general' | 'inline' | 'thread' }
): ReviewReplyRequest => ({
    reply: null,
    resolve: false,
    ...over,
});

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '..', '..', 'test', 'fixtures', 'review');
const fixture = (name: string): string => join(FIXTURES_DIR, name);
const GH_RESPONSES = JSON.parse(readFileSync(fixture('gh-responses.json'), 'utf8')) as {
    general: Array<Record<string, unknown>>;
    inline: Array<Record<string, unknown>>;
    reply: Record<string, unknown>;
};
const FAKE_GH = readFileSync(fixture('fake-gh.cjs'), 'utf8');

const tempDirs = new Set<string>();
afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.clear();
});

interface ScriptRun {
    stdout: string;
    stderr: string;
    args: string[][];
}

/**
 * Run one review script against a stub `gh`: a fake gh executable copied to a throwaway bin dir
 * on PATH that records every argv (the spawn-shape pins), refuses to answer without a credential,
 * and dishes canned payloads from the fixtures. The ambient board credentials are stripped so the
 * only token the child can ever see is the test's own.
 */
const runScript = async (
    name: string,
    env: Record<string, string>,
    opts: { token?: boolean } = {}
): Promise<ScriptRun> => {
    const dir = mkdtempSync(join(tmpdir(), 'review-'));
    tempDirs.add(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'gh'), 0o755);
    const argvLog = join(dir, 'argv.log');
    const childEnv: Record<string, string> = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete childEnv.GH_TOKEN;
    delete childEnv.GITHUB_TOKEN;
    const token = opts.token ?? true;
    Object.assign(childEnv, { GH_FIXTURES: fixture('gh-responses.json'), GH_ARGV_LOG: argvLog });
    if (token) childEnv.GITHUB_TOKEN = TEST_TOKEN;
    Object.assign(childEnv, env);
    const { stdout, stderr } = await execFile('node', [pathOf(name)], { env: childEnv });
    let args: string[][] = [];
    if (existsSync(argvLog)) {
        const raw = readFileSync(argvLog, 'utf8').trim();
        args = raw ? raw.split('\n').map((l) => JSON.parse(l) as string[]) : [];
    }
    return { stdout, stderr, args };
};

const collectRef = { owner: 'octo', repo: 'factory', number: 7 };

/** A disposable extra gh fixture for the boundedness runs that outgrow the canned one. */
const writeFixture = (body: Record<string, unknown>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'review-fixture-'));
    tempDirs.add(dir);
    const file = join(dir, 'responses.json');
    writeFileSync(file, JSON.stringify(body));
    return file;
};

describe('the review collection script', () => {
    const body114 = String(GH_RESPONSES.inline[2]?.body ?? '');
    const hunk114 = String(GH_RESPONSES.inline[2]?.diff_hunk ?? '');
    const truncatedBody = `${body114.slice(0, BODY_MAX)}${TRUNCATED_MARKER}`;
    const truncatedHunk = `${hunk114.slice(0, DIFF_HUNK_MAX)}${TRUNCATED_MARKER}`;

    const expectedVerdict = (): ReviewCollection => ({
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
                body: truncatedBody,
                createdAt: '2026-09-03T13:06:00Z',
                path: 'src/parse.ts',
                line: 9,
                diffHunk: truncatedHunk,
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
                        body: truncatedBody,
                        createdAt: '2026-09-03T13:06:00Z',
                    },
                ],
            },
        ],
        requestedReviewers: { users: ['reviewer-a', 'reviewer-b'], teams: ['qa-team'] },
        decision: 'CHANGES_REQUESTED',
        truncated: { sections: [], bodies: 2, diffHunks: 1, threads: 0, total: false },
        error: null,
    });

    it('collects every feedback surface into one bounded normalized verdict', async () => {
        const { stdout, stderr, args } = await runScript('review-collect.cjs', { REPO: 'octo/factory', PR: '7' });
        expect(JSON.parse(stdout.trim())).toEqual(expectedVerdict());
        expect(JSON.parse(stdout.trim())).toHaveProperty('error', null);
        expect(stderr).toBe('');
        expect(args).toHaveLength(5);
        expect(args[0]).toEqual(['api', 'repos/octo/factory/issues/7/comments', '--paginate']);
        expect(args[1]).toEqual(['api', 'repos/octo/factory/pulls/7/reviews', '--paginate']);
        expect(args[2]).toEqual(['api', 'repos/octo/factory/pulls/7/comments', '--paginate']);
        expect(args[3]).toEqual(['api', 'repos/octo/factory/pulls/7/requested_reviewers']);
        expect(args[4]!.slice(0, 2)).toEqual(['api', 'graphql']);
        expect(args[4]![2]).toBe('-f');
        expect(args[4]![3]!.startsWith('query=query($owner: String!')).toBe(true);
        expect(args[4]!.slice(4)).toEqual(['-F', 'owner=octo', '-F', 'repo=factory', '-F', 'number=7']);
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
            GH_HTTP_STATUS: '401',
        });
        const verdict = JSON.parse(stdout.trim()) as { ok: boolean; error: string };
        expect(verdict.ok).toBe(false);
        expect(verdict.error).toContain('HTTP 401');
        expect(verdict.error.length).toBeLessThanOrEqual(ERROR_MAX + TRUNCATED_MARKER.length);
        expect(stdout.trim().split('\n')).toHaveLength(1);
        expect(args.length).toBeLessThan(5);
    });

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

    it('caps a section at its limit and reports the truncation', async () => {
        const general = Array.from({ length: 60 }, (_, i) => ({
            id: 500 + i,
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
        expect(verdict.general.map((c) => c.id)).toEqual(Array.from({ length: 50 }, (_, i) => 500 + i));
        expect(verdict.truncated.sections).toContain('general');
        expect(verdict.truncated.total).toBe(false);
    });

    it('caps a thread at its comment limit and reports the truncation', async () => {
        const comments = Array.from({ length: 12 }, (_, i) => ({
            id: `C${i}`,
            databaseId: 600 + i,
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
        expect(verdict.threads[0]!.comments[0]!.databaseId).toBe(600);
        expect(verdict.truncated.sections).toContain('thread-comments');
        expect(verdict.truncated.threads).toBe(1);
    });

    it('collapses the whole verdict to the bounded shell when the payload outgrows the byte cap', async () => {
        // Multi-byte bodies pin the BYTE metric: 600 kept thread comments x 240 CJK chars each is
        // ~222 KiB of UTF-16 length but ~503 KiB of bytes — under TOTAL_OUTPUT_BYTES by length,
        // over it by bytes, so only the Buffer.byteLength check (vs the old string .length one)
        // collapses the verdict. A general key present would mean the bound did not trigger.
        const threads = Array.from({ length: 60 }, (_, i) => ({
            id: `T_bulk${i}`,
            isResolved: false,
            isOutdated: false,
            path: 'src/a.ts',
            line: 1,
            comments: {
                nodes: Array.from({ length: 20 }, (_, j) => ({
                    id: `C${i}_${j}`,
                    databaseId: 700 + i * 20 + j,
                    author: { login: 'bulk' },
                    body: '\u6c49'.repeat(240),
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
        expect(args).toHaveLength(5);
    });
});

const replyTarget = (over: Partial<ReviewPlan['targets'][number]>): ReviewPlan['targets'][number] => ({
    id: '',
    kind: 'general',
    reply: null,
    resolve: false,
    firstCommentId: null,
    status: 'planned',
    reason: null,
    ...over,
});

const replyPlan = (targets: ReviewPlan['targets'][]): string =>
    JSON.stringify({ version: 1, schema: 'review-reply/plan/v1', ref: collectRef, targets });

describe('the review reply script', () => {
    const base = { REPO: 'octo/factory', PR: '7' };

    it('replies to a general comment and reports done', async () => {
        const plan = replyPlan([replyTarget({ id: '401', kind: 'general', reply: 'added a test' })]);
        const { stdout, args } = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: plan });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            schema: 'review-reply/v1',
            ref: collectRef,
            results: [{ id: '401', kind: 'general', status: 'done', reason: null }],
        });
        expect(args).toEqual([['api', 'repos/octo/factory/issues/7/comments', '-f', 'body=added a test']]);
    });

    it('replies to an inline comment through the replies endpoint', async () => {
        const plan = replyPlan([replyTarget({ id: '112', kind: 'inline', reply: 'fixed' })]);
        const { stdout, args } = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: plan });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            results: [{ id: '112', kind: 'inline', status: 'done', reason: null }],
        });
        expect(args).toEqual([['api', 'repos/octo/factory/pulls/7/comments/112/replies', '-f', 'body=fixed']]);
    });

    it('replies to a thread then resolves it, in one run', async () => {
        const plan = replyPlan([
            replyTarget({ id: 'T_a', kind: 'thread', reply: 'closed the null path', firstCommentId: 111 }),
            replyTarget({ id: 'T_a', kind: 'resolve', resolve: true }),
        ]);
        const { stdout, args } = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: plan });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            results: [
                { id: 'T_a', kind: 'thread', status: 'done', reason: null },
                { id: 'T_a', kind: 'resolve', status: 'done', reason: null },
            ],
        });
        expect(args).toHaveLength(3);
        expect(args[0]!.join(' ')).toContain('graphql');
        expect(args[0]!.join(' ')).toContain('reviewThreads');
        expect(args[1]).toEqual([
            'api',
            'repos/octo/factory/pulls/7/comments/111/replies',
            '-f',
            'body=closed the null path',
        ]);
        expect(args[2]!.slice(0, 2)).toEqual(['api', 'graphql']);
        expect(args[2]!.join(' ')).toContain('resolveReviewThread');
        expect(args[2]!.at(-1)).toBe('threadId=T_a');
    });

    it('refuses a malformed target even when one before it is valid, without executing anything', async () => {
        const plan = replyPlan([
            replyTarget({ id: '401', kind: 'general', reply: 'added a test' }),
            replyTarget({ id: '112', kind: 'inline' }),
        ]);
        const { stdout, args } = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: plan });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            ok: false,
            error: expect.stringContaining('no reply body'),
        });
        expect(args).toEqual([]);
    });

    it('treats an already-resolved thread as an idempotent no-op, never re-resolving', async () => {
        const plan = replyPlan([replyTarget({ id: 'T_b', kind: 'resolve', resolve: true })]);
        const { stdout, args } = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: plan });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            results: [{ id: 'T_b', kind: 'resolve', status: 'noop', reason: 'already_resolved' }],
        });
        expect(args).toHaveLength(1);
        expect(args[0]!.join(' ')).toContain('reviewThreads');
        expect(args[0]!.join(' ')).not.toContain('resolveReviewThread');
    });

    it('refuses a resolve plan whose preflight cannot see thread state, before any mutation', async () => {
        const plan = replyPlan([
            replyTarget({ id: 'T_a', kind: 'general', reply: 'hi' }),
            replyTarget({ id: 'T_a', kind: 'resolve', resolve: true }),
        ]);
        const { stdout, args } = await runScript('review-reply.cjs', {
            ...base,
            REPLY_PLAN: plan,
            GH_HTTP_STATUS: '401',
        });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            ok: false,
            error: expect.stringContaining('HTTP 401'),
        });
        expect(args).toHaveLength(1);
        expect(args[0]!.join(' ')).toContain('reviewThreads');
    });

    it('treats a deleted comment as an idempotent no-op, not a failure', async () => {
        const plan = replyPlan([replyTarget({ id: '112', kind: 'inline', reply: 'fixed' })]);
        const { stdout } = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: plan, GH_HTTP_STATUS: '404' });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            results: [{ id: '112', kind: 'inline', status: 'noop', reason: 'not_found' }],
        });
    });

    it('keeps auth, permission and rate failures actionable refusals', async () => {
        for (const [status, reason] of [
            ['401', 'auth'],
            ['403', 'permission'],
            ['429', 'rate'],
        ] as const) {
            const plan = replyPlan([replyTarget({ id: '401', kind: 'general', reply: 'hi' })]);
            const { stdout } = await runScript('review-reply.cjs', {
                ...base,
                REPLY_PLAN: plan,
                GH_HTTP_STATUS: status,
            });
            expect(JSON.parse(stdout.trim()), `HTTP ${status}`).toMatchObject({
                results: [{ id: '401', kind: 'general', status: 'refused', reason }],
            });
        }
    });

    it('passes a plan-refused target through without executing it', async () => {
        const plan = replyPlan([
            replyTarget({ id: '999', kind: 'general', reply: 'hi', status: 'refused', reason: 'unknown_target' }),
        ]);
        const { stdout, args } = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: plan });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            results: [{ id: '999', kind: 'general', status: 'refused', reason: 'unknown_target' }],
        });
        expect(args).toEqual([]);
    });

    it('lets a partial retry re-attempt only the refused targets', async () => {
        const both = replyPlan([
            replyTarget({ id: '401', kind: 'general', reply: 'added a test' }),
            replyTarget({ id: '112', kind: 'inline', reply: 'fixed' }),
        ]);
        const first = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: both, GH_HTTP_STATUS: '401' });
        expect(JSON.parse(first.stdout.trim())).toMatchObject({
            results: [
                { id: '401', kind: 'general', status: 'refused', reason: 'auth' },
                { id: '112', kind: 'inline', status: 'refused', reason: 'auth' },
            ],
        });
        const retry = replyPlan([replyTarget({ id: '112', kind: 'inline', reply: 'fixed' })]);
        const second = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: retry });
        expect(JSON.parse(second.stdout.trim())).toMatchObject({
            results: [{ id: '112', kind: 'inline', status: 'done', reason: null }],
        });
        const calls = second.args.map((a) => a.join(' '));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('pulls/7/comments/112/replies');
    });

    it('refuses a malformed plan in one terminal verdict', async () => {
        const cases: Array<[string, Record<string, string>, string]> = [
            ['not JSON', { REPLY_PLAN: 'nope' }, 'not JSON'],
            [
                'wrong schema',
                { REPLY_PLAN: JSON.stringify({ version: 1, schema: 'other/v1', targets: [] }) },
                'expected review-reply/plan/v1',
            ],
            [
                'ref mismatch',
                {
                    REPLY_PLAN: JSON.stringify({
                        version: 1,
                        schema: 'review-reply/plan/v1',
                        ref: { owner: 'x', repo: 'y', number: 1 },
                        targets: [],
                    }),
                },
                'does not match REPO/PR',
            ],
            [
                'no targets',
                { REPLY_PLAN: JSON.stringify({ version: 1, schema: 'review-reply/plan/v1', ref: collectRef }) },
                'no targets',
            ],
            [
                'missing reply body',
                { REPLY_PLAN: replyPlan([replyTarget({ id: '401', kind: 'general' })]) },
                'no reply body',
            ],
        ];
        for (const [name, env, fragment] of cases) {
            const { stdout, args } = await runScript('review-reply.cjs', { ...base, ...env });
            expect(JSON.parse(stdout.trim()), name).toMatchObject({
                ok: false,
                error: expect.stringContaining(fragment),
            });
            expect(args, name).toEqual([]);
        }
    });

    it('refuses an oversized plan', async () => {
        const many = Array.from({ length: 33 }, (_, i) => replyTarget({ id: String(i), kind: 'general', reply: 'x' }));
        const { stdout } = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: replyPlan(many) });
        expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false, error: expect.stringContaining('oversized') });
    });

    it('refuses a missing credential before spawning gh', async () => {
        const plan = replyPlan([replyTarget({ id: '401', kind: 'general', reply: 'hi' })]);
        const { stdout, args } = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: plan }, { token: false });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            ok: false,
            error: expect.stringContaining('missing credential'),
        });
        expect(args).toEqual([]);
    });

    it('never lets the token reach argv, stdout or stderr', async () => {
        const plan = replyPlan([
            replyTarget({ id: 'T_a', kind: 'thread', reply: 'closed the null path', firstCommentId: 111 }),
            replyTarget({ id: 'T_a', kind: 'resolve', resolve: true }),
        ]);
        const { stdout, stderr, args } = await runScript('review-reply.cjs', { ...base, REPLY_PLAN: plan });
        const everything = [stdout, stderr, ...args.flat()].join('\n');
        expect(everything).not.toContain(TEST_TOKEN);
    });
});

describe('the review reference and truncation primitives', () => {
    it('validates an owner/name/pr reference', () => {
        expect(validateReviewRef('octo/factory', '7')).toEqual({ owner: 'octo', repo: 'factory', number: 7 });
        expect(validateReviewRef('octo/factory', '0123')).toEqual({ owner: 'octo', repo: 'factory', number: 123 });
        expect(validateReviewRef('octo/factory', '')).toBeNull();
        expect(validateReviewRef('octo/factory', '7.5')).toBeNull();
        expect(validateReviewRef('octo/factory', '1234567890')).toBeNull();
        expect(validateReviewRef('octo', '7')).toBeNull();
        expect(validateReviewRef('octo/', '7')).toBeNull();
        expect(validateReviewRef('/factory', '7')).toBeNull();
        expect(validateReviewRef('octo/factory', '-1')).toBeNull();
    });

    it('truncates at a code-point boundary with the visible marker', () => {
        const short = truncateText('short', 10);
        expect(short).toEqual({ text: 'short', truncated: false });
        const long = truncateText('abcdefghij', 5);
        expect(long.text).toBe(`abcde${TRUNCATED_MARKER}`);
        expect(long.truncated).toBe(true);
        const emoji = truncateText('👨‍👩‍👧‍👦 tail', 1);
        expect(emoji.text).toBe(`👨${TRUNCATED_MARKER}`);
    });
});

describe('the review collection parser', () => {
    it('maps a full verdict onto the normalized shape', () => {
        const state = parseReviewCollection(JSON.stringify(collection()));
        expect(state).toEqual(collection());
        expect(state.error).toBeNull();
        expect(state.ref).toEqual(ref);
        expect(state.requestedReviewers).toEqual({ users: ['reviewer-a'], teams: ['qa-team'] });
        expect(state.decision).toBe('CHANGES_REQUESTED');
    });

    it('surfaces a script refusal as an error, keeping empty lists', () => {
        const state = parseReviewCollection(
            JSON.stringify({ ok: false, version: 1, schema: 'review-collect/v1', error: 'gh failed' })
        );
        expect(state.error).toBe('gh failed');
        expect(state.general).toEqual([]);
    });

    it('defaults on an unreadable or unsupported verdict', () => {
        expect(parseReviewCollection('not json').error).toBe('unreadable collection verdict');
        expect(parseReviewCollection(JSON.stringify({ version: 1, schema: 'something-else/v9' })).error).toBe(
            'unsupported collection schema'
        );
    });

    it('tolerates malformed items without throwing', () => {
        const state = parseReviewCollection(
            JSON.stringify({
                version: 1,
                schema: 'review-collect/v1',
                ref: { owner: 'octo', repo: 'factory', number: 7 },
                general: [null, { id: 'nope', body: 9 }],
            })
        );
        expect(state.general).toHaveLength(2);
        expect(state.general[0]!.id).toBe(0);
        expect(state.general[1]!.body).toBe('');
        expect(state.threads).toEqual([]);
    });

    it('keeps the last stdout line only, like every script verdict', () => {
        const state = parseReviewCollection(`noise\n${JSON.stringify(collection())}\n`);
        expect(state.error).toBeNull();
        expect(state.general[0]!.id).toBe(401);
    });
});

describe('the review reply results parser', () => {
    it('maps a per-target verdict onto the result shape', () => {
        const results: ReviewReplyResults = {
            version: 1,
            schema: 'review-reply/v1',
            ref,
            results: [
                { id: '401', kind: 'general', status: 'done', reason: null },
                { id: 'T_a', kind: 'resolve', status: 'noop', reason: 'already_resolved' },
                { id: '112', kind: 'inline', status: 'refused', reason: 'rate' },
            ],
            error: null,
        };
        expect(parseReviewReplyResults(JSON.stringify(results))).toEqual(results);
    });

    it('surfaces a terminal refusal as an error', () => {
        const parsed = parseReviewReplyResults(
            JSON.stringify({ version: 1, schema: 'review-reply/v1', ref, error: 'malformed plan' })
        );
        expect(parsed.error).toBe('malformed plan');
        expect(parsed.results).toEqual([]);
    });

    it('defaults on unreadable verdicts', () => {
        expect(parseReviewReplyResults('').error).toBe('unreadable reply verdict');
        expect(parseReviewReplyResults(JSON.stringify({ version: 2, schema: 'review-reply/v2' })).error).toBe(
            'unsupported reply schema'
        );
    });
});

describe('the review reply planner', () => {
    it('plans a general and an inline reply', () => {
        const state = collection();
        const plan = buildReviewReply(state, [request({ id: '401', kind: 'general', reply: 'added a test' })]);
        expect(plan.ref).toEqual(ref);
        expect(plan.schema).toBe('review-reply/plan/v1');
        expect(plan.targets).toEqual([
            planned({ id: '401', kind: 'general', reply: 'added a test', status: 'planned' }),
        ]);
        const inline = buildReviewReply(state, [request({ id: '111', kind: 'inline', reply: 'fixed' })]);
        expect(inline.targets).toEqual([planned({ id: '111', kind: 'inline', reply: 'fixed' })]);
    });

    it('refuses a target the collected state does not hold', () => {
        const plan = buildReviewReply(collection(), [request({ id: '999', kind: 'general', reply: 'hi' })]);
        expect(plan.targets).toEqual([
            planned({ id: '999', kind: 'general', status: 'refused', reason: 'unknown_target' }),
        ]);
        const thread = buildReviewReply(collection(), [request({ id: 'T_ghost', kind: 'thread', resolve: true })]);
        expect(thread.targets).toEqual([
            planned({ id: 'T_ghost', kind: 'thread', status: 'refused', reason: 'unknown_target' }),
        ]);
    });

    it('refuses an empty or missing reply body', () => {
        const plan = buildReviewReply(collection(), [request({ id: '401', kind: 'general', reply: '   ' })]);
        expect(plan.targets[0]!.reason).toBe('no_reply_target');
    });

    it('truncates a reply body to the shared cap, visibly', () => {
        const plan = buildReviewReply(collection(), [
            request({ id: '401', kind: 'general', reply: 'x'.repeat(REPLY_BODY_MAX + 50) }),
        ]);
        expect(plan.targets[0]!.reply).toBe(`${'x'.repeat(REPLY_BODY_MAX)}${TRUNCATED_MARKER}`);
    });

    it('splits a thread intent into a reply and a resolve target', () => {
        const plan = buildReviewReply(collection(), [
            request({ id: 'T_a', kind: 'thread', reply: 'closed the null path', resolve: true }),
        ]);
        expect(plan.targets).toEqual([
            planned({
                id: 'T_a',
                kind: 'thread',
                reply: 'closed the null path',
                firstCommentId: 111,
                status: 'planned',
            }),
            planned({ id: 'T_a', kind: 'resolve', resolve: true, status: 'planned' }),
        ]);
    });

    it('refuses to plan a resolve for an already-resolved thread', () => {
        const plan = buildReviewReply(collection(), [request({ id: 'T_b', kind: 'thread', resolve: true })]);
        expect(plan.targets).toEqual([
            planned({ id: 'T_b', kind: 'resolve', resolve: true, status: 'refused', reason: 'already_resolved' }),
        ]);
    });

    it('refuses a thread intent with neither a reply nor a resolve', () => {
        const plan = buildReviewReply(collection(), [request({ id: 'T_a', kind: 'thread' })]);
        expect(plan.targets).toEqual([planned({ id: 'T_a', kind: 'thread', status: 'refused', reason: 'no_action' })]);
    });

    it('refuses a thread reply when the thread has no comment to anchor to', () => {
        const noComments = collection({
            threads: [{ id: 'T_empty', isResolved: false, isOutdated: false, path: null, line: null, comments: [] }],
        });
        const plan = buildReviewReply(noComments, [request({ id: 'T_empty', kind: 'thread', reply: 'hi' })]);
        expect(plan.targets).toEqual([
            planned({ id: 'T_empty', kind: 'thread', status: 'refused', reason: 'no_reply_target' }),
        ]);
    });

    it('refuses a target with no matching id in the collected state', () => {
        const plan = buildReviewReply(collection(), [{ id: '', kind: 'general', reply: 'hi' } as ReviewReplyRequest]);
        expect(plan.targets).toEqual([
            planned({ id: '', kind: 'general', status: 'refused', reason: 'unknown_target' }),
        ]);
    });

    it('dedupes repeated intents, keeping the first', () => {
        const plan = buildReviewReply(collection(), [
            request({ id: '401', kind: 'general', reply: 'first' }),
            request({ id: '401', kind: 'general', reply: 'second' }),
        ]);
        expect(plan.targets).toEqual([planned({ id: '401', kind: 'general', reply: 'first' })]);
    });
});
