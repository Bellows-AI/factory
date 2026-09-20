import { describe, expect, it } from 'vitest';
import { answeredWorkflows, type WorkflowAnswer } from '../src/api/useWorkflows.js';

/**
 * The composer may offer a workflow list only for the repository context it was fetched FOR. The
 * answer is keyed by its repository, so the moment the request context switches the previous
 * list is invisible — while the new fetch is still in flight, not only after it lands. A list
 * held over from another context is exactly how a workflow picked for one repository gets
 * submitted under another; the reviewer's data-integrity finding, pinned as a pure derivation
 * because the suite has no DOM.
 */
describe('answeredWorkflows — the list is only ever the current context answer', () => {
    const answer: WorkflowAnswer = {
        repo: 'acme/web',
        workflows: [{ id: 'w1', name: 'fix-issue', scope: 'org', params: [] }],
    };

    it('shows a list for the context that answered, and nothing before any answer', () => {
        expect(answeredWorkflows(answer, 'acme/web')).toEqual(answer.workflows);
        expect(answeredWorkflows(null, 'acme/web')).toBeNull();
    });

    it('goes dark the moment the repository context switches, response or not', () => {
        // The new request is pending: the OLD list must not sit interactive under it.
        expect(answeredWorkflows(answer, 'acme/api')).toBeNull();
        // Same for the no-repository context on either side of the switch.
        expect(answeredWorkflows(answer, null)).toBeNull();
    });

    it('distinguishes a no-repository answer from a repository one', () => {
        const unrepo: WorkflowAnswer = { repo: null, workflows: [] };
        expect(answeredWorkflows(unrepo, null)).toEqual([]);
        expect(answeredWorkflows(unrepo, 'acme/web')).toBeNull();
    });

    it('never lets another context answer leak into the first wait', () => {
        const next: WorkflowAnswer = { repo: 'acme/api', workflows: [] };
        expect(answeredWorkflows(next, 'acme/api')).toEqual([]);
        // ...and switching back is dark until acme/web's own list is re-fetched and stored.
        expect(answeredWorkflows(next, 'acme/web')).toBeNull();
    });
});
