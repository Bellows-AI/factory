import { Label, Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { useDownwardAnchor } from '../anchor.js';
import { useTheme } from '../theme.js';
import type { ThemePreference } from '../theme.js';

/** The System/Light/Dark contract values and their labels — the one place they are spelled. */
export const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
];

const THEME_BUTTON_ID = 'theme-select';

/**
 * The appearance control (issue 188): the System/Light/Dark preference, shared by the app bar and
 * the public pages.
 *
 * It shows the PREFERENCE, never the resolved palette — System stays selected while the OS
 * resolves dark — and owns nothing else: persistence, the document attribute, and the OS/
 * cross-tab listeners live in the provider (web/src/theme.tsx). A Headless UI `Listbox` rather
 * than a native select (issue 224): the quiet-selector treatment needs the panel anchored below
 * the trigger, capped to the viewport, and marked with a checkmark, none of which a native popup
 * allows. The trigger keeps a static id so the `Label` stays associated with it even before
 * hydration; at most one instance mounts at a time (the gate replaces the app; the onboarding
 * page renders outside the shell), so a static id is safe.
 */
export function ThemeSelector() {
    const { preference, setPreference } = useTheme();
    const { setReference, setFloating, floatingStyles } = useDownwardAnchor('end');
    const current = THEME_OPTIONS.find((option) => option.value === preference) ?? THEME_OPTIONS[0]!;
    return (
        <div className="theme-field">
            <Listbox value={preference} onChange={setPreference}>
                <Label className="theme-label" htmlFor={THEME_BUTTON_ID}>
                    Appearance
                </Label>
                <ListboxButton id={THEME_BUTTON_ID} ref={setReference} className="select-trigger">
                    {current.label}
                </ListboxButton>
                <ListboxOptions ref={setFloating} style={floatingStyles} portal className="popover">
                    {THEME_OPTIONS.map((option) => (
                        <ListboxOption key={option.value} value={option.value} className="popover-option">
                            {option.label}
                        </ListboxOption>
                    ))}
                </ListboxOptions>
            </Listbox>
        </div>
    );
}
