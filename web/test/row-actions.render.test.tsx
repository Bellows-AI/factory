import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RowActions } from '../src/components/RowActions.js';

/**
 * The reusable row-actions pattern (issue 411): one inline common action, everything else behind an
 * overflow menu whose trigger is named for the row — a table of them otherwise hands the screen
 * reader N identical "Actions" buttons.
 *
 * Headless UI portals `MenuItems`, and a static render has no DOM to portal into, so only the
 * trigger and the inline button reach this markup — the same limit `user-menu.render.test.tsx`
 * documents. The items' own behavior is the library's; what this file pins is which controls exist.
 */

const noop = () => {};

describe('RowActions', () => {
    it('renders the inline action and one overflow trigger named for the row', () => {
        const html = renderToStaticMarkup(
            <RowActions
                rowName="Main ORG"
                primary={{ label: 'Edit', onSelect: noop }}
                actions={[
                    { label: 'Make personal', onSelect: noop },
                    { label: 'Delete', onSelect: noop, danger: true },
                ]}
                disabled={false}
            />
        );
        expect(html).toContain('>Edit<');
        expect(html).toContain('aria-label="Actions for Main ORG"');
        expect(html.match(/row-actions-trigger/g)?.length).toBe(1);
    });

    it('renders no trigger when the overflow is empty', () => {
        const html = renderToStaticMarkup(
            <RowActions
                rowName="Main ORG"
                primary={{ label: 'Make default', onSelect: noop }}
                actions={[]}
                disabled={false}
            />
        );
        expect(html).toContain('>Make default<');
        expect(html).not.toContain('row-actions-trigger');
    });

    it('renders an empty cell when there is neither a primary action nor an overflow', () => {
        const html = renderToStaticMarkup(
            <RowActions rowName="Main ORG" primary={null} actions={[]} disabled={false} />
        );
        expect(html).not.toContain('<button');
    });

    it('disables the inline action and the trigger while a save is in flight', () => {
        const html = renderToStaticMarkup(
            <RowActions
                rowName="Main ORG"
                primary={{ label: 'Edit', onSelect: noop }}
                actions={[{ label: 'Delete', onSelect: noop, danger: true }]}
                disabled={true}
            />
        );
        // Both controls the cell renders: the inline action and the overflow trigger.
        expect(html.match(/<button[^>]*\sdisabled=""/g)?.length).toBe(2);
    });
});
