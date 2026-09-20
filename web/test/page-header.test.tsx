import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '../src/components/PageHeader.js';

const html = (props: Parameters<typeof PageHeader>[0]) => renderToStaticMarkup(<PageHeader {...props} />);

describe('PageHeader', () => {
    it('renders exactly one h1 carrying the title', () => {
        const markup = html({ title: 'Usage overview' });
        expect(markup.match(/<h1/g)?.length).toBe(1);
        expect(markup).toContain('<h1>Usage overview</h1>');
    });

    it('renders the header element', () => {
        expect(html({ title: 'Tasks' })).toContain('<header class="page-header"');
    });

    it('renders the eyebrow above the h1', () => {
        const markup = html({ eyebrow: 'Tasks', title: 'New task' });
        expect(markup).toContain('page-header-eyebrow');
        expect(markup.indexOf('page-header-eyebrow')).toBeLessThan(markup.indexOf('<h1'));
        expect(markup.match(/<h1/g)?.length).toBe(1);
    });

    it('renders the description in the leading column, after the h1', () => {
        const markup = html({ title: 'Account', description: 'Signed in as octocat' });
        expect(markup).toContain('page-header-description');
        expect(markup.indexOf('<h1')).toBeLessThan(markup.indexOf('page-header-description'));
    });

    it('omitted slots leave no wrappers behind', () => {
        const markup = html({ title: 'Usage overview' });
        expect(markup).not.toContain('page-header-eyebrow');
        expect(markup).not.toContain('page-header-description');
        expect(markup).not.toContain('page-header-meta');
        expect(markup).not.toContain('page-header-actions');
    });

    it('keeps meta and actions as siblings after the leading column, in that order', () => {
        const markup = html({
            title: 'Usage overview',
            meta: 'data as of yesterday',
            actions: <button type="button">Refresh</button>,
        });
        expect(markup.indexOf('page-header-meta')).toBeLessThan(markup.indexOf('page-header-actions'));
        // Actions never become children of the heading: the h1 closes before the action opens.
        expect(markup.indexOf('</h1>')).toBeLessThan(markup.indexOf('<button'));
    });

    it('does not hand a blank slot a wrapper even when siblings render', () => {
        const markup = html({ title: 'Tasks', actions: <button type="button">New task</button> });
        expect(markup).toContain('page-header-actions');
        expect(markup).not.toContain('page-header-eyebrow');
        expect(markup).not.toContain('page-header-description');
        expect(markup).not.toContain('page-header-meta');
    });

    it('renders nothing but empty wrappers for a null ReactNode slot', () => {
        // A caller may pass `null` (a valid ReactNode) for a slot it computes conditionally;
        // the guard is truthiness of the slot value, not JSX presence.
        const markup = html({ title: 'Tasks', meta: null, actions: null });
        expect(markup).not.toContain('page-header-meta');
        expect(markup).not.toContain('page-header-actions');
    });
});
