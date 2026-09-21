import { useTheme } from '../theme.js';
import type { ThemePreference } from '../theme.js';

/**
 * The appearance control (issue 188): one native select for the System/Light/Dark preference,
 * shared by the app bar and the public pages.
 *
 * It shows the PREFERENCE, never the resolved palette — System stays selected while the OS
 * resolves dark — and owns nothing else: persistence, the document attribute, and the OS/
 * cross-tab listeners live in the provider (web/src/theme.tsx). A native select rather than a
 * Headless UI listbox because the requirement is the platform control: keyboard-complete, no
 * focus trap, the browser's own popup. At most one instance mounts at a time (the gate replaces
 * the app; the onboarding page renders outside the shell), so the id is static.
 */
export function ThemeSelector() {
    const { preference, setPreference } = useTheme();
    return (
        <div className="theme-field">
            <label className="theme-label" htmlFor="theme-select">
                Appearance
            </label>
            <select
                id="theme-select"
                className="theme-select"
                value={preference}
                onChange={(event) => setPreference(event.target.value as ThemePreference)}
            >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
            </select>
        </div>
    );
}
