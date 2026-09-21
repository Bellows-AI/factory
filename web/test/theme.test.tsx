import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppBar } from '../src/components/AppBar.js';
import { ThemeSelector } from '../src/components/ThemeSelector.js';
import { OnboardingPage, type PendingSignInPayload } from '../src/pages/OnboardingPage.js';
import {
    THEME_STORAGE_KEY,
    ThemeContext,
    ThemeProvider,
    createThemeController,
    parsePreference,
    resolveTheme,
    windowThemePorts,
    type CrossTabPort,
    type ResolvedTheme,
    type SystemThemePort,
    type ThemeDomPort,
    type ThemePorts,
    type ThemePreference,
    type ThemeStoragePort,
} from '../src/theme.js';

/**
 * The theme preference (issue 188) without a DOM: the pure helpers are tested directly, the
 * controller is driven through fake ports that record what a real browser would do, the
 * before-paint bootstrap is executed with `new Function` and stubbed globals, and the provider is
 * exercised under `renderToStaticMarkup`, which never runs effects — exactly the environment this
 * suite has.
 */

// --- Fake ports -----------------------------------------------------------------------------

const fakeStorage = (initial: string | null = null): ThemeStoragePort & { value: () => string | null } => {
    let value = initial;
    return {
        read: () => value,
        write: (next) => {
            value = next;
        },
        remove: () => {
            value = null;
        },
        value: () => value,
    };
};

const fakeSystem = (
    light = false
): SystemThemePort & { fire: () => void; setLight: (next: boolean) => void; count: () => number } => {
    const listeners = new Set<() => void>();
    const state = { light };
    return {
        light: () => state.light,
        setLight: (next) => {
            state.light = next;
        },
        onChange: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        fire: () => {
            for (const listener of listeners) listener();
        },
        count: () => listeners.size,
    };
};

const fakeDom = (initial: ResolvedTheme | null = null): ThemeDomPort & { applied: ResolvedTheme[] } => {
    let theme = initial;
    const applied: ResolvedTheme[] = [];
    return {
        apply: (next) => {
            applied.push(next);
            theme = next;
        },
        current: () => theme,
        applied,
    };
};

const fakeCrossTab = (): CrossTabPort & { fire: (next: string | null) => void; count: () => number } => {
    const listeners = new Set<(next: string | null) => void>();
    return {
        onChange: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        fire: (next) => {
            for (const listener of listeners) listener(next);
        },
        count: () => listeners.size,
    };
};

/** Sets exactly the named globals and restores the prior shape afterwards — the worker is shared. */
const withGlobals = (stubs: Record<'window' | 'document' | 'localStorage', unknown>, run: () => void): void => {
    const target = globalThis as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    for (const key of ['window', 'document', 'localStorage'] as const) {
        saved[key] = target[key];
        if (stubs[key] === undefined) delete target[key];
        else target[key] = stubs[key];
    }
    try {
        run();
    } finally {
        for (const key of ['window', 'document', 'localStorage'] as const) {
            if (saved[key] === undefined) delete target[key];
            else target[key] = saved[key];
        }
    }
};

const throwingLocalStorage = () => ({
    getItem: () => {
        throw new Error('denied');
    },
    setItem: () => {
        throw new Error('denied');
    },
    removeItem: () => {
        throw new Error('denied');
    },
});

const src = (file: string) => readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');

// --- Parsing and resolution -------------------------------------------------------------------

describe('theme preference parsing', () => {
    it('accepts exactly light and dark', () => {
        expect(parsePreference('light')).toBe('light');
        expect(parsePreference('dark')).toBe('dark');
    });

    it('treats missing, empty, or unsupported values as System', () => {
        for (const raw of [null, undefined, '', 'moody', 'Light', 'DARK', 'system']) {
            expect(parsePreference(raw), String(raw)).toBe('system');
        }
    });

    it('resolves System to the OS palette and lets light/dark override it', () => {
        expect(resolveTheme('system', 'light')).toBe('light');
        expect(resolveTheme('system', 'dark')).toBe('dark');
        expect(resolveTheme('light', 'dark')).toBe('light');
        expect(resolveTheme('dark', 'light')).toBe('dark');
    });

    it('uses the one storage key the contract names', () => {
        expect(THEME_STORAGE_KEY).toBe('factory.theme');
    });
});

// --- The controller ---------------------------------------------------------------------------

describe('the theme controller', () => {
    it('resolves an absent stored value to System and the current OS palette, writing nothing', () => {
        const storage = fakeStorage(null);
        const dom = fakeDom(null);
        const controller = createThemeController({
            storage,
            system: fakeSystem(true),
            dom,
            crossTab: fakeCrossTab(),
        });
        expect(controller.snapshot()).toEqual({ preference: 'system', resolved: 'light' });
        expect(dom.applied).toEqual(['light']);
        expect(storage.value()).toBeNull();
    });

    it('resolves a stored light or dark immediately, idempotent with the bootstrapped document', () => {
        const storage = fakeStorage('dark');
        const dom = fakeDom('dark');
        const controller = createThemeController({
            storage,
            system: fakeSystem(false),
            dom,
            crossTab: fakeCrossTab(),
        });
        expect(controller.snapshot()).toEqual({ preference: 'dark', resolved: 'dark' });
        // One apply, no flip: the bootstrap already put `dark` on the document.
        expect(dom.applied).toEqual(['dark']);
        expect(storage.value()).toBe('dark');
    });

    it('sets Light and Dark synchronously: storage, document, and subscribers in one call', () => {
        const storage = fakeStorage(null);
        const dom = fakeDom(null);
        const controller = createThemeController({
            storage,
            system: fakeSystem(false),
            dom,
            crossTab: fakeCrossTab(),
        });
        let told = 0;
        controller.subscribe(() => {
            told += 1;
        });
        controller.setPreference('light');
        expect(told).toBe(1);
        expect(storage.value()).toBe('light');
        expect(controller.snapshot()).toEqual({ preference: 'light', resolved: 'light' });
        // The dark init resolution, then the override.
        expect(dom.applied).toEqual(['dark', 'light']);
        controller.setPreference('dark');
        expect(told).toBe(2);
        expect(storage.value()).toBe('dark');
    });

    it('removes the storage key when the preference returns to System', () => {
        const storage = fakeStorage('dark');
        const controller = createThemeController({
            storage,
            system: fakeSystem(true),
            dom: fakeDom(null),
            crossTab: fakeCrossTab(),
        });
        controller.setPreference('system');
        expect(storage.value()).toBeNull();
        expect(controller.snapshot()).toEqual({ preference: 'system', resolved: 'light' });
    });

    it('follows OS changes only while the preference is System', () => {
        const system = fakeSystem(false);
        const controller = createThemeController({
            storage: fakeStorage(null),
            system,
            dom: fakeDom(null),
            crossTab: fakeCrossTab(),
        });
        let told = 0;
        controller.subscribe(() => {
            told += 1;
        });
        // System tracks the OS…
        system.setLight(true);
        system.fire();
        expect(controller.snapshot()).toEqual({ preference: 'system', resolved: 'light' });
        expect(told).toBe(1);
        // …an explicit override notifies once, for the choice itself…
        controller.setPreference('dark');
        const toldAfterChoice = told;
        expect(toldAfterChoice).toBe(2);
        // …and the OS change under an explicit choice is ignored — no notification, no flip.
        system.setLight(false);
        system.fire();
        expect(controller.snapshot()).toEqual({ preference: 'dark', resolved: 'dark' });
        expect(told).toBe(toldAfterChoice);
        // Returning to System resolves the current OS value at once.
        controller.setPreference('system');
        expect(controller.snapshot()).toEqual({ preference: 'system', resolved: 'dark' });
        expect(told).toBe(toldAfterChoice + 1);
    });

    it('applies another tab’s stored preference', () => {
        const crossTab = fakeCrossTab();
        const controller = createThemeController({
            storage: fakeStorage(null),
            system: fakeSystem(false),
            dom: fakeDom(null),
            crossTab,
        });
        let told = 0;
        controller.subscribe(() => {
            told += 1;
        });
        crossTab.fire('light');
        expect(controller.snapshot()).toEqual({ preference: 'light', resolved: 'light' });
        expect(told).toBe(1);
    });

    it('treats a removed or unsupported cross-tab value as System', () => {
        const crossTab = fakeCrossTab();
        const controller = createThemeController({
            storage: fakeStorage('light'),
            system: fakeSystem(true),
            dom: fakeDom(null),
            crossTab,
        });
        crossTab.fire(null);
        expect(controller.snapshot()).toEqual({ preference: 'system', resolved: 'light' });
        crossTab.fire('blue');
        expect(controller.snapshot()).toEqual({ preference: 'system', resolved: 'light' });
    });

    it('detaches its listeners on dispose and ignores later control changes', () => {
        const storage = fakeStorage(null);
        const system = fakeSystem(false);
        const crossTab = fakeCrossTab();
        const controller = createThemeController({ storage, system, dom: fakeDom(null), crossTab });
        expect(system.count()).toBe(1);
        expect(crossTab.count()).toBe(1);
        controller.dispose();
        controller.dispose(); // double-dispose is safe — StrictMode mounts effects twice
        expect(system.count()).toBe(0);
        expect(crossTab.count()).toBe(0);
        controller.setPreference('light');
        expect(storage.value()).toBeNull();
        // The StrictMode shape — create, dispose, create — leaves exactly one live listener each.
        const second = createThemeController({ storage, system, dom: fakeDom(null), crossTab });
        expect(system.count()).toBe(1);
        expect(crossTab.count()).toBe(1);
        second.dispose();
    });
});

// --- The window ports --------------------------------------------------------------------------

describe('the window ports', () => {
    it('are inert without window, document, or storage', () => {
        withGlobals({ window: undefined, document: undefined, localStorage: undefined }, () => {
            const ports = windowThemePorts();
            expect(ports.storage.read()).toBeNull();
            expect(() => ports.storage.write('light')).not.toThrow();
            expect(() => ports.storage.remove()).not.toThrow();
            expect(ports.system.light()).toBe(false);
            const off = ports.system.onChange(() => {});
            expect(() => off()).not.toThrow();
            const offTab = ports.crossTab.onChange(() => {});
            expect(() => offTab()).not.toThrow();
            expect(() => ports.dom.apply('light')).not.toThrow();
            const controller = createThemeController(ports);
            expect(controller.snapshot()).toEqual({ preference: 'system', resolved: 'dark' });
            controller.dispose();
        });
    });

    it('survive storage that always throws, and still apply the palette', () => {
        const dataset: Record<string, string> = {};
        const document = { documentElement: { dataset } };
        const throwing = throwingLocalStorage();
        const window = {
            // Browsers expose storage on the window: this is the path the SecurityError rides.
            localStorage: throwing,
            matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
            addEventListener() {},
            removeEventListener() {},
        };
        withGlobals({ window, document, localStorage: throwing }, () => {
            const ports = windowThemePorts();
            expect(ports.storage.read()).toBeNull();
            expect(() => ports.storage.write('light')).not.toThrow();
            expect(() => ports.storage.remove()).not.toThrow();
            expect(ports.system.light()).toBe(true);
            ports.dom.apply('light');
            expect(dataset.theme).toBe('light');
        });
    });

    it('route storage events for the theme key only, handing the raw new value', () => {
        let storageHandler: ((event: { key: string | null; newValue: string | null }) => void) | undefined;
        const window = {
            matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
            addEventListener: (_type: string, handler: typeof storageHandler) => {
                storageHandler = handler;
            },
            removeEventListener() {},
        };
        withGlobals({ window, document: undefined, localStorage: undefined }, () => {
            const seen: Array<string | null> = [];
            const off = windowThemePorts().crossTab.onChange((next) => seen.push(next));
            storageHandler?.({ key: 'unrelated', newValue: 'light' });
            expect(seen).toEqual([]);
            storageHandler?.({ key: 'factory.theme', newValue: 'light' });
            expect(seen).toEqual(['light']);
            storageHandler?.({ key: 'factory.theme', newValue: null });
            expect(seen).toEqual(['light', null]);
            off();
        });
    });
});

// --- The provider and the control ---------------------------------------------------------------

const renderSelector = (preference: ThemePreference = 'system', resolved: ResolvedTheme = 'dark') =>
    renderToStaticMarkup(
        <ThemeContext.Provider value={{ preference, resolved, setPreference: () => {} }}>
            <ThemeSelector />
        </ThemeContext.Provider>
    );

describe('the provider', () => {
    it('renders server-side without touching window or document', () => {
        withGlobals({ window: undefined, document: undefined, localStorage: undefined }, () => {
            const html = renderToStaticMarkup(
                <ThemeProvider>
                    <p>theme-ready</p>
                </ThemeProvider>
            );
            expect(html).toContain('theme-ready');
        });
    });

    it('exposes the preference, so System stays selected while resolving dark', () => {
        const html = renderSelector('system', 'dark');
        expect(html).toContain('value="system"');
        expect(html).toMatch(/value="system"[^>]*selected/);
        expect(html).not.toMatch(/value="dark"[^>]*selected/);
    });
});

describe('the appearance control', () => {
    it('renders exactly three named options with the contract values', () => {
        const html = renderSelector();
        expect((html.match(/<option /g) ?? []).length).toBe(3);
        for (const [value, name] of [
            ['system', 'System'],
            ['light', 'Light'],
            ['dark', 'Dark'],
        ] as const) {
            expect(html, value).toContain(`value="${value}"`);
            expect(html, value).toContain(`>${name}</option>`);
        }
    });

    it('labels itself Appearance, the label pointing at the select', () => {
        const html = renderSelector();
        const forId = /<label[^>]*for="([^"]+)"[^>]*>Appearance<\/label>/.exec(html)?.[1];
        expect(forId, 'the label names a control').toBeTruthy();
        expect(html).toContain(`<select id="${forId}"`);
    });

    it('reflects an explicit preference rather than the resolved palette', () => {
        expect(renderSelector('dark', 'light')).toMatch(/value="dark"[^>]*selected/);
        expect(renderSelector('light', 'dark')).toMatch(/value="light"[^>]*selected/);
    });

    it('refuses to render outside the provider', () => {
        expect(() => renderToStaticMarkup(<ThemeSelector />)).toThrow(/ThemeProvider/);
    });
});

describe('placements', () => {
    it('the app bar carries the shared selector', () => {
        const html = renderToStaticMarkup(
            <MemoryRouter>
                <ThemeProvider>
                    <AppBar meta={null} session={null} navOpen={false} onOpenNav={() => {}} />
                </ThemeProvider>
            </MemoryRouter>
        );
        expect(html).toContain('theme-select');
        expect(html).toContain('Appearance');
    });

    it('both public pages place the shared control in a public header row', () => {
        for (const file of ['components/LoginGate.tsx', 'pages/OnboardingPage.tsx']) {
            const source = src(file);
            expect(source, file).toContain('<ThemeSelector />');
            expect(source, file).toContain('public-header');
        }
    });

    it('the onboarding header covers every render path', () => {
        const payload: PendingSignInPayload = {
            identity: { login: 'octocat', displayName: null, avatarUrl: null },
            installations: [{ id: '1', account: 'acme', tracked: null }],
            selected: ['1'],
            reselect: false,
            org: null,
            returnTo: '/',
        };
        const loaded = renderToStaticMarkup(
            <ThemeProvider>
                <OnboardingPage payload={payload} />
            </ThemeProvider>
        );
        expect(loaded).toContain('public-header');
        expect(loaded).toContain('theme-select');
        const loading = renderToStaticMarkup(
            <ThemeProvider>
                <OnboardingPage />
            </ThemeProvider>
        );
        expect(loading).toContain('public-header');
        expect(loading).toContain('theme-select');
    });
});

// --- The before-paint bootstrap -----------------------------------------------------------------

const bootstrap = readFileSync(fileURLToPath(new URL('../public/theme-bootstrap.js', import.meta.url)), 'utf8');

const runBootstrap = (globals: { window?: unknown; localStorage?: unknown }): Record<string, string> => {
    const dataset: Record<string, string> = {};
    new Function('document', 'window', 'localStorage', bootstrap)(
        { documentElement: { dataset } },
        globals.window,
        globals.localStorage
    );
    return dataset;
};

describe('the before-paint bootstrap', () => {
    it('reads the theme key and the light media query, and writes the resolved dataset', () => {
        expect(bootstrap).toContain("'factory.theme'");
        expect(bootstrap).toContain("'(prefers-color-scheme: light)'");
        expect(bootstrap).toContain('dataset.theme');
    });

    it('never fetches, logs, imports, or throws', () => {
        // Prose cannot mint a violation — the same rule styles.test.ts applies to CSS comments.
        const code = bootstrap.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(code).not.toMatch(/\b(fetch|console|import|export|require|eval|XMLHttpRequest)\b/);
        expect(code).not.toContain('throw');
    });

    it('prefers a stored light or dark value without consulting the OS', () => {
        let mediaCalls = 0;
        const window = {
            matchMedia: () => {
                mediaCalls += 1;
                return { matches: false };
            },
        };
        expect(runBootstrap({ window, localStorage: { getItem: () => 'dark' } })).toEqual({ theme: 'dark' });
        expect(runBootstrap({ window, localStorage: { getItem: () => 'light' } })).toEqual({ theme: 'light' });
        expect(mediaCalls).toBe(0);
    });

    it('falls back to the OS palette when nothing valid is stored', () => {
        const media = (light: boolean) => ({ matchMedia: () => ({ matches: light }) });
        expect(runBootstrap({ window: media(true), localStorage: { getItem: () => 'moody' } })).toEqual({
            theme: 'light',
        });
        expect(runBootstrap({ window: media(false), localStorage: { getItem: () => null } })).toEqual({
            theme: 'dark',
        });
    });

    it('resolves dark when storage or matchMedia is missing entirely', () => {
        expect(runBootstrap({ window: undefined, localStorage: undefined })).toEqual({ theme: 'dark' });
        expect(runBootstrap({ window: undefined, localStorage: throwingLocalStorage() })).toEqual({ theme: 'dark' });
    });

    it('always leaves a resolved palette on the document', () => {
        const cases = [
            { window: undefined, localStorage: undefined },
            { window: undefined, localStorage: throwingLocalStorage() },
            {
                window: { matchMedia: () => ({ matches: true }) },
                localStorage: { getItem: () => 'light' },
            },
            {
                window: { matchMedia: () => ({ matches: false }) },
                localStorage: { getItem: () => 'dark' },
            },
            {
                window: { matchMedia: () => ({ matches: true }) },
                localStorage: { getItem: () => '' },
            },
        ];
        for (const [index, testCase] of cases.entries()) {
            const dataset = runBootstrap(testCase);
            expect(dataset.theme, `case ${index}`).toMatch(/^light$|^dark$/);
        }
    });
});
