import type { ScopeSelection } from './RangeSelector.js';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { useDownwardAnchor } from '../anchor.js';
import { scopeWord } from '../dashboardSummary.js';

const SCOPE_BUTTON_ID = 'scope-select';

const SCOPE_VALUES: readonly ScopeSelection[] = ['org', 'mine'];

/**
 * The Scope group of the analytics toolbar (issue 246): one labeled dropdown, the shared
 * quiet-selector language (issue 224) instead of the old Org/Me button pair. `scopeWord` supplies
 * the trigger's text, the same wording the rendered-data summary sentence uses.
 *
 * Rendered only when the session reports a signed-in user — under AUTH_MODE=none there is no
 * "me", and a dropdown that renders anyway would advertise a filter the server can never answer.
 * Absent is the honest shape there: the page reads as org-scoped, which is exactly what it is.
 */
export function ScopeToggle({ scope, onChange }: { scope: ScopeSelection; onChange: (next: ScopeSelection) => void }) {
    const { setReference, setFloating, floatingStyles } = useDownwardAnchor('start');
    return (
        <fieldset className="toolbar-group">
            <legend className="toolbar-label">Scope</legend>
            <Listbox value={scope} onChange={onChange}>
                <ListboxButton id={SCOPE_BUTTON_ID} ref={setReference} className="select-trigger">
                    {scopeWord(scope)}
                </ListboxButton>
                <ListboxOptions ref={setFloating} style={floatingStyles} portal className="popover">
                    {SCOPE_VALUES.map((value) => (
                        <ListboxOption key={value} value={value} className="popover-option">
                            {scopeWord(value)}
                        </ListboxOption>
                    ))}
                </ListboxOptions>
            </Listbox>
        </fieldset>
    );
}
