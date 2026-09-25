import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkflowResult, WorkflowSummaryView } from '../src/api/useWorkflows.js';
import { WorkflowsPanel } from '../src/panels/WorkflowsPanel.js';

/**
 * The workflow management panel (issue 131), server-render-tested by markup assertions the way
 * `default-workflow.render.test.tsx` pins `DefaultWorkflowPanel`: everything reachable from props,
 * with the open-edit/save lifecycle exercised end to end by `verify:ui` where a browser is
 * available.
 */

const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

const ROW: WorkflowSummaryView = {
    id: '99999999-9999-4999-8999-999999999999',
    name: 'fix-issue',
    scope: 'org',
    userId: null,
    repo: null,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
};

const noopFetchOne = async (): Promise<WorkflowResult> => ({
    ok: true,
    record: { ...ROW, definition: { entry: 'a', params: [], nodes: [], edges: [] } },
});
const noopCreate = async (): Promise<WorkflowResult> => ({ ok: true, record: { ...ROW, definition: {} } });
const noopUpdate = async (): Promise<WorkflowResult> => ({ ok: true, record: { ...ROW, definition: {} } });
const noopRemove = async (): Promise<string | null> => null;

describe('WorkflowsPanel', () => {
    it('lists the caller-visible workflows with a scope badge and their timestamps', () => {
        const html = renderToStaticMarkup(
            <WorkflowsPanel
                workflows={[ROW, { ...ROW, id: 'b', name: 'mine', scope: 'user', userId: 'u1' }]}
                loading={false}
                error={null}
                isAdmin={false}
                fetchOne={noopFetchOne}
                onCreate={noopCreate}
                onUpdate={noopUpdate}
                onRemove={noopRemove}
            />
        );
        expect(html).toContain('fix-issue');
        expect(html).toContain('mine');
        expect(html).toContain('>org<');
        expect(html).toContain('>user<');
        expect(html).toContain('2026-09-15');
        expect(html).toContain('2026-09-20');
    });

    it('says there are none yet, never an empty table, when the caller has no workflows', () => {
        const html = renderToStaticMarkup(
            <WorkflowsPanel
                workflows={[]}
                loading={false}
                error={null}
                isAdmin={false}
                fetchOne={noopFetchOne}
                onCreate={noopCreate}
                onUpdate={noopUpdate}
                onRemove={noopRemove}
            />
        );
        expect(html).toContain('No workflows yet.');
        expect(html).not.toContain('<table');
    });

    it('hides Edit/Delete on the organization row for a non-admin, and shows them for an admin', () => {
        const member = renderToStaticMarkup(
            <WorkflowsPanel
                workflows={[ROW]}
                loading={false}
                error={null}
                isAdmin={false}
                fetchOne={noopFetchOne}
                onCreate={noopCreate}
                onUpdate={noopUpdate}
                onRemove={noopRemove}
            />
        );
        expect(member).not.toContain('>Edit<');
        expect(member).not.toContain('>Delete<');

        const admin = renderToStaticMarkup(
            <WorkflowsPanel
                workflows={[ROW]}
                loading={false}
                error={null}
                isAdmin={true}
                fetchOne={noopFetchOne}
                onCreate={noopCreate}
                onUpdate={noopUpdate}
                onRemove={noopRemove}
            />
        );
        expect(admin).toContain('>Edit<');
        expect(admin).toContain('>Delete<');
    });

    it("renders a fetch refusal as the panel's status line, never alongside the empty-list message", () => {
        const html = renderToStaticMarkup(
            <WorkflowsPanel
                workflows={null}
                loading={false}
                error="Could not load the workflows (500)"
                isAdmin={false}
                fetchOne={noopFetchOne}
                onCreate={noopCreate}
                onUpdate={noopUpdate}
                onRemove={noopRemove}
            />
        );
        expect(html).toContain('Could not load the workflows (500)');
        expect(html).not.toContain('No workflows yet.');
    });

    it('offers the organization scope only to an admin', () => {
        const member = renderToStaticMarkup(
            <WorkflowsPanel
                workflows={[]}
                loading={false}
                error={null}
                isAdmin={false}
                fetchOne={noopFetchOne}
                onCreate={noopCreate}
                onUpdate={noopUpdate}
                onRemove={noopRemove}
            />
        );
        expect(member).not.toContain('Organization');

        const admin = renderToStaticMarkup(
            <WorkflowsPanel
                workflows={[]}
                loading={false}
                error={null}
                isAdmin={true}
                fetchOne={noopFetchOne}
                onCreate={noopCreate}
                onUpdate={noopUpdate}
                onRemove={noopRemove}
            />
        );
        expect(admin).toContain('Organization');
    });

    it('never emits a placeholder value', () => {
        const html = renderToStaticMarkup(
            <WorkflowsPanel
                workflows={[ROW]}
                loading={false}
                error={null}
                isAdmin={false}
                fetchOne={noopFetchOne}
                onCreate={noopCreate}
                onUpdate={noopUpdate}
                onRemove={noopRemove}
            />
        );
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});
