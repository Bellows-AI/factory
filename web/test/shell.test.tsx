import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../src/components/AppShell.js';
import { ThemeProvider } from '../src/theme.js';

/**
 * The shell's markup contracts, pinned the only way an offline suite can: a static render. The
 * three polls AppShell owns never fire here — effects do not run under `renderToStaticMarkup` —
 * so the hooks return their initial state and the shell renders its frame with empty data. What
 * the frame must look like is issue 160's: skip link first, one main region carrying the skip
 * target, the persistent nav labelled Primary.
 */
function renderShell(path: string): string {
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            {/* The app bar's appearance control (issue 188) needs the theme provider. */}
            <ThemeProvider>
                <Routes>
                    <Route element={<AppShell />}>
                        <Route path="*" element={<p>page</p>} />
                    </Route>
                </Routes>
            </ThemeProvider>
        </MemoryRouter>
    );
}

describe('AppShell', () => {
    it('opens with the skip link, ahead of the navigation and the content', () => {
        const html = renderShell('/');
        const skip = html.indexOf('class="skip-link"');
        expect(skip).toBeGreaterThan(-1);
        expect(html).toContain('Skip to main content');
        expect(html).toContain('href="#main-content"');
        // First focusable element: nothing renders before it.
        expect(skip).toBeLessThan(html.indexOf('<nav'));
    });

    it('owns exactly one main region, carrying the stable skip target', () => {
        const html = renderShell('/');
        expect(html.match(/<main/g) ?? []).toHaveLength(1);
        expect(html).toContain('id="main-content"');
        // Programmatically focusable, so activating the skip link lands focus here.
        expect(html).toContain('tabindex="-1"');
        expect(html).toContain('class="page"');
    });

    it('labels the persistent navigation Primary', () => {
        expect(renderShell('/tasks')).toContain('aria-label="Primary"');
    });

    it('carries a global app bar, and no topbar and no page-level h1', () => {
        // The app bar is chrome, not content: no h1 in it — the routed page owns the page's
        // heading — and the old "Factory stats" topbar is gone entirely (issue 160).
        const html = renderShell('/');
        expect(html).toContain('class="appbar"');
        expect(html).not.toContain('topbar');
        expect(html).not.toContain('<h1');
    });

    it('exposes the drawer trigger with its contracts, ahead of the actions', () => {
        const html = renderShell('/');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-controls="mobile-nav"');
        expect(html).toContain('Open navigation');
        // Trigger first in DOM order: on mobile it is the bar's first control.
        expect(html.indexOf('appbar-trigger')).toBeLessThan(html.indexOf('appbar-actions'));
    });
});
