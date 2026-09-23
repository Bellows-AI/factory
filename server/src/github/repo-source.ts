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
    /** "owner/name" for the snapshot — the form every repo identity takes here. */
    snapshotNames(): readonly string[];
    list(): Promise<readonly Repo[]>;
    /** The picker's view: everything the installation can see, plus who it belongs to. */
    detail(): Promise<{ repos: readonly InstallationRepo[]; installation: Installation | null }>;
    /** The last failure, so a route can report a stale list honestly rather than as an empty one. */
    lastError(): string | null;
    /** When the cached list was fetched, or null if it never was. */
    fetchedAt(): number | null;
    /**
     * Ages the cached produce past its TTL so the next read re-runs it — the allowlist
     * intersection included (#125). The stale entry keeps serving until the refresh lands, so
     * there is no empty-snapshot window between the invalidate and the re-produce.
     */
    invalidate(): void;
}

/**
 * How long a repo list is trusted.
 *
 * Long, because the answer changes when a human installs or uninstalls the App — minutes-scale,
 * not seconds — and every read of it costs a rate-limit point. Short enough that granting the App
 * a new repository shows up without a restart, which is the whole workflow this replaced
 * ORG_REPOS to enable.
 */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const INSTALLATION_REPOS_TTL_MINUTES = 10;

export const INSTALLATION_REPOS_TTL_MS = INSTALLATION_REPOS_TTL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

// Re-exported so the test helpers keep one import site.
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
    /**
     * The org's tracked-repo allowlist (#125), as "owner/name" — the onboarding screen's per-org
     * checkbox answer, read from `tracked_repo`. Empty or absent means everything the
     * installation reports: the default, and the reason a confirm-with-everything-checked writes
     * nothing. The intersection is applied to whatever the source produced (client listing or
     * stored fallback), so stats scoping, `otherRepoSessions` and the workspace/env writes all
     * follow one truth — a session on an unselected repo stays counted, in `otherRepoSessions`.
     */
    readonly allowlist?: (() => Promise<readonly string[]>) | undefined;
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
    allowlist,
    ttlMs = INSTALLATION_REPOS_TTL_MS,
    now = Date.now,
}: RepoSourceDeps): RepoSource {
    const empty = Object.freeze([]) as readonly InstallationRepo[];
    let error: string | null = null;

    // The one place the allowlist bites: whatever the cache produces is narrowed here, so every
    // accessor — snapshot, list, detail — carries the same tracked set. Re-read per produce, so a
    // changed allowlist lands on the next refresh rather than being cached with the list.
    const narrow = async (listing: {
        repos: readonly InstallationRepo[];
        installation: Installation | null;
    }): Promise<{ repos: readonly InstallationRepo[]; installation: Installation | null }> => {
        if (!allowlist) return listing;
        const tracked = await allowlist();
        if (tracked.length === 0) return listing;
        const allowed = new Set(tracked);
        return { ...listing, repos: Object.freeze(listing.repos.filter((repo) => allowed.has(fullName(repo)))) };
    };

    const cache = createCache<{ repos: readonly InstallationRepo[]; installation: Installation | null }>({
        ttlMs,
        now,
        produce: async () => {
            if (!client) {
                if (!stored) return { repos: empty, installation: null };
                const names = await stored();
                const repos = names.map(parseFullName).filter((repo): repo is InstallationRepo => repo !== null);
                return narrow({ repos: Object.freeze(repos), installation: null });
            }
            try {
                const listing = await client.listRepositories();
                error = null;
                return await narrow(listing);
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
        invalidate: () => cache.expire(),
    };
}

/** A fixed list. The route tests use this instead of reaching GitHub. */
export interface StaticRepoSource extends RepoSource {
    /** How many times the source was invalidated — the route tests' observable. */
    invalidations(): number;
}

export function staticRepoSource(repos: readonly Repo[]): StaticRepoSource {
    const detailed = Object.freeze(
        repos.map((repo) => Object.freeze({ ...repo, private: false, defaultBranch: null, pushedAt: null }))
    ) as readonly InstallationRepo[];
    let invalidations = 0;
    return {
        snapshot: () => detailed,
        snapshotNames: () => detailed.map(fullName),
        list: async () => detailed,
        detail: async () => ({ repos: detailed, installation: null }),
        lastError: () => null,
        fetchedAt: () => 0,
        invalidate: () => {
            invalidations += 1;
        },
        invalidations: () => invalidations,
    };
}
