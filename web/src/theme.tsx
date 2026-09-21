import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * The appearance preference (issue 188): what the person chose, what the document resolves to,
 * and the machinery that keeps both truthful — the before-paint bootstrap in web/public/theme-
 * bootstrap.js starts the palette, this module owns it from React's side.
 *
 * Everything that touches the browser is funneled through four small ports (storage, system
 * media query, document attribute, cross-tab storage events), so the logic is testable without
 * a DOM: `web/test/theme.test.tsx` drives the controller with fakes and executes the bootstrap
 * with stubbed globals. The provider composes the ports inside an effect and never at module
 * scope, which is what keeps the render-server suites — and the first SSR-shaped render — free
 * of window access.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** The one localStorage key the preference lives in; removed entirely for System. */
export const THEME_STORAGE_KEY = 'factory.theme';

export interface ThemeSnapshot {
    preference: ThemePreference;
    resolved: ResolvedTheme;
}

/** `light`/`dark` pass through exactly; everything else — missing, corrupt, inaccessible — is System. */
export function parsePreference(raw: string | null | undefined): ThemePreference {
    return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** System borrows the OS palette; an explicit choice overrides it. */
export function resolveTheme(preference: ThemePreference, system: ResolvedTheme): ResolvedTheme {
    return preference === 'system' ? system : preference;
}

// --- Ports: the only seam to the browser ------------------------------------------------------

export interface ThemeStoragePort {
    /** The stored preference, or null when absent — never throws, even when storage is off-limits. */
    read(): string | null;
    write(value: 'light' | 'dark'): void;
    remove(): void;
}

export interface SystemThemePort {
    /** Whether the OS currently prefers light; dark whenever this cannot be known. */
    light(): boolean;
    onChange(listener: () => void): () => void;
}

export interface ThemeDomPort {
    apply(theme: ResolvedTheme): void;
    current(): ResolvedTheme | null;
}

export interface CrossTabPort {
    /** Fires with the other tab's raw stored value; null means the key was removed there. */
    onChange(listener: (next: string | null) => void): () => void;
}

export interface ThemePorts {
    storage: ThemeStoragePort;
    system: SystemThemePort;
    dom: ThemeDomPort;
    crossTab: CrossTabPort;
}

/** The real ports: window, document, localStorage, one matchMedia query. Every access is
 * guarded, and with the globals missing entirely the ports degrade to inert — System, dark,
 * no-op writes — which is the shape render tests and exotic browsers both get. */
export function windowThemePorts(): ThemePorts {
    const browser = typeof window === 'undefined' ? null : window;
    const doc = typeof document === 'undefined' ? null : document;

    const storage = (): Storage | null => {
        try {
            return browser ? browser.localStorage : null;
        } catch {
            return null;
        }
    };
    const media = (): MediaQueryList | null => {
        try {
            return browser && typeof browser.matchMedia === 'function'
                ? browser.matchMedia('(prefers-color-scheme: light)')
                : null;
        } catch {
            return null;
        }
    };

    return {
        storage: {
            read: () => {
                try {
                    return storage()?.getItem(THEME_STORAGE_KEY) ?? null;
                } catch {
                    return null;
                }
            },
            write: (value) => {
                try {
                    storage()?.setItem(THEME_STORAGE_KEY, value);
                } catch {
                    // Storage refused the write; the preference stays live for this session.
                }
            },
            remove: () => {
                try {
                    storage()?.removeItem(THEME_STORAGE_KEY);
                } catch {
                    // Storage refused the removal; System still resolves from the OS below.
                }
            },
        },
        system: {
            light: () => {
                try {
                    return media()?.matches === true;
                } catch {
                    return false;
                }
            },
            onChange: (listener) => {
                const query = media();
                if (!query) return () => {};
                try {
                    query.addEventListener('change', listener);
                } catch {
                    return () => {};
                }
                return () => query.removeEventListener('change', listener);
            },
        },
        dom: {
            apply: (theme) => {
                try {
                    if (doc) doc.documentElement.dataset.theme = theme;
                } catch {
                    // A detached document cannot carry the attribute; nothing else to do.
                }
            },
            current: () => {
                try {
                    const theme = doc?.documentElement.dataset.theme;
                    return theme === 'light' || theme === 'dark' ? theme : null;
                } catch {
                    return null;
                }
            },
        },
        crossTab: {
            onChange: (listener) => {
                if (!browser) return () => {};
                const handler = (event: StorageEvent) => {
                    if (event.key === THEME_STORAGE_KEY) listener(event.newValue);
                };
                try {
                    browser.addEventListener('storage', handler);
                } catch {
                    return () => {};
                }
                return () => browser.removeEventListener('storage', handler);
            },
        },
    };
}

// --- The controller: preference state and its synchronization ---------------------------------

export interface ThemeController {
    snapshot(): ThemeSnapshot;
    setPreference(next: ThemePreference): void;
    subscribe(listener: () => void): () => void;
    dispose(): void;
}

/** Owns the preference/resolved pair. Initialization reads storage and the OS once and applies
 * the resolution once — idempotent with what the bootstrap already put on the document, so the
 * palette never flips. An explicit choice persists immediately (the writing tab must not wait
 * for its own storage event); System removes the key and follows the OS; a cross-tab event with
 * a missing or unsupported value behaves exactly like a removal. */
export function createThemeController(ports: ThemePorts): ThemeController {
    let preference = parsePreference(ports.storage.read());
    let resolved = resolveTheme(preference, ports.system.light() ? 'light' : 'dark');
    const listeners = new Set<() => void>();
    let disposed = false;

    // The one unconditional apply: the controller owns the attribute from here on, and writing
    // the value the bootstrap already set is a rendering no-op.
    ports.dom.apply(resolved);

    const commit = () => {
        resolved = resolveTheme(preference, ports.system.light() ? 'light' : 'dark');
        ports.dom.apply(resolved);
        for (const listener of listeners) listener();
    };

    const offSystem = ports.system.onChange(() => {
        if (!disposed && preference === 'system') commit();
    });
    const offCrossTab = ports.crossTab.onChange((next) => {
        if (disposed) return;
        preference = parsePreference(next);
        commit();
    });

    return {
        snapshot: () => ({ preference, resolved }),
        setPreference: (next) => {
            if (disposed || next === preference) return;
            preference = next;
            if (next === 'system') ports.storage.remove();
            else ports.storage.write(next);
            commit();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            offSystem();
            offCrossTab();
            listeners.clear();
        },
    };
}

// --- The provider -------------------------------------------------------------------------------

export const ThemeContext = createContext<{
    preference: ThemePreference;
    resolved: ResolvedTheme;
    setPreference(next: ThemePreference): void;
} | null>(null);

const initialSnapshot = (): ThemeSnapshot => {
    // Server render has no document: the stylesheet's own default is the snapshot, and no global
    // may be touched. On the client this READS only — storage once, the OS once — so the first
    // render agrees with the bootstrap's attribute and the control starts truthful without a
    // flash. Do not move these reads into an effect: that reintroduces a first-paint mismatch.
    if (typeof document === 'undefined') return { preference: 'system', resolved: 'dark' };
    try {
        const preference = parsePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
        const system = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        return { preference, resolved: resolveTheme(preference, system) };
    } catch {
        return { preference: 'system', resolved: 'dark' };
    }
};

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [snapshot, setSnapshot] = useState<ThemeSnapshot>(initialSnapshot);
    const controller = useRef<ThemeController | null>(null);

    useEffect(() => {
        const next = createThemeController(windowThemePorts());
        controller.current = next;
        setSnapshot(next.snapshot());
        const unsubscribe = next.subscribe(() => setSnapshot(next.snapshot()));
        return () => {
            unsubscribe();
            next.dispose();
            controller.current = null;
        };
    }, []);

    const setPreference = useCallback((next: ThemePreference) => {
        controller.current?.setPreference(next);
    }, []);

    return (
        <ThemeContext.Provider value={{ preference: snapshot.preference, resolved: snapshot.resolved, setPreference }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme(): {
    preference: ThemePreference;
    resolved: ResolvedTheme;
    setPreference(next: ThemePreference): void;
} {
    const value = useContext(ThemeContext);
    if (!value) throw new Error('useTheme must be used within a ThemeProvider');
    return value;
}
