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

export interface OrgTeam {
    readonly slug: string;
    readonly name: string;
}

export interface TeamRepo {
    readonly owner: string;
    readonly name: string;
}

export interface OrgMember {
    /** The numeric GitHub account id — the identity the roster sync matches on. */
    readonly id: number;
    /** The current login, lowercased to match how org_membership stores the label. */
    readonly login: string;
}

export interface OrgRoster {
    /** Every org member, with the id that survives their renames. */
    readonly members: readonly OrgMember[];
    /** The numeric ids that hold the org `admin` role. */
    readonly admins: readonly number[];
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

    /*
     * What the installation can see about the org's people — the inputs of per-user repo scoping
     * and the roster sync (#66). Every call below spends the installation's rate limit, which is
     * why access-scope.ts caches the org-wide answers (teams, per-team repos) rather than re-asking
     * per login.
     */

    /** The org's teams. Needs the App to hold Organization members: read. */
    orgTeams(org: string): Promise<readonly OrgTeam[]>;
    /** The repos a team has been granted, directly or via child-team inheritance on GitHub's side. */
    teamRepos(org: string, slug: string): Promise<readonly TeamRepo[]>;
    /** Whether this login belongs to this team. */
    teamMembership(org: string, slug: string, login: string): Promise<boolean>;
    /** Whether this login is a DIRECT collaborator on the repo — invited by name, not via a team. */
    collaborator(owner: string, name: string, login: string): Promise<boolean>;
    /** The org roster and its admins, for the periodic removal/role sweep. */
    orgMembers(org: string): Promise<OrgRoster>;
}

/**
 * A hard ceiling on paging. 100 pages of 100 is 10,000
 * repositories; past that something is looping rather than large.
 */
const MAX_PAGES = 100;

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
            const detail = (await response.text().catch(() => '')).slice(0, 200);
            throw new GitHubAppError(`GET ${path} failed with ${response.status}${detail ? `: ${detail}` : ''}`);
        }
        return response.json();
    };

    // Membership and collaborator questions are answered with 204 (yes) or 404 (no) and no body —
    // not with JSON — so they get their own path through fetch. Any other status is a fault: a 403
    // here means the App lacks the permission the probe needs, and silently reading it as "no"
    // would de-scope members who in fact have access.
    const probe = async (path: string): Promise<boolean> => {
        const response = await fetchFn(`${github.apiUrl}${path}`, {
            headers: {
                authorization: `Bearer ${await tokens.get()}`,
                accept: 'application/vnd.github+json',
                'user-agent': 'factory-ai',
            },
        });
        if (response.status === 204) return true;
        if (response.status === 404) return false;
        throw new GitHubAppError(`GET ${path} failed with ${response.status}`);
    };

    /** The standard page walk: 100 a page, empty page ends, MAX_PAGES is the loop guard. */
    const pages = async function* <T>(path: string): AsyncGenerator<T[]> {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const batch = (await call(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)) as T[];
            if (batch.length === 0) return;
            yield batch;
        }
    };

    return {
        async listRepositories() {
            const repos: InstallationRepo[] = [];
            let selection: string | undefined;
            for (let page = 1; page <= MAX_PAGES; page += 1) {
                const body = (await call(`/installation/repositories?per_page=100&page=${page}`)) as {
                    total_count?: number;
                    repository_selection?: string;
                    repositories?: RepoPayload[];
                };
                selection ??= body.repository_selection;
                const batch = body.repositories ?? [];
                for (const repo of batch) {
                    // Skipped rather than thrown: one malformed entry must not cost the whole list,
                    // and there is nothing an operator could do about it from here anyway.
                    if (!repo.name || !repo.owner?.login) continue;
                    repos.push(
                        Object.freeze({
                            owner: repo.owner.login,
                            name: repo.name,
                            private: repo.private ?? false,
                            defaultBranch: repo.default_branch ?? null,
                            pushedAt: repo.pushed_at ?? null,
                        })
                    );
                }
                // Both conditions, not just the count: an empty page ends the walk even if
                // total_count disagrees, which is what stops a miscount becoming MAX_PAGES requests.
                if (batch.length === 0) break;
                if (typeof body.total_count === 'number' && repos.length >= body.total_count) break;
            }

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

        async orgTeams(org) {
            const teams: OrgTeam[] = [];
            for await (const batch of pages<{ slug?: string; name?: string }>(
                `/orgs/${encodeURIComponent(org)}/teams`
            )) {
                for (const team of batch) {
                    if (team.slug) teams.push({ slug: team.slug, name: team.name ?? team.slug });
                }
            }
            return Object.freeze(teams);
        },

        async teamRepos(org, slug) {
            const repos: TeamRepo[] = [];
            for await (const batch of pages<RepoPayload>(
                `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/repos`
            )) {
                for (const repo of batch) {
                    if (!repo.name || !repo.owner?.login) continue;
                    repos.push({ owner: repo.owner.login, name: repo.name });
                }
            }
            return Object.freeze(repos);
        },

        async teamMembership(org, slug, login) {
            return probe(
                `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(login)}`
            );
        },

        async collaborator(owner, name, login) {
            // `affiliation=direct` — an org member who reaches the repo through a team is answered
            // by teamMembership instead, so counting them here too would only double the calls.
            return probe(
                `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(login)}?affiliation=direct`
            );
        },

        async orgMembers(org) {
            const members: OrgMember[] = [];
            for await (const batch of pages<{ login?: string; id?: number }>(
                `/orgs/${encodeURIComponent(org)}/members`
            )) {
                for (const member of batch) {
                    if (member.login && typeof member.id === 'number') {
                        members.push({ id: member.id, login: member.login.toLowerCase() });
                    }
                }
            }
            const admins: number[] = [];
            for await (const batch of pages<{ id?: number }>(`/orgs/${encodeURIComponent(org)}/members?role=admin`)) {
                for (const member of batch) {
                    if (typeof member.id === 'number') admins.push(member.id);
                }
            }
            return Object.freeze({ members: Object.freeze(members), admins: Object.freeze(admins) });
        },
    };
}
