import type { BranchHistory, CanonicalPr, PrConnection } from '@factory-ai/core';
import { isRevertHeadline } from '@factory-ai/core';
import type { AppConfig, Repo } from '../config.js';
import type {
    BranchCommit,
    ForgeClient,
    Progress,
    PullRequestsOptions,
    PullRequestsResult,
    RateLimit,
    RepoBranchHistory,
} from '../forge.js';
import { GitHubError, describeHttpFailure } from './errors.js';
import { GITHUB_CAPABILITIES, oversizedConnections, toCanonical } from './map.js';
import {
    CREATED_DESC,
    HISTORY_QUERY,
    PAGE_SIZE,
    PR_QUERY,
    REVIEWS_QUERY,
    THREADS_QUERY,
    UPDATED_DESC,
} from './queries.js';
import type { RawPullRequest } from './schema.js';
import { fullName, type RepoSource } from './repo-source.js';
import type { TokenProvider } from './token.js';

const ENDPOINT = 'https://api.github.com/graphql';
const MAX_INNER_PAGES = 50;

/**
 * The history loop needs its own cap for the same reason the inner loops have one: the first
 * scan of a busy base branch is bounded by `since`, but a bad `since` — or a repo with a very
 * long tail — would otherwise page until the rate limit ran out.
 */
const MAX_HISTORY_PAGES = 400;

interface Connection<N> {
    nodes: N[];
    pageInfo: { hasNextPage: boolean; endCursor: string };
}

interface PrPageResponse {
    repository: { pullRequests: Connection<RawPullRequest> };
    rateLimit: RateLimit | null;
}

interface HistoryCommit {
    oid: string;
    messageHeadline: string;
    committedDate: string;
}

interface HistoryResponse {
    repository: {
        ref: {
            target: {
                history?: Connection<HistoryCommit> & { totalCount: number };
            } | null;
        } | null;
    };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ClientDeps {
    config: AppConfig;
    /** Which repositories to walk. Reported by the App installation, so it is read per call. */
    repos: RepoSource;
    /**
     * Absent only when the process was built with the code-only `none` arm — the offline
     * tooling — and then every method here refuses before building a request. An optional
     * dependency rather than a provider that throws: a process with no credential cannot fetch,
     * and saying so in the type is stronger than saying it in an error message.
     */
    tokens?: TokenProvider | undefined;
    fetch?: typeof globalThis.fetch;
}

export function createGitHubClient({ config, repos, tokens, fetch = globalThis.fetch }: ClientDeps): ForgeClient {
    const { baseBranch } = config;

    // The list as of this call. Every method below walks it once, and the source caches, so this is
    // a snapshot read rather than a request per repo.
    const measured = () => repos.snapshot();

    async function graphql<T>(
        query: string,
        variables: Record<string, unknown>,
        repo: Repo,
        attempts = 3,
    ): Promise<T> {
        if (!tokens) {
            // Before any request is built, which is what makes the offline tooling a distinct
            // process rather than a misconfigured one: nothing reaches the network, the stored
            // figures still render, and `meta` carries this sentence instead of a network error
            // nobody can act on.
            throw new GitHubError(
                'this process was built with no GitHub credential, so it serves only what is already stored',
                'TOKEN_REJECTED',
            );
        }
        const token = await tokens.get();
        let lastError: GitHubError | undefined;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            let response: Response;
            try {
                response = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify({ query, variables }),
                });
            } catch (e) {
                // Network-level failure: no response, so no status to branch on.
                lastError = new GitHubError(
                    `Could not reach api.github.com (${(e as Error).message}).`,
                    'NETWORK',
                );
                if (attempt === attempts) throw lastError;
                await sleep(2 ** attempt * 500);
                continue;
            }

            if (response.status >= 500) {
                const failure = describeHttpFailure(response, '', repo);
                lastError = new GitHubError(failure.message, failure.code, response.status);
                if (attempt === attempts) throw lastError;
                await sleep(2 ** attempt * 500);
                continue;
            }

            if (!response.ok) {
                const failure = describeHttpFailure(response, await response.text(), repo);
                throw new GitHubError(failure.message, failure.code, response.status);
            }

            const payload = (await response.json()) as { data: T; errors?: { message: string }[] };
            if (payload.errors?.length) {
                throw new GitHubError(
                    payload.errors.map((e) => e.message).join('; '),
                    'GRAPHQL',
                    200,
                );
            }
            return payload.data;
        }

        throw lastError as GitHubError;
    }

    async function collectNodes<N>(
        query: string,
        repo: Repo,
        number: number,
        field: 'reviewThreads' | 'reviews',
    ): Promise<N[]> {
        const nodes: N[] = [];
        let cursor: string | null = null;

        // Hand-written cursor loop. Note: `gh api graphql --paginate` only advances the
        // cursor if the variable is named `$endCursor` — named anything else it silently
        // re-requests page 1 forever. That bug is gh-CLI-only; do not switch to gh.
        for (let page = 0; page < MAX_INNER_PAGES; page += 1) {
            const data = await graphql<{
                repository: { pullRequest: Record<string, Connection<N>> };
            }>(
                query,
                {
                    owner: repo.owner,
                    name: repo.name,
                    number,
                    cursor,
                },
                repo,
            );
            const connection = data.repository.pullRequest[field] as Connection<N>;
            nodes.push(...connection.nodes);
            if (!connection.pageInfo.hasNextPage) return nodes;
            cursor = connection.pageInfo.endCursor;
        }

        throw new GitHubError(
            `${fullName(repo)}#${number} exceeded ${MAX_INNER_PAGES} inner pages; refusing to loop.`,
            'UPSTREAM',
        );
    }

    /** Fills in the node lists the first pass cut off. Leaves `commits` alone — it only
     *  contributes commit timestamps, and 100 is already past the point of meaning. */
    async function backfill(
        repo: Repo,
        pr: RawPullRequest,
        connections: PrConnection[],
        onProgress?: (p: Progress) => void,
    ): Promise<void> {
        if (connections.includes('reviewThreads')) {
            pr.reviewThreads.nodes = await collectNodes(THREADS_QUERY, repo, pr.number, 'reviewThreads');
        }
        if (connections.includes('reviews')) {
            pr.reviews.nodes = await collectNodes(REVIEWS_QUERY, repo, pr.number, 'reviews');
        }
        onProgress?.({ phase: 'backfill', repo: fullName(repo), backfillingPr: pr.number });
    }

    return {
        provider: 'github',
        capabilities: GITHUB_CAPABILITIES,

        async fetchPullRequests({
            onProgress,
            mode = 'full',
            cutoff = {},
        }: PullRequestsOptions = {}): Promise<PullRequestsResult> {
            const raw: { repo: Repo; pr: RawPullRequest }[] = [];
            const oversized: { repo: Repo; pr: RawPullRequest; connections: PrConnection[] }[] = [];
            const completed: Record<string, boolean> = {};
            let rateLimit: RateLimit | null = null;

            // Sequential, not Promise.all: the point of the rate-limit budget is that it is
            // shared, and N concurrent paginations would burn it in a burst that the TTL floor
            // cannot smooth out.
            for (const repo of measured()) {
                const name = fullName(repo);
                const stopAt = mode === 'incremental' ? cutoff[name] : undefined;
                // A repo with no watermark has never been synced, so there is nothing to be
                // incremental about: walk it in full even in incremental mode.
                const order = stopAt ? UPDATED_DESC : CREATED_DESC;
                let cursor: string | null = null;
                completed[name] = false;

                for (;;) {
                    const data: PrPageResponse = await graphql<PrPageResponse>(
                        PR_QUERY,
                        {
                            owner: repo.owner,
                            name: repo.name,
                            pageSize: PAGE_SIZE,
                            cursor,
                            order,
                        },
                        repo,
                    );

                    const page: Connection<RawPullRequest> = data.repository.pullRequests;
                    rateLimit = data.rateLimit;

                    for (const pr of page.nodes) {
                        const cut = oversizedConnections(pr);
                        if (cut.length) oversized.push({ repo, pr, connections: cut });
                        raw.push({ repo, pr });
                    }

                    onProgress?.({ phase: 'prs', repo: name, prsFetched: raw.length });

                    // The whole page is kept before the stop is considered: orderBy is not a
                    // strict total order across equal timestamps, so a mid-page stop can drop a
                    // sibling of the node that triggered it.
                    if (stopAt && page.nodes.length && page.nodes.every((pr) => pr.updatedAt < stopAt)) {
                        completed[name] = true;
                        break;
                    }

                    if (!page.pageInfo.hasNextPage) {
                        completed[name] = true;
                        break;
                    }
                    cursor = page.pageInfo.endCursor;
                }
            }

            for (const { repo, pr, connections } of oversized) {
                await backfill(repo, pr, connections, onProgress);
            }

            // Mapped after backfill, so `truncated` reflects what actually survived rather than
            // what the first page happened to cut.
            const prs: CanonicalPr[] = raw.map(({ repo, pr }) => toCanonical(pr, fullName(repo)));
            return { prs, rateLimit, completed };
        },

        async fetchBranchHistories(since, { onProgress } = {}): Promise<RepoBranchHistory[]> {
            const results: RepoBranchHistory[] = [];
            let scanned = 0;

            for (const repo of measured()) {
                const name = fullName(repo);
                const from = since[name];
                if (!from) {
                    throw new GitHubError(
                        `fetchBranchHistories called without a since for ${name}`,
                        'UPSTREAM',
                    );
                }

                let cursor: string | null = null;
                let commits = 0;
                let reverts = 0;
                let readable = true;
                const collected: BranchCommit[] = [];

                for (let page = 0; ; page += 1) {
                    if (page >= MAX_HISTORY_PAGES) {
                        throw new GitHubError(
                            `${name} exceeded ${MAX_HISTORY_PAGES} history pages since ${from}; refusing to loop.`,
                            'UPSTREAM',
                        );
                    }

                    const data: HistoryResponse = await graphql<HistoryResponse>(
                        HISTORY_QUERY,
                        {
                            owner: repo.owner,
                            name: repo.name,
                            branch: baseBranch,
                            since: from,
                            cursor,
                        },
                        repo,
                    );

                    const history = data.repository.ref?.target?.history;
                    // No readable ref means no revert rate for this repo. Returning zeros here
                    // would render "0 reverts in 0 commits", which reads as a real answer.
                    if (!history) {
                        readable = false;
                        break;
                    }

                    commits = history.totalCount;
                    for (const commit of history.nodes) {
                        scanned += 1;
                        if (isRevertHeadline(commit.messageHeadline)) reverts += 1;
                        collected.push({
                            sha: commit.oid,
                            committedAt: commit.committedDate,
                            messageHeadline: commit.messageHeadline,
                        });
                    }
                    onProgress?.({ phase: 'history', repo: name, historyScanned: scanned });

                    if (!history.pageInfo.hasNextPage) break;
                    cursor = history.pageInfo.endCursor;
                }

                const history: BranchHistory | null = readable
                    ? { branch: baseBranch, since: from, commits, reverts }
                    : null;
                results.push({ repo: name, branch: baseBranch, history, commits: readable ? collected : [] });
            }

            return results;
        },
    };
}
