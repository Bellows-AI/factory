import { HOUR } from './config.js';
import { isoWeekKey, ratio, weekStart } from './metrics.js';
import type {
    SessionRollup,
    TelemetryInput,
    TelemetryStats,
    TelemetryWeekPoint,
    TokenTotals,
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

function acceptRatio(accepted: number | null, rejected: number | null): number | null {
    const total = sum([accepted, rejected]);
    if (total === null || accepted === null) return null;
    return ratio(accepted, total);
}

export interface TelemetryStatsOptions {
    /** Only sessions the hook tagged with one of these repos are counted. */
    repos?: readonly string[];
    /** Injected so the `partial` week flag is testable against a frozen fixture. */
    now?: Date;
}

interface WeekBucket {
    week: string;
    start: string;
    sessions: number;
    tokens: { tokens: TokenTotals }[];
    linesAdded: number;
    linesRemoved: number;
}

function weeklySeries(sessions: SessionRollup[], now: Date): TelemetryWeekPoint[] {
    if (!sessions.length) return [];

    const weeks = new Map<string, WeekBucket>();
    const emptyWeek = (date: string): WeekBucket => ({
        week: isoWeekKey(date),
        start: weekStart(date).toISOString().slice(0, 10),
        sessions: 0,
        tokens: [],
        linesAdded: 0,
        linesRemoved: 0,
    });

    // Seed every week in the window, including the quiet ones: a series that closes its own
    // gaps overstates activity.
    const first = sessions[0] as SessionRollup;
    const earliest = sessions.reduce((min, s) => (s.firstSeen < min ? s.firstSeen : min), first.firstSeen);
    const latest = sessions.reduce((max, s) => (s.firstSeen > max ? s.firstSeen : max), first.firstSeen);
    const cursor = weekStart(earliest);
    const last = weekStart(latest);
    while (cursor <= last) {
        const iso = cursor.toISOString();
        weeks.set(isoWeekKey(iso), emptyWeek(iso));
        cursor.setUTCDate(cursor.getUTCDate() + 7);
    }

    for (const session of sessions) {
        const key = isoWeekKey(session.firstSeen);
        if (!weeks.has(key)) weeks.set(key, emptyWeek(session.firstSeen));
        const bucket = weeks.get(key) as WeekBucket;
        bucket.sessions += 1;
        bucket.tokens.push(session);
        bucket.linesAdded += session.linesAdded ?? 0;
        bucket.linesRemoved += session.linesRemoved ?? 0;
    }

    const currentWeek = isoWeekKey(now.toISOString());
    return [...weeks.values()]
        .sort((a, b) => a.week.localeCompare(b.week))
        .map(({ tokens, ...rest }) => ({
            ...rest,
            tokens: sumTokens(tokens),
            partial: rest.week === currentWeek,
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
export function telemetryStats(
    input: TelemetryInput,
    options: TelemetryStatsOptions = {},
): TelemetryStats {
    const { repos, now = new Date() } = options;
    const inRepoScope = (name: string) => repos === undefined || repos.includes(name);

    const inScope: SessionRollup[] = [];
    let otherRepoSessions = 0;
    let sessionsWithoutHook = 0;
    for (const session of input.sessions) {
        if (session.repo === null) sessionsWithoutHook += 1;
        else if (!inRepoScope(session.repo)) otherRepoSessions += 1;
        else inScope.push(session);
    }

    const totalsTokens = sumTokens(inScope);
    const totalAccepted = sum(inScope.map((s) => s.editsAccepted));
    const totalRejected = sum(inScope.map((s) => s.editsRejected));
    const totalActive = sum(inScope.map((s) => s.activeSeconds));

    return {
        totals: {
            sessions: inScope.length,
            tokens: totalsTokens,
            activeHours: totalActive === null ? null : (totalActive * 1000) / HOUR,
            linesAdded: sum(inScope.map((s) => s.linesAdded)),
            linesRemoved: sum(inScope.map((s) => s.linesRemoved)),
            acceptRatio: acceptRatio(totalAccepted, totalRejected),
        },
        otherRepoSessions,
        sessionsWithoutHook,
        weekly: weeklySeries(inScope, now),
        coverage: input.coverage,
    };
}
