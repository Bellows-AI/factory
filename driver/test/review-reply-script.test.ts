import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewPlan } from '../src/review.js';
import { collectRef } from './fixtures/review-fixtures.js';
import { cleanupTempDirs, runScript, TEST_TOKEN } from './fixtures/review-script-support.js';

afterEach(cleanupTempDirs);

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

const HTTP_UNAUTHORIZED = '401';

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
        const EXPECTED_THREAD_RESOLVE_CALLS = 3;
        expect(args).toHaveLength(EXPECTED_THREAD_RESOLVE_CALLS);
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
});

describe('the review reply script: preflight failures and idempotence', () => {
    const base = { REPO: 'octo/factory', PR: '7' };

    it('refuses a resolve plan whose preflight cannot see thread state, before any mutation', async () => {
        const plan = replyPlan([
            replyTarget({ id: 'T_a', kind: 'general', reply: 'hi' }),
            replyTarget({ id: 'T_a', kind: 'resolve', resolve: true }),
        ]);
        const { stdout, args } = await runScript('review-reply.cjs', {
            ...base,
            REPLY_PLAN: plan,
            GH_HTTP_STATUS: HTTP_UNAUTHORIZED,
        });
        expect(JSON.parse(stdout.trim())).toMatchObject({
            ok: false,
            error: expect.stringContaining(`HTTP ${HTTP_UNAUTHORIZED}`),
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
            [HTTP_UNAUTHORIZED, 'auth'],
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
        const first = await runScript('review-reply.cjs', {
            ...base,
            REPLY_PLAN: both,
            GH_HTTP_STATUS: HTTP_UNAUTHORIZED,
        });
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
});

describe('the review reply script: malformed plans and credentials', () => {
    const base = { REPO: 'octo/factory', PR: '7' };

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
        const OVERSIZED_TARGET_COUNT = 33;
        const many = Array.from({ length: OVERSIZED_TARGET_COUNT }, (_, i) =>
            replyTarget({ id: String(i), kind: 'general', reply: 'x' })
        );
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
