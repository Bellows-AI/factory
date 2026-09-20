import { describe, expect, it } from 'vitest';
import { exactInt, preciseTimestamp, updatedAgo } from '../src/format.js';

/**
 * The freshness cluster and the rendered-data summary format time on the page. These helpers
 * are pure — every `now` is injected, every locale explicit — so the copy is pinned, not
 * whatever the run machine's clock and locale produce.
 */

const NOW = new Date('2026-09-20T12:00:00.000Z');

describe('updatedAgo', () => {
    it('says just now inside the first minute', () => {
        expect(updatedAgo('2026-09-20T11:59:40.000Z', NOW)).toBe('just now');
    });

    it('counts minutes and hours', () => {
        expect(updatedAgo('2026-09-20T11:56:00.000Z', NOW)).toBe('4 min ago');
        expect(updatedAgo('2026-09-20T10:00:00.000Z', NOW)).toBe('2 hr ago');
    });

    it('counts days beyond the first day', () => {
        expect(updatedAgo('2026-09-17T12:00:00.000Z', NOW)).toBe('3 d ago');
    });

    it('degrades to a dash on absent or unparseable stamps', () => {
        expect(updatedAgo(null, NOW)).toBe('—');
        expect(updatedAgo('not a date', NOW)).toBe('—');
    });
});

describe('preciseTimestamp', () => {
    it('renders the full localized stamp when the locale is given', () => {
        // Pinned with an explicit locale; callers omit it to get the user's own.
        expect(preciseTimestamp('2026-08-21T12:00:00.000Z', 'en-US')).toContain('2026');
    });

    it('degrades to a dash on absent or unparseable stamps', () => {
        expect(preciseTimestamp(null, 'en-US')).toBe('—');
        expect(preciseTimestamp('garbage', 'en-US')).toBe('—');
    });
});

describe('exactInt', () => {
    it('groups digits and renders a measured zero as 0', () => {
        expect(exactInt(12345)).toBe('12,345');
        expect(exactInt(0)).toBe('0');
    });

    it('degrades to a dash on null — unmeasured is not zero', () => {
        expect(exactInt(null)).toBe('—');
    });
});
