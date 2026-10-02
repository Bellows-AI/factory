import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OrgExecutorsPanel } from '../src/panels/OrgExecutorsPanel.js';

/** The same contract workspace.render.test.tsx pins for the personal panel's Make default action. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

describe('the organization executors panel', () => {
    const executor = (name: string, type: string, createdAt = '2026-09-01T00:00:00.000Z') => ({
        name,
        type,
        createdAt,
    });
    const noop = () => {};

    it('renders Make default on every non-default row, and not on the row the org default names', () => {
        const html = renderToStaticMarkup(
            <OrgExecutorsPanel
                executors={[executor('team-runner', 'claude-code'), executor('oc', 'opencode')]}
                isAdmin={false}
                saving={false}
                defaultName="team-runner"
                onAdd={undefined}
                onEdit={undefined}
                onDelete={undefined}
                onDemote={undefined}
                onMakeDefault={noop}
            />
        );
        // The default row answers with its caption instead — a click there would write nothing.
        expect(html.match(/>Make default</g)?.length).toBe(1);
        expect(html.match(/Default — selected on new tasks/g)?.length).toBe(1);
    });

    it('disables Make default while a save is in flight', () => {
        const html = renderToStaticMarkup(
            <OrgExecutorsPanel
                executors={[executor('team-runner', 'claude-code'), executor('oc', 'opencode')]}
                isAdmin={false}
                saving={true}
                defaultName={null}
                onAdd={undefined}
                onEdit={undefined}
                onDelete={undefined}
                onDemote={undefined}
                onMakeDefault={noop}
            />
        );
        expect(html).toMatch(/>Make default<\/button>/);
        expect(html).toContain('disabled');
    });

    it('shows an admin Edit inline and one overflow trigger naming the profile', () => {
        const html = renderToStaticMarkup(
            <OrgExecutorsPanel
                executors={[executor('team-runner', 'claude-code')]}
                isAdmin={true}
                saving={false}
                defaultName={null}
                onAdd={noop}
                onEdit={noop}
                onDelete={noop}
                onDemote={noop}
                onMakeDefault={noop}
            />
        );
        expect(html.match(/>Edit</g)?.length).toBe(1);
        expect(html).toContain('aria-label="Actions for team-runner"');
        // Make personal and Delete live in the portalled menu, so they reach no static markup —
        // what matters here is that they are no longer four equal-weight buttons in the cell.
        expect(html).not.toContain('>Delete<');
        expect(html).not.toContain('>Make personal<');
    });

    it('shows a member Make default and no overflow trigger', () => {
        const html = renderToStaticMarkup(
            <OrgExecutorsPanel
                executors={[executor('team-runner', 'claude-code')]}
                isAdmin={false}
                saving={false}
                defaultName={null}
                onAdd={undefined}
                onEdit={undefined}
                onDelete={undefined}
                onDemote={undefined}
                onMakeDefault={noop}
            />
        );
        expect(html.match(/>Make default</g)?.length).toBe(1);
        expect(html).not.toContain('row-actions-trigger');
    });

    it('gives a member no control at all on the row the org default names', () => {
        const html = renderToStaticMarkup(
            <OrgExecutorsPanel
                executors={[executor('team-runner', 'claude-code')]}
                isAdmin={false}
                saving={false}
                defaultName="team-runner"
                onAdd={undefined}
                onEdit={undefined}
                onDelete={undefined}
                onDemote={undefined}
                onMakeDefault={noop}
            />
        );
        expect(html).not.toContain('<button');
        // And no caption over the nothing: the card reflow writes `data-label` above each cell.
        expect(html).not.toContain('data-label="Actions"');
    });

    it('labels every cell for the narrow-viewport card reflow', () => {
        const html = renderToStaticMarkup(
            <OrgExecutorsPanel
                executors={[executor('team-runner', 'claude-code')]}
                isAdmin={false}
                saving={false}
                defaultName={null}
                onAdd={undefined}
                onEdit={undefined}
                onDelete={undefined}
                onDemote={undefined}
                onMakeDefault={noop}
            />
        );
        expect(html).toContain('table-cards');
        for (const label of ['Name', 'Type', 'Added', 'Actions']) {
            expect(html, label).toContain(`data-label="${label}"`);
        }
    });

    it('keeps the panel legible with no placeholder values', () => {
        const html = renderToStaticMarkup(
            <OrgExecutorsPanel
                executors={[executor('team-runner', 'claude-code')]}
                isAdmin={false}
                saving={false}
                defaultName={null}
                onAdd={undefined}
                onEdit={undefined}
                onDelete={undefined}
                onDemote={undefined}
                onMakeDefault={noop}
            />
        );
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});
