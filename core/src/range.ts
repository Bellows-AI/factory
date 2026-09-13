import type { TelemetryInput } from './types.js';

export type RangePreset = 'day' | 'week' | '2w' | 'month' | 'all' | 'custom';

export const RANGE_PRESETS: RangePreset[] = ['day', 'week', '2w', 'month', 'all', 'custom'];

export interface DateRange {
    preset: RangePreset;
    /** Inclusive lower bound, ISO instant. null means unbounded. */
    from: string | null;
    /** Exclusive upper bound, ISO instant. null means unbounded. */
    to: string | null;
}

export const ALL_TIME: DateRange = { preset: 'all', from: null, to: null };

const DAY_MS = 86_400_000;

const PRESET_DAYS: Record<'day' | 'week' | '2w' | 'month', number> = {
    day: 1,
    week: 7,
    '2w': 14,
    month: 30,
};

export function isRangePreset(value: string): value is RangePreset {
    return (RANGE_PRESETS as string[]).includes(value);
}

/**
 * Presets are a rolling lookback from `now`, not a calendar period: "this week" on a Tuesday
 * would otherwise report two days and read as a collapse in activity.
 */
export function resolveRange(
    preset: RangePreset,
    now: Date,
    custom?: { from?: string | null; to?: string | null },
): DateRange {
    if (preset === 'all') return ALL_TIME;
    if (preset === 'custom') {
        return { preset, from: custom?.from ?? null, to: custom?.to ?? null };
    }
    return {
        preset,
        from: new Date(now.getTime() - PRESET_DAYS[preset] * DAY_MS).toISOString(),
        to: now.toISOString(),
    };
}

export function isAllTime(range: DateRange): boolean {
    return range.from === null && range.to === null;
}

function overlaps(from: string, to: string, range: DateRange): boolean {
    if (range.from !== null && to < range.from) return false;
    if (range.to !== null && from >= range.to) return false;
    return true;
}

/**
 * Sessions are intervals, so they are kept on overlap rather than containment: a session
 * running across the range boundary did real work inside the range, and dropping it
 * would understate usage exactly at the edge the user is looking at.
 *
 * `coverage` is deliberately untouched — it reports what the store holds, which is how the UI
 * distinguishes "no AI usage in this range" from "telemetry does not reach back this far".
 */
export function filterTelemetryInput(input: TelemetryInput, range: DateRange): TelemetryInput {
    if (isAllTime(range)) return input;
    return {
        sessions: input.sessions.filter((s) => overlaps(s.firstSeen, s.lastSeen, range)),
        coverage: input.coverage,
    };
}
