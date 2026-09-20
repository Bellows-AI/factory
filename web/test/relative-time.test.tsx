import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { relativeTime } from '../src/format.js';
import { RelativeTime } from '../src/components/RelativeTime.js';

/**
 * The board section's finish stamp: relative to a caller-supplied `now` (pure, renderable
 * offline), with the precise UTC stamp on hover/focus via the `title`.
 */

const NOW = new Date('2026-08-21T12:00:00.000Z');

describe('relativeTime', () => {
    it('buckets by minute, hour and day', () => {
        expect(relativeTime('2026-08-21T11:59:40.000Z', NOW)).toBe('just now');
        expect(relativeTime('2026-08-21T11:31:00.000Z', NOW)).toBe('29m ago');
        expect(relativeTime('2026-08-21T09:00:00.000Z', NOW)).toBe('3h ago');
        expect(relativeTime('2026-08-19T12:00:00.000Z', NOW)).toBe('2d ago');
        // Beyond 48h the day count takes over entirely — no "47h ago".
        expect(relativeTime('2026-08-18T11:00:00.000Z', NOW)).toBe('3d ago');
    });

    it('renders absence and nonsense as an em dash', () => {
        expect(relativeTime(null, NOW)).toBe('—');
        expect(relativeTime(undefined, NOW)).toBe('—');
        expect(relativeTime('not a date', NOW)).toBe('—');
    });
});

describe('RelativeTime', () => {
    it('renders a <time dateTime> with the precise UTC stamp as its title', () => {
        const html = renderToStaticMarkup(<RelativeTime at="2026-08-21T09:00:00.000Z" now={NOW} />);
        expect(html).toContain('<time dateTime="2026-08-21T09:00:00.000Z" title="2026-08-21 09:00">3h ago</time>');
    });

    it('renders an em dash for an absent stamp, with no time element', () => {
        const html = renderToStaticMarkup(<RelativeTime at={null} now={NOW} />);
        expect(html).toBe('—');
    });
});
