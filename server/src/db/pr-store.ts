import type {
    CanonicalPr,
    CanonicalPrState,
    CanonicalReviewState,
    PrConnection,
    ProviderId,
} from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import type { BranchCommit, RateLimit, SyncMode } from '../forge.js';

export interface SyncState {
    /** Newest `updatedAt` a COMPLETED walk has seen. Null until one completes. */
    watermarkAt: string | null;
    lastSyncAt: string | null;
    lastFullAt: string | null;
    syncedEpoch: number;
    lastRateLimit: RateLimit | null;
}

export interface BranchCoverage {
    repo: string;
    branch: string;
    /** How far back the persisted commits actually reach. */
    from: string;
    commits: number;
    reverts: number;
    scannedAt: string;
}

/** One persisted base-branch commit. The headline is kept raw so reverts stay re-classifiable. */
export interface StoredBranchCommit {
    repo: string;
    branch: string;
    sha: string;
    committedAt: string;
    messageHeadline: string;
}

export interface PrStore {
    /**
     * Every persisted PR for these repos, in creation order, newest first.
     *
     * The ordering is not a convenience: `compute()` derives `stats.meta.window` from array
     * position rather than min/max, so this `order by` is the single authority that keeps that
     * invariant true once records come from a database instead of a CREATED_AT DESC query.
     */
    loadPullRequests(provider: ProviderId, repos: readonly string[]): Promise<CanonicalPr[]>;
    savePullRequests(prs: readonly CanonicalPr[]): Promise<void>;

    /**
     * Every repo this organization has rows for, as "owner/name".
     *
     * The repo list normally comes from the GitHub App installation, but a credential-less process
     * (the offline tooling's code-only `none` arm) has no installation to ask — and every other
     * read below is scoped BY the repo list, so without an answer a warm database renders as an
     * empty dashboard. That is not a hypothetical: `npm run seed` plus `npm run verify:ui` is
     * exactly that shape.
     *
     * "Whatever is stored" is also the honest answer there. A process that cannot fetch has no way
     * to know about a repo it holds no rows for, so reporting one would be a claim it cannot make.
     */
    storedRepos(provider: ProviderId): Promise<string[]>;

    loadBranchCommits(
        provider: ProviderId,
        repos: readonly string[],
        branch: string,
    ): Promise<StoredBranchCommit[]>;
    saveBranchHistory(
        provider: ProviderId,
        entry: {
            repo: string;
            branch: string;
            coveredFrom: string;
            commits: number;
            reverts: number;
            newCommits: readonly BranchCommit[];
        },
    ): Promise<void>;
    loadBranchCoverage(
        provider: ProviderId,
        repos: readonly string[],
        branch: string,
    ): Promise<BranchCoverage[]>;

    readSyncState(provider: ProviderId, repos: readonly string[], kind: string): Promise<Record<string, SyncState>>;
    /**
     * Per repo, the oldest `updatedAt` among still-open PRs.
     *
     * An incremental cutoff is floored by this because a provider does not reliably bump a PR's
     * `updatedAt` when a *child* changes — a thread resolved, a label removed, a force push.
     * Those feed the most prominent ratio on the page, and a PR whose timestamp is stuck would
     * otherwise never be looked at again.
     */
    oldestOpenUpdatedAt(provider: ProviderId, repos: readonly string[]): Promise<Record<string, string>>;
    /** Only ever called for a repo whose walk reached the end of the list. */
    recordSync(
        provider: ProviderId,
        repo: string,
        kind: string,
        update: {
            watermarkAt?: string | null;
            mode: SyncMode;
            rateLimit: RateLimit | null;
            syncedEpoch: number;
        },
    ): Promise<void>;
}

/**
 * Bumped when a newly selected provider field leaves existing rows null. A full walk is the only
 * repair, and a row's epoch is how the sync knows its data is stale rather than genuinely empty.
 */
export const SCHEMA_EPOCH = 1;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

interface PrRow {
    provider: ProviderId;
    repo: string;
    number: number;
    title: string;
    state: CanonicalPrState;
    is_draft: boolean;
    base_ref: string;
    head_ref: string;
    author: string | null;
    created_at: Date;
    merged_at: Date | null;
    closed_at: Date | null;
    ready_at: Date | null;
    additions: number;
    deletions: number;
    changed_files: number;
    commit_count: number;
    review_count: number;
    thread_count: number;
    issue_comment_count: number;
    force_push_count: number | null;
    truncated: PrConnection[];
    provider_updated_at: Date;
}

/**
 * The organization is bound at construction, not passed per call.
 *
 * It is a constant for the life of the process, so threading it through all thirteen call sites in
 * stats-service would be the same literal thirteen times — and one of them eventually forgotten.
 * Binding it also happens to be the shape a per-request store needs later, where the org is no
 * longer a constant; a leading parameter would have to be plumbed through anyway.
 */
export function createPrStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
}): PrStore {
    const gate = async () => {
        if (ready) await ready;
    };

    return {
        async storedRepos(provider) {
            await gate();
            const rows = await sql<{ repo: string }[]>`
                select distinct repo from pull_request
                where org_id = ${orgId} and provider = ${provider}
                order by repo asc
            `;
            return rows.map((row) => row.repo);
        },

        async loadPullRequests(provider, repos) {
            await gate();
            if (!repos.length) return [];

            const rows = await sql<PrRow[]>`
                select * from pull_request
                where org_id = ${orgId} and provider = ${provider}
                  and repo in ${sql(repos as string[])}
                order by created_at desc, repo asc, number desc
            `;
            if (!rows.length) return [];

            const keys = rows.map((row) => `${row.repo}#${row.number}`);
            const [reviews, threads, commits, labels] = await Promise.all([
                sql<
                    {
                        repo: string;
                        pr_number: number;
                        review_key: string;
                        author: string | null;
                        state: CanonicalReviewState;
                        provider_state: string;
                        submitted_at: Date | null;
                    }[]
                >`select * from pr_review where org_id = ${orgId} and provider = ${provider} and repo in ${sql(repos as string[])}`,
                sql<
                    {
                        repo: string;
                        pr_number: number;
                        thread_key: string;
                        is_resolved: boolean;
                        is_outdated: boolean;
                        first_comment_author: string | null;
                        first_comment_at: Date | null;
                        parent_review_key: string | null;
                    }[]
                >`select * from pr_review_thread where org_id = ${orgId} and provider = ${provider} and repo in ${sql(repos as string[])}`,
                sql<{ repo: string; pr_number: number; sha: string; committed_at: Date }[]>`
                    select * from pr_commit
                    where org_id = ${orgId} and provider = ${provider} and repo in ${sql(repos as string[])}
                    order by committed_at asc
                `,
                sql<{ repo: string; pr_number: number; label: string }[]>`
                    select * from pr_label
                    where org_id = ${orgId} and provider = ${provider} and repo in ${sql(repos as string[])}
                    order by label asc
                `,
            ]);

            const bucket = <T>(source: { repo: string; pr_number: number }[]) => {
                const map = new Map<string, T[]>(keys.map((key) => [key, []]));
                for (const row of source) {
                    map.get(`${row.repo}#${row.pr_number}`)?.push(row as unknown as T);
                }
                return map;
            };

            const reviewsBy = bucket<(typeof reviews)[number]>(reviews);
            const threadsBy = bucket<(typeof threads)[number]>(threads);
            const commitsBy = bucket<(typeof commits)[number]>(commits);
            const labelsBy = bucket<(typeof labels)[number]>(labels);

            return rows.map((row) => {
                const key = `${row.repo}#${row.number}`;
                return {
                    provider: row.provider,
                    repo: row.repo,
                    number: row.number,
                    title: row.title,
                    state: row.state,
                    isDraft: row.is_draft,
                    baseRef: row.base_ref,
                    headRef: row.head_ref,
                    createdAt: row.created_at.toISOString(),
                    mergedAt: iso(row.merged_at),
                    closedAt: iso(row.closed_at),
                    updatedAt: row.provider_updated_at.toISOString(),
                    additions: row.additions,
                    deletions: row.deletions,
                    changedFiles: row.changed_files,
                    author: row.author === null ? null : { login: row.author },
                    commitCount: row.commit_count,
                    reviewCount: row.review_count,
                    threadCount: row.thread_count,
                    issueCommentCount: row.issue_comment_count,
                    forcePushCount: row.force_push_count,
                    readyAt: iso(row.ready_at),
                    commits: (commitsBy.get(key) ?? []).map((c) => ({
                        sha: c.sha,
                        committedAt: c.committed_at.toISOString(),
                    })),
                    reviews: (reviewsBy.get(key) ?? []).map((r) => ({
                        reviewKey: r.review_key,
                        author: r.author === null ? null : { login: r.author },
                        state: r.state,
                        providerState: r.provider_state,
                        submittedAt: iso(r.submitted_at),
                    })),
                    threads: (threadsBy.get(key) ?? []).map((t) => ({
                        threadKey: t.thread_key,
                        isResolved: t.is_resolved,
                        isOutdated: t.is_outdated,
                        firstCommentAuthor:
                            t.first_comment_author === null ? null : { login: t.first_comment_author },
                        firstCommentAt: iso(t.first_comment_at),
                        parentReviewKey: t.parent_review_key,
                    })),
                    labels: (labelsBy.get(key) ?? []).map((l) => l.label),
                    truncated: row.truncated,
                } satisfies CanonicalPr;
            });
        },

        async savePullRequests(prs) {
            await gate();
            if (!prs.length) return;

            for (const pr of prs) {
                await sql.begin(async (tx) => {
                    await tx`
                        insert into pull_request (
                            org_id, provider, repo, number, title, state, is_draft, base_ref,
                            head_ref, author, created_at, merged_at, closed_at, ready_at, additions,
                            deletions, changed_files, commit_count, review_count, thread_count,
                            issue_comment_count, force_push_count, truncated, provider_updated_at,
                            fetched_at
                        ) values (
                            ${orgId},
                            ${pr.provider}, ${pr.repo}, ${pr.number}, ${pr.title}, ${pr.state},
                            ${pr.isDraft}, ${pr.baseRef}, ${pr.headRef}, ${pr.author?.login ?? null},
                            ${pr.createdAt}, ${pr.mergedAt}, ${pr.closedAt}, ${pr.readyAt},
                            ${pr.additions}, ${pr.deletions}, ${pr.changedFiles}, ${pr.commitCount},
                            ${pr.reviewCount}, ${pr.threadCount}, ${pr.issueCommentCount},
                            ${pr.forcePushCount}, ${pr.truncated}, ${pr.updatedAt}, now()
                        )
                        on conflict (org_id, provider, repo, number) do update set
                            title               = excluded.title,
                            state               = excluded.state,
                            is_draft            = excluded.is_draft,
                            base_ref            = excluded.base_ref,
                            head_ref            = excluded.head_ref,
                            author              = excluded.author,
                            merged_at           = excluded.merged_at,
                            closed_at           = excluded.closed_at,
                            ready_at            = excluded.ready_at,
                            additions           = excluded.additions,
                            deletions           = excluded.deletions,
                            changed_files       = excluded.changed_files,
                            commit_count        = excluded.commit_count,
                            review_count        = excluded.review_count,
                            thread_count        = excluded.thread_count,
                            issue_comment_count = excluded.issue_comment_count,
                            force_push_count    = excluded.force_push_count,
                            -- Recomputed from this fetch, never unioned with what was there:
                            -- a union leaves a stale caveat on the page after a successful
                            -- backfill has already filled the list in.
                            truncated           = excluded.truncated,
                            provider_updated_at = excluded.provider_updated_at,
                            fetched_at          = now()
                    `;

                    await writeChildren(tx, orgId, pr);
                });
            }
        },

        async loadBranchCommits(provider, repos, branch) {
            await gate();
            if (!repos.length) return [];
            const rows = await sql<
                { repo: string; branch: string; sha: string; committed_at: Date; message_headline: string }[]
            >`
                select * from branch_commit
                where org_id = ${orgId} and provider = ${provider} and branch = ${branch}
                  and repo in ${sql(repos as string[])}
                order by committed_at asc
            `;
            return rows.map((row) => ({
                repo: row.repo,
                branch: row.branch,
                sha: row.sha,
                committedAt: row.committed_at.toISOString(),
                messageHeadline: row.message_headline,
            }));
        },

        async saveBranchHistory(provider, { repo, branch, coveredFrom, commits, reverts, newCommits }) {
            await gate();

            if (newCommits.length) {
                const payload = newCommits.map((commit) => ({
                    org_id: orgId,
                    provider,
                    repo,
                    branch,
                    sha: commit.sha,
                    committed_at: new Date(commit.committedAt),
                    message_headline: commit.messageHeadline,
                }));
                // DO NOTHING: `since` is inclusive upstream and the scan is deliberately given an
                // overlap, so the tip commits arrive again on every run. An identical commit is
                // the same commit.
                await sql`insert into branch_commit ${sql(payload)} on conflict do nothing`;
            }

            await sql`
                insert into branch_history (org_id, provider, repo, branch, covered_from, commits, reverts, scanned_at)
                values (${orgId}, ${provider}, ${repo}, ${branch}, ${coveredFrom}, ${commits}, ${reverts}, now())
                on conflict (org_id, provider, repo, branch) do update set
                    -- Coverage only ever grows backwards. A later scan starting from a newer
                    -- lower bound has not lost the older commits, and moving this forward would
                    -- make a range that IS covered report as unavailable.
                    covered_from = least(branch_history.covered_from, excluded.covered_from),
                    commits      = excluded.commits,
                    reverts      = excluded.reverts,
                    scanned_at   = now()
            `;
        },

        async loadBranchCoverage(provider, repos, branch) {
            await gate();
            if (!repos.length) return [];
            const rows = await sql<
                {
                    repo: string;
                    branch: string;
                    covered_from: Date;
                    commits: number;
                    reverts: number;
                    scanned_at: Date;
                }[]
            >`
                select * from branch_history
                where org_id = ${orgId} and provider = ${provider} and branch = ${branch}
                  and repo in ${sql(repos as string[])}
            `;
            return rows.map((row) => ({
                repo: row.repo,
                branch: row.branch,
                from: row.covered_from.toISOString(),
                commits: row.commits,
                reverts: row.reverts,
                scannedAt: row.scanned_at.toISOString(),
            }));
        },

        async readSyncState(provider, repos, kind) {
            await gate();
            if (!repos.length) return {};
            const rows = await sql<
                {
                    repo: string;
                    watermark_at: Date | null;
                    last_sync_at: Date | null;
                    last_full_at: Date | null;
                    synced_epoch: number;
                    last_rate_limit: RateLimit | null;
                }[]
            >`
                select * from sync_state
                where org_id = ${orgId} and provider = ${provider} and kind = ${kind}
                  and repo in ${sql(repos as string[])}
            `;

            const state: Record<string, SyncState> = {};
            for (const row of rows) {
                state[row.repo] = {
                    watermarkAt: iso(row.watermark_at),
                    lastSyncAt: iso(row.last_sync_at),
                    lastFullAt: iso(row.last_full_at),
                    syncedEpoch: row.synced_epoch,
                    lastRateLimit: row.last_rate_limit,
                };
            }
            return state;
        },

        async oldestOpenUpdatedAt(provider, repos) {
            await gate();
            if (!repos.length) return {};
            const rows = await sql<{ repo: string; oldest: Date }[]>`
                select repo, min(provider_updated_at) as oldest from pull_request
                where org_id = ${orgId} and provider = ${provider} and state = 'open'
                  and repo in ${sql(repos as string[])}
                group by repo
            `;
            return Object.fromEntries(rows.map((row) => [row.repo, row.oldest.toISOString()]));
        },

        async recordSync(provider, repo, kind, { watermarkAt = null, mode, rateLimit, syncedEpoch }) {
            await gate();
            const full = mode === 'full';
            await sql`
                insert into sync_state (
                    org_id, provider, repo, kind, watermark_at, last_sync_at, last_full_at,
                    synced_epoch, last_rate_limit
                ) values (
                    ${orgId}, ${provider}, ${repo}, ${kind}, ${watermarkAt}, now(),
                    ${full ? sql`now()` : null}, ${syncedEpoch}, ${rateLimit as never}
                )
                on conflict (org_id, provider, repo, kind) do update set
                    -- Monotonic. A page loop that stopped early hands back the watermark it
                    -- started from, and an out-of-order report must not rewind coverage.
                    watermark_at    = greatest(sync_state.watermark_at, excluded.watermark_at),
                    last_sync_at    = excluded.last_sync_at,
                    last_full_at    = coalesce(excluded.last_full_at, sync_state.last_full_at),
                    synced_epoch    = greatest(sync_state.synced_epoch, excluded.synced_epoch),
                    last_rate_limit = coalesce(excluded.last_rate_limit, sync_state.last_rate_limit)
            `;
        },
    };
}

/**
 * Rewrites a PR's child rows.
 *
 * Per connection, and gated on whether the incoming list is complete:
 *
 * - complete  -> delete then insert. This is the only thing that ever makes a review or thread
 *                deleted upstream stop being counted; a pure upsert leaks removed rows forever.
 * - truncated -> upsert only, NEVER delete. A degraded refetch of a 397-review PR returns 100
 *                nodes; the 397 rows already stored are strictly better data than what just
 *                arrived, and replacing them corrupts the resolution ratio with no error
 *                anywhere. This is the single most dangerous case in the write path — the `if`
 *                below is load-bearing, not defensive.
 *
 * The decision is per connection because one PR can arrive with a complete commit list and a
 * truncated review list in the same fetch.
 */
async function writeChildren(tx: TransactionSql, orgId: string, pr: CanonicalPr): Promise<void> {
    const key = { org_id: orgId, provider: pr.provider, repo: pr.repo, pr_number: pr.number };
    const complete = (connection: PrConnection) => !pr.truncated.includes(connection);
    // Every delete below is org-scoped. Without it a complete list for one org would wipe another
    // org's rows for the same repo and PR number — and both are routinely the same string.
    const owned = tx`org_id = ${orgId} and provider = ${pr.provider}
                     and repo = ${pr.repo} and pr_number = ${pr.number}`;

    if (complete('reviews')) {
        await tx`delete from pr_review where ${owned}`;
    }
    if (pr.reviews.length) {
        await tx`
            insert into pr_review ${tx(
                pr.reviews.map((review) => ({
                    ...key,
                    review_key: review.reviewKey,
                    author: review.author?.login ?? null,
                    state: review.state,
                    provider_state: review.providerState,
                    submitted_at: review.submittedAt === null ? null : new Date(review.submittedAt),
                })),
            )}
            on conflict (org_id, provider, repo, pr_number, review_key) do update set
                author         = excluded.author,
                state          = excluded.state,
                provider_state = excluded.provider_state,
                submitted_at   = excluded.submitted_at
        `;
    }

    if (complete('reviewThreads')) {
        await tx`delete from pr_review_thread where ${owned}`;
    }
    if (pr.threads.length) {
        await tx`
            insert into pr_review_thread ${tx(
                pr.threads.map((thread) => ({
                    ...key,
                    thread_key: thread.threadKey,
                    is_resolved: thread.isResolved,
                    is_outdated: thread.isOutdated,
                    first_comment_author: thread.firstCommentAuthor?.login ?? null,
                    first_comment_at:
                        thread.firstCommentAt === null ? null : new Date(thread.firstCommentAt),
                    parent_review_key: thread.parentReviewKey,
                })),
            )}
            on conflict (org_id, provider, repo, pr_number, thread_key) do update set
                is_resolved          = excluded.is_resolved,
                is_outdated          = excluded.is_outdated,
                first_comment_author = excluded.first_comment_author,
                first_comment_at     = excluded.first_comment_at,
                parent_review_key    = excluded.parent_review_key
        `;
    }

    if (complete('commits')) {
        await tx`delete from pr_commit where ${owned}`;
    }
    if (pr.commits.length) {
        await tx`
            insert into pr_commit ${tx(
                pr.commits.map((commit) => ({
                    ...key,
                    sha: commit.sha,
                    committed_at: new Date(commit.committedAt),
                })),
            )}
            on conflict do nothing
        `;
    }

    // Labels have no count of their own, so they are always complete: the query asks for 20 and
    // nothing reports how many there really are. Replace outright — a removed label must go.
    await tx`delete from pr_label where ${owned}`;
    if (pr.labels.length) {
        await tx`insert into pr_label ${tx(pr.labels.map((label) => ({ ...key, label })))}
                 on conflict do nothing`;
    }
}
