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
