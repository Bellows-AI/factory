import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE, RangeSelector, rangeQuery, statsQuery } from '../src/components/RangeSelector.js';
import type { ScopeSelection } from '../src/components/RangeSelector.js';
import { ScopeToggle } from '../src/components/ScopeToggle.js';

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
        expect(html).toContain('aria-checked="true"');
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

describe('statsQuery', () => {
    // The scope rides the same query string the range does, which is the whole wiring: useStats
    // keys on the string, so a scope change re-polls with `scope=mine` and a range change
    // re-polls with the scope preserved — no state reconciliation anywhere.
    it('omits the scope parameter under the default org scope', () => {
        expect(statsQuery({ ...DEFAULT_RANGE, preset: 'month' }, 'org')).toBe('range=month');
        expect(statsQuery(DEFAULT_RANGE, 'org')).toBe('range=all');
    });

    it('appends scope=mine for caller scope', () => {
        expect(statsQuery({ ...DEFAULT_RANGE, preset: 'month' }, 'mine')).toBe('range=month&scope=mine');
        expect(statsQuery({ ...DEFAULT_RANGE, preset: 'all' }, 'mine')).toBe('range=all&scope=mine');
    });

    it('keeps the scope across a range change, and the range across a scope change', () => {
        expect(statsQuery({ ...DEFAULT_RANGE, preset: 'week' }, 'mine')).toBe('range=week&scope=mine');
        expect(statsQuery({ preset: 'custom', from: '2026-08-01', to: '2026-08-07' }, 'mine')).toBe(
            'range=custom&from=2026-08-01&to=2026-08-07&scope=mine'
        );
    });
});

describe('ScopeToggle', () => {
    const renderToggle = (scope: ScopeSelection) =>
        renderToStaticMarkup(<ScopeToggle scope={scope} onChange={() => {}} />);

    it('offers Org and Me and marks the active one', () => {
        // The RadioGroup renders real buttons in the radiogroup role; `aria-checked` is how the
        // state is read, not aria-pressed.
        expect(renderToggle('org')).toContain('Org');
        expect(renderToggle('org')).toContain('Me');
        expect(renderToggle('org')).toContain('aria-checked="true"');
        expect(renderToggle('mine')).toMatch(/Me<\/button>/);
    });

    it('marks org active only when org is selected', () => {
        // The `active` class is how the state is seen; both buttons render either way.
        const org = renderToggle('org');
        expect(org).toContain('Org</button>');
    });
});
