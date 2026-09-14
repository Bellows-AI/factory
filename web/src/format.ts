/**
 * A null metric means "not measurable", which is never the same as zero. Every formatter
 * renders it as an em dash; callers must not substitute `?? 0`, and must not test
 * truthiness, because 0 is a real value here.
 */
export const pct = (value: number | null | undefined): string =>
    value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;

export const num = (value: number | null | undefined, digits = 1): string =>
    value === null || value === undefined ? '—' : Number(value.toFixed(digits)).toString();

export function duration(hours: number | null | undefined): string {
    if (hours === null || hours === undefined) return '—';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 48) return `${num(hours, 1)}h`;
    return `${num(hours / 24, 1)}d`;
}

/**
 * A checkout's size on disk.
 *
 * Null is an em dash like everything else here, and it matters more than usual: a repository that
 * is still cloning has no size, and `0 B` would read as an empty repository rather than as one
 * nobody has measured. Powers of 1024, because this is disk.
 */
export function bytes(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${num(size, size < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Just the day. A commit's time of day is noise in a table of repositories. */
export function commitDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? '—' : at.toISOString().slice(0, 10);
}

/**
 * A task's stamp in the chat: the time of day is the useful part there, unlike a commit table, so
 * the date stays only to disambiguate older threads. UTC, like every formatter here — a constant
 * offset the whole team reads the same way beats a local one nobody can compare.
 */
export function taskTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '—';
    const utc = at.toISOString();
    return `${utc.slice(0, 10)} ${utc.slice(11, 16)}`;
}

/**
 * How long a run has taken, or took: from the attempt's start to its finish, or — while it is
 * still going — to `now`, which the caller decides so this stays pure (the detail page re-renders
 * on every 2s poll, which is the ticker). A dash for anything absent, unparseable, or ending
 * before it started: a negative duration is a lie, not a number.
 */
export function runDuration(
    startedAt: string | null | undefined,
    endedAt: string | null | undefined,
    now: Date = new Date()
): string {
    if (!startedAt) return '—';
    const from = new Date(startedAt);
    if (Number.isNaN(from.getTime())) return '—';
    const to = endedAt === null || endedAt === undefined ? now : new Date(endedAt);
    if (Number.isNaN(to.getTime()) || to.getTime() < from.getTime()) return '—';
    return duration((to.getTime() - from.getTime()) / 3_600_000);
}

/**
 * A task's overall wall clock: what the board has banked for the thread so far, plus the head
 * run's live in-flight segment while it is still going (`runningSince` is passed only then — a
 * finished run's stale start stamp would double-count a segment the board already banked). A
 * dash where nothing has been banked and nothing is going: null means "no clock", which is not
 * zero. Pure, like `runDuration` — the caller decides what "now" is, and the detail page's 2s
 * poll is the ticker.
 */
export function wallClock(
    totalMs: number | null | undefined,
    runningSince: string | null | undefined,
    now: Date = new Date()
): string {
    const banked = totalMs ?? 0; // feeds the sum only — the null contract is the dash branch below
    let live = 0;
    if (runningSince) {
        const from = new Date(runningSince);
        if (!Number.isNaN(from.getTime())) live = Math.max(0, now.getTime() - from.getTime());
    }
    if (totalMs == null && live === 0) return '—';
    return duration((banked + live) / 3_600_000);
}

/**
 * Rounded on purpose. The branch attribution behind these figures is a ~20s sample from a
 * hook that is allowed to fail, so "92.4k" is the honest precision and "92,431" is not.
 */
export function tokens(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    if (value < 1000) return String(Math.round(value));
    if (value < 1_000_000) return `${num(value / 1000, 1)}k`;
    // Billions are routine once cache reads are counted — a real run showed 4.5e9, which
    // rendered as the unreadable "4543.89M" before this branch existed.
    if (value < 1_000_000_000) return `${num(value / 1_000_000, 2)}M`;
    return `${num(value / 1_000_000_000, 2)}B`;
}
