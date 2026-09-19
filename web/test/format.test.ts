import { describe, expect, it } from 'vitest';
import { relativeTime } from '../src/format.js';

/**
 * The inbox row's age in words, beside the precise `<time>` value the row also carries. Pure —
 * `now` is injected, the same contract `runDuration` and `wallClock` follow.
 */
describe('relativeTime', () => {
    const now = new Date('2026-09-15T12:00:00.000Z');
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

    it('buckets the recent past into just-now, minutes, hours and days', () => {
        expect(relativeTime(ago(10), now)).toBe('just now');
        expect(relativeTime(ago(90), now)).toBe('1m ago');
        expect(relativeTime(ago(3_599), now)).toBe('59m ago');
        expect(relativeTime(ago(3_600), now)).toBe('1h ago');
        expect(relativeTime(ago(86_399), now)).toBe('23h ago');
        expect(relativeTime(ago(90_000), now)).toBe('1d ago');
    });

    it('falls back to the date once the age is legible as one', () => {
        expect(relativeTime(ago(8 * 86_400), now)).toBe('2026-09-07');
    });

    it('answers a future stamp with just now, never a negative age', () => {
        expect(relativeTime(new Date(now.getTime() + 60_000).toISOString(), now)).toBe('just now');
    });

    it('is null-honest: a dash for anything absent or unparseable', () => {
        expect(relativeTime(null, now)).toBe('—');
        expect(relativeTime(undefined, now)).toBe('—');
        expect(relativeTime('not a stamp', now)).toBe('—');
    });
});
