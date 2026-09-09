import { createCache } from '../cache.js';
import { fullName, type Repo } from '../config.js';
import type { GitHubAppClient, Installation, InstallationRepo } from './app-client.js';

/**
 * The repo list, cached, in the shape the rest of the server wants it.
 *
 * This is what `AppConfig.repos` used to be. The difference that shapes the interface: the list is
 * now a network read, so it cannot be a field. Two accessors rather than one, because the two
 * callers genuinely differ —
 *
 * - `list()` is what the refresh path uses. It may go to GitHub, and it is always awaited.
 * - `snapshot()` is what `StatsService.current()` uses, and that method is synchronous by design:
 *   it aggregates an already-fetched payload over a date range and must not become a fetch. It
 *   returns the last known list, empty until something has loaded one.
 *
 * A single async accessor would have forced `current()` to become async, which would have turned
 * every read of a cached payload into a promise for a value that was already in memory.
 */
export interface RepoSource {
    /** Never blocks, never fetches. Empty until the first successful `list()`. */
    snapshot(): readonly Repo[];
    /** "owner/name" for the snapshot — the form stamped onto every stored PR. */
    snapshotNames(): readonly string[];
    list(): Promise<readonly Repo[]>;
    /** The picker's view: everything the installation can see, plus who it belongs to. */
    detail(): Promise<{ repos: readonly InstallationRepo[]; installation: Installation | null }>;
    /** The last failure, so a route can report a stale list honestly rather than as an empty one. */
    lastError(): string | null;
    /** When the cached list was fetched, or null if it never was. */
    fetchedAt(): number | null;
}

/**
 * How long a repo list is trusted.
 *
 * Long, next to the sync TTL, because the answer changes when a human installs or uninstalls the
 * App — minutes-scale, not seconds — and every read of it costs a rate-limit point. Short enough
 * that granting the App a new repository shows up without a restart, which is the whole workflow
 * this replaced ORG_REPOS to enable.
 */
export const INSTALLATION_REPOS_TTL_MS = 10 * 60 * 1000;

// Re-exported so `github/client.ts` and the test helpers keep one import site.
export { fullName };

export interface RepoSourceDeps {
    /** Absent under the code-only `none` arm (the offline tooling), where `stored` answers instead. */
    readonly client?: GitHubAppClient | undefined;
    /**
     * The repos this organization already has rows for, as "owner/name".
     *
     * Used only when there is no App client. Without it a credential-less process reports no repos,
     * and since every stored read is scoped by the repo list, a warm database would render as an
     * empty dashboard — which is what `npm run seed` followed by `npm run verify:ui` is.
     */
    readonly stored?: (() => Promise<readonly string[]>) | undefined;
    readonly ttlMs?: number;
    readonly now?: () => number;
}

/** "owner/name" back to a Repo. A repo name cannot contain a slash, so the first one splits it. */
function parseFullName(name: string): InstallationRepo | null {
    const slash = name.indexOf('/');
    if (slash <= 0 || slash === name.length - 1) return null;
    return Object.freeze({
        owner: name.slice(0, slash),
        name: name.slice(slash + 1),
        // Unknown rather than guessed: nothing stored says whether a repo is private, and the
        // picker is not reachable in this mode anyway — there is nothing to clone from.
        private: false,
        defaultBranch: null,
        pushedAt: null,
    });
}

export function createRepoSource({
    client,
    stored,
    ttlMs = INSTALLATION_REPOS_TTL_MS,
    now = Date.now,
}: RepoSourceDeps): RepoSource {
    const empty = Object.freeze([]) as readonly InstallationRepo[];
    let error: string | null = null;

    const cache = createCache<{ repos: readonly InstallationRepo[]; installation: Installation | null }>({
        ttlMs,
        now,
        produce: async () => {
            if (!client) {
                if (!stored) return { repos: empty, installation: null };
                const names = await stored();
                const repos = names
                    .map(parseFullName)
                    .filter((repo): repo is InstallationRepo => repo !== null);
                return { repos: Object.freeze(repos), installation: null };
            }
            try {
                const listing = await client.listRepositories();
                error = null;
                return { repos: listing.repos, installation: listing.installation };
            } catch (failure) {
                // Recorded and rethrown. The cache keeps its last good entry either way; recording
                // it here is what lets a route serve that entry AND say it is stale, rather than
                // choosing between a lie and an empty page.
                error = (failure as Error).message;
                throw failure;
            }
        },
    });

    const load = async (): Promise<{
        repos: readonly InstallationRepo[];
        installation: Installation | null;
    }> => {
        if (!cache.isStale()) return cache.peek()!.value;
        try {
            return (await cache.refresh()).value;
        } catch {
            // A failed refresh serves the last good list. Nothing on the read path can do anything
            // useful with a thrown error here — the stored figures are still worth rendering — and
            // `lastError()` carries the reason to whoever wants to show it.
            return cache.peek()?.value ?? { repos: empty, installation: null };
        }
    };

    return {
        snapshot: () => cache.peek()?.value.repos ?? empty,
        snapshotNames: () => (cache.peek()?.value.repos ?? empty).map(fullName),
        list: async () => (await load()).repos,
        detail: load,
        lastError: () => error,
        fetchedAt: () => cache.peek()?.fetchedAt ?? null,
    };
}

/** A fixed list. The route tests and `npm run seed` use this instead of reaching GitHub. */
export function staticRepoSource(repos: readonly Repo[]): RepoSource {
    const detailed = Object.freeze(
        repos.map((repo) =>
            Object.freeze({ ...repo, private: false, defaultBranch: null, pushedAt: null }),
        ),
    ) as readonly InstallationRepo[];
    return {
        snapshot: () => detailed,
        snapshotNames: () => detailed.map(fullName),
        list: async () => detailed,
        detail: async () => ({ repos: detailed, installation: null }),
        lastError: () => null,
        fetchedAt: () => 0,
    };
}
