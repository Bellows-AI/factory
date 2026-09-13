import { HOUR } from './config.js';

// ISO-8601 week: Monday-based, week 1 contains the first Thursday.
export function isoWeekKey(isoDate: string): string {
    const d = new Date(isoDate);
    const day = (d.getUTCDay() + 6) % 7;
    const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
    const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
    const firstDay = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
    const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * HOUR));
    return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function weekStart(isoDate: string): Date {
    const d = new Date(isoDate);
    const day = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
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
