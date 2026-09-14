import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE, RangeSelector, rangeQuery } from '../src/components/RangeSelector.js';

describe('rangeQuery', () => {
    it('sends the preset alone', () => {
        expect(rangeQuery({ ...DEFAULT_RANGE, preset: 'week' })).toBe('range=week');
    });

    it('falls back to all time while a custom range has no bound yet', () => {
        // Otherwise every keystroke between picking Custom and picking a date is a 400.
        expect(rangeQuery({ preset: 'custom', from: '', to: '' })).toBe('range=all');
    });

    it('sends a half-open custom range without an empty parameter', () => {
        expect(rangeQuery({ preset: 'custom', from: '2026-08-01', to: '' })).toBe('range=custom&from=2026-08-01');
    });

    it('sends both bounds when both are set', () => {
        expect(rangeQuery({ preset: 'custom', from: '2026-08-01', to: '2026-08-07' })).toBe(
            'range=custom&from=2026-08-01&to=2026-08-07'
        );
    });
});

describe('RangeSelector', () => {
    const render = (range = DEFAULT_RANGE) => renderToStaticMarkup(<RangeSelector range={range} onChange={() => {}} />);

    it('offers every preset and marks the active one', () => {
        const html = render({ ...DEFAULT_RANGE, preset: 'month' });
        for (const label of ['Today', 'This week', 'Two weeks', 'Month', 'All time', 'Custom']) {
            expect(html).toContain(label);
        }
        expect(html).toContain('range-option active');
        expect(html).toContain('aria-pressed="true"');
    });

    it('shows the date inputs only for a custom range', () => {
        expect(render()).not.toContain('type="date"');
        expect(render({ preset: 'custom', from: '', to: '' })).toContain('type="date"');
    });

    it('says what it is showing while a custom range is still empty', () => {
        expect(render({ preset: 'custom', from: '', to: '' })).toContain('showing all time');
        expect(render({ preset: 'custom', from: '2026-08-01', to: '' })).not.toContain('showing all time');
    });

    it('stops the from picker from crossing the to date', () => {
        const html = render({ preset: 'custom', from: '', to: '2026-08-07' });
        expect(html).toContain('max="2026-08-07"');
    });
});
