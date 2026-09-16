import { ALL_TIME, filterJobRuns, filterTelemetryInput, taskUsageStats, telemetryStats } from '@factory-ai/core';
import type {
    DateRange,
    JobRun,
    OrganizationMeta,
    TaskUsageStats,
    TelemetryInput,
    TelemetryStats,
} from '@factory-ai/core';
import { createCache } from './cache.js';
import type { AppConfig } from './config.js';
import type { RepoSource } from './github/repo-source.js';
import type { TelemetryClient } from './telemetry/client.js';
import { TelemetryError } from './telemetry/errors.js';

/**
 * Who the figures are computed for: the whole organization, or one member. The route resolves
 * the caller to this; `current()` applies it as a read-time filter over the same snapshot the
 * org scope reads — a scope switch never re-fetches.
 */
export type StatsScope = 'org' | { id: string; login: string };

export interface TelemetryMeta {
    status: 'ok' | 'empty' | 'unreachable' | 'disabled';
    reason: string | null;
    source: 'postgres' | 'fixture';
    fetchedAt: string | null;
    ageSeconds: number | null;
    stale: boolean;
    repoFilter: readonly string[];
    /** Sessions the hook attributed to a different repo. */
    otherRepoSessions: number;
    /** Sessions with telemetry but no hook data — the plugin is missing, or failing. */
    sessionsWithoutHook: number;
    /** Sessions no board task matches — the third exclusion, kept distinct from the two above. */
    unattributedSessions: number;
}

export interface TelemetrySnapshot {
    input: TelemetryInput;
    /** The organization's run rows, fetched beside the rollups for the per-task statistics. */
    runs: JobRun[];
}

export interface FetchState {
    state: 'idle' | 'loading' | 'error';
    startedAt: string | null;
    finishedAt: string | null;
    error: { message: string; code: string } | null;
}

export interface StatsPayload {
    telemetry: TelemetryStats | null;
    /**
     * What a task costs, over the same range and scope the telemetry block covers. Null exactly
     * when `telemetry` is — there is no snapshot to distribute over yet.
     */
    tasks: TaskUsageStats | null;
    meta: {
        fetchedAt: string;
        ageSeconds: number;
        stale: boolean;
        /**
         * Whose figures these are, and what else the caller could ask for.
         *
         * One block rather than a bare `org: string`, and in this payload rather than behind a
         * second `GET /api/orgs`: `current` has to ride here regardless — the store is partitioned
         * by organization, so a page that cannot name the one it is showing cannot be read — and
         * bundling `available` with it makes the pair atomic. Split across two requests,
         * `/api/orgs` can say "you may see A and B" while these figures were computed for A.
         */
        organization: OrganizationMeta;
        /** The repos this deployment reports on. */
        repos: { owner: string; name: string }[];
        range: DateRange;
        /**
         * The scope the figures were computed under, and — under caller scope — the member they
         * resolved to. An org payload names 'org' with a null login, so a reader can never
         * mistake whose numbers are on screen.
         */
        scope: 'org' | 'mine';
        scopeLogin: string | null;
        telemetry: TelemetryMeta;
    };
}

export interface StatsService {
    /**
     * Cached payload for a range and scope, or null if nothing has ever been fetched.
     *
     * `orgMeta` is what the payload's `meta.organization` carries: the org the figures were
     * computed for and what else THIS caller could ask for — resolved per request by the route,
     * because since #99 both are properties of the caller, not of the process. The route-test
     * default keeps the payload renderable when nobody resolved anything.
     */
    current(range?: DateRange, scope?: StatsScope, orgMeta?: OrganizationMeta): StatsPayload | null;
    /** Kicks off a refresh if one is warranted. Single-flight. */
    ensureFresh(): void;
    refresh(): void;
    fetchState(): FetchState;
}

export interface StatsServiceDeps {
    config: AppConfig;
    /**
     * Which repositories this organization measures. Was `config.repos`; it is a dependency now
     * because the answer comes from the GitHub App installation and is therefore a network read.
     */
    repos: RepoSource;
    telemetry: TelemetryClient;
    now?: () => number;
}

function idleState(): FetchState {
    return {
        state: 'idle',
        startedAt: null,
        finishedAt: null,
        error: null,
    };
}

/**
 * After a failed fetch, hold off before trying again. Without this every incoming request
 * restarts the fetch, so a dead database socket turns into a request loop. An explicit
 * POST /api/refresh bypasses it.
 */
const ERROR_COOLDOWN_MS = 30_000;

export function createStatsService({ config, repos, telemetry, now = Date.now }: StatsServiceDeps): StatsService {
    /**
     * The measured repos, as "owner/name" — the form the hook stamps onto every session.
     *
     * A function over the source's snapshot rather than a bound array, because the list can change
     * under the process now: somebody grants the App another repository and it appears without a
     * restart. Every async path calls `repos.list()` first, which is what refreshes the snapshot
     * this reads; `current()` deliberately does not, because it is synchronous and must stay a
     * pure re-aggregation of an already-fetched payload.
     */
    const repoNames = (): readonly string[] => repos.snapshotNames();

    let fetchState = idleState();
    let telemetryFailure: { at: number; reason: string } | null = null;

    async function produceTelemetry(): Promise<TelemetrySnapshot> {
        // Set before the first await, so a request arriving in the same tick as the refresh sees
        // 'loading' rather than 'idle' — that is what makes the cold-start 202 honest.
        fetchState = { ...idleState(), state: 'loading', startedAt: new Date(now()).toISOString() };

        try {
            // Refreshes the repo snapshot the scoping filter reads. The call is cached, so this
            // is usually free.
            await repos.list();
            const fetch = await telemetry.fetchRollups({ repos: repoNames() });
            telemetryFailure = null;
            fetchState = {
                ...fetchState,
                state: 'idle',
                finishedAt: new Date(now()).toISOString(),
            };
            return fetch;
        } catch (e) {
            telemetryFailure = {
                at: now(),
                reason: e instanceof TelemetryError ? e.message : (e as Error).message,
            };
            fetchState = {
                ...fetchState,
                state: 'error',
                finishedAt: new Date(now()).toISOString(),
                error: {
                    message: telemetryFailure.reason,
                    code: e instanceof TelemetryError ? e.code : 'UNKNOWN',
                },
            };
            throw e;
        }
    }

    const cache = createCache<TelemetrySnapshot>({
        ttlMs: config.telemetryTtlMs,
        produce: produceTelemetry,
        now,
    });

    const start = () => {
        // A rejected refresh is reported through fetchState; an unhandled rejection here
        // would take the process down.
        cache.refresh().catch(() => {});
    };

    function telemetryMeta(
        entry: { value: TelemetrySnapshot; fetchedAt: number } | null,
        stats: TelemetryStats | null,
        scopedNames: readonly string[]
    ): TelemetryMeta {
        const source = config.telemetrySource === 'postgres' ? 'postgres' : 'fixture';
        const base = {
            source,
            repoFilter: scopedNames,
            otherRepoSessions: stats?.otherRepoSessions ?? 0,
            sessionsWithoutHook: stats?.sessionsWithoutHook ?? 0,
            unattributedSessions: stats?.unattributedSessions ?? 0,
        } as const;

        if (config.telemetrySource === 'off') {
            return { ...base, status: 'disabled', reason: null, fetchedAt: null, ageSeconds: null, stale: false };
        }
        if (!entry) {
            return {
                ...base,
                status: 'unreachable',
                reason: telemetryFailure?.reason ?? 'No telemetry has been read yet',
                fetchedAt: null,
                ageSeconds: null,
                stale: false,
            };
        }
        return {
            ...base,
            // Reachable but silent is its own state: it lets the panels render their structure,
            // which is how you see the pipeline is wired and just has nothing to say yet. Judged
            // from the SCOPED stats — the status describes what THIS caller is looking at, so a
            // member whose subset holds no sessions sees "empty" even when the org-wide cache
            // does not.
            status: (stats?.totals.sessions ?? 0) === 0 ? 'empty' : 'ok',
            reason: telemetryFailure?.reason ?? null,
            fetchedAt: new Date(entry.fetchedAt).toISOString(),
            ageSeconds: Math.floor((now() - entry.fetchedAt) / 1000),
            stale: cache.isStale(),
        };
    }

    return {
        current(range = ALL_TIME, scope: StatsScope = 'org', orgMeta?: OrganizationMeta) {
            const entry = cache.peek();
            if (!entry) return null;

            // No scoping filter any more (#99): the per-user repo scope retired with auto-join,
            // and the caller's organization is chosen by the route resolving the caller, not by
            // filtering the repo list here. The whole snapshot is this org's.
            const all = repoNames();

            // Aggregated at read time, not at fetch time: telemetryStats() is pure over the
            // session list, so every range — and now every scope — is served from the one read
            // the database paid for. Caller scope filters the sessions the same way the range
            // does (and the runs beside them for the task statistics); it never narrows the
            // snapshot itself, which is what would cost a second fetch.
            const user = scope === 'org' ? undefined : { id: scope.id };
            const input = filterTelemetryInput(entry.value.input, range);
            const telemetry = telemetryStats(input, {
                repos: all,
                now: new Date(now()),
                range,
                ...(user ? { user } : {}),
            });
            // The org's full repo list on BOTH task inputs: the run rows are read org-wide, and
            // the sessions they attribute to come from the same list.
            const tasks = taskUsageStats(input.sessions, filterJobRuns(entry.value.runs, range), {
                repos: all,
                ...(user ? { user } : {}),
            });

            return {
                telemetry,
                tasks,
                meta: {
                    fetchedAt: new Date(entry.fetchedAt).toISOString(),
                    ageSeconds: Math.floor((now() - entry.fetchedAt) / 1000),
                    stale: cache.isStale(),
                    organization:
                        orgMeta ??
                        ({
                            // The route always supplies it; this default exists so the signature
                            // stays optional for the service's own tests. 'config' with one org is
                            // the only thing a service with no caller can honestly claim.
                            mode: 'config',
                            current: { id: 'default', name: 'default' },
                            available: [{ id: 'default', name: 'default' }],
                        } as OrganizationMeta),
                    repos: repos.snapshot().map((repo) => ({ owner: repo.owner, name: repo.name })),
                    range,
                    scope: scope === 'org' ? 'org' : 'mine',
                    scopeLogin: scope === 'org' ? null : scope.login,
                    telemetry: telemetryMeta(entry, telemetry, all),
                },
            };
        },

        ensureFresh() {
            if (config.telemetrySource === 'off') return;
            if (!cache.isStale() || cache.inFlight()) return;
            // A rejected read must not become a request loop against the database.
            if (telemetryFailure !== null && now() - telemetryFailure.at < ERROR_COOLDOWN_MS) return;
            start();
        },

        refresh() {
            if (config.telemetrySource === 'off') return;
            if (!cache.inFlight()) start();
        },

        fetchState: () => fetchState,
    };
}
