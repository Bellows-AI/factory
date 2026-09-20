import type { ScopeSelection } from './RangeSelector.js';
import { Radio, RadioGroup } from '@headlessui/react';

/**
 * The org/my toggle, in the analytics toolbar's Scope group.
 *
 * Rendered only when the session reports a signed-in user — under AUTH_MODE=none there is no
 * "me", and a toggle that renders disabled would advertise a filter the server can never answer.
 * Absent is the honest shape there: the page reads as org-scoped, which is exactly what it is.
 */
export function ScopeToggle({ scope, onChange }: { scope: ScopeSelection; onChange: (next: ScopeSelection) => void }) {
    return (
        <div className="toolbar-group">
            {/* The visible label names the group programmatically too — an accessible name of
                "Scope" that contains what the group says, not a parallel "Whose usage". */}
            <span className="toolbar-label" id="scope-label">
                Scope
            </span>
            <RadioGroup value={scope} onChange={onChange} aria-labelledby="scope-label" className="range-presets">
                {(
                    [
                        { value: 'org', label: 'Org' },
                        { value: 'mine', label: 'Me' },
                    ] as const
                ).map(({ value, label }) => (
                    <Radio
                        key={value}
                        as="button"
                        value={value}
                        className={value === scope ? 'range-option active' : 'range-option'}
                    >
                        {label}
                    </Radio>
                ))}
            </RadioGroup>
        </div>
    );
}
