import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { RepoPickerDialog } from '../src/components/RepoPickerDialog.js';
import { SideNav } from '../src/components/SideNav.js';

/**
 * `MemoryRouter` rather than a browser router: this suite has no DOM, and a router that reads
 * `window.location` cannot run here. It is also the one router that exists under the same name in
 * both v6 and v7.
 */
const render = (path: string) =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <SideNav />
        </MemoryRouter>,
    );

describe('SideNav', () => {
    it('links to every section', () => {
        const html = render('/');
        expect(html).toContain('href="/"');
        expect(html).toContain('href="/workspace"');
        expect(html).toContain('href="/tasks"');
        expect(html).toContain('Dashboard');
        expect(html).toContain('Workspace');
        expect(html).toContain('Tasks');
    });

    it('marks the current section for assistive technology, not only visually', () => {
        expect(render('/workspace')).toContain('aria-current="page"');
    });

    it('does not treat "/" as the parent of every other route', () => {
        // Without `end`, the index link matches every path below it and both entries look active.
        const html = render('/workspace');
        const active = html.match(/is-active/g) ?? [];
        expect(active).toHaveLength(1);
    });

});

describe('RepoPickerDialog', () => {
    /*
     * `useEffect` does not run under renderToStaticMarkup, so `showModal()` is never called here.
     * That means modality, the focus trap, focus restoration and Escape are NOT covered by this
     * suite — they are the browser's behaviour, and they belong in e2e/workspace.spec.ts. What is
     * covered is the markup, including the two things that fail silently if they regress.
     */
    const render = (open: boolean) =>
        renderToStaticMarkup(
            <RepoPickerDialog
                open={open}
                selected={[]}
                onClose={() => {}}
                onSave={async () => null}
                saving={false}
            />,
        );

    it('disables Save until the installation list has actually loaded', () => {
        /*
         * The body of the PUT is the WHOLE selection, so saving against a list that has not
         * arrived is how somebody loses every checkout they had. This used to be worse than a
         * missing guard: `save()` built its payload by FILTERING the installation list, so an
         * empty list produced an empty payload — one click deselected everything.
         *
         * `useRepos` does not fetch under renderToStaticMarkup (no effects), so this render is
         * exactly the not-yet-loaded state.
         */
        const html = render(true);
        const save = html.slice(html.indexOf('Save') - 200, html.indexOf('Save'));
        expect(save).toContain('disabled');
    });

    it('renders a dialog element without the `open` attribute', () => {
        // `<dialog open>` is the NON-modal mode: no top layer, no backdrop, no focus trap. Modality
        // has to come from showModal(), which is why the attribute must never be set here.
        const html = render(true);
        expect(html).toContain('<dialog');
        expect(html).not.toMatch(/<dialog[^>]*\sopen/);
    });

    it('uses no form, because the CSP sends form-action \'none\'', () => {
        // The same trap that makes LoginGate an anchor rather than a form. A `method="dialog"` form
        // would look correct and be blocked by the header set in server/src/app.ts.
        const html = render(true);
        expect(html).not.toContain('method="dialog"');
        expect(html).not.toContain('<form');
    });

    it('says the App is installed nowhere rather than showing an empty list', () => {
        // An empty picker and an unreachable GitHub look identical otherwise, and only one of them
        // is something the reader can act on.
        expect(render(true)).toContain('not installed on any repositories');
    });

    it('offers a way out, because this is not a hard gate', () => {
        // If the App is installed nowhere, a non-dismissible dialog is a bricked application with
        // no route to the docs — and the dashboard's figures are readable without a selection.
        expect(render(true)).toContain('Not now');
    });
});
