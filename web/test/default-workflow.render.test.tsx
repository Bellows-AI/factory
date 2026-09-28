import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DefaultWorkflowPanel } from '../src/panels/DefaultWorkflowPanel.js';
import { renderComposer } from './tasks-fixtures.js';

/**
 * The default-workflow settings panel, server-render-tested by markup assertions the way
 * `env.render.test.tsx` pins `EnvVarsPanel`: everything reachable from props, with the save
 * lifecycle (dirty, saving, saved, refusal) decided by the pure layer (`default-workflow-draft.ts`)
 * and exercised end to end by `verify:ui` where a DB/browser environment is available.
 */

const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

const noop = async () => ({
    ok: true as const,
    data: { reviewReconciliation: true, mergeConflictAutofix: true, updatedAt: null },
});

describe('DefaultWorkflowPanel', () => {
    it('shows the missing-row defaults with both steps on, and a clean (disabled) Save', () => {
        const html = renderToStaticMarkup(
            <DefaultWorkflowPanel
                initialSettings={{ reviewReconciliation: true, mergeConflictAutofix: true, updatedAt: null }}
                onSave={noop}
            />
        );
        expect(html).toContain('Iterate on PR review comments');
        expect(html).toContain('Repair merge conflicts');
        const checkboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
        expect(checkboxes).toHaveLength(2);
        for (const box of checkboxes) expect(box).toContain('checked=""');
        expect(html).toContain('Save changes');
        const save = html.slice(Math.max(0, html.indexOf('Save changes') - 300), html.indexOf('Save changes'));
        expect(save).toContain('disabled');
    });

    it('ends with the Save/Cancel footer after the two switches, clean and without the indicator', () => {
        const html = renderToStaticMarkup(
            <DefaultWorkflowPanel
                initialSettings={{ reviewReconciliation: true, mergeConflictAutofix: true, updatedAt: null }}
                onSave={noop}
            />
        );
        const footerAt = html.indexOf('class="settings-actions"');
        expect(footerAt).toBeGreaterThan(html.indexOf('Repair merge conflicts'));
        expect(html.indexOf('>Save changes</button>')).toBeGreaterThan(footerAt);
        expect(html).not.toContain('panel-actions');
        expect(html).toContain('<h2>Default workflow</h2>');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
        expect(html).not.toContain('Unsaved changes');
    });

    it('round-trips all four saved/default combinations into the checkboxes it renders', () => {
        for (const reviewReconciliation of [true, false]) {
            for (const mergeConflictAutofix of [true, false]) {
                const html = renderToStaticMarkup(
                    <DefaultWorkflowPanel
                        initialSettings={{
                            reviewReconciliation,
                            mergeConflictAutofix,
                            updatedAt: '2026-09-01T00:00:00Z',
                        }}
                        onSave={noop}
                    />
                );
                const checkboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
                expect(checkboxes[0]!.includes('checked=""')).toBe(reviewReconciliation);
                expect(checkboxes[1]!.includes('checked=""')).toBe(mergeConflictAutofix);
            }
        }
    });

    it('shows the mandatory spine as read-only prose, never a control', () => {
        const html = renderToStaticMarkup(
            <DefaultWorkflowPanel
                initialSettings={{ reviewReconciliation: true, mergeConflictAutofix: true, updatedAt: null }}
                onSave={noop}
            />
        );
        expect(html).toMatch(/Prompt.*Gates.*Publish/);
    });

    it('explains the scope of a saved default, verbatim', () => {
        const html = renderToStaticMarkup(
            <DefaultWorkflowPanel
                initialSettings={{ reviewReconciliation: true, mergeConflictAutofix: true, updatedAt: null }}
                onSave={noop}
            />
        );
        expect(html).toContain(
            'Saved defaults apply to new task drafts; running tasks keep their launch configuration.'
        );
    });

    it('never emits a placeholder value', () => {
        const html = renderToStaticMarkup(
            <DefaultWorkflowPanel
                initialSettings={{ reviewReconciliation: false, mergeConflictAutofix: false, updatedAt: null }}
                onSave={noop}
            />
        );
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe("the composer's workflow details beside Default workflow (#280)", () => {
    const oneWorkflow = [
        { id: 'w1', name: 'fix-issue', scope: 'org' as const, params: [{ name: 'issue', pattern: '#\\d+' }] },
    ];
    const details = (html: string) => html.slice(html.indexOf('Workflow details'), html.indexOf('Readiness'));

    it('states the mandatory spine as text, and the saved optional steps under their real labels', () => {
        const html = details(
            renderComposer({
                workflows: oneWorkflow,
                defaultWorkflowSettings: { reviewReconciliation: false, mergeConflictAutofix: true },
            })
        );
        expect(html).toContain('Every task runs: prompt → gates → publish.');
        expect(html).toContain('Optional steps (1 of 2 on)');
        // The spine is prose, never a control: only the two optional steps are checkboxes.
        expect(html.match(/<input type="checkbox"/g) ?? []).toHaveLength(2);
        expect(html).toContain('Iterate on PR review comments');
        expect(html).toContain('Repair merge conflicts');
    });

    it('keeps the spine but holds the optional steps back until the saved settings answer', () => {
        const html = details(renderComposer({ workflows: oneWorkflow, defaultWorkflowSettings: null }));
        expect(html).toContain('Every task runs: prompt → gates → publish.');
        expect(html).not.toContain('composer-steps');
    });

    it('trades the default steps for a named workflow and its own launch details', () => {
        const html = details(
            renderComposer({
                workflows: oneWorkflow,
                defaultWorkflowSettings: { reviewReconciliation: true, mergeConflictAutofix: true },
                restored: {
                    draft: 'fix it',
                    executor: 'main',
                    repo: 'acme/web',
                    repoTouched: false,
                    workflowRepo: 'acme/web',
                    workflow: 'fix-issue',
                    storedParams: { workflowId: null, values: {} },
                    paramTouched: {},
                    defaultStepOverrides: {},
                },
            })
        );
        expect(html).toContain('composer-param-input');
        expect(html).not.toContain('Every task runs');
        expect(html).not.toContain('composer-steps');
    });
});
