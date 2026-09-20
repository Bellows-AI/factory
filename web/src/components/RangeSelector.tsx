import type { RangePreset } from '@factory-ai/core';
import { Popover, PopoverButton, PopoverPanel, Radio, RadioGroup } from '@headlessui/react';
import { useState } from 'react';

export interface RangeSelection {
    preset: RangePreset;
    /** `YYYY-MM-DD`, as submitted by the date inputs. Only read when preset is 'custom'. */
    from: string;
    to: string;
}

export const DEFAULT_RANGE: RangeSelection = { preset: 'all', from: '', to: '' };

const PRESET_LABELS: { preset: RangePreset; label: string }[] = [
    { preset: 'day', label: 'Today' },
    { preset: 'week', label: '7 days' },
    { preset: '2w', label: '14 days' },
    { preset: 'month', label: '30 days' },
    { preset: 'all', label: 'All time' },
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
 * The custom-draft validity rule, shared by the Apply button's disabled state and by
 * `applyDraft`: both bounds empty is not a range, `from` may not cross `to`, and neither bound
 * reaches past today. One bound on its own is a legitimate half-open range — the API takes it.
 */
export function draftValid(draft: { from: string; to: string }, today: string): boolean {
    if (!draft.from && !draft.to) return false;
    if (draft.to && draft.to > today) return false;
    if (draft.from && draft.to && draft.from > draft.to) return false;
    return true;
}

/**
 * The draft-commit rule: a draft is committed exactly once, through Apply, and an invalid draft
 * commits nothing — the selection passes through untouched. Cancel, Escape and outside clicks
 * commit nothing the same way: they simply never call this.
 */
export function applyDraft(range: RangeSelection, draft: { from: string; to: string }, today: string): RangeSelection {
    if (!draftValid(draft, today)) return range;
    return { preset: 'custom', from: draft.from, to: draft.to };
}

/** Clear abandons the custom window entirely: back to All time. */
export function clearRange(): RangeSelection {
    return DEFAULT_RANGE;
}

/**
 * The popover's draft form. Draft values are LOCAL state seeded from the last committed bounds
 * at mount — the panel unmounts when the popover closes, so reopening re-seeds from what was
 * committed and an abandoned draft is discarded. Typing here never issues a request; only Apply
 * (a valid draft, committed once) and Clear (back to All time) commit, and both close.
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
    const apply = () => {
        onApply(applyDraft({ preset: 'custom', from: committed.from, to: committed.to }, draft, today));
        onClose();
    };
    return (
        <div className="range-draft">
            <label>
                From
                <input
                    type="date"
                    value={draft.from}
                    max={draft.to || today}
                    onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                />
            </label>
            <label>
                To
                <input
                    type="date"
                    value={draft.to}
                    min={draft.from || undefined}
                    max={today}
                    onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                />
            </label>
            <div className="range-draft-actions">
                <button type="button" onClick={apply} disabled={!draftValid(draft, today)}>
                    Apply range
                </button>
                <button
                    type="button"
                    onClick={() => {
                        onApply(clearRange());
                        onClose();
                    }}
                >
                    Clear
                </button>
            </div>
        </div>
    );
}

/**
 * The Range group of the analytics toolbar. Common presets commit immediately; Custom opens a
 * popover holding the draft (`RangeDraft`) instead of expanding the toolbar — opening it, typing
 * in it, or dismissing it never issues a request. The trigger carries `aria-expanded` and
 * restores focus on close (Headless UI's popover contract), and the group is labeled by the
 * visible `Range` text every bit as much as by an invisible aria-label.
 */
export function RangeSelector({
    range,
    onChange,
}: {
    range: RangeSelection;
    onChange: (next: RangeSelection) => void;
}) {
    const today = new Date().toISOString().slice(0, 10);

    return (
        <div className="toolbar-group">
            <span className="toolbar-label" id="range-label">
                Range
            </span>
            <div className="range-picker">
                <RadioGroup
                    value={range.preset}
                    onChange={(preset) => onChange({ ...range, preset })}
                    aria-labelledby="range-label"
                    className="range-presets"
                >
                    {PRESET_LABELS.map(({ preset, label }) => (
                        <Radio
                            key={preset}
                            as="button"
                            value={preset}
                            className={preset === range.preset ? 'range-option active' : 'range-option'}
                        >
                            {label}
                        </Radio>
                    ))}
                </RadioGroup>
                <Popover className="range-popover-root">
                    <PopoverButton
                        as="button"
                        type="button"
                        className={range.preset === 'custom' ? 'range-option active' : 'range-option'}
                    >
                        Custom
                    </PopoverButton>
                    <PopoverPanel className="range-popover">
                        {({ close }) => (
                            <RangeDraft
                                committed={{ from: range.from, to: range.to }}
                                today={today}
                                onApply={onChange}
                                onClose={() => close()}
                            />
                        )}
                    </PopoverPanel>
                </Popover>
            </div>
        </div>
    );
}
