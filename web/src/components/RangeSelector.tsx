import type { RangePreset } from '@factory-ai/core';
import {
    Dialog,
    DialogBackdrop,
    DialogPanel,
    DialogTitle,
    Listbox,
    ListboxButton,
    ListboxOption,
    ListboxOptions,
} from '@headlessui/react';
import { useState } from 'react';
import { useDownwardAnchor } from '../anchor.js';
import { rangeText, requestedRange } from '../dashboardSummary.js';

export interface RangeSelection {
    preset: RangePreset;
    /** `YYYY-MM-DD`, as submitted by the date inputs. Only read when preset is 'custom'. */
    from: string;
    to: string;
}

export const DEFAULT_RANGE: RangeSelection = { preset: 'all', from: '', to: '' };

const RANGE_BUTTON_ID = 'range-select';

const PRESET_LABELS: { preset: RangePreset; label: string }[] = [
    { preset: 'day', label: 'Today' },
    { preset: 'week', label: '7 days' },
    { preset: '2w', label: '14 days' },
    { preset: 'month', label: '30 days' },
    { preset: 'all', label: 'All time' },
    { preset: 'custom', label: 'Custom' },
];

/**
 * A custom range with neither bound entered is sent as all-time rather than as an incomplete
 * custom range: the alternative is a 400 for every keystroke between picking 'Custom' and
 * choosing a date.
 */
export function rangeQuery(range: RangeSelection): string {
    if (range.preset !== 'custom') return `range=${range.preset}`;
    if (!range.from && !range.to) return 'range=all';
    const params = new URLSearchParams({ range: 'custom' });
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    return params.toString();
}

/** Who the dashboard's figures are for. `mine` rides the request as `?scope=mine`. */
export type ScopeSelection = 'org' | 'mine';

export const DEFAULT_SCOPE: ScopeSelection = 'org';

/**
 * The full stats query: the range, then the scope. Pure and exported so the wiring is pinnable —
 * `useStats` keys on this string, which is what makes a scope switch a re-poll with `scope=mine`
 * and a range change a re-poll that KEEPS the scope, with no state reconciliation anywhere.
 */
export function statsQuery(range: RangeSelection, scope: ScopeSelection): string {
    return scope === 'org' ? rangeQuery(range) : `${rangeQuery(range)}&scope=mine`;
}

/**
 * The Range trigger's text: a preset shows its rolling name (truthful — "7 days" is a lookback,
 * not "this week"); a committed custom window shows the days it covers, read the same way the
 * summary sentence reads them; a custom selection with no bound yet — Custom picked but not typed
 * into — shows the word itself rather than lying about a window nobody chose.
 */
export function rangeLabel(range: RangeSelection, now: Date): string {
    if (range.preset !== 'custom') {
        return PRESET_LABELS.find(({ preset }) => preset === range.preset)!.label;
    }
    if (!range.from && !range.to) return 'Custom';
    return rangeText(requestedRange(range, now));
}

/**
 * The Range dropdown's commit rule: picking a preset commits it immediately, custom bounds
 * carried along unused; picking Custom commits nothing — it only opens the picker, which is why
 * this returns null rather than a selection.
 */
export function presetChange(range: RangeSelection, option: RangePreset): RangeSelection | null {
    if (option === 'custom') return null;
    return { ...range, preset: option };
}

/**
 * The custom-draft validity rule, shared by the Apply button's disabled state and by
 * `applyDraft`: both bounds empty is not a range, `from` may not cross `to`, and neither bound
 * reaches past today. One bound on its own is a legitimate half-open range — the API takes it.
 */
export function draftValid(draft: { from: string; to: string }, today: string): boolean {
    if (!draft.from && !draft.to) return false;
    return draftProblem(draft, today) === null;
}

/**
 * What is wrong with a draft, in words — or null for an empty or a genuinely valid one. An empty
 * draft is silent rather than invalid: nothing has been typed yet, so nothing needs explaining.
 */
export function draftProblem(draft: { from: string; to: string }, today: string): string | null {
    if ((draft.from && draft.from > today) || (draft.to && draft.to > today)) {
        return "Dates can't be later than today.";
    }
    if (draft.from && draft.to && draft.from > draft.to) {
        return 'The start date must be on or before the end date.';
    }
    return null;
}

/**
 * The draft-commit rule: a valid draft becomes the custom selection; an invalid draft commits
 * nothing — null, and the caller keeps whatever is committed. Cancel, Escape and outside clicks
 * commit nothing the same way: they simply never call this.
 */
export function applyDraft(draft: { from: string; to: string }, today: string): RangeSelection | null {
    if (!draftValid(draft, today)) return null;
    return { preset: 'custom', from: draft.from, to: draft.to };
}

/** Clear abandons the custom window entirely: back to All time. */
export function clearRange(): RangeSelection {
    return DEFAULT_RANGE;
}

/**
 * The custom-range dialog's draft form. Draft values are LOCAL state seeded from the last
 * committed bounds at mount — a controlled `Dialog` with no `transition` prop wraps its panel in
 * Headless UI's `Transition` with `unmount` defaulting to true, so the panel (and this component)
 * unmounts on close and reopening re-seeds from what was committed; an abandoned draft is
 * discarded. Typing here never issues a request; only Apply (a valid draft, committed once) and
 * Clear (back to All time) commit, and both close — Cancel and Escape close without committing
 * anything.
 */
export function RangeDraft({
    committed,
    today,
    onApply,
    onClose,
}: {
    committed: { from: string; to: string };
    today: string;
    onApply: (next: RangeSelection) => void;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState(committed);
    const problem = draftProblem(draft, today);
    const apply = () => {
        const next = applyDraft(draft, today);
        if (next) onApply(next);
        onClose();
    };
    return (
        <div className="range-draft">
            <div className="range-draft-fields">
                <label>
                    Start date
                    <input
                        type="date"
                        value={draft.from}
                        max={draft.to || today}
                        onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                    />
                </label>
                <label>
                    End date
                    <input
                        type="date"
                        value={draft.to}
                        min={draft.from || undefined}
                        max={today}
                        onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                    />
                </label>
            </div>
            {problem !== null ? (
                <p className="status error" role="alert">
                    {problem}
                </p>
            ) : null}
            <div className="range-draft-actions">
                <button
                    type="button"
                    onClick={() => {
                        onApply(clearRange());
                        onClose();
                    }}
                >
                    Clear
                </button>
                <button type="button" onClick={onClose}>
                    Cancel
                </button>
                <button type="button" className="primary" onClick={apply} disabled={!draftValid(draft, today)}>
                    Apply range
                </button>
            </div>
        </div>
    );
}

/**
 * The Range group of the analytics toolbar (issue 246): one labeled dropdown built from the
 * shared quiet-selector language (issue 224) — the presets commit immediately; Custom commits
 * nothing and opens a Headless UI Dialog holding the draft (`RangeDraft`) in the shared dialog
 * shell, never an inline expansion. The trigger shows the current selection, so the toolbar row
 * carries one control instead of a row of buttons.
 */
export function RangeSelector({
    range,
    onChange,
}: {
    range: RangeSelection;
    onChange: (next: RangeSelection) => void;
}) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const [customOpen, setCustomOpen] = useState(false);
    const { setReference, setFloating, floatingStyles } = useDownwardAnchor('start');

    return (
        <fieldset className="toolbar-group">
            <legend className="toolbar-label">Range</legend>
            <Listbox
                value={range.preset}
                onChange={(option: RangePreset) => {
                    const next = presetChange(range, option);
                    if (next) onChange(next);
                    else setCustomOpen(true);
                }}
            >
                <ListboxButton id={RANGE_BUTTON_ID} ref={setReference} className="select-trigger">
                    {rangeLabel(range, now)}
                </ListboxButton>
                <ListboxOptions ref={setFloating} style={floatingStyles} portal className="popover">
                    {PRESET_LABELS.map(({ preset, label }) => (
                        <ListboxOption key={preset} value={preset} className="popover-option">
                            {label}
                        </ListboxOption>
                    ))}
                </ListboxOptions>
            </Listbox>
            <Dialog open={customOpen} onClose={() => setCustomOpen(false)} className="dialog-layer">
                <DialogBackdrop className="dialog-backdrop" />
                <div className="dialog-position">
                    <DialogPanel className="range-dialog">
                        <DialogTitle as="h2" className="range-dialog-title">
                            Custom range
                        </DialogTitle>
                        <RangeDraft
                            committed={{ from: range.from, to: range.to }}
                            today={today}
                            onApply={onChange}
                            onClose={() => setCustomOpen(false)}
                        />
                    </DialogPanel>
                </div>
            </Dialog>
        </fieldset>
    );
}
