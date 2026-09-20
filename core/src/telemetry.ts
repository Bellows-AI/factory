import { HOUR } from './config.js';
import { dayKey, dayStart, isoWeekKey, ratio, weekStart } from './metrics.js';
import type { DateRange } from './range.js';
import type {
    EditAcceptance,
    SessionRollup,
    TelemetryInput,
    TelemetryPoint,
    TelemetryStats,
    TokenTotals,
    UserRef,
} from './types.js';

/**
 * Sums the measured values and returns null only when nothing was measured at all.
 * A missing contributor must not drag a real total down to a smaller real number, and an
 * all-missing total must not read as zero.
 */
function sum(values: (number | null | undefined)[]): number | null {
    let total = 0;
    let seen = false;
    for (const value of values) {
        if (value === null || value === undefined) continue;
        total += value;
        seen = true;
    }
    return seen ? total : null;
}

function sumTokens(items: { tokens: TokenTotals }[]): TokenTotals {
    return {
        input: sum(items.map((i) => i.tokens.input)),
        output: sum(items.map((i) => i.tokens.output)),
        cacheRead: sum(items.map((i) => i.tokens.cacheRead)),
        cacheCreation: sum(items.map((i) => i.tokens.cacheCreation)),
    };
}

/**
 * Assembles the edit-acceptance figures from the measured sums. `decisions` is the null-aware
 * denominator; the ratio stays null unless the numerator was measured AND something was —
 * a rejected count alone proves nothing about acceptance, and zero measured decisions have
 * no ratio (`ratio()` nulls the zero denominator, keeping 0-of-0 distinct from unmeasured).
 */
function editAcceptance(accepted: number | null, rejected: number | null): EditAcceptance {
    const decisions = sum([accepted, rejected]);
    return {
        accepted,
        rejected,
        decisions,
        ratio: accepted === null || decisions === null ? null : ratio(accepted, decisions),
    };
}

export interface TelemetryStatsOptions {
    /** Only sessions the hook tagged with one of these repos are counted. */
    repos?: readonly string[];
    /** Injected so the `partial` bucket flag is testable against a frozen fixture. */
    now?: Date;
    /**
     * Scopes every figure to the caller: only sessions whose landed user matches count toward
     * the totals, the series and `byUser`. Unattributed sessions stay out of the totals but
     * keep being named by `unattributedSessions` — out of "mine" is not the same as invisible.
     * Coverage and the two setup-failure counters describe the store, not the caller, and are
     * deliberately untouched.
     */
    user?: { id: string };
    /**
     * The selected window, for the series granularity rule: day at ≤ 92 days of window, week
     * beyond — and for all-time, the coverage span decides. The range never changes WHICH
     * sessions are aggregated (that already happened); it only picks the bucket size.
     */
    range?: DateRange;
}

interface Bucket {
    key: string;
    start: string;
    sessions: number;
    tokens: { tokens: TokenTotals }[];
    linesAdded: number;
    linesRemoved: number;
}

const DAY_MS = 86_400_000;

/**
 * Day buckets when the window (or, unbounded, the coverage span) is at most 92 days — the
 * width at which a fixed-width chart of daily bars stops being information and starts being
 * hairlines — and ISO weeks beyond.
 */
export function seriesGranularity(range: DateRange | undefined, input: TelemetryInput, now: Date): 'day' | 'week' {
    let from = range?.from !== undefined && range.from !== null ? Date.parse(range.from) : null;
    let to = range?.to !== undefined && range.to !== null ? Date.parse(range.to) : null;
    // An unbounded edge falls back to what the store actually holds: for all-time that IS the
    // coverage span, and an empty store answers a zero span (day, with no points) honestly.
    if (from === null) from = input.coverage.from !== null ? Date.parse(input.coverage.from) : (to ?? now.getTime());
    if (to === null) to = input.coverage.to !== null ? Date.parse(input.coverage.to) : now.getTime();
    return to - from <= 92 * DAY_MS ? 'day' : 'week';
}

function bucketSeries(sessions: SessionRollup[], granularity: 'day' | 'week', now: Date): TelemetryPoint[] {
    if (!sessions.length) return [];
    const daily = granularity === 'day';
    const keyOf = daily ? dayKey : isoWeekKey;
    const startOf = daily ? dayStart : weekStart;
    const stepDays = daily ? 1 : 7;

    const buckets = new Map<string, Bucket>();
    const emptyBucket = (iso: string): Bucket => ({
        key: keyOf(iso),
        start: startOf(iso).toISOString().slice(0, 10),
        sessions: 0,
        tokens: [],
        linesAdded: 0,
        linesRemoved: 0,
    });

    // Seed every bucket in the window, including the quiet ones: a series that closes its own
    // gaps overstates activity.
    const first = sessions[0] as SessionRollup;
    const earliest = sessions.reduce((min, s) => (s.firstSeen < min ? s.firstSeen : min), first.firstSeen);
    const latest = sessions.reduce((max, s) => (s.firstSeen > max ? s.firstSeen : max), first.firstSeen);
    const cursor = startOf(earliest);
    const last = startOf(latest);
    while (cursor <= last) {
        const iso = cursor.toISOString();
        buckets.set(keyOf(iso), emptyBucket(iso));
        cursor.setUTCDate(cursor.getUTCDate() + stepDays);
    }

    for (const session of sessions) {
        const key = keyOf(session.firstSeen);
        if (!buckets.has(key)) buckets.set(key, emptyBucket(session.firstSeen));
        const bucket = buckets.get(key) as Bucket;
        bucket.sessions += 1;
        bucket.tokens.push(session);
        bucket.linesAdded += session.linesAdded ?? 0;
        bucket.linesRemoved += session.linesRemoved ?? 0;
    }

    const current = keyOf(now.toISOString());
    return [...buckets.values()]
        .sort((a, b) => a.start.localeCompare(b.start))
        .map(({ tokens, ...rest }) => ({
            start: rest.start,
            sessions: rest.sessions,
            tokens: sumTokens(tokens),
            linesAdded: rest.linesAdded,
            linesRemoved: rest.linesRemoved,
            partial: rest.key === current,
        }));
}

/**
 * Aggregates agent telemetry into the figures the dashboard renders.
 *
 * Pure, like every aggregation in core. The fetch lives in the server; only the arithmetic
 * lives here. Sessions the hook tagged with a repo outside `repos` are counted in
 * `otherRepoSessions` rather than the totals, and sessions with no hook report at all are
 * counted in `sessionsWithoutHook` — three different setup failures must stay distinguishable.
 */
export function telemetryStats(input: TelemetryInput, options: TelemetryStatsOptions = {}): TelemetryStats {
    const { repos, now = new Date(), user } = options;
    const inRepoScope = (name: string) => repos === undefined || repos.includes(name);

    const repoScoped: SessionRollup[] = [];
    let otherRepoSessions = 0;
    let sessionsWithoutHook = 0;
    for (const session of input.sessions) {
        if (session.repo === null) sessionsWithoutHook += 1;
        else if (!inRepoScope(session.repo)) otherRepoSessions += 1;
        else repoScoped.push(session);
    }

    // Caller scope is a filter, applied after the repo filter and before every figure below:
    // a session the join attributed to someone else is out of "mine" entirely. Unattributed
    // sessions are out too — but they keep their own figure, so "mine" narrows honestly.
    const inScope = user ? repoScoped.filter((s) => s.user !== null && s.user.id === user.id) : repoScoped;

    const totalsTokens = sumTokens(inScope);
    const totalAccepted = sum(inScope.map((s) => s.editsAccepted));
    const totalRejected = sum(inScope.map((s) => s.editsRejected));
    const totalActive = sum(inScope.map((s) => s.activeSeconds));

    // Group by the user's id, not the object: two rows resolved from the same app_user must
    // land in one bucket. Sessions with no user are counted, never dropped — the same honesty
    // rule as sessionsWithoutHook. The count runs over the repo-scoped set, so the
    // unattributed figure means the same thing under both scopes.
    const byUser = new Map<string, { user: UserRef; sessions: SessionRollup[] }>();
    let unattributedSessions = 0;
    for (const session of repoScoped) {
        if (session.user === null) {
            unattributedSessions += 1;
            continue;
        }
        if (user && session.user.id !== user.id) continue;
        const bucket = byUser.get(session.user.id);
        if (bucket) bucket.sessions.push(session);
        else byUser.set(session.user.id, { user: session.user, sessions: [session] });
    }

    const granularity = seriesGranularity(options.range, input, now);

    return {
        totals: {
            sessions: inScope.length,
            tokens: totalsTokens,
            activeHours: totalActive === null ? null : (totalActive * 1000) / HOUR,
            linesAdded: sum(inScope.map((s) => s.linesAdded)),
            linesRemoved: sum(inScope.map((s) => s.linesRemoved)),
            editAcceptance: editAcceptance(totalAccepted, totalRejected),
        },
        otherRepoSessions,
        sessionsWithoutHook,
        byUser: [...byUser.values()]
            .map(({ user, sessions }) => ({ user, sessions: sessions.length, tokens: sumTokens(sessions) }))
            .sort((a, b) => a.user.login.localeCompare(b.user.login)),
        unattributedSessions,
        series: { granularity, points: bucketSeries(inScope, granularity, now) },
        coverage: input.coverage,
    };
}
