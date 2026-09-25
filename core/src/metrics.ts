import { HOUR } from './config.js';

// getUTCDay() is Sunday-based (Sun=0..Sat=6); ISO weeks are Monday-based, so this offset
// rotates Monday to 0 and Sunday to 6.
const ISO_WEEKDAY_OFFSET = 6;
const DAYS_PER_WEEK = 7;
// Monday of an ISO week plus this offset lands on that week's Thursday.
const THURSDAY_OFFSET = 3;
// January 4th always falls in ISO week 1, so it anchors the first-week calculation.
const JANUARY = 0;
const JANUARY_ANCHOR_DAY = 4;
const HOURS_PER_DAY = 24;

// ISO-8601 week: Monday-based, week 1 contains the first Thursday.
export function isoWeekKey(isoDate: string): string {
    const d = new Date(isoDate);
    const day = (d.getUTCDay() + ISO_WEEKDAY_OFFSET) % DAYS_PER_WEEK;
    const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + THURSDAY_OFFSET));
    const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), JANUARY, JANUARY_ANCHOR_DAY));
    const firstDay = (firstThursday.getUTCDay() + ISO_WEEKDAY_OFFSET) % DAYS_PER_WEEK;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + THURSDAY_OFFSET);
    const week =
        1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (DAYS_PER_WEEK * HOURS_PER_DAY * HOUR));
    return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function weekStart(isoDate: string): Date {
    const d = new Date(isoDate);
    const day = (d.getUTCDay() + ISO_WEEKDAY_OFFSET) % DAYS_PER_WEEK;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

/** UTC calendar day of an instant: 23:30 and 00:15 land in different days, never a local one. */
export function dayStart(isoDate: string): Date {
    const d = new Date(isoDate);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** `YYYY-MM-DD` — the day bucket's map key, and its own bucket start. */
export function dayKey(isoDate: string): string {
    return dayStart(isoDate).toISOString().slice(0, 10);
}

/**
 * Returns null on a zero denominator, never 0. The entire unavailable-vs-zero contract on the
 * page rests on this: "0 reverts in 0 commits" reads as a real answer, and a 0/0 that became 0
 * would too.
 */
export function ratio(part: number, whole: number): number | null {
    if (whole === 0) return null;
    return part / whole;
}
