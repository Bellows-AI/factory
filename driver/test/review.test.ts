import { describe, expect, it } from 'vitest';
import {
    REPLY_BODY_MAX,
    TRUNCATED_MARKER,
    buildReviewReply,
    parseReviewCollection,
    parseReviewReplyResults,
    truncateText,
    validateReviewRef,
    type ReviewReplyRequest,
    type ReviewReplyResults,
} from '../src/review.js';
import { collection, planned, ref, request } from './fixtures/review-fixtures.js';

/**
 * The pure review-planning functions: reference validation, text truncation, the two verdict
 * parsers, and the reply planner. The scripts that PRODUCE and CONSUME these shapes for real —
 * against a stub `gh` — are exercised in `review-scripts.test.ts` (split out for the line-count
 * cap); both suites share their fixture data via `./fixtures/review-fixtures.js`.
 */
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
        const HALF_LENGTH = 5;
        const long = truncateText('abcdefghij', HALF_LENGTH);
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
        // The first general comment's id, per the `collection()` fixture.
        const FIRST_GENERAL_COMMENT_ID = 401;
        expect(state.general[0]!.id).toBe(FIRST_GENERAL_COMMENT_ID);
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
        const OVER_CAP_MARGIN = 50;
        const plan = buildReviewReply(collection(), [
            request({ id: '401', kind: 'general', reply: 'x'.repeat(REPLY_BODY_MAX + OVER_CAP_MARGIN) }),
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
