import type { DateRange, TaskUsageStats, TelemetryStats } from '@factory-ai/core';
import type { StatsPayload } from './api/useStats.js';
import type { RangeSelection, ScopeSelection } from './components/RangeSelector.js';

/**
 * The rendered-data summary and the empty/degraded state decisions, in one pure module.
 *
 * The authority for every figure on screen is the payload's meta — `meta.range`, `meta.scope`,
 * `meta.telemetry.repoFilter` — never the requested selection, which is only the NEXT read.
 * These helpers describe what is rendered; the page labels a pending change on top of that.
 *
 * All date math runs on the payload's instants alone — no `new Date()` — so frozen-instant
 * tests pin the copy exactly.
 */

/**
 * The last calendar day an exclusive `to` covers: one millisecond back, so a bound the server
 * widened to next midnight (a `YYYY-MM-DD` from the date input) presents as the day the user
 * chose, while a mid-day bound still presents as its own day.
 */
function inclusiveEndDay(to: string): string {
    const last = new Date(Date.parse(to) - 1);
    return last.toISOString().slice(0, 10);
}

/** The UTC calendar day of an instant, `YYYY-MM-DD` — never the reader's local offset. */
function utcDay(iso: string): string {
    return new Date(iso).toISOString().slice(0, 10);
}

/** `Sep 13` — the short UTC form the range copy is built from. */
function shortDay(day: string): string {
    const at = new Date(`${day}T00:00:00.000Z`);
    return at.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) + ` ${at.getUTCDate()}`;
}

function boundedDays(from: string, to: string): string {
    const start = utcDay(from);
    const end = inclusiveEndDay(to);
    if (start === end) return shortDay(start);
    if (start.slice(0, 7) === end.slice(0, 7)) return `${shortDay(start)}–${end.slice(8)}`;
    return `${shortDay(start)} – ${shortDay(end)}`;
}

/**
 * The requested window in calendar words: "Sep 13–19", "Since Sep 13", "Through Sep 19",
 * "All time". Presets resolve to instants the user never typed, so the days come from the
 * resolved bounds like any custom window.
 */
export function rangeText(range: DateRange): string {
    if (range.from === null && range.to === null) return 'All time';
    if (range.from === null) return `Through ${shortDay(inclusiveEndDay(range.to as string))}`;
    if (range.to === null) return `Since ${shortDay(utcDay(range.from))}`;
    return boundedDays(range.from, range.to);
}

/** The scope in words — the same word the toolbar renders, so the sentence agrees with it. */
export function scopeWord(scope: ScopeSelection): string {
    return scope === 'org' ? 'Organization' : 'Personal';
}

/** Window and scope, without repositories — the Sessions line and the Updating-to suffix. */
export function selectionText(range: DateRange, scope: ScopeSelection): string {
    return `${rangeText(range)} · ${scopeWord(scope)}`;
}

/** Read-only coverage, not a filter: zero, one, or a plural count. */
export function countRepos(repoFilter: readonly string[]): string {
    if (repoFilter.length === 0) return 'No repositories configured';
    if (repoFilter.length === 1) return '1 repository';
    return `${repoFilter.length} tracked repositories`;
}

/** The one-line rendered-data sentence: window · scope · coverage, all from payload meta. */
export function renderedSelection(meta: StatsPayload['meta']): string {
    return `${rangeText(meta.range)} · ${scopeWord(meta.scope)} · ${countRepos(meta.telemetry.repoFilter)}`;
}

/**
 * Whether the REQUESTED selection differs from what the payload rendered. An empty custom
 * draft rides the wire as all-time, so it compares as all-time; custom bounds compare as the
 * days the user typed against the bounds the server normalized. False means the payload is
 * exactly what was asked for.
 */
export function selectionMismatch(range: RangeSelection, scope: ScopeSelection, meta: StatsPayload['meta']): boolean {
    if (scope !== meta.scope) return true;
    const rendered = meta.range;
    if (range.preset !== 'custom') return range.preset !== rendered.preset;
    if (!range.from && !range.to) return rendered.preset !== 'all';
    if (rendered.preset !== 'custom') return true;
    return boundMismatch(range.from, rendered.from, 'from') || boundMismatch(range.to, rendered.to, 'to');
}

/** Custom bounds match bound by bound: the typed day against the payload's normalized bound. */
function boundMismatch(typed: string, bound: string | null, edge: 'from' | 'to'): boolean {
    if (!typed) return bound !== null;
    if (bound === null) return true;
    const day = edge === 'to' ? inclusiveEndDay(bound) : utcDay(bound);
    return day !== typed;
}

/** Which analytics shape the page renders — decided once, above the panels. */
export type AnalyticsState = 'ready' | 'partial' | 'empty';

/**
 * `ready` renders the full summary; `partial` is task measurements without telemetry sessions
 * (the compact empty state plus per-task usage); `empty` is one analytics empty state
 * replacing every telemetry section. A measured zero session count is not fabricated into
 * figures either way.
 */
export function analyticsState(telemetry: TelemetryStats, tasks: TaskUsageStats | null): AnalyticsState {
    if (telemetry.totals.sessions > 0) return 'ready';
    const measured =
        tasks !== null &&
        [tasks.tokensPerTask, tasks.jobTurnsPerTask, tasks.agentTurnsPerTask, tasks.wallClockPerTask].some(
            (d) => d.tasks > 0
        );
    return measured ? 'partial' : 'empty';
}

/**
 * The one empty state's copy: the rendered selection it names, and exactly one next action —
 * broaden the range when the store holds coverage outside the rendered window, or run an
 * agent session when the store itself is quiet.
 */
export function emptyStateCopy(telemetry: TelemetryStats, meta: StatsPayload['meta']): string {
    const selection = `${rangeText(meta.range)} · ${scopeWord(meta.scope)}`;
    const { from, to } = telemetry.coverage;
    const outside =
        (meta.range.from !== null && from !== null && from < meta.range.from) ||
        (meta.range.to !== null && to !== null && to > meta.range.to);
    if (outside) return `No agent sessions in ${selection}. Broaden the range to reach the coverage the store holds.`;
    return `No agent sessions in ${selection}. Run an agent session to populate the store.`;
}
