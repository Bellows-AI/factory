import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../src/components/AppShell.js';

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
            <Routes>
                <Route element={<AppShell />}>
                    <Route path="*" element={<p>page</p>} />
                </Route>
            </Routes>
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
});
