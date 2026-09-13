import type { CanonicalActor, CanonicalPr, ProviderCapabilities } from './canonical.js';
import { AI_LABELS, ALL_CAPABILITIES, DEFAULT_BOTS, HOUR, SIZE_BUCKETS } from './config.js';
import type {
    AuthorRow,
    BranchHistory,
    DerivedPr,
    ReviewerRow,
    Stats,
    ThreadStats,
    TruncatedPr,
    WeekPoint,
} from './types.js';

const login = (actor: CanonicalActor | null | undefined): string => actor?.login ?? 'ghost';

export const defaultBots = (): Set<string> => new Set(DEFAULT_BOTS);

export function median(values: (number | null)[]): number | null {
    return percentile(values, 50);
}

export function percentile(values: (number | null)[], p: number): number | null {
    if (!values.length) return null;
    const sorted = [...(values as number[])].sort((a, b) => a - b);
    const rank = (p / 100) * (sorted.length - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    if (low === high) return sorted[low] as number;
    return (sorted[low] as number) + ((sorted[high] as number) - (sorted[low] as number)) * (rank - low);
}

// ISO-8601 week: Monday-based, week 1 contains the first Thursday.
export function isoWeekKey(isoDate: string): string {
    const d = new Date(isoDate);
    const day = (d.getUTCDay() + 6) % 7;
    const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
    const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
    const firstDay = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
    const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * HOUR));
    return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function weekStart(isoDate: string): Date {
    const d = new Date(isoDate);
    const day = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

function timeline(pr: CanonicalPr) {
    const commits = pr.commits.map((commit) => commit.committedAt).sort();
    const reviews = pr.reviews
        .filter((review) => review.submittedAt)
        .map((review) => ({ at: review.submittedAt as string, author: login(review.author) }))
        .sort((a, b) => a.at.localeCompare(b.at));

    return { commits, reviews };
}

function threadStats(pr: CanonicalPr, isBot: (name: string) => boolean): ThreadStats {
    const threads = pr.threads.map((thread) => ({
        author: login(thread.firstCommentAuthor),
        reviewId: thread.parentReviewKey,
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
    }));

    const byAuthorClass = (bot: boolean) => threads.filter((t) => isBot(t.author) === bot);
    return {
        total: pr.threadCount,
        threads,
        bot: byAuthorClass(true).length,
        human: byAuthorClass(false).length,
        resolved: threads.filter((t) => t.resolved).length,
        unresolvedOutdated: threads.filter((t) => !t.resolved && t.outdated).length,
        unresolvedLive: threads.filter((t) => !t.resolved && !t.outdated).length,
    };
}

/** One flat record per PR — everything downstream reads these, not the provider's nodes. */
export function derive(
    pr: CanonicalPr,
    bots: Set<string> = defaultBots(),
    capabilities: ProviderCapabilities = ALL_CAPABILITIES,
): DerivedPr {
    const isBot = (name: string) => bots.has(name);
    const { commits, reviews } = timeline(pr);
    const threads = threadStats(pr, isBot);

    const firstReview = reviews[0] ?? null;
    const firstHumanReview = reviews.find((r) => !isBot(r.author)) ?? null;
    const commitsAfter = (mark: string | undefined) =>
        mark ? commits.filter((c) => c > mark).length : 0;

    // A review that owns no thread left no line comment — it is a body-only review. Without
    // review linkage the question cannot be asked at all, so the answer is null rather than
    // "every review was body-only", which is what an empty id set would produce.
    const threadReviewKeys = new Set(threads.threads.map((t) => t.reviewId).filter(Boolean));
    const bodyOnly = (key: string): boolean | null =>
        capabilities.reviewLinkage ? !threadReviewKeys.has(key) : null;

    const mergedAt = pr.mergedAt;
    const lastCommit = commits.length ? (commits[commits.length - 1] as string) : null;
    const createdMs = new Date(pr.createdAt).getTime();
    const mergedMs = mergedAt ? new Date(mergedAt).getTime() : null;

    return {
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        author: login(pr.author),
        authorIsBot: isBot(login(pr.author)),
        baseRefName: pr.baseRef,
        headRefName: pr.headRef,
        state: pr.state,
        createdAt: pr.createdAt,
        mergedAt,
        labels: pr.labels,
        hasAiLabel: pr.labels.some((label) => AI_LABELS.has(label)),
        additions: pr.additions,
        deletions: pr.deletions,
        size: pr.additions + pr.deletions,
        changedFiles: pr.changedFiles,
        commitCount: pr.commitCount,
        issueComments: pr.issueCommentCount,
        reviewCount: pr.reviewCount,
        reviews: pr.reviews.map((r) => ({
            id: r.reviewKey,
            author: login(r.author),
            state: r.providerState,
            submittedAt: r.submittedAt,
            bodyOnly: bodyOnly(r.reviewKey),
        })),
        bodyOnlyReviewCount: capabilities.reviewLinkage
            ? pr.reviews.filter((r) => !threadReviewKeys.has(r.reviewKey)).length
            : null,
        threads,
        // Both already carry their own unavailability: the adapter nulls forcePushCount when
        // the provider has no such event, and readyAt is null on a PR that was never a draft.
        // Only review linkage needs the capability flag, because "no thread named a review"
        // and "threads cannot name reviews here" look identical in the data.
        forcePushes: pr.forcePushCount,
        readyAt: pr.readyAt,
        firstReviewAt: firstReview?.at ?? null,
        firstHumanReviewAt: firstHumanReview?.at ?? null,
        commitsAfterAnyReview: commitsAfter(firstReview?.at),
        commitsAfterHumanReview: commitsAfter(firstHumanReview?.at),
        cycleHours: mergedMs !== null ? (mergedMs - createdMs) / HOUR : null,
        cycleFromReadyHours:
            mergedMs !== null && pr.readyAt
                ? (mergedMs - new Date(pr.readyAt).getTime()) / HOUR
                : null,
        firstReviewWaitHours: firstReview
            ? (new Date(firstReview.at).getTime() - createdMs) / HOUR
            : null,
        firstHumanReviewWaitHours: firstHumanReview
            ? (new Date(firstHumanReview.at).getTime() - createdMs) / HOUR
            : null,
        lastCommitToMergeHours:
            mergedMs !== null && lastCommit
                ? (mergedMs - new Date(lastCommit).getTime()) / HOUR
                : null,
        truncated: pr.truncated,
    };
}

// Returns null, not 0, on a zero denominator: the whole unavailable-vs-zero contract
// on the page rests on this. "0 reverts in 0 commits" reads as a real answer.
// Exported so telemetry.ts shares the one definition rather than growing a second.
export function ratio(part: number, whole: number): number | null {
    return whole ? part / whole : null;
}

function sizeBucket(size: number) {
    return SIZE_BUCKETS.find((b) => size < b.max) ?? (SIZE_BUCKETS[SIZE_BUCKETS.length - 1] as { label: string; max: number });
}

interface WeekBucket {
    week: string;
    start: string;
    merges: number;
    loc: number;
    cycles: (number | null)[];
    resolved: number;
    unresolvedOutdated: number;
    unresolvedLive: number;
}

function emptyWeek(date: string): WeekBucket {
    return {
        week: isoWeekKey(date),
        start: weekStart(date).toISOString().slice(0, 10),
        merges: 0,
        loc: 0,
        cycles: [],
        resolved: 0,
        unresolvedOutdated: 0,
        unresolvedLive: 0,
    };
}

function weeklySeries(merged: DerivedPr[], now: Date): WeekPoint[] {
    if (!merged.length) return [];

    const weeks = new Map<string, WeekBucket>();

    // Seed every week in the window, including the quiet ones: a median over only the
    // weeks that had a merge would overstate throughput, and the chart would silently
    // close the gaps.
    const first = merged[0] as DerivedPr;
    const earliest = merged.reduce(
        (min, pr) => ((pr.mergedAt as string) < min ? (pr.mergedAt as string) : min),
        first.mergedAt as string,
    );
    const latest = merged.reduce(
        (max, pr) => ((pr.mergedAt as string) > max ? (pr.mergedAt as string) : max),
        first.mergedAt as string,
    );
    const cursor = weekStart(earliest);
    const last = weekStart(latest);
    while (cursor <= last) {
        const iso = cursor.toISOString();
        weeks.set(isoWeekKey(iso), emptyWeek(iso));
        cursor.setUTCDate(cursor.getUTCDate() + 7);
    }

    for (const pr of merged) {
        const key = isoWeekKey(pr.mergedAt as string);
        if (!weeks.has(key)) weeks.set(key, emptyWeek(pr.mergedAt as string));
        const bucket = weeks.get(key) as WeekBucket;
        bucket.merges += 1;
        bucket.loc += pr.size;
        bucket.cycles.push(pr.cycleHours);
        bucket.resolved += pr.threads.resolved;
        bucket.unresolvedOutdated += pr.threads.unresolvedOutdated;
        bucket.unresolvedLive += pr.threads.unresolvedLive;
    }

    const currentWeek = isoWeekKey(now.toISOString());
    return [...weeks.values()]
        .sort((a, b) => a.week.localeCompare(b.week))
        .map(({ cycles, ...rest }) => ({
            ...rest,
            cycleP50: median(cycles),
            partial: rest.week === currentWeek,
        }));
}

function reviewerTable(merged: DerivedPr[], isBot: (name: string) => boolean): ReviewerRow[] {
    const rows = new Map<string, Omit<ReviewerRow, 'resolvedRatio'>>();
    const row = (name: string) => {
        if (!rows.has(name)) {
            rows.set(name, {
                login: name,
                isBot: isBot(name),
                threads: 0,
                resolved: 0,
                bodyOnlyReviews: 0,
                reviews: 0,
                prsTouched: 0,
            });
        }
        return rows.get(name) as Omit<ReviewerRow, 'resolvedRatio'>;
    };

    for (const pr of merged) {
        const seen = new Set<string>();
        for (const thread of pr.threads.threads) {
            const r = row(thread.author);
            r.threads += 1;
            if (thread.resolved) r.resolved += 1;
            seen.add(thread.author);
        }
        for (const review of pr.reviews) {
            const r = row(review.author);
            r.reviews += 1;
            // One unclassifiable review nulls the whole column for this reviewer. Skipping the
            // increment instead would leave a 0, which reads as "always left line comments" —
            // a claim about their reviewing rather than about the data.
            if (review.bodyOnly === null) r.bodyOnlyReviews = null;
            else if (review.bodyOnly && r.bodyOnlyReviews !== null) r.bodyOnlyReviews += 1;
            seen.add(review.author);
        }
        for (const name of seen) row(name).prsTouched += 1;
    }

    return [...rows.values()]
        .map((r) => ({ ...r, resolvedRatio: ratio(r.resolved, r.threads) }))
        .sort((a, b) => b.threads - a.threads || b.reviews - a.reviews);
}

function authorTable(merged: DerivedPr[], isBot: (name: string) => boolean): AuthorRow[] {
    const groups = new Map<string, DerivedPr[]>();
    for (const pr of merged) {
        if (!groups.has(pr.author)) groups.set(pr.author, []);
        (groups.get(pr.author) as DerivedPr[]).push(pr);
    }

    return [...groups.entries()]
        .map(([name, prs]) => {
            const threadsReceived = prs.reduce((sum, pr) => sum + pr.threads.total, 0);
            const resolvedReceived = prs.reduce((sum, pr) => sum + pr.threads.resolved, 0);
            return {
                login: name,
                isBot: isBot(name),
                merged: prs.length,
                medianSize: median(prs.map((pr) => pr.size)),
                medianCommits: median(prs.map((pr) => pr.commitCount)),
                cycleP50: median(prs.map((pr) => pr.cycleHours)),
                reworkRatio: ratio(
                    prs.filter((pr) => pr.commitsAfterHumanReview > 0).length,
                    prs.length,
                ),
                threadsReceived,
                unresolvedRatio: ratio(threadsReceived - resolvedReceived, threadsReceived),
            };
        })
        .sort((a, b) => a.login.localeCompare(b.login));
}

export function deriveAll(
    prs: CanonicalPr[],
    bots: Set<string> = defaultBots(),
    capabilities: ProviderCapabilities = ALL_CAPABILITIES,
): DerivedPr[] {
    return prs.map((pr) => derive(pr, bots, capabilities));
}

export interface ComputeOptions {
    history?: BranchHistory | null;
    baseBranch?: string;
    bots?: Set<string>;
    /** Injected so the `partial` week flag and `generatedAt` are testable against a frozen fixture. */
    now?: Date;
}

/** Takes derived records (see `derive`), not a provider's response nodes. */
export function compute(all: DerivedPr[], options: ComputeOptions = {}): Stats {
    const { history = null, baseBranch = 'dev', bots = defaultBots(), now = new Date() } = options;
    const isBot = (name: string) => bots.has(name);

    const merged = all.filter((pr) => pr.mergedAt && pr.baseRefName === baseBranch);
    const open = all.filter((pr) => pr.state === 'open');
    const closedUnmerged = all.filter((pr) => pr.state === 'closed');

    const truncated: TruncatedPr[] = all
        .filter((pr) => pr.truncated.length)
        .map((pr) => ({ repo: pr.repo, number: pr.number, connections: [...pr.truncated] }));

    const threadTotals = merged.reduce(
        (acc, pr) => ({
            total: acc.total + pr.threads.total,
            resolved: acc.resolved + pr.threads.resolved,
            unresolvedOutdated: acc.unresolvedOutdated + pr.threads.unresolvedOutdated,
            unresolvedLive: acc.unresolvedLive + pr.threads.unresolvedLive,
            bot: acc.bot + pr.threads.bot,
            human: acc.human + pr.threads.human,
        }),
        { total: 0, resolved: 0, unresolvedOutdated: 0, unresolvedLive: 0, bot: 0, human: 0 },
    );

    const weekly = weeklySeries(merged, now);
    const completeWeeks = weekly.filter((w) => !w.partial);
    const cycles = merged.map((pr) => pr.cycleHours);

    const withAnyReview = merged.filter((pr) => pr.firstReviewAt);
    const withHumanReview = merged.filter((pr) => pr.firstHumanReviewAt);

    return {
        meta: {
            generatedAt: now.toISOString(),
            baseBranch,
            truncated,
            counts: {
                all: all.length,
                mergedToBase: merged.length,
                open: open.length,
                closedUnmerged: closedUnmerged.length,
            },
            // Relies on loadPullRequests()'s ordering (created_at desc — pr-store.ts). Do not
            // "fix" to min/max.
            window: {
                from: merged.length ? (merged[merged.length - 1] as DerivedPr).mergedAt : null,
                to: merged.length ? (merged[0] as DerivedPr).mergedAt : null,
            },
        },
        headline: {
            unresolvedThreadRatio: ratio(
                threadTotals.total - threadTotals.resolved,
                threadTotals.total,
            ),
            mergesPerWeek: median(completeWeeks.map((w) => w.merges)),
            cycleP50: percentile(cycles, 50),
            cycleP90: percentile(cycles, 90),
            reworkAfterAnyReview: ratio(
                withAnyReview.filter((pr) => pr.commitsAfterAnyReview > 0).length,
                withAnyReview.length,
            ),
            reworkAfterHumanReview: ratio(
                withHumanReview.filter((pr) => pr.commitsAfterHumanReview > 0).length,
                withHumanReview.length,
            ),
            botThreadsPerPr: ratio(threadTotals.bot, merged.length),
            humanThreadsPerPr: ratio(threadTotals.human, merged.length),
            medianSize: median(merged.map((pr) => pr.size)),
        },
        threads: {
            total: threadTotals.total,
            resolved: threadTotals.resolved,
            unresolvedOutdated: threadTotals.unresolvedOutdated,
            unresolvedLive: threadTotals.unresolvedLive,
            bot: threadTotals.bot,
            human: threadTotals.human,
        },
        weekly,
        cycle: {
            p50: percentile(cycles, 50),
            p90: percentile(cycles, 90),
            p50FromReady: percentile(
                merged
                    .filter((pr) => pr.cycleFromReadyHours !== null)
                    .map((pr) => pr.cycleFromReadyHours),
                50,
            ),
            firstReviewWaitP50: percentile(
                withAnyReview.map((pr) => pr.firstReviewWaitHours),
                50,
            ),
            firstHumanReviewWaitP50: percentile(
                withHumanReview.map((pr) => pr.firstHumanReviewWaitHours),
                50,
            ),
            lastCommitToMergeP50: percentile(
                merged
                    .filter((pr) => pr.lastCommitToMergeHours !== null)
                    .map((pr) => pr.lastCommitToMergeHours),
                50,
            ),
        },
        rework: {
            prsWithAnyReview: withAnyReview.length,
            prsWithHumanReview: withHumanReview.length,
            afterAnyReview: withAnyReview.filter((pr) => pr.commitsAfterAnyReview > 0).length,
            afterHumanReview: withHumanReview.filter((pr) => pr.commitsAfterHumanReview > 0).length,
            medianCommitsAfterAnyReview: median(withAnyReview.map((pr) => pr.commitsAfterAnyReview)),
            medianCommitsAfterHumanReview: median(
                withHumanReview.map((pr) => pr.commitsAfterHumanReview),
            ),
            // All-or-nothing across the set, for the same reason the revert rate is: adding up
            // only the PRs whose provider can see force pushes gives a plausible number
            // measured over an unknown subset. A plain reduce over nulls also yields NaN,
            // which renders as the literal string "NaN".
            forcePushes: merged.some((pr) => pr.forcePushes === null)
                ? null
                : merged.reduce((sum, pr) => sum + (pr.forcePushes as number), 0),
        },
        size: {
            histogram: SIZE_BUCKETS.map((bucket) => ({
                label: bucket.label,
                count: merged.filter((pr) => sizeBucket(pr.size).label === bucket.label).length,
            })),
            scatter: merged
                .filter((pr) => pr.cycleHours !== null && pr.size > 0)
                .map((pr) => ({
                    repo: pr.repo,
                    number: pr.number,
                    size: pr.size,
                    hours: pr.cycleHours as number,
                    botThreads: pr.threads.bot,
                })),
            medianChangedFiles: median(merged.map((pr) => pr.changedFiles)),
        },
        commitsHistogram: (() => {
            const counts = new Map<number, number>();
            for (const pr of merged) {
                const key = Math.min(pr.commitCount, 10);
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            return [...counts.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([commits, count]) => ({
                    label: commits === 10 ? '10+' : String(commits),
                    count,
                }));
        })(),
        reviewers: reviewerTable(merged, isBot),
        authors: authorTable(merged, isBot),
        quality: {
            labelledPrs: merged.filter((pr) => pr.hasAiLabel).length,
            mergedPrs: merged.length,
            // Release and merge-forward PRs are opened and merged seconds apart. They are
            // real merges, but counting them as delivery pulls every latency median down.
            instantMerges: merged.filter((pr) => pr.cycleHours !== null && (pr.cycleHours as number) < 2 / 60)
                .length,
            history,
            revertRatio: history ? ratio(history.reverts, history.commits) : null,
        },
    };
}
