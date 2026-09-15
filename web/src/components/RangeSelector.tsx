import type { RangePreset } from '@factory-ai/core';

export interface RangeSelection {
    preset: RangePreset;
    /** `YYYY-MM-DD`, as submitted by the date inputs. Only read when preset is 'custom'. */
    from: string;
    to: string;
}

export const DEFAULT_RANGE: RangeSelection = { preset: 'all', from: '', to: '' };

const PRESET_LABELS: { preset: RangePreset; label: string }[] = [
    { preset: 'day', label: 'Today' },
    { preset: 'week', label: 'This week' },
    { preset: '2w', label: 'Two weeks' },
    { preset: 'month', label: 'Month' },
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

export function RangeSelector({
    range,
    onChange,
}: {
    range: RangeSelection;
    onChange: (next: RangeSelection) => void;
}) {
    const today = new Date().toISOString().slice(0, 10);

    return (
        <section className="range-selector">
            <div className="range-presets">
                {PRESET_LABELS.map(({ preset, label }) => (
                    <button
                        key={preset}
                        type="button"
                        className={preset === range.preset ? 'range-option active' : 'range-option'}
                        aria-pressed={preset === range.preset}
                        onClick={() => onChange({ ...range, preset })}
                    >
                        {label}
                    </button>
                ))}
            </div>
            {range.preset === 'custom' ? (
                <div className="range-custom">
                    <label>
                        from
                        <input
                            type="date"
                            value={range.from}
                            max={range.to || today}
                            onChange={(e) => onChange({ ...range, from: e.target.value })}
                        />
                    </label>
                    <label>
                        to
                        <input
                            type="date"
                            value={range.to}
                            min={range.from || undefined}
                            max={today}
                            onChange={(e) => onChange({ ...range, to: e.target.value })}
                        />
                    </label>
                    {!range.from && !range.to ? (
                        <span className="muted">pick a date — showing all time until then</span>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}
