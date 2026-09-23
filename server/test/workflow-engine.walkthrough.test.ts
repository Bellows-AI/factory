import { describe, expect, it } from 'vitest';
import type { EngineRow } from '../src/db/workflow-engine.js';
import { nextTransition } from '../src/db/workflow-engine.js';
import { BASE_WORKFLOW } from '../src/db/workflow-templates.js';
import { checkWorkflowParams } from '../src/db/workflow-schema.js';
import { validateDefinition } from '../src/db/workflow-schema-validate.js';
import { done, gate, row } from './workflow-engine-fixtures.js';

describe('the base workflow walkthrough', () => {
    /** Walks the happy path and the loop, inserting as the store would, so every node's template
     * is filled at least once under the walkthrough's rows. */
    const insert = (t: Extract<ReturnType<typeof nextTransition>, { action: 'insert' }>, id: string): EngineRow => ({
        id,
        node: t.node.name,
        status: 'queued',
        output: null,
        gates: null,
        sessionId: null,
    });

    it('walks fetch-issue → implement → review → fix → publish, filling every placeholder', () => {
        const rows: EngineRow[] = [row({ id: 'fetch', node: 'fetch-issue', output: 'ISSUE: the board is dumb' })];
        const steps: string[] = [];

        // fetch-issue succeeded → implement
        let t = nextTransition({
            params: {},
            command: '',
            snapshot: BASE_WORKFLOW.definition,
            rows,
            completed: done({ id: 'fetch', node: 'fetch-issue' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'implement' } });
        if (t.action !== 'insert') return;
        expect(t.command).toContain('ISSUE: the board is dumb');
        steps.push(t.node.name);
        rows.push(insert(t, 'impl'));

        // implement succeeded → review
        rows[rows.length - 1] = row({ id: 'impl', node: 'implement', output: 'implemented; suite green' });
        t = nextTransition({
            params: {},
            command: '',
            snapshot: BASE_WORKFLOW.definition,
            rows,
            completed: done({ id: 'impl', node: 'implement' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'review' } });
        if (t.action !== 'insert') return;
        steps.push(t.node.name);
        rows.push(insert(t, 'rev1'));

        // review names blockers → fix, carrying the review's output
        rows[rows.length - 1] = row({ id: 'rev1', node: 'review', output: '1. src/x.ts is wrong\nVERDICT: BLOCKERS' });
        t = nextTransition({
            params: {},
            command: '',
            snapshot: BASE_WORKFLOW.definition,
            rows,
            completed: done({ id: 'rev1', node: 'review', output: '1. src/x.ts is wrong\nVERDICT: BLOCKERS' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'fix' } });
        if (t.action !== 'insert') return;
        expect(t.command).toContain('1. src/x.ts is wrong');
        steps.push(t.node.name);
        rows.push(insert(t, 'fix1'));

        // fix succeeded → review (round two), then clean → publish
        rows[rows.length - 1] = row({ id: 'fix1', node: 'fix', output: 'fixed' });
        t = nextTransition({ snapshot: BASE_WORKFLOW.definition, rows, completed: done({ id: 'fix1', node: 'fix' }) });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'review' } });
        if (t.action !== 'insert') return;
        steps.push(t.node.name);
        rows.push(insert(t, 'rev2'));
        rows[rows.length - 1] = row({ id: 'rev2', node: 'review', output: 'all good\nVERDICT: CLEAN' });
        t = nextTransition({
            params: {},
            command: '',
            snapshot: BASE_WORKFLOW.definition,
            rows,
            completed: done({ id: 'rev2', node: 'review', output: 'all good\nVERDICT: CLEAN' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'publish' }, publish: true, session: 'resume' });
        if (t.action !== 'insert') return;
        steps.push(t.node.name);

        expect(steps).toEqual(['implement', 'review', 'fix', 'review', 'publish']);
    });

    it('walks gate-failed into gate-fix, filling both gate placeholders', () => {
        const rows: EngineRow[] = [row({ id: 'impl', node: 'implement', sessionId: 'primary' })];
        const t = nextTransition({
            params: {},
            command: '',
            snapshot: BASE_WORKFLOW.definition,
            rows,
            completed: done({
                id: 'impl',
                node: 'implement',
                status: 'failed',
                gates: [gate('test', 'failed', 1, '3 tests failed')],
            }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'gate-fix' } });
        if (t.action !== 'insert') return;
        expect(t.command).toContain('--- FAILED GATE: test ---');
        expect(t.command).toContain('3 tests failed');
        // The gate-fix node resumes the thread's primary session.
        expect(t.session).toBe('resume');
    });

    it('carries the publish flag on exactly the publish node and the fresh policy on review', () => {
        for (const node of BASE_WORKFLOW.definition.nodes) {
            expect(node.publish === true).toBe(node.name === 'publish');
            expect(node.session === 'fresh').toBe(node.name === 'review');
        }
    });
});

describe('the seeded issue parameter', () => {
    it('declares a required issue param accepting a bare #number or an issues URL', () => {
        expect(validateDefinition(BASE_WORKFLOW.definition).ok).toBe(true);
        expect(BASE_WORKFLOW.definition.params).toEqual([
            {
                name: 'issue',
                pattern: expect.any(String),
                description: 'Enter an issue reference such as #123 or a full GitHub issue URL.',
                example: '#123',
            },
        ]);
        expect(checkWorkflowParams(BASE_WORKFLOW.definition, { issue: '#127' }).ok).toBe(true);
        expect(
            checkWorkflowParams(BASE_WORKFLOW.definition, { issue: 'https://github.com/acme/widget/issues/44' }).ok
        ).toBe(true);
        // The bare form keeps its '#': the driver's issue parse and the branch/commit issue
        // references read it off the interpolated prompt.
        expect(checkWorkflowParams(BASE_WORKFLOW.definition, { issue: '127' }).ok).toBe(false);
        expect(checkWorkflowParams(BASE_WORKFLOW.definition, { issue: 'issues 44' }).ok).toBe(false);
        expect(checkWorkflowParams(BASE_WORKFLOW.definition, { issue: 'x#44' }).ok).toBe(false);
        // A param-less launch is refused — the point of the declaration.
        expect(checkWorkflowParams(BASE_WORKFLOW.definition, {}).ok).toBe(false);
    });

    it("fetches the declared param and carries the member's words, with no mining fallback", () => {
        const fetchNode = BASE_WORKFLOW.definition.nodes[0]!;
        expect(fetchNode.name).toBe('fetch-issue');
        expect(fetchNode.prompt).toContain('{{param.issue}}');
        expect(fetchNode.prompt).toContain('{{command}}');
        expect(fetchNode.prompt).not.toContain('if none was given');
        // The command block passes the declared param itself — no placeholder left to re-derive.
        expect(fetchNode.prompt).not.toContain('<url-or-number>');
        expect(fetchNode.prompt).toContain('gh issue view {{param.issue}}');
    });
});
