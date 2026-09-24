import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RANGE,
    applyDraft,
    clearRange,
    draftProblem,
    draftValid,
    presetChange,
    rangeLabel,
    RangeDraft,
    RangeSelector,
    rangeQuery,
    statsQuery,
} from '../src/components/RangeSelector.js';
import type { ScopeSelection } from '../src/components/RangeSelector.js';
import { ScopeToggle } from '../src/components/ScopeToggle.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');

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

describe('rangeLabel', () => {
    it('labels a preset by its rolling name, never the resolved dates', () => {
        // Rolling presets are lookbacks, not calendar periods: "7 days" says what it does,
        // "this week" on a Tuesday would not.
        expect(rangeLabel({ ...DEFAULT_RANGE, preset: 'month' }, NOW)).toBe('30 days');
        expect(rangeLabel({ ...DEFAULT_RANGE, preset: 'all' }, NOW)).toBe('All time');
        expect(rangeLabel({ ...DEFAULT_RANGE, preset: 'day' }, NOW)).toBe('Today');
    });

    it('labels a committed custom window by the days it covers', () => {
        expect(rangeLabel({ preset: 'custom', from: '2026-07-01', to: '2026-08-01' }, NOW)).toBe('Jul 1 – Aug 1');
        expect(rangeLabel({ preset: 'custom', from: '2026-07-01', to: '' }, NOW)).toBe('Since Jul 1');
    });

    it('labels a boundless custom selection as Custom', () => {
        // Picked but not yet typed into: the trigger should not lie about a window that was
        // never committed.
        expect(rangeLabel({ preset: 'custom', from: '', to: '' }, NOW)).toBe('Custom');
    });
});

describe('presetChange', () => {
    it('commits a preset, carrying any custom bounds along unused', () => {
        expect(presetChange({ preset: 'custom', from: '2026-07-01', to: '2026-08-01' }, 'week')).toEqual({
            preset: 'week',
            from: '2026-07-01',
            to: '2026-08-01',
        });
    });

    it('returns null for custom — Custom opens the picker, it never commits by itself', () => {
        expect(presetChange(DEFAULT_RANGE, 'custom')).toBeNull();
    });
});

describe('draftProblem', () => {
    const today = '2026-09-20';

    it('names a crossed range', () => {
        expect(draftProblem({ from: '2026-09-02', to: '2026-09-01' }, today)).toBe(
            'The start date must be on or before the end date.'
        );
    });

    it('names a future bound', () => {
        expect(draftProblem({ from: '2030-01-01', to: '' }, today)).toBe("Dates can't be later than today.");
        expect(draftProblem({ from: '2026-09-01', to: '2026-09-25' }, today)).toBe("Dates can't be later than today.");
    });

    it('is silent for an empty or a genuinely valid draft', () => {
        expect(draftProblem({ from: '', to: '' }, today)).toBeNull();
        expect(draftProblem({ from: '2026-09-01', to: '' }, today)).toBeNull();
        expect(draftProblem({ from: '2026-09-01', to: '2026-09-19' }, today)).toBeNull();
    });
});

describe('RangeSelector', () => {
    const render = (range = DEFAULT_RANGE) => renderToStaticMarkup(<RangeSelector range={range} onChange={() => {}} />);

    it('renders one labeled Range dropdown showing the current selection', () => {
        const html = render({ ...DEFAULT_RANGE, preset: 'month' });
        expect(html).toContain('<legend');
        expect(html).toContain('>Range<');
        expect(html).toContain('id="range-select"');
        expect(html).toContain('aria-haspopup="listbox"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('>30 days</button>');
        // The preset-buttons row is gone: no radio semantics, no range-option class.
        expect(html).not.toContain('role="radio"');
        expect(html).not.toContain('range-option');
    });

    it('keeps the custom dates out of the toolbar row entirely', () => {
        const html = render({ preset: 'custom', from: '', to: '' });
        expect(html).not.toContain('type="date"');
        expect(html).toContain('>Custom</button>');
    });

    it('shows the committed custom window on the trigger, not the word Custom', () => {
        const html = render({ preset: 'custom', from: '2026-08-14', to: '2026-08-20' });
        expect(html).toContain('>Aug 14–20</button>');
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

    it('labels the two fields Start date and End date', () => {
        const html = render();
        expect(html).toContain('Start date');
        expect(html).toContain('End date');
    });

    it('offers Clear, Cancel and a primary Apply range, in that order', () => {
        const html = render();
        expect(html).toContain('Clear');
        expect(html).toContain('Cancel');
        expect(html).toContain('Apply range');
        expect(html.indexOf('Clear')).toBeLessThan(html.indexOf('Cancel'));
        expect(html.indexOf('Cancel')).toBeLessThan(html.indexOf('Apply range'));
        expect(html).toMatch(/class="primary"[^>]*>Apply range/);
    });

    it('disables Apply and explains a crossed range', () => {
        const html = render({ from: '2026-09-02', to: '2026-09-01' });
        expect(html).toContain('disabled=""');
        expect(html).toContain('The start date must be on or before the end date.');
    });

    it('shows no error line for a valid or an empty draft', () => {
        // Not just the message text: the line itself must not be mounted, or an empty draft
        // still reserves the space a real error would take.
        expect(render()).not.toContain('status error');
        expect(render({ from: '', to: '' })).not.toContain('status error');
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

    it('renders one labeled Scope dropdown, no radio semantics', () => {
        const html = renderToggle('org');
        expect(html).toContain('<legend');
        expect(html).toContain('>Scope<');
        expect(html).toContain('id="scope-select"');
        expect(html).toContain('aria-haspopup="listbox"');
        expect(html).not.toContain('role="radio"');
        expect(html).not.toContain('range-option');
    });

    it('shows the selected scope on the trigger, spelled out in full', () => {
        expect(renderToggle('org')).toContain('>Organization</button>');
        expect(renderToggle('mine')).toContain('>Personal</button>');
    });
});
