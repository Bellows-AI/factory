import type { GitHubConfig, Repo } from '../config.js';
import { GitHubAppError } from './app-token.js';
import type { InstallationTokenProvider } from './app-token.js';

/**
 * What the App installation reports it can see. This replaced ORG_REPOS: the credential and the
 * repo list now come from the same place, so they cannot drift — a repo the operator listed but
 * never granted used to fail every sync with a 404 that read as a deleted repository.
 */
export interface InstallationRepo extends Repo {
    readonly private: boolean;
    readonly defaultBranch: string | null;
    /** ISO. Sorts the picker, so the repos somebody actually works in are at the top. */
    readonly pushedAt: string | null;
}

export interface Installation {
    readonly id: string;
    /** The org or user the App is installed on. Display only. */
    readonly account: string | null;
    /** `all` or `selected` — whether adding a repo needs a change on GitHub's side. */
    readonly repositorySelection: 'all' | 'selected' | null;
}

export interface InstallationListing {
    readonly repos: readonly InstallationRepo[];
    readonly installation: Installation;
}

export interface GitHubAppClient {
    /**
     * The repositories and the installation that owns them, in one call.
     *
     * Together rather than as two methods because they arrive in one response.
     * `GET /installation/repositories` carries `repository_selection` alongside the page, and there
     * is no second endpoint to ask: `GET /app/installations/:id` authenticates with the App JWT,
     * not with the installation token this client holds, so reaching for it here would 403.
     */
    listRepositories(): Promise<InstallationListing>;
}

/**
 * A hard ceiling on paging. 100 pages of 100 is 10,000
 * repositories; past that something is looping rather than large.
 */
const MAX_PAGES = 100;

/** GitHub's page size for the repositories listing — the standard, and the largest, `per_page`. */
const PAGE_SIZE = 100;

/** How much of a failed response's body is worth quoting back in the thrown error. */
const ERROR_DETAIL_LIMIT = 200;

interface RepoPayload {
    name?: string;
    private?: boolean;
    default_branch?: string | null;
    pushed_at?: string | null;
    owner?: { login?: string };
}

export function createGitHubAppClient(
    github: Extract<GitHubConfig, { mode: 'app' }>,
    tokens: InstallationTokenProvider,
    fetchFn: typeof fetch = fetch
): GitHubAppClient {
    const call = async (path: string): Promise<unknown> => {
        const response = await fetchFn(`${github.apiUrl}${path}`, {
            headers: {
                authorization: `Bearer ${await tokens.get()}`,
                accept: 'application/vnd.github+json',
                // GitHub rejects an API request with no User-Agent outright.
                'user-agent': 'factory-ai',
            },
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, ERROR_DETAIL_LIMIT);
            throw new GitHubAppError(`GET ${path} failed with ${response.status}${detail ? `: ${detail}` : ''}`);
        }
        return response.json();
    };

    /**
     * Skipped rather than thrown: one malformed entry must not cost the whole list, and there is
     * nothing an operator could do about it from here anyway.
     */
    const toInstallationRepo = (repo: RepoPayload): InstallationRepo | null => {
        if (!repo.name || !repo.owner?.login) return null;
        return Object.freeze({
            owner: repo.owner.login,
            name: repo.name,
            private: repo.private ?? false,
            defaultBranch: repo.default_branch ?? null,
            pushedAt: repo.pushed_at ?? null,
        });
    };

    interface RepoPage {
        total_count?: number;
        repository_selection?: string;
        repositories?: RepoPayload[];
    }

    const fetchRepoPage = (page: number): Promise<RepoPage> =>
        call(`/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`) as Promise<RepoPage>;

    /**
     * Both conditions, not just the count: an empty page ends the walk even if total_count
     * disagrees, which is what stops a miscount becoming MAX_PAGES requests.
     */
    const isLastPage = (body: RepoPage, batchLength: number, repoCount: number): boolean =>
        batchLength === 0 || (typeof body.total_count === 'number' && repoCount >= body.total_count);

    const fetchInstallationRepos = async (): Promise<{
        repos: InstallationRepo[];
        selection: string | undefined;
    }> => {
        const repos: InstallationRepo[] = [];
        let selection: string | undefined;
        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const body = await fetchRepoPage(page);
            selection ??= body.repository_selection;
            const batch = body.repositories ?? [];
            for (const repo of batch) {
                const parsed = toInstallationRepo(repo);
                if (parsed) repos.push(parsed);
            }
            if (isLastPage(body, batch.length, repos.length)) break;
        }
        return { repos, selection };
    };

    return {
        async listRepositories() {
            const { repos, selection } = await fetchInstallationRepos();

            // The account is inferred from the repositories rather than looked up, for the reason on
            // the interface: the endpoint that would report it authenticates differently. Null when
            // the installation spans several owners, which it can, because "the account this is
            // installed on" is then not a single answer and a first-repo guess would be a wrong one.
            const owners = new Set(repos.map((repo) => repo.owner));
            return Object.freeze({
                repos: Object.freeze(repos),
                installation: Object.freeze({
                    id: await tokens.installationId(),
                    account: owners.size === 1 ? ([...owners][0] as string) : null,
                    repositorySelection: selection === 'all' || selection === 'selected' ? selection : null,
                }),
            });
        },
    };
}
