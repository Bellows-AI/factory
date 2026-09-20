import { describe, expect, it } from 'vitest';
import { int, relativeTime, timestamp, tokenPair, utcRange } from '../src/format.js';

/** The clock is always injected, so every expectation here is frozen, never flaky. */
const NOW = new Date('2026-08-21T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('int', () => {
    it('renders the exact value, grouped for reading', () => {
        expect(int(1_234_567)).toBe('1,234,567');
        expect(int(0)).toBe('0');
        expect(int(999)).toBe('999');
        expect(int(-42_000)).toBe('-42,000');
    });

    it('rounds a fractional figure to the exact integer it names', () => {
        expect(int(12.6)).toBe('13');
    });

    it('renders unmeasured as an em dash', () => {
        expect(int(null)).toBe('—');
        expect(int(undefined)).toBe('—');
    });
});

describe('relativeTime', () => {
    it('reads seconds and minutes as human recency', () => {
        expect(relativeTime(ago(30_000), NOW)).toBe('just now');
        expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5m ago');
        expect(relativeTime(ago(59 * 60_000), NOW)).toBe('59m ago');
    });

    it('climbs through hours and days', () => {
        expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3h ago');
        expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe('2d ago');
        expect(relativeTime(ago(29 * 86_400_000), NOW)).toBe('29d ago');
    });

    it('falls back to the date beyond a month, where relative time becomes a guess', () => {
        expect(relativeTime(ago(40 * 86_400_000), NOW)).toBe('2026-07-12');
    });

    it('never claims a negative age, however the clocks skew', () => {
        const future = new Date(NOW.getTime() + 5 * 60_000).toISOString();
        expect(relativeTime(future, NOW)).toBe('just now');
    });

    it('renders absent or unparseable input as an em dash', () => {
        expect(relativeTime(null, NOW)).toBe('—');
        expect(relativeTime('not a date', NOW)).toBe('—');
    });
});

describe('timestamp', () => {
    it('renders the full UTC stamp, seconds included', () => {
        expect(timestamp('2026-08-21T06:45:03Z')).toBe('2026-08-21 06:45:03');
    });

    it('renders absent or unparseable input as an em dash', () => {
        expect(timestamp(null)).toBe('—');
        expect(timestamp('not a date')).toBe('—');
    });
});

describe('utcRange', () => {
    it('spans both ends in UTC days', () => {
        expect(utcRange('2026-04-15T12:00:00Z', '2026-08-21T06:45:00Z')).toBe('2026-04-15 → 2026-08-21 UTC');
    });

    it('dashes an unmeasured end rather than guessing it', () => {
        expect(utcRange(null, '2026-08-21T00:00:00Z')).toBe('— → 2026-08-21 UTC');
        expect(utcRange('2026-04-15T00:00:00Z', null)).toBe('2026-04-15 → — UTC');
    });

    it('renders a wholly unbounded range as an em dash', () => {
        expect(utcRange(null, null)).toBe('—');
    });
});

describe('tokenPair', () => {
    it('renders input and output side by side, each through the tokens rounding', () => {
        expect(tokenPair({ input: 12_345, output: 678 })).toBe('12.3k / 678');
    });

    it('keeps an unmeasured side an em dash, never a zero', () => {
        expect(tokenPair({ input: null, output: 4_500 })).toBe('— / 4.5k');
        expect(tokenPair({ input: null, output: null })).toBe('— / —');
    });
});
