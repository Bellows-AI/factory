import { describe, expect, it } from 'vitest';
import { int, relativeTime, timestamp, tokenPair, utcRange } from '../src/format.js';

/** The clock is always injected, so every expectation here is frozen, never flaky. */
const NOW = new Date('2026-08-21T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('int', () => {
    it('renders the exact value, grouped for reading', () => {
        const MILLIONS = 1_234_567;
        expect(int(MILLIONS)).toBe('1,234,567');
        expect(int(0)).toBe('0');
        const HUNDREDS = 999;
        expect(int(HUNDREDS)).toBe('999');
        const NEGATIVE_THOUSANDS = -42_000;
        expect(int(NEGATIVE_THOUSANDS)).toBe('-42,000');
    });

    it('rounds a fractional figure to the exact integer it names', () => {
        const FRACTIONAL = 12.6;
        expect(int(FRACTIONAL)).toBe('13');
    });

    it('renders unmeasured as an em dash', () => {
        expect(int(null)).toBe('—');
        expect(int(undefined)).toBe('—');
    });
});

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

describe('relativeTime', () => {
    it('reads seconds and minutes as human recency', () => {
        const THIRTY_SECONDS_MS = 30_000;
        expect(relativeTime(ago(THIRTY_SECONDS_MS), NOW)).toBe('just now');
        const FIVE_MINUTES = 5;
        expect(relativeTime(ago(FIVE_MINUTES * MS_PER_MINUTE), NOW)).toBe('5m ago');
        const FIFTY_NINE_MINUTES = 59;
        expect(relativeTime(ago(FIFTY_NINE_MINUTES * MS_PER_MINUTE), NOW)).toBe('59m ago');
    });

    it('climbs through hours and days', () => {
        const THREE_HOURS = 3;
        expect(relativeTime(ago(THREE_HOURS * MS_PER_HOUR), NOW)).toBe('3h ago');
        const TWO_DAYS = 2;
        expect(relativeTime(ago(TWO_DAYS * MS_PER_DAY), NOW)).toBe('2d ago');
        const TWENTY_NINE_DAYS = 29;
        expect(relativeTime(ago(TWENTY_NINE_DAYS * MS_PER_DAY), NOW)).toBe('29d ago');
    });

    it('falls back to the date beyond a month, where relative time becomes a guess', () => {
        const FORTY_DAYS = 40;
        expect(relativeTime(ago(FORTY_DAYS * MS_PER_DAY), NOW)).toBe('2026-07-12');
    });

    it('never claims a negative age, however the clocks skew', () => {
        const FIVE_MINUTES = 5;
        const future = new Date(NOW.getTime() + FIVE_MINUTES * MS_PER_MINUTE).toISOString();
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
