import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon } from '../src/components/Icon.js';

describe('Icon', () => {
    it('ships exactly the foundation glyph set, which the lanes consume and never extend', () => {
        // IMPLEMENTATION-PLAN §1.6: Icon.tsx freezes at Checkpoint A, so the list is the contract.
        expect([...ICON_NAMES].sort()).toEqual(
            [
                'home',
                'list',
                'settings',
                'plus',
                'search',
                'chevron-down',
                'chevron-right',
                'arrow-left',
                'arrow-right',
                'x',
                'check',
                'check-circle',
                'alert-circle',
                'alert-triangle',
                'info',
                'clock',
                'circle-dot',
                'minus-circle',
                'refresh',
                'external-link',
                'copy',
                'git-branch',
                'git-pull-request',
                'repo',
                'user',
                'users',
                'layers',
                'sparkles',
                'terminal',
                'file',
                'sliders',
                'menu',
                'calendar',
                'more-horizontal',
            ].sort()
        );
    });

    it('draws every glyph as a stroked 24px-grid svg in the text color', () => {
        for (const name of ICON_NAMES) {
            const markup = renderToStaticMarkup(<Icon name={name} />);
            expect(markup, name).toMatch(/^<svg class="icon" width="16" height="16" viewBox="0 0 24 24"/);
            expect(markup, name).toContain('fill="none"');
            expect(markup, name).toContain('stroke="currentColor"');
            expect(markup, name).toContain('stroke-width="1.75"');
            expect(markup, name).toContain('stroke-linecap="round"');
            expect(markup, name).toContain('stroke-linejoin="round"');
            expect(markup, name).toMatch(/<path d="M[^"]+"/);
        }
    });

    it('is hidden from assistive technology unless it is labelled', () => {
        const decorative = renderToStaticMarkup(<Icon name="search" />);
        expect(decorative).toContain('aria-hidden="true"');
        expect(decorative).not.toContain('role=');

        const labelled = renderToStaticMarkup(<Icon name="alert-circle" label="Failed" />);
        expect(labelled).toContain('role="img"');
        expect(labelled).toContain('aria-label="Failed"');
        expect(labelled).not.toContain('aria-hidden');
    });

    it('takes its size from the caller', () => {
        expect(renderToStaticMarkup(<Icon name="menu" size={20} />)).toContain('width="20" height="20"');
    });
});
