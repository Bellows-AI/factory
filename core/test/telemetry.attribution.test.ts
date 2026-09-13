import { describe, expect, it } from 'vitest';
import { attribute } from '../src/telemetry.js';
import type { PrTelemetryRow, TokenTotals } from '../src/types.js';
import { FIXTURE_NOW, FIXTURE_REPO, joinKeys, sampleTelemetry } from './fixtures/load.js';

const input = sampleTelemetry();
const prs = joinKeys();
const stats = attribute(prs, input, { repos: [FIXTURE_REPO], now: FIXTURE_NOW });

const row = (number: number): PrTelemetryRow => {
    const found = stats.prs.find((r) => r.number === number);
    if (!found) throw new Error(`no row for PR #${number}`);
    return found;
};

const inScope = input.sessions.filter((s) => s.repo === FIXTURE_REPO);
const billable = (t: TokenTotals) => (t.input ?? 0) + (t.output ?? 0);

describe('repo scoping', () => {
    it('separates the three session groups instead of conflating them', () => {
        // The two likeliest setup failures look identical on the page unless these are distinct.
        expect(stats.totals.sessions).toBe(inScope.length);
        expect(stats.otherRepoSessions).toBe(1);
        expect(stats.sessionsWithoutHook).toBe(1);
    });

    it('excludes another repo from the totals entirely', () => {
        // s09-other-repo is the largest session in the fixture, so a broken filter inflates this.
        expect(stats.totals.tokens.input).toBe(
            inScope.reduce((sum, s) => sum + (s.tokens.input ?? 0), 0),
        );
        expect(stats.prs.every((r) => r.branch !== 'feat/other-thing')).toBe(true);
    });
});

describe('conservation', () => {
    it('divides a divisible session without creating or losing tokens', () => {
        for (const session of inScope) {
            const parts = input.splits.filter((s) => s.sessionId === session.sessionId);
            if (!parts.length || parts.some((p) => p.share === null)) continue;
            const summed = parts.reduce((sum, p) => sum + (p.tokens.input ?? 0), 0);
            expect(summed).toBe(session.tokens.input ?? 0);
        }
    });

    it('accounts for every attributable token as matched or unmatched, never dropped', () => {
        // A linked session is accounted for by PR number, not by branch, so its split is
        // excluded from the branch partition — double-counting it here is exactly the bug
        // this assertion exists to catch.
        // Only a link to a PR the fetch actually saw removes a session from the branch
        // partition. A link to PR #99999 falls back to branch, so it must stay counted here.
        const known = new Set(prs.map((pr) => pr.number));
        const linked = new Set(
            input.links
                .filter(
                    (l) =>
                        inScope.some((x) => x.sessionId === l.sessionId) && known.has(l.prNumber),
                )
                .map((l) => l.sessionId),
        );
        const attributable = input.splits
            .filter(
                (s) =>
                    inScope.some((x) => x.sessionId === s.sessionId) &&
                    s.share !== null &&
                    !linked.has(s.sessionId),
            )
            .reduce((sum, s) => sum + (s.tokens.input ?? 0), 0);
        const matched = stats.prs
            .filter((r) => r.attribution === 'exact')
            .reduce((sum, r) => sum + (r.tokens.input ?? 0), 0);
        expect(matched + (stats.unmatched.tokens.input ?? 0)).toBe(attributable);
    });

    it('loses nothing when a PR is both linked and branch-matched', () => {
        // The leak this guards: if the linked tier simply won, a PR named by one session and
        // branch-matched by another would report only the first and drop the second — counted
        // in no row and in no unmatched bucket. Every attributable session must land somewhere.
        const known = new Set(prs.map((pr) => pr.number));
        const placeable = input.sessions.filter(
            (s) =>
                s.repo === FIXTURE_REPO &&
                (input.links.some((l) => l.sessionId === s.sessionId && known.has(l.prNumber)) ||
                    input.splits.some((sp) => sp.sessionId === s.sessionId && sp.share !== null)),
        );
        const accountedFor = new Set<string>();
        for (const r of stats.prs) {
            if (r.attribution === 'none') continue;
            for (const s of placeable) {
                if (
                    input.links.some((l) => l.sessionId === s.sessionId && l.prNumber === r.number) ||
                    input.splits.some((sp) => sp.sessionId === s.sessionId && sp.branch === r.branch)
                ) {
                    accountedFor.add(s.sessionId);
                }
            }
        }
        for (const s of placeable) {
            const orphaned = stats.unmatched.branches.length > 0 && !accountedFor.has(s.sessionId);
            expect(accountedFor.has(s.sessionId) || orphaned).toBe(true);
        }
    });

    it('derives totals from sessions, not from the PR rows', () => {
        // These two legitimately disagree: shared sessions contribute to totals and to no row.
        // Pinning which is authoritative is what stops a "make these agree" refactor.
        const fromRows = stats.prs.reduce((sum, r) => sum + (r.tokens.input ?? 0), 0);
        expect(stats.totals.tokens.input).toBe(
            inScope.reduce((sum, s) => sum + (s.tokens.input ?? 0), 0),
        );
        expect(fromRows).toBeLessThan(stats.totals.tokens.input as number);
    });
});

describe('attribution', () => {
    it('attributes a single-branch session exactly', () => {
        const r = row(204);
        expect(r.attribution).toBe('exact');
        expect(r.sessions).toBe(1);
        expect(r.tokens.input).toBe(74000);
        expect(r.linesAdded).toBe(380);
    });

    it('aggregates two sessions on one branch', () => {
        const r = row(183);
        expect(r.attribution).toBe('exact');
        expect(r.sessions).toBe(2);
        expect(r.tokens.input).toBe(51000 + 33000);
        expect(r.linesAdded).toBe(240 + 300);
    });

    it('splits a divisible multi-branch session across both PRs', () => {
        expect(row(10).attribution).toBe('exact');
        expect(row(11).attribution).toBe('exact');
        expect(row(10).tokens.input).toBe(36000);
        expect(row(11).tokens.input).toBe(24000);
    });

    it('attributes a cumulative session that held only one branch', () => {
        // Cumulative temporality alone does not make a session indivisible; two branches do.
        expect(row(145).attribution).toBe('exact');
        expect(row(145).tokens.input).toBe(18000);
    });

    it('matches a still-open PR, which is still accepting work', () => {
        expect(row(143).attribution).toBe('exact');
        expect(row(143).tokens.input).toBe(41000);
    });
});

describe('a transcript pr-link outranks the branch join', () => {
    it('attributes the whole session to the PR the transcript names', () => {
        const r = row(128);
        expect(r.attribution).toBe('linked');
        expect(r.sessions).toBe(1);
        expect(r.tokens.input).toBe(37000);
        expect(r.linesAdded).toBe(140);
        expect(stats.linkedSessions).toBe(1);
    });

    it('does not also count the linked session through its branch', () => {
        // s14 sits on 'LEEL-10995-e2e-stack-improvements', which PR #128 owns anyway — but the
        // link is what attributed it, so the branch split must not add a second helping.
        const viaBranch = stats.prs.filter(
            (r) => r.branch === 'LEEL-10995-e2e-stack-improvements' && r.attribution === 'exact',
        );
        expect(viaBranch).toEqual([]);
        expect(stats.unmatched.branches.map((b) => b.branch)).not.toContain('LEEL-10995-e2e-stack-improvements');
    });

    it('marks both PRs shared when one session opened two of them', () => {
        for (const number of [117, 102]) {
            expect(row(number).attribution).toBe('shared');
            expect(row(number).tokens.input).toBeNull();
        }
    });

    it('falls back to the branch join when the linked PR is outside the window', () => {
        // s01 links PR #99999, which the fetch never saw. The session must still be attributed
        // by branch rather than disappearing.
        expect(stats.prs.every((r) => r.number !== 99999)).toBe(true);
        expect(row(204).attribution).toBe('exact');
        expect(row(204).tokens.input).toBe(74000);
    });
});

describe('a head branch is not a unique key', () => {
    // Nine branches in the sample payload are reused across separate merged PRs. Matching on
    // branch alone would credit the same work to every PR that ever used the branch.
    it('routes work to the PR that was still open when it happened', () => {
        expect(row(7).attribution).toBe('shared');
        expect(row(37).attribution).toBe('exact');
        expect(row(37).tokens.input).toBe(29000);
    });

    it('does not back-date work onto a PR that had already merged', () => {
        // s12-after-merge worked on hotfix-0.79.3 six weeks after #5 merged.
        expect(stats.unmatched.branches).toContainEqual({ repo: FIXTURE_REPO, branch: 'hotfix-0.79.3' });
        expect(row(5).tokens.input).toBeNull();
    });
});

describe('the null-not-zero contract', () => {
    it('reports an unmatched PR as null on every quantity, and still lists it', () => {
        // 0 tokens would assert the PR was written without AI. That is not what was measured.
        const untouched = stats.prs.filter((r) => r.attribution === 'none');
        expect(untouched.length).toBeGreaterThan(150);
        for (const r of untouched.slice(0, 20)) {
            expect(r.tokens.input).toBeNull();
            expect(r.tokens.output).toBeNull();
            expect(r.linesAdded).toBeNull();
            expect(r.acceptRatio).toBeNull();
            expect(r.activeHours).toBeNull();
            expect(r.tokensPerLoc).toBeNull();
            expect(r.sessions).toBe(0);
        }
    });

    it('nulls an indivisible session rather than reporting the divisible part', () => {
        for (const number of [5, 7]) {
            expect(row(number).attribution).toBe('shared');
            expect(row(number).tokens.input).toBeNull();
            expect(row(number).linesAdded).toBeNull();
            // The session count survives: the work happened, it just cannot be sized.
            expect(row(number).sessions).toBe(1);
        }
        // s05 held two branches; s15 opened two PRs. Both are indivisible for the same reason.
        expect(stats.sharedSessions).toBe(2);
    });

    it('exposes no monetary field anywhere', () => {
        // Cost is deliberately out of scope. This stops it returning via a "small addition".
        const keys: string[] = [];
        const walk = (value: unknown) => {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) {
                    keys.push(k.toLowerCase());
                    walk(v);
                }
            }
        };
        walk(stats);
        for (const forbidden of ['cost', 'usd', 'price', 'costusd', 'dollars']) {
            expect(keys).not.toContain(forbidden);
        }
    });
});

describe('work that reaches no PR', () => {
    it('reports it rather than dropping or folding it into the totals', () => {
        expect(stats.unmatched.branches).toEqual([
            { repo: FIXTURE_REPO, branch: 'chore/scratch-notes' },
            { repo: FIXTURE_REPO, branch: 'hotfix-0.79.3' },
        ]);
        expect(stats.unmatched.sessions).toBe(3); // no-pr, detached, after-merge
        expect(stats.unmatched.tokens.input).toBe(12000 + 7000 + 9000);
    });

    it('never matches a detached HEAD to a PR', () => {
        expect(stats.unmatched.branches.map((b) => b.branch)).not.toContain(null);
        expect(stats.prs.every((r) => r.branch !== null)).toBe(true);
    });

    it('counts PRs with no telemetry at all', () => {
        const noneRows = stats.prs.filter((r) => r.attribution === 'none').length;
        expect(stats.prsWithoutTelemetry).toBe(noneRows);
        // Nine reached by branch (#204 #183 #10 #11 #5 #7 #37 #145 #143), one by pr-link
        // (#128), and two left shared by an ambiguous link (#117 #102).
        expect(stats.prsWithoutTelemetry).toBe(prs.length - 12);
    });
});

describe('output invariants', () => {
    it('seeds every week in the window rather than closing the gaps', () => {
        const gaps = stats.weekly
            .map((w) => new Date(w.start).getTime())
            .map((t, i, all) => (i === 0 ? 7 : (t - (all[i - 1] as number)) / 86_400_000));
        expect(gaps.every((g) => g === 7)).toBe(true);
        expect(stats.weekly.reduce((s, w) => s + w.sessions, 0)).toBe(inScope.length);
    });

    it('flags only the current week as partial', () => {
        expect(stats.weekly.filter((w) => w.partial)).toHaveLength(1);
        expect(stats.weekly[stats.weekly.length - 1]?.partial).toBe(true);
    });

    it('keeps every ratio null or within [0,1]', () => {
        const ratios = [
            stats.totals.acceptRatio,
            ...stats.prs.map((r) => r.acceptRatio),
        ];
        for (const r of ratios) {
            if (r === null) continue;
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThanOrEqual(1);
        }
    });

    it('contains no NaN anywhere', () => {
        // A 0/0 in tokensPerLoc is exactly how a NaN reaches the page.
        const bad: string[] = [];
        const walk = (value: unknown, path: string) => {
            if (typeof value === 'number' && Number.isNaN(value)) bad.push(path);
            else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
            else if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
            }
        };
        walk(stats, 'telemetry');
        expect(bad).toEqual([]);
    });

    it('never sums the four token types into one figure', () => {
        // A long cached conversation would count the same context repeatedly.
        const r = row(204);
        expect(billable(r.tokens)).toBe(74000 + 12000);
        expect(r.tokens.cacheRead).toBe(410000);
        expect(Object.keys(r.tokens).sort()).toEqual([
            'cacheCreation', 'cacheRead', 'input', 'output',
        ]);
    });
});

describe('degradation', () => {
    it('reports an empty store as zero sessions with null tokens, not zeros', () => {
        const empty = attribute(prs, { sessions: [], spans: [], splits: [], links: [], coverage: { from: null, to: null } }, { repos: [FIXTURE_REPO], now: FIXTURE_NOW });
        expect(empty.totals.sessions).toBe(0);
        expect(empty.totals.tokens.input).toBeNull();
        expect(empty.totals.acceptRatio).toBeNull();
        expect(empty.weekly).toEqual([]);
        // The rows still render, so the page shows structure rather than vanishing.
        expect(empty.prs).toHaveLength(prs.length);
        expect(empty.prsWithoutTelemetry).toBe(prs.length);
    });

    it('counts everything when no repo filter is given', () => {
        const all = attribute(prs, input, { now: FIXTURE_NOW });
        expect(all.otherRepoSessions).toBe(0);
        expect(all.sessionsWithoutHook).toBe(1);
        expect(all.totals.sessions).toBe(input.sessions.length - 1);
    });
});

/**
 * The reason `repo` is threaded through DerivedPr at all. Every map in attribute() used to be
 * keyed by PR number or by branch name, and neither is unique once a second repo is in scope —
 * so a combined view would have reported one repo's tokens on the other repo's PR, with an
 * 'exact' label on it.
 */
describe('a branch is not unique across repos', () => {
    const A = 'acme/alpha';
    const B = 'acme/beta';
    const key = (repo: string) => ({
        repo,
        number: 7,
        author: 'dev',
        headRefName: 'feature/shared-name',
        createdAt: '2026-07-01T00:00:00Z',
        mergedAt: '2026-07-10T00:00:00Z',
        size: 100,
        cycleHours: 24,
        commitsAfterHumanReview: 0,
    });

    const tokensFor = (input: number) => ({
        input,
        output: 0,
        cacheRead: null,
        cacheCreation: null,
    });

    const span = (sessionId: string, repo: string) => ({
        sessionId,
        repo,
        branch: 'feature/shared-name',
        headSha: null,
        from: '2026-07-05T00:00:00Z',
        to: '2026-07-05T01:00:00Z',
        samples: 3,
    });

    const session = (sessionId: string, repo: string, input: number) => ({
        sessionId,
        agent: 'claude-code',
        repo,
        firstSeen: '2026-07-05T00:00:00Z',
        lastSeen: '2026-07-05T01:00:00Z',
        tokens: tokensFor(input),
        linesAdded: 10,
        linesRemoved: 0,
        editsAccepted: 1,
        editsRejected: 0,
        activeSeconds: 60,
        commits: 0,
        pullRequests: 0,
        granularity: 'window' as const,
    });

    const split = (sessionId: string, repo: string, input: number) => ({
        sessionId,
        repo,
        branch: 'feature/shared-name',
        from: '2026-07-05T00:00:00Z',
        to: '2026-07-05T01:00:00Z',
        share: 1,
        tokens: tokensFor(input),
        linesAdded: 10,
        linesRemoved: 0,
        editsAccepted: 1,
        editsRejected: 0,
        activeSeconds: 60,
    });

    // Both repos have a PR #7 on a branch of the same name, worked in the same hour.
    const crossRepo = attribute(
        [key(A), key(B)],
        {
            sessions: [session('s-a', A, 1000), session('s-b', B, 2000)],
            spans: [span('s-a', A), span('s-b', B)],
            splits: [split('s-a', A, 1000), split('s-b', B, 2000)],
            links: [],
            coverage: { from: '2026-07-01T00:00:00Z', to: '2026-07-31T00:00:00Z' },
        },
        { repos: [A, B], now: new Date('2026-07-31T00:00:00Z') },
    );

    const rowFor = (repo: string) => {
        const found = crossRepo.prs.find((r) => r.repo === repo);
        if (!found) throw new Error(`no row for ${repo}`);
        return found;
    };

    it('keeps each repo\u2019s work on its own PR', () => {
        expect(crossRepo.prs).toHaveLength(2);
        expect(rowFor(A).tokens.input).toBe(1000);
        expect(rowFor(B).tokens.input).toBe(2000);
    });

    it('does not report the collision as shared or unmatched', () => {
        // Keying by branch alone made both sessions candidates for both PRs. That reads as
        // 'shared' at best and as a doubled 'exact' at worst — never as two clean rows.
        expect(rowFor(A).attribution).toBe('exact');
        expect(rowFor(B).attribution).toBe('exact');
        expect(rowFor(A).sessions).toBe(1);
        expect(rowFor(B).sessions).toBe(1);
        expect(crossRepo.unmatched.sessions).toBe(0);
        expect(crossRepo.prsWithoutTelemetry).toBe(0);
    });

    it('conserves the total across the two rows', () => {
        expect(crossRepo.totals.tokens.input).toBe(3000);
        expect(billable(rowFor(A).tokens) + billable(rowFor(B).tokens)).toBe(3000);
    });

    it('separates identically named unmatched branches by repo', () => {
        const orphaned = attribute(
            [],
            {
                sessions: [session('s-a', A, 1000), session('s-b', B, 2000)],
                spans: [span('s-a', A), span('s-b', B)],
                splits: [split('s-a', A, 1000), split('s-b', B, 2000)],
                links: [],
                coverage: { from: '2026-07-01T00:00:00Z', to: '2026-07-31T00:00:00Z' },
            },
            { repos: [A, B], now: new Date('2026-07-31T00:00:00Z') },
        );
        // One entry per repo. Collapsing them to a single "feature/shared-name" would understate
        // how much work reached no PR.
        expect(orphaned.unmatched.branches).toEqual([
            { repo: A, branch: 'feature/shared-name' },
            { repo: B, branch: 'feature/shared-name' },
        ]);
    });
});
