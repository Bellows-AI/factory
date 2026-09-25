import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HELPER_REGISTRY, parseHelperOutput } from '../src/helpers.js';
import { REVIEW_COLLECT_PROBE_ID, REVIEW_REPLY_PROBE_ID } from '../src/review-helpers.js';
import { cleanupTempDirs, fixture, runSource, writeFixture } from './fixtures/review-script-support.js';

/**
 * End-to-end coverage of the github-review-reconcile block's two composed helper bodies (issue
 * #133) against a stub `gh`, mirroring `review-collect-script.test.ts`'s own convention but
 * driving the ASSEMBLED body (prelude + the unmodified #201 script + postlude), never a single
 * file — the pieces are unit-testable on their own, but only the assembly proves the HELPER_INPUT
 * mapping, the stdout capture/restore, and the final envelope all actually compose end to end.
 */

afterEach(cleanupTempDirs);

const PUBLICATION = { repo: 'octo/factory', prNumber: 7 };

/** Writes a registry descriptor's composed body to a temp file `runSource` can execute. */
function writeComposedBody(id: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'review-helper-'));
    const path = join(dir, `${id}.cjs`);
    writeFileSync(path, HELPER_REGISTRY.get(id)!.scriptBody);
    return path;
}

/** An empty-but-well-shaped gh-responses.json fixture: no feedback, no requested reviewers. */
function emptyFixture(over: { decision?: string | null; users?: string[]; teams?: string[] } = {}): string {
    return writeFixture({
        general: [],
        reviews: [],
        inline: [],
        requested: {
            users: (over.users ?? []).map((login) => ({ login })),
            teams: (over.teams ?? []).map((name) => ({ name })),
        },
        threads: {
            data: {
                repository: {
                    pullRequest: {
                        reviewDecision: over.decision ?? null,
                        reviewThreads: { totalCount: 0, nodes: [] },
                    },
                },
            },
        },
    });
}

describe('the review-collect-probe helper', () => {
    it('registers with the generic helper transport under its own schema', () => {
        const descriptor = HELPER_REGISTRY.get(REVIEW_COLLECT_PROBE_ID);
        expect(descriptor?.schema).toBe('review-collect-probe/v1');
        expect(descriptor?.version).toBe(1);
    });

    it('concludes REVIEW-CLEAN when the PR is approved with nothing outstanding', async () => {
        const path = writeComposedBody(REVIEW_COLLECT_PROBE_ID);
        const gh = emptyFixture({ decision: 'APPROVED' });
        const cwd = mkdtempSync(join(tmpdir(), 'review-cwd-'));
        const run = await runSource(
            path,
            { HELPER_INPUT: JSON.stringify({ publication: PUBLICATION }), GH_FIXTURES: gh },
            { cwd }
        );
        const verdict = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop()!);
        expect(verdict).toEqual({
            schema: 'review-collect-probe/v1',
            version: 1,
            ok: true,
            output: 'REVIEW-CLEAN',
            control: 'conclude',
        });
        const result = parseHelperOutput(HELPER_REGISTRY.get(REVIEW_COLLECT_PROBE_ID)!, run.stdout);
        expect(result).toEqual({ ok: true, output: 'REVIEW-CLEAN', control: 'conclude' });
    });

    it('concludes REVIEW-WAIT when a reviewer is requested but nothing is actionable yet', async () => {
        const path = writeComposedBody(REVIEW_COLLECT_PROBE_ID);
        const gh = emptyFixture({ users: ['reviewer-a'] });
        const cwd = mkdtempSync(join(tmpdir(), 'review-cwd-'));
        const run = await runSource(
            path,
            { HELPER_INPUT: JSON.stringify({ publication: PUBLICATION }), GH_FIXTURES: gh },
            { cwd }
        );
        const verdict = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop()!);
        expect(verdict.output).toBe('REVIEW-WAIT');
        expect(verdict.control).toBe('conclude');
    });

    it('answers REVIEW-ACTIONABLE and writes a digest when unresolved feedback exists', async () => {
        const path = writeComposedBody(REVIEW_COLLECT_PROBE_ID);
        const cwd = mkdtempSync(join(tmpdir(), 'review-cwd-'));
        // The shared gh-responses.json fixture (review-collect-script.test.ts's own data): a
        // CHANGES_REQUESTED review, two general comments, an unresolved thread and a resolved one.
        const run = await runSource(path, { HELPER_INPUT: JSON.stringify({ publication: PUBLICATION }) }, { cwd });
        const verdict = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop()!);
        expect(verdict).toEqual({
            schema: 'review-collect-probe/v1',
            version: 1,
            ok: true,
            output: 'REVIEW-ACTIONABLE',
        });

        const digestPath = join(cwd, '.factory', 'review-reconcile', 'digest.json');
        expect(existsSync(digestPath)).toBe(true);
        const digest = JSON.parse(readFileSync(digestPath, 'utf8'));
        expect(digest.schema).toBe('review-reconcile-digest/v1');
        const keys = digest.items.map((i: { key: string }) => i.key).sort();
        // general:401/402 (unresolved conversation comments), review:23 (CHANGES_REQUESTED with a
        // body), thread:T_a (unresolved) — thread:T_b is resolved and excluded, and inline 111/112
        // are excluded as already covered by thread T_a's own comments (never double-counted).
        expect(keys).toEqual(['general:401', 'general:402', 'review:23', 'thread:T_a']);
    });

    it('never re-surfaces a general/review item once a bot reply carrying its marker exists', async () => {
        // Regression: a general/review item's own body never gets the addressed marker — the
        // reply lands as a brand-new, SEPARATE general comment (review-reply-probe-middle.cjs's
        // generalTarget). The digest must look for the marker across `general`, not on the
        // original comment's own body, or the item would loop as actionable forever.
        const path = writeComposedBody(REVIEW_COLLECT_PROBE_ID);
        const cwd = mkdtempSync(join(tmpdir(), 'review-cwd-'));
        const base = JSON.parse(readFileSync(fixture('gh-responses.json'), 'utf8'));
        const gh = writeFixture({
            ...base,
            general: [
                ...base.general,
                {
                    id: 999,
                    user: { login: 'factory-ai[bot]' },
                    body: 'added a regression test\n\n<!-- factory-review-reconcile addressed general:401 -->\n\naddressed review:23 too\n\n<!-- factory-review-reconcile addressed review:23 -->',
                    created_at: '2026-09-04T00:00:00Z',
                },
            ],
        });
        await runSource(path, { HELPER_INPUT: JSON.stringify({ publication: PUBLICATION }), GH_FIXTURES: gh }, { cwd });
        const digestPath = join(cwd, '.factory', 'review-reconcile', 'digest.json');
        const digest = JSON.parse(readFileSync(digestPath, 'utf8'));
        const keys = digest.items.map((i: { key: string }) => i.key).sort();
        // general:401 and review:23 are now addressed; general:402 and thread:T_a still stand.
        expect(keys).toEqual(['general:402', 'thread:T_a']);
    });

    it('fails (never a marker) on an unreadable collection, so the retry edge can re-attempt it', async () => {
        const path = writeComposedBody(REVIEW_COLLECT_PROBE_ID);
        const cwd = mkdtempSync(join(tmpdir(), 'review-cwd-'));
        const run = await runSource(
            path,
            { HELPER_INPUT: JSON.stringify({ publication: PUBLICATION }) },
            { cwd, token: false }
        );
        const verdict = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop()!);
        expect(verdict.ok).toBe(false);
        const result = parseHelperOutput(HELPER_REGISTRY.get(REVIEW_COLLECT_PROBE_ID)!, run.stdout);
        expect(result.ok).toBe(false);
    });
});

describe('the review-reply-probe helper', () => {
    it('registers with the generic helper transport under its own schema', () => {
        const descriptor = HELPER_REGISTRY.get(REVIEW_REPLY_PROBE_ID);
        expect(descriptor?.schema).toBe('review-reply-probe/v1');
        expect(descriptor?.version).toBe(1);
    });

    it('replies only to digest-presented, still-live targets and concludes REVIEW-REPLIED', async () => {
        const path = writeComposedBody(REVIEW_REPLY_PROBE_ID);
        const cwd = mkdtempSync(join(tmpdir(), 'review-cwd-'));
        const stateDir = join(cwd, '.factory', 'review-reconcile');
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(
            join(stateDir, 'digest.json'),
            JSON.stringify({
                schema: 'review-reconcile-digest/v1',
                version: 1,
                items: [
                    { key: 'general:401', kind: 'general', path: null, body: 'add a test' },
                    { key: 'thread:T_a', kind: 'thread', path: 'src/parse.ts', body: 'null here blows up' },
                ],
            })
        );
        writeFileSync(
            join(stateDir, 'intents.json'),
            JSON.stringify({
                schema: 'review-reconcile-intents/v1',
                items: [
                    { key: 'general:401', reply: 'added a regression test', resolve: false },
                    { key: 'thread:T_a', reply: 'fixed the null path', resolve: true },
                    // Not present in the digest — must never reach the plan.
                    { key: 'general:999', reply: 'should never post', resolve: false },
                ],
            })
        );
        const run = await runSource(path, { HELPER_INPUT: JSON.stringify({ publication: PUBLICATION }) }, { cwd });
        const verdict = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop()!);
        expect(verdict).toEqual({
            schema: 'review-reply-probe/v1',
            version: 1,
            ok: true,
            output: 'REVIEW-REPLIED',
            control: 'conclude',
        });

        // One general comment posted, one inline reply anchored on the thread's first comment
        // (databaseId 111), and one resolve mutation on the thread's real node id — never a
        // fourth call for the stale "general:999" intent the digest never presented.
        const posted = run.args.filter(
            (a) => a.join(' ').includes('issues/7/comments') && a.some((x) => x.startsWith('-f'))
        );
        const replied = run.args.filter((a) => a.join(' ').includes('comments/111/replies'));
        const resolved = run.args.filter(
            (a) => a.join(' ').includes('graphql') && a.some((x) => x.includes('resolveReviewThread'))
        );
        expect(posted.length).toBe(1);
        expect(replied.length).toBe(1);
        expect(resolved.length).toBe(1);
        expect(run.args.some((a) => a.join(' ').includes('999'))).toBe(false);
    });

    it('runs with zero targets when the digest/intents files are absent, and still concludes', async () => {
        const path = writeComposedBody(REVIEW_REPLY_PROBE_ID);
        const cwd = mkdtempSync(join(tmpdir(), 'review-cwd-'));
        const run = await runSource(path, { HELPER_INPUT: JSON.stringify({ publication: PUBLICATION }) }, { cwd });
        const verdict = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop()!);
        expect(verdict).toEqual({
            schema: 'review-reply-probe/v1',
            version: 1,
            ok: true,
            output: 'REVIEW-REPLIED',
            control: 'conclude',
        });
    });

    it('fails the helper (never concludes) when the underlying collect fetch fails', async () => {
        // GH_HTTP_STATUS fails every gh call, including the fresh re-fetch this node always runs
        // first — proving a reply-step failure propagates as ok:false, never a marker, so the
        // block's own reply->reply retry edge (server/src/db/workflow-blocks/
        // github-review-reconcile.ts) is what re-attempts it.
        const path = writeComposedBody(REVIEW_REPLY_PROBE_ID);
        const cwd = mkdtempSync(join(tmpdir(), 'review-cwd-'));
        const run = await runSource(
            path,
            { HELPER_INPUT: JSON.stringify({ publication: PUBLICATION }), GH_HTTP_STATUS: '403' },
            { cwd }
        );
        const verdict = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop()!);
        expect(verdict.ok).toBe(false);
    });
});
