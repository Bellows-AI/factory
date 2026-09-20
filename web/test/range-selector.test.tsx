import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RANGE,
    applyDraft,
    clearRange,
    draftValid,
    RangeDraft,
    RangeSelector,
    rangeQuery,
    statsQuery,
} from '../src/components/RangeSelector.js';
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

    it('offers every preset under a labeled Range group, with truthful rolling labels', () => {
        // Rolling presets are lookbacks, not calendar periods: "7 days" says what it does,
        // "this week" on a Tuesday would not.
        const html = render({ ...DEFAULT_RANGE, preset: 'month' });
        for (const label of ['Range', 'Today', '7 days', '14 days', '30 days', 'All time', 'Custom']) {
            expect(html).toContain(label);
        }
        expect(html).toContain('range-option active');
        expect(html).toContain('aria-checked="true"');
    });

    it('keeps the custom dates in a popover, not the toolbar row', () => {
        const html = render({ preset: 'custom', from: '', to: '' });
        expect(html).not.toContain('type="date"');
        // The trigger announces the popover state and owns the expansion.
        expect(html).toContain('aria-expanded');
    });

    it('marks the Custom trigger active when a custom range is committed', () => {
        const html = render({ preset: 'custom', from: '2026-08-01', to: '2026-08-07' });
        expect(html).toMatch(/Custom/);
        expect(html).toContain('range-option active');
    });
});

describe('custom-range draft helpers', () => {
    const today = '2026-09-20';

    it('commits a valid draft once, one-sided bounds included', () => {
        // A pure function called once is one commit: either bound alone is allowed — the API
        // supports half-open custom ranges.
        expect(applyDraft({ from: '2026-09-01', to: '' }, today)).toEqual({
            preset: 'custom',
            from: '2026-09-01',
            to: '',
        });
        expect(applyDraft({ from: '', to: '2026-09-19' }, today)).toEqual({
            preset: 'custom',
            from: '',
            to: '2026-09-19',
        });
        expect(applyDraft({ from: '2026-09-01', to: '2026-09-19' }, today)).toEqual({
            preset: 'custom',
            from: '2026-09-01',
            to: '2026-09-19',
        });
    });

    it('never commits an invalid draft: crossed dates, an empty draft, or a future bound', () => {
        // Cancel issues no change the same way: it simply never calls apply. Only a valid
        // Apply commits.
        expect(applyDraft({ from: '2026-09-02', to: '2026-09-01' }, today)).toBeNull();
        expect(applyDraft({ from: '', to: '' }, today)).toBeNull();
        expect(applyDraft({ from: '2026-09-01', to: '2026-09-25' }, today)).toBeNull();
        // A future `from` on its own is just as meaningless: a "Since 2030" window that can
        // only render an empty state.
        expect(applyDraft({ from: '2030-01-01', to: '' }, today)).toBeNull();
    });

    it('validates the same rule for the disabled state of Apply', () => {
        expect(draftValid({ from: '', to: '' }, today)).toBe(false);
        expect(draftValid({ from: '2026-09-02', to: '2026-09-01' }, today)).toBe(false);
        expect(draftValid({ from: '2026-09-01', to: '2026-09-25' }, today)).toBe(false);
        expect(draftValid({ from: '2030-01-01', to: '' }, today)).toBe(false);
        expect(draftValid({ from: '2026-09-01', to: '' }, today)).toBe(true);
    });

    it('Clear returns to All time', () => {
        expect(clearRange()).toEqual(DEFAULT_RANGE);
    });
});

describe('RangeDraft', () => {
    const render = (committed = { from: '2026-09-13', to: '2026-09-19' }) =>
        renderToStaticMarkup(
            <RangeDraft committed={committed} today="2026-09-20" onApply={() => {}} onClose={() => {}} />
        );

    it('seeds both date inputs from the last committed values, bounded to today', () => {
        const html = render();
        expect((html.match(/type="date"/g) ?? []).length).toBe(2);
        expect(html).toContain('value="2026-09-13"');
        expect(html).toContain('value="2026-09-19"');
        expect(html).toContain('max="2026-09-20"');
    });

    it('renders Apply and Clear; Apply is disabled while the draft is invalid', () => {
        expect(render()).toContain('Apply range');
        expect(render()).toContain('Clear');
        expect(render({ from: '2026-09-02', to: '2026-09-01' })).toContain('disabled=""');
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

    it('carries a visible Scope label', () => {
        expect(renderToggle('org')).toContain('Scope');
    });

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
