import { createCache, type Cache } from '../cache.js';
import { fullName } from '../config.js';
import type { Role } from '../auth/store.js';
import type { Roster } from '../auth/reconcile.js';
import type { UserRepoAccessStore } from '../db/user-repo-access-store.js';
import type { GitHubAppClient, TeamRepo } from './app-client.js';
import type { RepoSource } from './repo-source.js';

/**
 * How long the org-wide answers (the team list, each team's repos) are trusted. The 10-minute
 * figure and the reasoning are the repo list's (repo-source.ts): the answer changes when a human
 * edits GitHub, and every read spends the installation's rate limit.
 */
export const ACCESS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Per-user repo scoping, computed with the credential the server already holds.
 *
 * The question "which of the installation's repos can this account reach?" is answered by
 * enumerating, server-side, with the installation token: the org's teams and each team's repos
 * (org-wide answers, cached — they would otherwise be re-fetched on every login), plus a direct
 * collaborator probe per not-yet-reachable repo. No new OAuth scope, no second token, no consent
 * screen change: the App installation already sees everything this asks, and the person's own
 * token stays exactly as scoped as it was.
 *
 * The result is stored per user and intersected with the installation list on every read, so a
 * repo pulled from the App stops matching immediately, while a team change lands at the next
 * sign-in (or the sweep, for members who never sign out and in).
 */
export interface RepoAccessScope {
    /**
     * Recomputes one user's reachable set and stores it. Throws when GitHub could not be asked —
     * callers log and move on, leaving the last computed set to stand, which is why the store is
     * only ever written on a successful enumeration.
     */
    refreshUser(userId: string, login: string): Promise<void>;
    /**
     * The user's stored set intersected with the current installation list, or null when nothing
     * has ever been computed — the fail-open-for-the-uncomputed case that keeps accounts which
     * pre-date scoping working until their next sign-in.
     */
    scopedNames(userId: string): Promise<readonly string[] | null>;
    /** GitHub id → org role, under the login GitHub currently knows. The roster sync's input. */
    roster(): Promise<Roster>;
}

export interface RepoAccessScopeDeps {
    appClient: GitHubAppClient;
    repos: RepoSource;
    org: string;
    access: UserRepoAccessStore;
    ttlMs?: number;
    now?: () => number;
}

export function createRepoAccessScope({
    appClient,
    repos,
    org,
    access,
    ttlMs = ACCESS_CACHE_TTL_MS,
    now = Date.now,
}: RepoAccessScopeDeps): RepoAccessScope {
    const teams = createCache<readonly { slug: string }[]>({
        ttlMs,
        now,
        produce: async () => await appClient.orgTeams(org),
    });

    // One slot per team, created on demand: a team's repo list is an org-wide answer, so the
    // second user to sign in pays nothing for the first user's walk.
    const teamRepos = new Map<string, Cache<readonly TeamRepo[]>>();
    const teamReposFor = (slug: string): Cache<readonly TeamRepo[]> => {
        let cache = teamRepos.get(slug);
        if (!cache) {
            cache = createCache<readonly TeamRepo[]>({
                ttlMs,
                now,
                produce: async () => await appClient.teamRepos(org, slug),
            });
            teamRepos.set(slug, cache);
        }
        return cache;
    };

    // cache.refresh() is unconditional; the TTL decision is the caller's, same as repo-source's
    // load(): serve the live entry until it goes stale, then refresh it single-flight.
    const cached = async <T>(cache: Cache<T>): Promise<T> => {
        if (!cache.isStale()) return cache.peek()!.value;
        return (await cache.refresh()).value;
    };

    return {
        async refreshUser(userId, login) {
            // list(), not snapshot(): the refresh path, so a cold cache is warmed here rather than
            // intersecting against an empty list — which would wrongly store "can reach nothing".
            const listed = await repos.list();
            // list() never throws; a failed fetch comes back as an EMPTY list with lastError set.
            // Persisting that intersection would overwrite a good set with an authoritative
            // "nothing" — every scoped route then denies until the next sign-in — so an
            // empty-because-unreachable read aborts the refresh and the last computed set stands.
            // An empty list with NO error is a real state: the installation has no repositories.
            if (listed.length === 0 && repos.lastError()) {
                throw new Error(`Cannot refresh repository access: ${repos.lastError()}`);
            }
            const installation = listed.map(fullName);

            const reachable = new Set<string>();
            for (const team of await cached(teams)) {
                if (!(await appClient.teamMembership(org, team.slug, login))) continue;
                for (const repo of await cached(teamReposFor(team.slug))) {
                    reachable.add(`${repo.owner}/${repo.name}`);
                }
            }
            // Direct collaborator probes only for the repos the teams did not already grant: the
            // team path bounds the cost to teams, this one to whatever is left of the installation.
            for (const name of installation) {
                if (reachable.has(name)) continue;
                const slash = name.indexOf('/');
                if (await appClient.collaborator(name.slice(0, slash), name.slice(slash + 1), login)) {
                    reachable.add(name);
                }
            }

            // Intersection with the installation is the point: team grants can outlive the App's
            // repository selection, and a name the installation cannot see is one no clone could
            // fetch anyway.
            await access.setRepos(
                userId,
                installation.filter((name) => reachable.has(name))
            );
        },

        async scopedNames(userId) {
            const stored = await access.repos(userId);
            if (stored === null) return null;
            const current = new Set(repos.snapshotNames());
            return stored.filter((name) => current.has(name));
        },

        async roster() {
            const { members, admins } = await appClient.orgMembers(org);
            const adminIds = new Set(admins);
            return new Map(
                members.map((member) => [
                    member.id,
                    { login: member.login, role: (adminIds.has(member.id) ? 'admin' : 'member') as Role },
                ])
            );
        },
    };
}
